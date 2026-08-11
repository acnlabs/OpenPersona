#!/usr/bin/env python3
"""Decode MatrAIx Persona 1M packed Parquet shards into persona-seed JSONL.

Requires: Python 3 + pyarrow

Example:
  huggingface-cli download MatrAIx2026/MatrAIx_Persona_1M \\
    --repo-type dataset --local-dir ./matraix-1m

  python3 decode_parquet.py \\
    --dataset-dir ./matraix-1m \\
    --out ./matraix-1m.decoded.jsonl \\
    --limit 1000

Then:
  export MATRAIX_CORPUS_PATH=./matraix-1m.decoded.jsonl
  # search.js / prepare-corpus.js accept JSON arrays; for JSONL use prepare-corpus
  # or convert: python3 -c 'import json; ...' → .json array for the provider.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# High-signal fields → fixture attribute keys (identity preserved when same).
FIELD_MAP = {
    "region": "region",
    "age_bracket": "age_bracket",
    "primary_language": "primary_language",
    "highest_education": "highest_education",
    "occupation": "occupation",
    "occupation_domain": "occupation_domain",
    "industry": "occupation_domain",
    "risk_tolerance": "risk_tolerance",
    "communication_formality": "communication_formality",
}

# Collect into arrays when present under these source ids / prefixes.
LIST_FIELDS = {
    "personality_traits": ("personality_traits", "big_five", "trait_"),
    "values": ("values", "value_"),
    "motivations": ("motivations", "motivation_"),
    "interests": ("interests", "hobby", "interest_"),
    "speaking_style_hints": ("speaking_style", "communication_style", "interaction_"),
    "tools": ("tools", "programming_language", "software_tool"),
}


def load_schema(dataset_dir: Path) -> list[dict[str, Any]]:
    schema_path = dataset_dir / "persona_codes.schema.json"
    if not schema_path.exists():
        # Some releases nest under release/
        alt = dataset_dir / "release" / "persona_codes.schema.json"
        schema_path = alt if alt.exists() else schema_path
    if not schema_path.exists():
        raise SystemExit(f"persona_codes.schema.json not found under {dataset_dir}")
    data = json.loads(schema_path.read_text(encoding="utf-8"))
    cols = data.get("columns")
    if not isinstance(cols, list):
        raise SystemExit("persona_codes.schema.json missing columns[]")
    return cols


def decode_attributes(
    attributes: bytes | None,
    null_bitmap: bytes | None,
    schema: list[dict[str, Any]],
    overrides: dict[str, Any] | None,
) -> dict[str, str]:
    out: dict[str, str] = {}
    if attributes is None:
        return out
    if isinstance(attributes, memoryview):
        attributes = attributes.tobytes()
    elif not isinstance(attributes, (bytes, bytearray)):
        attributes = bytes(attributes)

    nb = None
    if null_bitmap is not None:
        if isinstance(null_bitmap, memoryview):
            nb = null_bitmap.tobytes()
        elif isinstance(null_bitmap, (bytes, bytearray)):
            nb = bytes(null_bitmap)
        else:
            nb = bytes(null_bitmap)

    for i, col in enumerate(schema):
        if nb is not None and (nb[i // 8] >> (i % 8)) & 1:
            continue
        code = (attributes[i // 2] & 0x0F) if i % 2 == 0 else (attributes[i // 2] >> 4)
        values = col.get("values") or []
        if code < len(values):
            out[col["id"]] = values[code]

    if overrides:
        for k, v in overrides.items():
            if v is not None:
                out[str(k)] = v if isinstance(v, str) else str(v)
    return out


def collect_lists(decoded: dict[str, str]) -> dict[str, list[str]]:
    lists: dict[str, list[str]] = {k: [] for k in LIST_FIELDS}
    for field_id, value in decoded.items():
        fid = field_id.lower()
        for target, prefixes in LIST_FIELDS.items():
            if any(fid == p or fid.startswith(p) for p in prefixes):
                if value and value not in lists[target]:
                    lists[target].append(value)
    return {k: v for k, v in lists.items() if v}


def summarize(attrs: dict[str, Any], decoded: dict[str, str]) -> str:
    bits = [
        attrs.get("occupation"),
        attrs.get("region"),
        attrs.get("age_bracket"),
        attrs.get("occupation_domain"),
    ]
    bits = [b for b in bits if b]
    if bits:
        return " · ".join(str(b) for b in bits)
    # fall back to a few decoded keys
    for key in ("occupation", "region", "age_bracket"):
        if key in decoded:
            bits.append(decoded[key])
    return " · ".join(bits) if bits else "MatrAIx persona seed"


def grounding_type(source: str | None) -> str:
    if not source:
        return "unknown"
    s = source.lower()
    if "synthetic" in s:
        return "synthetic"
    return "human_grounded"


def row_to_record(
    *,
    idx: int,
    source: str | None,
    source_record_id: str | None,
    decoded: dict[str, str],
    description: str | None,
) -> dict[str, Any]:
    attrs: dict[str, Any] = {}
    for src, dest in FIELD_MAP.items():
        if src in decoded and dest not in attrs:
            attrs[dest] = decoded[src]
    attrs.update(collect_lists(decoded))

    rid = source_record_id or f"{source or 'row'}-{idx}"
    return {
        "id": str(rid),
        "groundingType": grounding_type(source),
        "description": description or summarize(attrs, decoded),
        "attributes": attrs,
        "source": source,
    }


def find_parquet_files(dataset_dir: Path) -> list[Path]:
    candidates: list[Path] = []
    for sub in ("data", "release/data", "."):
        root = dataset_dir / sub if sub != "." else dataset_dir
        if not root.exists():
            continue
        candidates.extend(sorted(root.glob("*.parquet")))
        candidates.extend(sorted(root.glob("persona*.parquet")))
    # Prefer packed shards over sample/ flatten files
    packed = [p for p in candidates if "sample" not in p.parts]
    return packed or candidates


def description_from_row(row: dict[str, Any]) -> str | None:
    descs = row.get("descriptions")
    if isinstance(descs, list) and descs:
        texts = []
        for d in descs[:3]:
            if isinstance(d, dict):
                t = d.get("text") or d.get("description")
                if t:
                    texts.append(str(t))
            elif isinstance(d, str):
                texts.append(d)
        if texts:
            return " ".join(texts)
    if row.get("has_description") and isinstance(row.get("metadata_json"), str):
        try:
            meta = json.loads(row["metadata_json"])
            if isinstance(meta.get("description"), str):
                return meta["description"]
        except json.JSONDecodeError:
            pass
    return None


def decode_shard(
    path: Path,
    schema: list[dict[str, Any]],
    limit: int | None,
    written: int,
    out_fh,
) -> int:
    import pyarrow.parquet as pq

    table = pq.read_table(path)
    n = table.num_rows
    cols = set(table.column_names)

    for i in range(n):
        if limit is not None and written >= limit:
            return written
        attributes = table["attributes"][i].as_py() if "attributes" in cols else None
        null_bitmap = table["null_bitmap"][i].as_py() if "null_bitmap" in cols else None
        overrides = None
        if "attribute_overrides" in cols:
            overrides = table["attribute_overrides"][i].as_py()
            if isinstance(overrides, str):
                try:
                    overrides = json.loads(overrides)
                except json.JSONDecodeError:
                    overrides = None

        decoded = decode_attributes(attributes, null_bitmap, schema, overrides)
        source = table["source"][i].as_py() if "source" in cols else None
        srid = (
            table["source_record_id"][i].as_py()
            if "source_record_id" in cols
            else None
        )
        row_dict = {name: table[name][i].as_py() for name in cols}
        rec = row_to_record(
            idx=written,
            source=source,
            source_record_id=srid,
            decoded=decoded,
            description=description_from_row(row_dict),
        )
        out_fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        written += 1
    return written


def jsonl_to_array(jsonl_path: Path, json_path: Path, limit: int | None) -> int:
    rows = []
    with jsonl_path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
            if limit is not None and len(rows) >= limit:
                break
    json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return len(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-dir", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path, help="Output .jsonl path")
    parser.add_argument("--json-out", type=Path, help="Also write a JSON array for MATRAIX_CORPUS_PATH")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    try:
        import pyarrow.parquet  # noqa: F401
    except ImportError as exc:
        raise SystemExit("pyarrow is required: pip install pyarrow") from exc

    schema = load_schema(args.dataset_dir)
    files = find_parquet_files(args.dataset_dir)
    if not files:
        raise SystemExit(f"No parquet files under {args.dataset_dir}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with args.out.open("w", encoding="utf-8") as out_fh:
        for path in files:
            written = decode_shard(path, schema, args.limit, written, out_fh)
            if args.limit is not None and written >= args.limit:
                break

    print(f"wrote {written} records → {args.out}", file=sys.stderr)
    if args.json_out:
        n = jsonl_to_array(args.out, args.json_out, args.limit)
        print(f"wrote JSON array ({n}) → {args.json_out}", file=sys.stderr)
        print(
            f"export MATRAIX_CORPUS_PATH={args.json_out.resolve()}",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
