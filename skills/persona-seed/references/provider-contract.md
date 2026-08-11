# Persona Seed — Provider Contract

All corpus / population sources implement the same interface. MatrAIx Persona 1M is the first provider; new sources add an adapter under `providers/<id>/` only.

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

## Adding a provider

1. Create `providers/<id>/provider.js` exporting `{ capabilities, search, fetch, toSeed }`.
2. Document field mapping in `providers/<id>/mapping.md`.
3. Register the id in `scripts/search.js` `PROVIDERS` map.
4. Add a small fixture so offline tests pass without network.
