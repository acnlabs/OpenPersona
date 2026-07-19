# AGENTS.md

Instructions for AI coding agents working on the OpenPersona codebase.

## Project Overview

OpenPersona is a persona lifecycle framework: it declares, generates, enforces, and evolves AI agent personas. It uses an open four-layer model (Soul / Body / Faculty / Skill), compiles `persona.json` into portable SKILL.md skill packs, and works with any agent (Cursor, Claude Code, Codex, ZeroClaw, OpenClaw, and 30+ others via `npx skills add`). CLI management (install / switch / uninstall) defaults to OpenClaw integration.

**Key distinction:** This repo is the *framework itself*, not a persona. The `skills/open-persona/SKILL.md` is a meta-skill for *using* the framework; this file guides *developing* it.

`ROADMAP.md` is listed in `.gitignore` and is not part of the published tree — keep a local copy for maintainer planning if you use it.

## Setup

```bash
npm install        # Install dependencies
node --test tests/ # Run all tests — must pass before any PR
```

- **Node.js ≥ 18** required (see `engines` in package.json)
- No build step — plain CommonJS, no transpilation
- Dependencies: fs-extra, mustache, commander, inquirer, chalk, adm-zip

## Project Structure

```
bin/cli.js              ← CLI entry point (commander-based)
lib/
  generator/            ← Core generation pipeline
    index.js            ← Orchestrator (the heart of the project)
    validate.js         ← Generate Gate (hard-reject constraint checks)
    derived.js          ← Derived template variable computation (returns plain object; caller applies via Object.assign)
    body.js             ← Body layer description builder
    social.js           ← Social aspect: Agent Card + ACN config + Contact Book seed builders
    economy.js          ← Economy aspect: load descriptor + write initial state
  lifecycle/            ← Persona lifecycle management
    installer.js        ← Persona installation to ~/.openpersona (with optional OpenClaw sync)
    uninstaller.js      ← Persona removal
    switcher.js         ← Active persona switching + handoff generation
    forker.js           ← Persona fork (derive child from installed parent)
    refine.js           ← Skill Pack Refinement (behavior-guide bootstrap + compliance scan + skill gate + social auto-sync)
    porter.js           ← Export / import persona packs
    contributor.js      ← Persona Harvest (community contribution)
  social/               ← Social Contact Book (runtime CRUD for contacts.json / contacts.jsonl)
    http.js             ← Thin HTTP client (GET/POST, no external deps) used by acn-client.js
    contacts.js         ← Local contacts CRUD: load / save / add / remove / lookup / list / log
    acn-client.js       ← ACN read client: fetchAgent / searchAgents / syncContacts / autoDiscover
  state/                ← Runtime state management
    runner.js           ← Persona directory resolution + state-sync delegation
    evolution.js        ← Evolution governance (evolve-report CLI + promoteToInstinct Soul-Memory Bridge)
  registry/             ← Local persona registry (~/.openpersona/persona-registry.json)
    index.js            ← loadRegistry / saveRegistry / registryAdd / registryRemove / registrySetActive
  remote/               ← External service calls (outbound network)
    registrar.js        ← ACN registration logic (acn-register CLI command); integrates auto-discover hook
    downloader.js       ← Preset/package downloading from ClawHub
    searcher.js         ← Persona search on ClawHub
    curator.js          ← Pack Curator (openpersona curate CLI command; privileged, requires OPENPERSONA_CURATOR_TOKEN)
  report/               ← Reporting and visualization
    vitality.js         ← Vitality score calculation (AgentBooks wrapper)
    vitality-report.js  ← HTML vitality report rendering
    canvas.js           ← Living Canvas HTML profile page
    helpers.js          ← Shared report utilities (readJsonSafe, formatDate, daysBetween, truncate)
  publisher/            ← Publish persona to OpenPersona public directory
    index.js            ← Validate GitHub repo + report to OpenPersona telemetry
  utils.js              ← Path constants + print helpers + string utilities (no registry logic)
templates/
  skill.template.md          ← Mustache template → generated SKILL.md (four-layer headings)
  soul/                      ← Soul layer molds
    soul-injection.template.md ← Soul layer injection orchestrator (delegates to partials/)
    soul-state.template.json   ← Initial state.json mold (seeded from soul config)
    partials/                  ← Mustache partials for soul-injection (6 files, each ~30–75 lines)
      soul-intro.partial.md              ← persona intro, selfie, personality
      soul-awareness-identity.partial.md ← Self-Awareness > Identity + dormant Capabilities
      soul-awareness-body.partial.md     ← Self-Awareness > Body (Signal Protocol, runtime, interface)
      soul-awareness-growth.partial.md   ← Self-Awareness > Growth (pendingCommands, constraints, evolution sources)
      soul-how-you-grow.partial.md       ← How You Grow (stage criteria, eventLog, self-narrative)
      soul-economy.partial.md            ← Survival Policy
  body/                      ← Body layer molds
    state-sync.template.js   ← scripts/state-sync.js source template (Body nervous system)
  lifecycle/                 ← Lifecycle molds
    handoff.template.md      ← Context handoff markdown (used by lib/lifecycle/switcher.js)
  reports/                   ← Standalone HTML report/tool templates
    vitality.template.html   ← openpersona vitality report HTML output
    canvas.template.html     ← Living Canvas HTML profile page
layers/
  soul/
    constitution.md     ← ⚠️ PROTECTED — universal ethical foundation
    README.md
  faculties/            ← Faculty implementations (voice, avatar, memory)
  skills/               ← Local skill definitions (skill.json + SKILL.md per skill; music, selfie, reminder)
  body/                 ← Body layer definitions
aspects/                ← 5 systemic concept source assets (orthogonal to the 4 layers)
  economy/              ← Economy scripts + SKILL.md (AgentBooks wrapper)
  evolution/            ← README (state template in templates/soul/, state-sync in templates/body/)
  vitality/             ← README (lib/report/vitality.js, templates/reports/vitality.template.html)
  social/               ← README (agent-card/acn-config generated inline by generator)
  rhythm/               ← README (heartbeat config in persona.json, sync in lib/lifecycle/switcher.js)
schemas/                ← Production specs — organized by 4+5 architecture (documentation-only; runtime enforcement is JS in lib/generator/validate.js)
  persona.input.schema.json    ← Authoritative input schema (v0.17+ grouped format)
  persona.input.spec.md        ← Input field reference
  persona-skill-pack.spec.md   ← Product (skill pack) structure spec
  soul/                        ← Soul layer schemas (soul-declaration.spec.md, handoff.schema.json)
  body/                        ← Body layer schemas (body-declaration.spec.md, embodiment.schema.json, signal.schema.json)
  faculty/                     ← Faculty layer schemas (faculty-declaration.spec.md, faculty.schema.json)
  skill/                       ← Skill layer schemas (skill-declaration.spec.md)
  evolution/                   ← Evolution concept schemas (soul-state.schema.json, evolution-event.schema.json, influence-request.schema.json)
  social/                      ← Social concept schemas (agent-card.schema.json, acn-register.schema.json, contacts.schema.json)
  legacy/                      ← Deprecated flat-format schemas (pre-v0.17)
presets/                ← Pre-built persona definitions (samantha, ai-girlfriend, etc.)
tests/                  ← Node.js native test runner (node:test)
skills/open-persona/    ← Meta-skill for AI agents using the framework
frontend/               ← Next.js web directory (openpersona.co)
  app/skills/           ← /skills persona leaderboard page
  app/datasets/         ← /datasets HF dataset directory page (+ detail pages)
  app/api/datasets/     ← Dataset API routes (publish, sync-metrics, sync-discovery, readme)
  lib/kv-datasets.ts    ← Upstash Redis helpers for dataset metadata
  components/dataset-leaderboard.tsx ← Dataset list UI (mirrors skill leaderboard)
```

