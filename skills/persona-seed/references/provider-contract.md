# Persona Seed — Provider Contract

`/datasets` discovers Hugging Face corpora. **persona-seed** consumes only sources listed in `providers/registry.json`. MatrAIx is the first `attribute-census` provider — not a special-case architecture.

## Registry

`providers/registry.json` maps:

- `id` → provider module
- `family` → schema family (`attribute-census` | `persona-card` | `dialogue-extract` | `generic-hf`)
- `hfRepos[]` → Hugging Face dataset ids (one provider may cover many repos with the same schema)
- `directoryUrls[]` → optional openpersona.co/datasets links
- `status` → `ga` | `experimental` | `planned`

```bash
node scripts/search.js --list-providers
node scripts/search.js --seed-capable
node scripts/search.js --repo MatrAIx2026/MatrAIx_Persona_1M --capabilities
```

Publishing to `/datasets` does **not** register a seed provider. Add a registry entry + module first.

## Interface

| Method | Input | Output |
|--------|-------|--------|
| `capabilities()` | — | `{ id, name, licenseNotes, offline?, dataset? }` |
| `search(intent)` | Intent object (`schemas/intent.schema.json`) | `Candidate[]` (3–10 summaries) |
| `fetch(id)` | provider-local record id | raw record (provider-shaped) |
| `toSeed(raw)` | raw record | `SeedProfile` (`schemas/seed-profile.schema.json`) |

### Candidate shape

```json
{
  "id": "provider-local-id",
  "provider": "matraix-persona-1m",
  "summary": "One-line human-readable blurb",
  "highlights": { "region": "…", "traits": ["…"], "domain": ["…"] },
  "score": 0.0
}
```

`score` is the **attribute-filter** score. The orchestrating agent may re-rank candidates against the user's free-text request before asking the user to pick.

## Rules

1. Providers never write `persona.json` or call the generator.
2. Providers never set OpenPersona `sourceIdentity` for statistical / synthetic corpora.
3. Sensitive or weakly evidenced attributes go into `constraints.sensitiveFlags` or are omitted — not silently asserted as facts.
4. `toSeed` must populate `gaps` for anything the shared mapper cannot invent (at least `personaName`, `slug`, `role` when absent).
5. Provenance is written by `scripts/write-provenance.js` to `soul/seed-provenance.json` after pack generation (not as a `persona.json` root key).
6. Prefer **one module per schema family**; register multiple `hfRepos` when schemas align.

## Adding a provider

1. Create `providers/<id>/provider.js` exporting `{ capabilities, search, fetch, toSeed }`.
2. Document field mapping in `providers/<id>/mapping.md`.
3. Add an entry to `providers/registry.json` (id, family, module, hfRepos, status).
4. Add a small fixture so offline tests pass without network.
5. Do **not** edit a hard-coded map in `search.js` — resolution is registry-driven.
