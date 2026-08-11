# Seed providers

Adapters that turn corpus rows into `SeedProfile`. Orchestration: `../SKILL.md`. Contract: `../references/provider-contract.md`.

**Source of truth for what is seed-capable:** [`registry.json`](./registry.json)

| Provider id | Family | Status | HF repos |
|-------------|--------|--------|----------|
| `matraix-persona-1m` | attribute-census | ga | `MatrAIx2026/MatrAIx_Persona_1M` |
| `nemotron-personas-usa` | attribute-census | ga | `nvidia/Nemotron-Personas-USA` |

Keep `seed-capable.public.json` in sync when adding `hfRepos` (mirror into the frontend repo’s `lib/persona-seed-capable.json` for `/datasets` badges).

`openpersona.co/datasets` may list many more corpora. Only registry rows are usable with persona-seed.

## Add a provider

1. Implement `providers/<id>/provider.js` (`capabilities`, `search`, `fetch`, `toSeed`).
2. Prefer reusing a **family** module when the schema matches an existing adapter.
3. Register in `registry.json` (`hfRepos`, `directoryUrls`, `status`).
4. Keep an offline fixture for tests.