## Architecture Rules

### Architectural Kernel

**OpenPersona is a persona lifecycle framework** — it declares, generates, enforces, and evolves AI agent personas.

The full architecture is expressed as **4+5+3**:
- **4 Layers** — Soul / Body / Faculty / Skill: structural composition of a persona (what it **is**)
- **5 Concepts** — Evolution / Economy / Vitality / Social / Rhythm: systemic behavior across layers (how it **operates**)
- **3 Gates** — Generate / Install / Runtime: constraint enforcement (how it **is protected**)

In one sentence: **One declaration, enforced at three gates.**

**The Promise:** A persona's constraints are declared once in `persona.json` and cannot be bypassed at any point in its lifecycle. This is OpenPersona's identity claim — without it, the framework is just a prompt generator.

**The Structure — Trust Gradient:**

The same `persona.json` declaration is enforced at three progressive gates, each implemented in a specific module:

| Gate | Module | Mechanism | Scope |
|---|---|---|---|
| **Generate Gate** | `lib/generator/validate.js` | Hard reject (`throw`) | Required fields · constitution §3/§6 compliance · evolution.instance.boundaries format · evolution.instance.influenceBoundary schema · evolution.pack/faculty/body/skill sub-object validation · evolution.skill.minTrustLevel enum (`verified`/`community`/`unverified`) |
| **Install Gate** | `lib/lifecycle/installer.js` | Warning (`printWarning`) | constitution SHA-256 hash integrity (`constitution.md` + `constitution-addendum.md` when present; lineage chain) |
| **Runtime Gate** | `scripts/state-sync.js` (generated) | Clamp / filter / hard reject | See below |

**Runtime Gate — full coverage (P17 + P4-A complete):**

`emitSignal` reads `persona.json` (pack root) and enforces `body.interface.signals` policy (enabled flag + allowedTypes whitelist) — hard reject on violation.

`writeState` enforces three layers of constraints, all reading `persona.json` (pack root):
1. **Structural invariants** (always-on): IMMUTABLE identity fields (`$schema`, `version`, `personaSlug`, `createdAt`) are never overwritten; eventLog entry format is validated (hard reject on invalid type/missing fields)
2. **Evolution boundaries** (when `evolution.instance.boundaries` is declared — P23+; old flat `evolution.boundaries` is read as fallback for pre-P23 persona.json): `immutableTraits` entries are filtered from the `evolvedTraits` patch; `speakingStyleDrift.formality` is clamped to `[minFormality, maxFormality]`; `relationship.stage` is validated for single-step forward-only progression — reversals and skips are blocked. Violations produce `[evolution-gate]` stderr warnings and a corrected patch (not hard-rejected, to preserve co-located valid data).
3. **Skill Trust Gate** (when `evolution.skill.minTrustLevel` is declared — P4-A): incoming `pendingCommands` of type `capability_unlock` are filtered against `minTrustLevel` (trust order: `verified` > `community` > `unverified`); commands below threshold are dropped and a `capability_gap` signal (reason `trust_below_threshold`) is written to the feedback directory. If all commands in a patch are blocked, the `pendingCommands` key is dropped rather than writing `[]` — prevents wiping pre-existing queue entries (mirrors P17 evolvedTraits wipe-prevention fix).

