# Seed providers

Each directory is one **Persona Seed** adapter. Orchestration lives in `../SKILL.md`; providers only implement the contract in `../references/provider-contract.md`.

| Provider id | Status | Notes |
|-------------|--------|-------|
| `matraix-persona-1m` | v1 | Attribute filter + fixture corpus; set `MATRAIX_CORPUS_PATH` for a larger decoded JSON array |

## Add a provider

1. Copy `matraix-persona-1m/` as a template.
2. Implement `capabilities`, `search`, `fetch`, `toSeed` in `provider.js`.
3. Register in `../scripts/search.js` → `PROVIDERS`.
4. Keep a tiny offline fixture for tests.
