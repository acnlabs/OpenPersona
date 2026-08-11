# matraix-persona-1m → SeedProfile

MatrAIx Persona 1M stores ~1,290 categorical attributes (packed in the HF release). This adapter maps only a **high-signal subset** into `SeedProfile`. Full 1,290 → OpenPersona dump is intentionally unsupported.

## Attribute → SeedProfile

| SeedProfile path | MatrAIx / fixture fields | Notes |
|------------------|--------------------------|-------|
| `identity.summary` | record `description` or composed blurbs | Prefer source NL description |
| `identity.region` | `region` | Soft filter + display |
| `identity.ageBracket` | `age_bracket` | Optional |
| `identity.occupation` | `occupation` | Optional |
| `identity.education` | `highest_education` | Optional |
| `identity.locale` | `primary_language` | Normalized to short tags when possible |
| `character.traits` | `personality_traits` | Cap ~12 |
| `character.values` | `values` | |
| `character.motivations` | `motivations` | |
| `character.speakingHints` | `speaking_style_hints` | Hints only; mapper writes final `speakingStyle` |
| `character.interests` | `interests` | |
| `character.riskTolerance` | `risk_tolerance` | Pass-through string |
| `character.formalityBaseline` | `communication_formality` | Mapped to rough -5..5 |
| `capabilities.domains` | `occupation_domain` | Array of one+ |
| `capabilities.skills` / `tools` | `tools` + occupation keywords | Suggestions only |
| `constraints.sensitiveFlags` | healthcare / political / etc. domains | When domain is Healthcare → flag |
| `constraints.suggestedImmutableTraits` | defaults | Always include `honest` at minimum |
| `evidence.attributeHighlights` | selected decoded field=value | Audit trail |
| `gaps` | — | Always include `personaName`, `slug`, `role`, `boundaries` |

## Defaults / non-goals

- Do **not** set OpenPersona `sourceIdentity` (archetype / synthetic seed).
- Do **not** invent `personaName` in the adapter; leave for agent + user.
- Full HF parquet decode is v2; v1 uses fixtures or a decoded JSON corpus path via `MATRAIX_CORPUS_PATH`.

## Dataset / corpusMode

| Mode | When | `provenance.dataset` |
|------|------|----------------------|
| `fixture` | default (no `MATRAIX_CORPUS_PATH`) | `persona-seed/providers/matraix-persona-1m/fixtures/sample-corpus` |
| `external` | `MATRAIX_CORPUS_PATH` set | `MatrAIx2026/MatrAIx_Persona_1M` (caller-supplied decoded rows) |

- Public coreset on HF: `MatrAIx2026/MatrAIx_Persona_1M` (~1M rows) — not loaded until decoded into the fixture-shaped JSON array
- Full 8.3B: controlled access — out of scope for this provider id
- Search never falls back to an unfiltered corpus when filters match nothing (`[]`)