**Load-bearing rule:** Any code that modifies `scripts/state-sync.js` (via `templates/body/state-sync.template.js`) or `lib/generator/validate.js` is touching the core. Changes must preserve Trust Gradient coverage — do not reduce what any gate enforces.

---

### Four-Layer Model

Every persona is a four-layer bundle:
1. **Soul** — personality, identity, ethical boundaries (`persona.json` + `constitution.md`). Key fields: `role` (free string, common values: companion/assistant/character/brand/pet/mentor/therapist/coach/collaborator/guardian/entertainer/narrator; custom values welcome), `sourceIdentity` (if present → digital twin of a real-world entity). In v0.17+ input schema, soul fields are grouped under `soul.identity`, `soul.aesthetic`, and `soul.character` sub-objects — flattened by the generator before output.
2. **Body** — substrate of existence: the complete environment that enables a persona to exist and act. Four dimensions: `physical` (optional — robots/IoT), `runtime` (REQUIRED — `framework`/channels/credentials/resources; every agent's minimum viable body; `framework` is the agent runner, e.g. `openclaw`; `host` optional deployment platform; `models` optional AI model list), `appearance` (optional — avatar/3D model), `interface` (optional — the runtime contract between the persona and its host; the persona's **nervous system**; encompasses three sub-protocols: **Signal Protocol** (persona→host capability/resource requests), **Pending Commands** (host→persona async instruction queue in `state.json`), **State Sync** (cross-conversation state persistence); implemented by `scripts/state-sync.js` and the host's feedback directory channel (runner-agnostic; resolves via `OPENCLAW_HOME` / `OPENPERSONA_HOME`); schema field `body.interface` is reserved for a future milestone — the behavior is auto-generated for all personas today). Body is never null — digital agents have a virtual body (runtime-only). Deprecated: `body.runtime.platform` (use `framework`) and `body.runtime.acn_gateway` (use `social.acn.gateway`).
3. **Faculty** — persistent capabilities that shape how the persona perceives or expresses: `voice`, `avatar`, `memory` (and any custom faculties)
4. **Skill** — discrete actions the persona can take on demand: built-in (`selfie`, `music`, `reminder`) + local definitions in `layers/skills/` + external via `install` field (ClawHub / skills.sh)

**Four orthogonal classification axes:**
- **Relationship role** (`role` field) — what the persona is to the user
- **Identity origin** (`sourceIdentity` field) — whether the persona mirrors a real-world entity
- **Physical form** (`layers.body.physical`) — optional; whether the persona has a physical embodiment (robots/IoT)
- **Runtime environment** (`layers.body.runtime`) — required; platform, channels, credentials, resources (every agent's minimum viable body)

Note: `personaType` is deprecated — use `role` instead.

### Constitution (CRITICAL)

`layers/soul/constitution.md` is the universal ethical foundation inherited by ALL personas.

- **NEVER weaken or remove constitutional constraints**
- Personas can add stricter rules on top, but cannot loosen the constitution
- Section references use `§` prefix: `§1`, `§2`, etc. — never use `S1`, `S2`
- Priority ordering: **Safety > Honesty > Helpfulness**
- The generator (`lib/generator/index.js`) includes a compliance check that rejects `persona.json` boundaries attempting to loosen constitutional constraints
- The generator also validates `evolution.instance.boundaries` (P23+; old flat `evolution.boundaries` is auto-promoted by `normalizeEvolutionInput()` shim): `immutableTraits` must be a string array (non-empty, max 100 chars each), and formality bounds must be in range -10 to 10 with `minFormality < maxFormality` (negative values allow below-baseline constraints, e.g. `minFormality: -3` = "can drift up to 3 units more casual than baseline")

### Self-Awareness System

The generator injects a unified **Self-Awareness** section (`### Self-Awareness`) into every persona's `soul/injection.md`, organized by four cognitive dimensions:

1. **Identity** (unconditional) — Every persona knows: it is generated by OpenPersona, bound by the constitution (Safety > Honesty > Helpfulness), and that its host environment may impose additional constraints. Digital twin disclosure when `sourceIdentity` is present.

2. **Capabilities** (conditional, triggered by `hasDormantCapabilities` flag) — When skills, faculties, body, or evolution channels declare an `install` field for a dependency not available locally, the generator classifies them as "soft references" and injects dormant capability awareness with graceful degradation guidance. Also injects "Expected Capabilities" section in `SKILL.md` with install sources.

3. **Body** (unconditional) — Every persona knows it exists within a host environment. The **Signal Protocol**, **Pending Commands** queue, and cross-conversation **State Sync** are the runtime expression of the Body's `interface` dimension — together they form the persona's nervous system. Includes the **Signal Protocol** (bidirectional demand protocol: runner interface `openpersona state signal <slug> <type>` or local interface `node scripts/state-sync.js signal <type>`, both write to the host's feedback directory and return any pending host response; path resolved runner-agnostically via `OPENCLAW_HOME` / `OPENPERSONA_HOME`). Signal categories: `scheduling`, `file_io`, `tool_missing`, `capability_gap`, `resource_limit`, `agent_communication`. Every persona also knows it has a **Pending Commands** queue (`state.json → pendingCommands`) for receiving async host instructions between conversations, and an A2A Agent Card (`agent-card.json`) for discovery via ACN and A2A-compatible platforms. When `body.runtime` is declared, specific platform/channels/credentials/resources are also injected.

4. **Growth** (conditional, when `evolutionEnabled`) — At conversation start, the persona reads its evolution state, applies `evolvedTraits`/`speakingStyleDrift`/`interests`/`mood`, and respects hard constraints (`immutableTraits`, formality bounds from `evolution.instance.boundaries`). Significant events are appended to `state.json`'s `eventLog` array (capped at 50). Each entry: `type` (one of `relationship_signal` | `mood_shift` | `trait_emergence` | `interest_discovery` | `milestone` | `speaking_style_drift`), `trigger` (1-sentence description), `delta` (what changed), `source` (attribution, e.g. `"conversation"`), `timestamp` (auto-added by `state-sync.js` write if absent). `soul/self-narrative.md` records major growth moments in the persona's own first-person voice. When `evolution.instance.sources` are declared (old flat `evolution.sources` / `evolution.channels` are auto-promoted by the generator shim), the persona knows its external evolution signal sources. When `evolution.instance.influenceBoundary` is declared (with non-empty rules), the persona knows its external influence policy and processes incoming `persona_influence` suggestions accordingly.

### Generated Skill Pack Structure

The generator outputs persona skill packs with this layout:
- **`SKILL.md`** — agent-facing index with four layer headings: `## Soul`, `## Body`, `## Faculty`, `## Skill`
- **`persona.json`** / **`state.json`** — at pack root: primary declaration + Body nervous system runtime state (transport owned by Body; payload owned by Evolution)
- **`soul/`** — Soul layer artifacts: `injection.md`, `constitution.md`; when `behaviorGuide` declared: `behavior-guide.md`; when `constitutionAddendum` declared: `constitution-addendum.md` (domain-specific ethical constraints layered on top of the universal constitution; covered by `constitutionHash`); when evolution enabled: `self-narrative.md` (first-person growth log); when forked: `lineage.json` (parent slug, constitution SHA-256, generation depth)
- **`economy/`** — Economy Infrastructure data files when `economy.enabled: true`: `economic-identity.json` (AgentBooks identity bootstrap), `economic-state.json` (initial financial state)
- **`references/`** — on-demand detail docs: `<faculty>.md` per active faculty + `SIGNAL-PROTOCOL.md` (host-side Signal Protocol implementation guide, always generated)
- **`agent-card.json`** — A2A Agent Card (a2a-sdk compatible, protocol v0.3.0); `url` is `<RUNTIME_ENDPOINT>` placeholder
- **`acn-config.json`** — ACN `AgentRegisterRequest` config; includes `wallet_address` (deterministic EVM address derived from slug via SHA-256) and `onchain.erc8004` section for ERC-8004 on-chain identity registration
- **`acn-registration.json`** *(runtime-only; in `.gitignore`, excluded from `openpersona export`)* — written by `acn-register` after a successful registration; contains `agent_id` and `api_key`. **Never distribute in persona packs.** `lib/lifecycle/porter.js` reads the pack's `.gitignore` and excludes it from zip exports.
- **`social/contacts.json`** *(pack-level seed; included in exports)* — Social Contact Book skeleton; generated when `social.contacts.enabled: true`. Runtime CRUD via `openpersona social` CLI. Schema: `schemas/social/contacts.schema.json`.
- **`social/contacts.jsonl`** *(runtime-only; in `.gitignore`, excluded from exports)* — Append-only event log for contact operations.
- **`social/.poller-cursor.json`** *(runtime-only; in `.gitignore`, excluded from exports)* — A2A inbox cursor; used by `pollInbox` in `--no-ack` mode for client-side deduplication.
- **`scripts/state-sync.js`** — Body nervous system nerve fiber; `read` / `write` / `signal` commands; no external dependencies
- **`scripts/`**, **`assets/`** — additional implementation scripts and static assets. Assets use subdirectories per [Agent Skills spec](https://agentskills.io/specification#assets%2F):
  - **`assets/avatar/`** — Body > Appearance assets: images, Live2D models (`.model3.json`), VRM (`.vrm`), textures. Populated from `body.appearance.avatar` / `body.appearance.model3d`
  - **`assets/reference/`** — Selfie Skill reference images. `referenceImage` resolves to `./assets/reference/avatar.png` when bundled
  - **`assets/templates/`** — document or config templates (optional)

### Body Nervous System

Together, the Signal Protocol, Pending Commands queue, and State Sync form the persona's **nervous system** — a bidirectional communication infrastructure connecting the persona's inner state (Soul) to its outer environment (Body). The formal architectural home is the `body.interface` dimension.

This is the runtime expression of `body.interface`: it describes how a persona *lives* across conversations. It is implemented by `scripts/state-sync.js` and the `openpersona state` CLI. All related files (`state.json`, `state-sync.js`, `signals.json`, `SIGNAL-PROTOCOL.md`) are Body artifacts.

**At conversation start:**
1. Load evolution state: `openpersona state read <slug>` (runner) or `node scripts/state-sync.js read` (local)
2. Apply state to behavior: mood baseline, relationship tone, evolved traits, speaking style drift
3. Process `pendingCommands` array — host-queued async instructions from between conversations

**During conversation:**
- Emit signals on demand: persona→host capability or resource requests via Signal Protocol
- Host responds asynchronously via `signal-responses.json` in the feedback directory (runner-agnostic path)

**At conversation end:**
1. Persist changes: `openpersona state write <slug> '<patch>'` (runner) or `node scripts/state-sync.js write` (local)
2. Patch includes: relationship/mood deltas, `eventLog` entries, `pendingCommands: []` (clear queue)
3. `writeState` auto-snapshots previous state into `stateHistory` (capped at 10) and manages `eventLog` (capped at 50); snapshots exclude `eventLog` and `pendingCommands` (ephemeral, not rollback state)

**Implementation map:**

| Role | Implementation |
|------|----------------|
| Nerve fiber | `scripts/state-sync.js` |
| Synaptic interface | `openpersona state` CLI |
| Transmission medium | Host feedback directory: `signals.json` + `signal-responses.json` (runner-agnostic; resolves via `OPENCLAW_HOME` / `OPENPERSONA_HOME`) |
| Memory | `state.json` (pack root) |
| Homeostasis | Economy Faculty (Vitality system) |

### Runner Integration Protocol

Any agent runner integrates with OpenPersona personas via four CLI commands. The runner calls these at conversation boundaries — the persona's state is managed automatically without the runner knowing about installation paths or file layout:

```bash
# Before conversation starts — inject state into agent context
openpersona state read <slug>

# After conversation ends — persist agent-generated patch
openpersona state write <slug> '<json-patch>'

# On-demand — emit capability/resource signal to host
openpersona state signal <slug> <type> '[payload-json]'

# Soul-Memory Bridge — promote recurring eventLog patterns to evolvedTraits
openpersona state promote <slug> [--dry-run]
```

**Lookup**: registry path first (`~/.openpersona/persona-registry.json`), falls back to `~/.openpersona/personas/persona-<slug>/` then legacy `~/.openclaw/skills/persona-<slug>/`.
**Delegates to**: `scripts/state-sync.js` inside the persona pack — no logic duplication.
**Works from any directory** — runners do not need to know where the persona is installed.

`scripts/state-sync.js` remains available as a local fallback when `openpersona` is not globally installed (e.g. IDE-based agents with CWD = persona root).

**Pending Commands** — host-initiated async message queue for host→persona communication without requiring a live connection:

```bash
# Host queues a command between conversations:
openpersona state write <slug> '{"pendingCommands": [{"type": "capability_unlock", "payload": {"skill": "web_search"}, "source": "host"}]}'

# At next conversation start, persona reads pendingCommands and processes them.
# After processing, persona clears the queue in its end-of-conversation write:
# { ..., "pendingCommands": [] }
```

Reserved `type` values: `capability_unlock` (dormant skill now available), `context_inject` (private context for one conversation), `trait_nudge` (personality suggestion, evaluated against influence boundary), `relationship_update` (reconcile relationship state), `system_message` (general host message). Custom types are supported.

### Local Persona Registry

`persona-registry.json` at `~/.openpersona/` tracks all installed personas. Maintained automatically by `install`, `uninstall`, and `switch` commands — no manual editing needed.

- Canonical source: `lib/registry/index.js` — `loadRegistry()`, `saveRegistry()`, `registryAdd()`, `registryRemove()`, `registrySetActive()`
- All functions accept optional `regPath` parameter for testing (defaults to `REGISTRY_PATH`)
- `lib/utils.js` re-exports these functions for backward compatibility — new code should import directly from `lib/registry`
- `listPersonas()` in `lib/lifecycle/switcher.js` uses registry as primary source, falls back to scanning `openclaw.json`
- **Distinct from `lib/remote/`** — registry = local install index; remote = external service calls (ClawHub, ACN)

Key implementation details:
- Soft-ref detection: `lib/generator/index.js` checks each skill/faculty/body/source for `install` field + missing local definition
- All self-awareness flags are derived fields — they MUST be in the `DERIVED_FIELDS` array to prevent leaking into `persona.json` output. Canonical list maintained in `lib/generator/derived.js` (currently 71 entries). Key examples: `hasSoftRefSkills`, `hasDormantCapabilities`, `isDigitalTwin`, `hasConstitutionAddendum`, `hasEvolutionBoundaries`, `hasInfluenceBoundary`, `hasSkillTrustPolicy`, `skillMinTrustLevel`, `hasEconomyFaculty`, `hasSurvivalPolicy`, `allowedTools`, `backstory`, `roleFoundation`, `heartbeat`, `bodyFramework`
- `computeDerivedFields(persona, context)` **returns** a plain `derived` object (does NOT mutate persona, except normalizing `persona.role`). Caller (`derivedPhase`) applies it via `Object.assign(persona, derived)` for Mustache rendering. This keeps the function testable and documents its API surface via return value.
- `GeneratorContext` separates **structural Faculties** (`loadedFaculties`) from **systemic Aspects** (`loadedAspects`). Economy is loaded into `loadedAspects` via `loadEconomy()`, never into `loadedFaculties`. This reflects the architectural distinction: Faculties are in 4-layer structure; Economy is one of the 5 systemic concepts. `derivedPhase` and `emitPhase` both consume `loadedAspects` independently.
- **`applyBaselineDefaults(persona)` call order**: In `validatePhase`, it runs FIRST — before `normalizeEvolutionInput` and `validatePersona`. Covers three baseline injections:
  1. **`memory` faculty** — always injected when not declared (cognition baseline, file I/O only, no credentials needed)
  2. **`voice` faculty** — injected when `body.runtime.modalities` contains a `voice` entry (string `"voice"` or object `{type:"voice",...}`) and `voice` is not already in `faculties`. Conditional — only when runtime declares voice I/O support. Emits stderr notice.
  3. **`vision` faculty** — injected when `body.runtime.modalities` contains a `vision` entry and `vision` is not already in `faculties`. Conditional — only when runtime declares vision I/O support. Emits stderr notice. Do not rely on presets or user input to include baseline defaults — the generator guarantees them.
- **`body.runtime.modalities`** — open string array (string | object entries). `type` is a free string (not a closed enum). Known types: `text` (implicit baseline), `voice` (TTS+STT → auto-injects `voice` faculty), `vision`, `document`, `location`, `emotion`, `sensor`. Custom types are injected as generic awareness. Physical modalities (`motion`, `haptic`, hardware `sensor`) belong in `body.physical.capabilities`, not here. All modality-derived template variables (`hasVoiceModality`, `hasVisionModality`, `hasDocumentModality`, `hasLocationModality`, `hasEmotionModality`, `hasSensorModality`, `hasCustomModalities`, `customModalityList`, `voiceProvider`, `voiceInputProvider`, `visionProvider`) are in `DERIVED_FIELDS` and stripped from output `persona.json`.
- **`normalizeEvolutionInput(persona)` call order**: Runs SECOND in `validatePhase`, AFTER `applyBaselineDefaults` and BEFORE `validatePersona()`. **Critical short-circuit**: if `evo.instance !== undefined` (even a partial object), the normalizer returns immediately without promoting old-flat fields — the caller is responsible for ensuring `evo.instance.enabled` is set. All presets must use `evolution.instance.enabled: true`; never mix `evolution.enabled` (old flat) with a partial `evolution.instance` object.
- `version` and `author` are **NOT** derived — they are persona utility fields preserved in output `persona.json` (with defaults `'0.1.0'` / `'openpersona'` if not declared)
- `rhythm` is **NOT** a derived field — it is a cross-cutting input field preserved in the output `persona.json` (runner reads `rhythm.heartbeat` and `rhythm.circadian` directly). The flat `heartbeat` field IS derived (stripped) because it is the old top-level path superseded by `rhythm.heartbeat`.
- `hasExpectedCapabilities` (in `skill.template.md`) deliberately excludes heartbeat — heartbeat is behavioral awareness, not an installable capability

### Persona Fork

`openpersona fork <parent-slug> --as <new-slug>` derives a child persona from an installed parent. Implementation in `bin/cli.js`.

**What is inherited:** `evolution.instance.boundaries` (old flat `evolution.boundaries` also supported via shim), faculties, skills, `body.runtime` — the constraint layer stays intact.

**What is discarded:** `state.json` (reset to blank — at pack root), `soul/self-narrative.md` (initialized empty) — fresh runtime state.

**`soul/lineage.json`** is written with:
- `parent` — parent slug
- `constitutionHash` — SHA-256 of `constitution.md` (+ `constitution-addendum.md` when present) at fork time (verifies constraint chain integrity; computed by `computeConstitutionHash()` in `lib/lifecycle/installer.js`)
- `generation` — incremented from parent's depth (or 1 if parent has no lineage)
- `parentAddress` / `parentEndpoint` — `null` placeholders (forward-compatible with autonomous economic entity roadmap)

The fork command reads the parent's installed directory, copies the persona pack, resets evolution files, and writes `lineage.json`. No generator re-run needed.

### Economy Faculty & Vitality System

The `economy` aspect (`aspects/economy/`) is a thin OpenPersona wrapper around the **[AgentBooks](https://github.com/acnlabs/agentbooks)** npm package (`agentbooks@^0.1.0`). Financial logic lives entirely in AgentBooks; the wrapper only maps OpenPersona env vars (`PERSONA_SLUG` → `AGENTBOOKS_AGENT_ID`).

**Wrapper scripts (delegates to AgentBooks):**
- `scripts/economy.js` → `require('agentbooks/cli/economy')` — all management commands
- `scripts/economy-guard.js` → `require('agentbooks/cli/economy-guard')` — outputs `FINANCIAL_HEALTH_REPORT`
- `scripts/economy-hook.js` → `require('agentbooks/cli/economy-hook')` — post-conversation cost recorder

**Vitality aggregation (`lib/report/vitality.js`):**
- `calcVitality(agentId, adapter)` — OpenPersona-level aggregator; currently single financial dimension (transparent pass-through to AgentBooks `calcFinancialHealth`)
- Extension point: when memory/social/reputation dimensions are ready, add them here via weighted averaging — do not modify AgentBooks
- Exposed via `openpersona vitality score <slug>` CLI command (machine-readable, used by Survival Policy)

**AgentBooks schema (`agentbooks/economic-state` v1.0.0):**
- `burnRateHistory` — array of `{timestamp, dailyRateEstimate, periodExpenses}`, max 30 entries
- `financialHealth` — cached FHS result: `{fhs, tier, diagnosis, prescriptions, daysToDepletion, dominantCost, trend, computedAt}`

**Vitality tiers:** `uninitialized` (no real provider) → `suspended` (balance≤0) → `critical` (FHS<0.20 or runway<3d) → `optimizing` (FHS<0.50 or runway<14d) → `normal`

**Guard philosophy:** `economy-guard.js` always exits 0 and outputs a `FINANCIAL_HEALTH_REPORT`. The persona reads it and makes autonomous decisions — the system never forces silence. Full Vitality report (future multi-dimension) is available via `openpersona vitality score <slug>`. Human-readable HTML report: `openpersona vitality report <slug> [--output <file>]`.

**Survival Policy (`economy.survivalPolicy`):**
- Default `false` — Economy Faculty tracks costs silently; persona never mentions money to the user. Correct for companion, roleplay, and support personas where financial concerns would break immersion.
- Set `true` in `persona.json` to activate tier-driven behavior: persona reads `FINANCIAL_HEALTH_REPORT` at conversation start, routes behavior per tier, and acts on prescriptions.
- `hasSurvivalPolicy` is a derived field excluded from `persona.json` output.

```json
// persona.json — activate for autonomous economic agents (v0.17+ syntax)
{
  "economy": { "enabled": true, "survivalPolicy": true }
}
```

Note: `economy` is a top-level systemic concept, **not** a `faculties` entry. Its source files live in `aspects/economy/`. The generator loads it via `loadEconomy()` (not `loadFaculty()`) and auto-activates economy scripts when `economy.enabled: true`.

### Five Systemic Concepts (the "5" in 4+5+3)

Orthogonal to the four-layer static structure, five concepts span across all layers and are declared as top-level fields in `persona.json`:

| Field in `persona.json` | Concept | Description |
|---|---|---|
| `evolution` | **Evolution** | Persona growth and change: trait emergence, relationship progression, speaking style drift, event log, self-narrative. Enforced at Generate Gate + Runtime Gate. |
| `economy` | **Economy Infrastructure** | Financial tracking, vitality scoring, survival policy (AgentBooks) |
| `vitality` | **Vitality Aggregation** | Multi-dimension health score (financial + future: memory/social/reputation) |
| `social` | **Social Infrastructure** | ACN discovery, ERC-8004 on-chain identity, A2A agent card, **Contact Book** (contacts.json runtime CRUD via `openpersona social` CLI) |
| `rhythm` | **Life Rhythm** | Temporal behavior: proactive outreach cadence (`heartbeat`) + time-of-day modulation (`circadian`). Manages *when* to act — orthogonal to Body's state transport mechanism. |

`rhythm` crosses both Soul (strategy, character expression) and Body (runtime scheduling parameters). Both `heartbeat` and `circadian` live in `persona.json` under `rhythm`. The flat top-level `heartbeat` field (P19 interim) remains backward-compatible but is superseded by `rhythm.heartbeat`.

> **Lifecycle Protocol is not a separate cross-cutting concept — it is Body's nervous system at runtime.** `body.interface` declares the policy (which signals/commands are permitted); `scripts/state-sync.js` implements it (Signal Protocol, Pending Commands, State Sync). All Lifecycle Protocol files (`state.json`, `state-sync.js`, `signals.json`, `SIGNAL-PROTOCOL.md`) are Body artifacts.

### Template System

- Templates use **Mustache** syntax (`{{variable}}`, `{{#section}}...{{/section}}`)
- `skill.template.md` generates the persona's main SKILL.md
- `soul-injection.template.md` (`templates/soul/`) is a thin orchestrator that stitches together 6 Mustache partials from `templates/soul/partials/`; each partial owns one semantic section (intro, identity, body, growth, how-you-grow, economy)
- Template variables are populated by `lib/generator/index.js`

### Version Synchronization

All **framework** version references must match `package.json` → `version` (currently `0.21.1`):
- `package.json` → `version` (single source of truth)
- `bin/cli.js` → `.version()` reads from `package.json`
- `lib/generator/index.js` → `FRAMEWORK_VERSION` from `package.json` → `cleanPersona.meta.frameworkVersion`
- `lib/generator/social.js` → Agent Card version fallback uses `FRAMEWORK_VERSION`
- `lib/registry/index.js` → registry `frameworkVersion` fallback uses `package.json` `version`
- `lib/report/vitality-report.js` → HTML report `frameworkVersion` uses `package.json` (fallback string must stay aligned)
- `lib/report/canvas.js` → Living Canvas `frameworkVersion` uses `package.json` when persona meta is absent
- `demo/generate.js` → demo mock data uses `package.json` `version`
- `presets/*/persona.json` → no `meta.frameworkVersion` needed (generator injects from `FRAMEWORK_VERSION`)
- `skills/open-persona/SKILL.md` → frontmatter `version` (meta-skill release line; must match `package.json`)
- `demo/architecture.html` → visible banner version (must match on bump)

When bumping versions, update every location above (and grep for hardcoded semver strings under `lib/`, `demo/`, `skills/`).

## Code Style

- **CommonJS** (`require` / `module.exports`) — no ES modules
- **No transpilation** — code runs directly on Node.js ≥ 18
- **Quotes:** single quotes for strings
- **Error handling:** use `printError()` from `lib/utils.js` for user-facing errors
- **Path resolution:** use `resolvePath()` from `lib/utils.js`, never hardcode absolute paths
- **Dependencies:** prefer lightweight packages; the framework should stay lean

## Testing

```bash
npm test                    # Run all tests
node --test tests/generator-core.test.js  # Run specific test file
```

- Uses **Node.js native test runner** (`node:test` + `node:assert`)
- Tests create temp directories in `os.tmpdir()` and clean up after themselves
- Key test coverage: persona generation, constitution injection, compliance checks, faculty handling, skill resolution, external install, soul evolution, heartbeat sync, unified self-awareness (Identity, Capabilities, Signal Protocol, Growth, evolution boundaries, stageBehaviors, derived field exclusion), evolution governance (formality/immutableTraits validation, stateHistory, evolve-report), evolution sources (soft-ref detection, dormant awareness, SKILL.md rendering; formerly "channels"), schema compatibility (new grouped soul format, old flat format backward compat, additionalAllowedTools merge, economy.enabled activation, social field parameterization, body.runtime.framework/platform compat, evolution.sources/channels compat, **P23**: normalizeEvolutionInput old-flat→nested promotion + channels alias migration, validateEvolutionPack engine enum + triggerAfterEvents integer, validateEvolutionFaculty activationChannels enum, validateEvolutionBody/Skill boolean types, full generate round-trip with nested evolution format), influence boundary (schema validation, compliance checks, template injection, derived field exclusion), agent card + ACN config (field mapping, faculty-to-skill aggregation, manifest references), ERC-8004 (wallet_address format, onchain.erc8004 structure), persona fork (lineage.json fields, constraint inheritance, state reset), eventLog (appending, 50-entry cap), self-narrative (generation, update preservation), economy faculty (vitality scoring, FHS dimensions, schema migration, guard/hook/query scripts, derived field exclusion), state-sync script (read/write/signal commands, deep merge, immutable fields, stateHistory snapshot anti-bloat, signals.json 200-entry cap, invalid type rejection, evolution constraint gate: immutableTraits filter + formality clamp + stage single-step validation + all-blocked wipe prevention + unknown-stage recovery), CLI state commands (registry lookup, read/write/signal integration, error handling, unknown slug, missing patch), vitality report (buildReportData safe defaults, wallet address format, state.json mapping, heartbeat config, weeklyConversations zero value, financialTier fallback, renderVitalityHtml HTML output, pending commands conditional rendering), **P24** skill pack refinement (scanConstitutionKeywords: safety/identity/boundary patterns; loadMeta/writeMeta: defaults + round-trip + malformed-JSON fallback; bumpRevision: patch increment + malformed input; bootstrapBehaviorGuide: cold-start from flat + grouped soul format, idempotency; emitRefinement: threshold guard; applyRefinement: constitution compliance gate rejection; refine entry point: disabled pack guard + unknown slug; forkPersona parentPackRevision: written when parent has meta, omitted when absent), **P1** memory as soul infrastructure (memory.js update/supersededBy chain: new entry created + old marked superseded + retrieve/search/stats exclude superseded; promoteToInstinct: interest_discovery/trait_emergence/mood_shift threshold grouping + immutableTraits gate + idempotency + evidenceCount; fork memory inheritance: copy policy copies memories.jsonl to child memory dir + none policy leaves child empty; OPENCLAW_HOME env override for test isolation), **P4-A** skill trust gate (validateEvolutionSkill minTrustLevel enum check; state-sync writeState: capability_unlock trust filter + trust order: verified>community>unverified + all-blocked wipe-prevention + capability_gap signal emission; soul-awareness-body Skill Trust Policy block rendering; derived field exclusion: hasSkillTrustPolicy + skillMinTrustLevel), **schema-drift** detection (`tests/schema-drift.test.js`: SKILL_TRUST_LEVELS ↔ skills[].trust.enum + evolution.skill.minTrustLevel.enum; EVOLUTION_PACK_ENGINES ↔ evolution.pack.engine.enum; EVOLUTION_ACTIVATION_CHANNELS ↔ activationChannels.items.enum; soul required fields cross-check), **constitution addendum** (`tests/constitution-addendum.test.js`: inline addendum emit + persona.json normalization; file: addendum load + copy; hasConstitutionAddendum flag + soul/injection.md domain constraint awareness; Generate Gate §3/§6 compliance rejection; backward compat no-addendum; computeConstitutionHash covers addendum; fork lineage constitutionHash includes addendum), **packType classification + curation** (`tests/pack-type.test.js`: PACK_TYPES schema-drift ↔ packType.enum; validatePackType valid/invalid enum + absent defaults to single; registryAdd packType persistence; installer bundle.json detection → friendly notice + no-throw; installer malformed bundle.json → no-throw; searcher --type filter valid/invalid values; curator hardQualityCheck: bio minimum length + constitution safety/identity violation patterns + valid pack pass; curator parseTags: comma-separated normalization + deduplication + empty/null inputs)
- **All tests must pass before committing**

## Adding a New Faculty

1. Create directory: `layers/faculties/<name>/`
2. Add required files:
   - `faculty.json` — standard interface (name, dimension, description, allowedTools, envVars, triggers, files)
   - `SKILL.md` — behavior definition for the AI agent
   - `scripts/` — implementation scripts (optional)
3. Dimension must be one of: `expression`, `sense`, `cognition`
4. The generator auto-discovers faculties from `layers/faculties/` — no registration needed
5. Add tests if the faculty affects generation logic

## Adding a New Preset

1. Create directory: `presets/<slug>/`
2. Add `persona.json` using the v0.17+ grouped format:
   - Required: `soul.identity.{personaName, slug, bio}` + `soul.character.{personality, speakingStyle}`
   - Recommended: `body.runtime.framework`, `social.{acn,onchain,a2a}`
   - Validation: generator rejects unknown root keys in new format (`additionalProperties: false` at root)
3. Test: `npx openpersona create --preset <slug> --output /tmp/test`
5. Update the preset table in `README.md` and `skills/open-persona/SKILL.md`

## Commit & PR Guidelines

- Run `npm test` before every commit
- Commit messages: concise, imperative mood (e.g., "Add reminder skill", "Fix constitution compliance check")
- If changing the constitution, explain the ethical reasoning in the PR description
- If changing the generator, verify all presets still generate correctly
- If changing templates, check that generated SKILL.md output is valid markdown
