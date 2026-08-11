# persona-seed

Population / corpus **seed providers** → OpenPersona persona packs.

One orchestration skill; pluggable adapters. First provider: **MatrAIx Persona 1M** (fixture by default; optional larger JSON corpus via `MATRAIX_CORPUS_PATH`).

## When to use

| Goal | Skill |
|------|--------|
| Distill a specific person / character from evidence | `anyone-skill` |
| Sample an archetype from a persona corpus | **`persona-seed`** |

## Quick start (agent)

1. Read `SKILL.md` and follow Phases 0–5.
2. One-shot pipeline (fixture):  
   `node scripts/run-pipeline.js --intent '{"domain":["software"],"traits":["precise"]}' --name "Nova" --slug nova-seed --out /tmp/nova-seed`
3. Or step-by-step: `search.js` → `--to-seed` → `map-seed-to-persona.js` → `openpersona create` → `write-provenance.js`
4. Larger corpus: decode HF → `prepare-corpus.js --validate` → `export MATRAIX_CORPUS_PATH=…`

## Layout

```
SKILL.md
schemas/           intent + SeedProfile
references/        provider contract
providers/         matraix-persona-1m + …
scripts/           search, map-seed-to-persona, write-provenance
```
