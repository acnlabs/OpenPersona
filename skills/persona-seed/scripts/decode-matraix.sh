#!/usr/bin/env bash
# Download (optional) + decode MatrAIx Persona 1M into MATRAIX_CORPUS_PATH JSON.
set -euo pipefail

SEED_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DECODE_PY="$SEED_DIR/providers/matraix-persona-1m/scripts/decode_parquet.py"
DATASET_DIR="${MATRAIX_DATASET_DIR:-./matraix-1m}"
OUT_JSONL="${MATRAIX_JSONL:-./matraix-1m.decoded.jsonl}"
OUT_JSON="${MATRAIX_CORPUS_PATH:-./matraix-1m.decoded.json}"
LIMIT="${MATRAIX_DECODE_LIMIT:-1000}"
DOWNLOAD="${MATRAIX_DOWNLOAD:-0}"

usage() {
  cat <<EOF
Usage: decode-matraix.sh [--download] [--limit N] [--dataset-dir DIR]

Decodes packed HF Parquet into persona-seed fixture-shaped JSON for:
  export MATRAIX_CORPUS_PATH=<json>

Env:
  MATRAIX_DATASET_DIR   local HF download dir (default ./matraix-1m)
  MATRAIX_CORPUS_PATH   output JSON array (default ./matraix-1m.decoded.json)
  MATRAIX_DECODE_LIMIT  max rows (default 1000)
  MATRAIX_DOWNLOAD=1    run huggingface-cli download first
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --download) DOWNLOAD=1; shift ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --dataset-dir) DATASET_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ "$DOWNLOAD" == "1" ]]; then
  if ! command -v huggingface-cli >/dev/null 2>&1; then
    echo "huggingface-cli not found. Install: pip install huggingface_hub" >&2
    exit 1
  fi
  huggingface-cli download MatrAIx2026/MatrAIx_Persona_1M \
    --repo-type dataset \
    --local-dir "$DATASET_DIR"
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 required" >&2
  exit 1
fi

python3 "$DECODE_PY" \
  --dataset-dir "$DATASET_DIR" \
  --out "$OUT_JSONL" \
  --json-out "$OUT_JSON" \
  --limit "$LIMIT"

echo "Next:"
echo "  export MATRAIX_CORPUS_PATH=$(cd "$(dirname "$OUT_JSON")" && pwd)/$(basename "$OUT_JSON")"
echo "  node $SEED_DIR/scripts/prepare-corpus.js --validate \"\$MATRAIX_CORPUS_PATH\" --limit 20"
echo "  node $SEED_DIR/scripts/search.js --intent '{\"domain\":[\"software\"],\"limit\":5}'"
