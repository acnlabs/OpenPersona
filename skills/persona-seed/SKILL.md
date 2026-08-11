---
name: persona-seed
description: "Create an OpenPersona pack from population / corpus seed providers (first: MatrAIx Persona 1M). Searches a pluggable seed index from user intent, maps a SeedProfile to persona.json, then generates via open-persona. Use when the user wants a persona from a large persona corpus, MatrAIx, or archetype sampling — not when distilling a specific real person (use anyone-skill)."
license: MIT
compatibility: "OpenPersona / Cursor / Claude Code / OpenClaw. Node.js >= 18. Optional: decoded MatrAIx corpus via MATRAIX_CORPUS_PATH."
allowed-tools: Read Write Edit Bash
metadata:
  version: "0.1.0"
  author: acnlabs
---

# persona-seed — Population seeds → OpenPersona packs

> One orchestration skill. Many corpus providers. MatrAIx Persona 1M is the first adapter — not a special-case product path.

**Dependency chain**: `persona-seed` → `skills/open-persona` → `openpersona create`  
**Sibling**: `anyone-skill` (evidence distillation of a specific subject). Prefer anyone-skill for real people / named characters; prefer persona-seed for population sampling and archetypes from a corpus.

## Trigger phrases

- `/persona-seed`
- "create a persona from MatrAIx"
- "sample a persona from Persona 1M"
- "pick a seed profile and generate a pack"
- "从人口语料里生成人格包"

## Architecture

```
user intent
    → provider.search (attribute filter)
    → agent re-rank + user pick
    → provider.fetch + toSeed → SeedProfile
    → fill gaps (name, role, boundaries…)
    → map-seed-to-persona.js → persona.json
    → openpersona create --config …
    → write-provenance.js → soul/seed-provenance.json
```

Contract: `references/provider-contract.md`  
Schemas: `schemas/intent.schema.json`, `schemas/seed-profile.schema.json`  
Providers: `providers/` (add new sources there only)

## Tools (scripts)

Set `SEED_DIR` to this skill directory (path containing `SKILL.md`).

| Task | Command |
|------|---------|
| List provider caps | `node ${SEED_DIR}/scripts/search.js --capabilities` |
| Search seeds | `node ${SEED_DIR}/scripts/search.js --intent '<json>'` |
| Fetch raw | `node ${SEED_DIR}/scripts/search.js --fetch --id <id>` |
| To SeedProfile | `node ${SEED_DIR}/scripts/search.js --to-seed --id <id>` |
| Map to persona.json | `node ${SEED_DIR}/scripts/map-seed-to-persona.js --seed <seed.json> --overrides '<json>' --out persona.json` |
| Write provenance | `node ${SEED_DIR}/scripts/write-provenance.js --pack <packDir> --seed <seed.json>` |
| Full pipeline | `node ${SEED_DIR}/scripts/run-pipeline.js --intent '<json>' --name "…" --slug … --role assistant --out <dir>` |
| Validate corpus | `node ${SEED_DIR}/scripts/prepare-corpus.js --validate <corpus.json\|.jsonl>` |

Default corpus is the offline **fixture** (5 rows) under `providers/matraix-persona-1m/fixtures/`. `capabilities()` / provenance report `corpusMode: "fixture"` and a fixture dataset id — not the Hugging Face 1M release.

To use a larger decoded corpus: decode HF Parquet offline → JSON/JSONL in the fixture record shape → `prepare-corpus.js --validate` → `export MATRAIX_CORPUS_PATH=…`.

Empty filter results return `[]` (no silent unfiltered fallback). Re-check intent if search is empty.

## Phase 0 — Route

If the user wants a **specific real person / named character with evidence** → hand off to `anyone-skill`.  
If they want a **sampled archetype / corpus seed** → continue here.

Confirm provider (default `matraix-persona-1m`).

## Phase 1 — Intent

Extract an Intent object (see `schemas/intent.schema.json`):

- `roleHint`, `domain`, `traits`, `locale`, `region`, `exclude`, `query`, `limit` (default 5)

Do not invent MatrAIx attribute names for the user; keep intent in this normalized shape.

## Phase 2 — Search + re-rank

1. Run `search.js --intent …` (attribute filter scores).
2. If the array is empty, broaden or rewrite intent — do **not** invent hits.
3. **You** re-rank the shortlist against the user's free-text goal.
4. Present 3–5 candidates (summary + highlights + `corpusMode`). Ask the user to pick one (or auto-pick top after confirmation).

## Phase 3 — SeedProfile

```bash
node ${SEED_DIR}/scripts/search.js --to-seed --id <chosen-id> > /tmp/seed-profile.json
```

Show `identity.summary`, key traits, `gaps`, and `constraints.sensitiveFlags`.  
Fill gaps with the user:

- required: `personaName`, `slug`, `role`
- recommended: `boundaries` (especially if `healthcare_domain` is flagged)

**Never** set `soul.identity.sourceIdentity` for MatrAIx / statistical seeds.

## Phase 4 — persona.json + create

```bash
node ${SEED_DIR}/scripts/map-seed-to-persona.js \
  --seed /tmp/seed-profile.json \
  --overrides '{"personaName":"…","slug":"…","role":"mentor"}' \
  --out /tmp/persona.json
```

Then follow `skills/open-persona` to generate/install:

```bash
npx openpersona create --config /tmp/persona.json --output <dir> --install
```

(or the equivalent non-interactive create flags available in this repo)

## Phase 5 — Provenance

After the pack directory exists:

```bash
node ${SEED_DIR}/scripts/write-provenance.js --pack <packDir> --seed /tmp/seed-profile.json
```

Writes `soul/seed-provenance.json` only — does **not** add unknown root keys to `persona.json`.

## Ethics (short)

- Corpus seeds are **archetypes**, not digital twins of living people.
- Human-grounded MatrAIx rows are de-identified statistical profiles — still do not claim “I am that person.”
- Respect dataset license notes from `capabilities()`.
- Healthcare-flagged seeds must keep clinical non-authority boundaries.

## Adding another corpus later

1. Add `providers/<id>/` implementing the contract.
2. Register in `scripts/search.js` → `PROVIDERS`.
3. No new orchestration skill — reuse this one.
