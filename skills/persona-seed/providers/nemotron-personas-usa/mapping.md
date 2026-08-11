# nemotron-personas-usa → SeedProfile

Source: [`nvidia/Nemotron-Personas-USA`](https://huggingface.co/datasets/nvidia/Nemotron-Personas-USA)  
Family: `attribute-census`

## Field map

| SeedProfile | Nemotron field(s) |
|-------------|-------------------|
| `identity.summary` | `persona` (fallback: `professional_persona`) |
| `identity.occupation` | `occupation` |
| `identity.education` | `education_level` (+ `bachelors_field` when present) |
| `identity.region` | `city`, `state`, `country` joined |
| `identity.ageBracket` | derived from `age` |
| `identity.locale` | `["en"]` for USA rows |
| `character.traits` | light keywords from persona texts (optional) |
| `character.interests` | `hobbies_and_interests_list` (split on `;` / `,`) |
| `character.motivations` | `career_goals_and_ambitions` (single entry) |
| `capabilities.skills` / `tools` | `skills_and_expertise_list` |
| `capabilities.domains` | occupation / bachelor field tokens |
| `evidence.rawDescriptions` | persona + professional_persona + cultural_background |
| `constraints.sensitiveFlags` | `healthcare_domain` when occupation/persona mentions clinical/medical |

## Corpus

- Default: offline fixture (5 rows)
- External: `NEMOTRON_CORPUS_PATH` → JSON array or `.jsonl` of raw Nemotron rows
