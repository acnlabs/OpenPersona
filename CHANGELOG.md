# Changelog

All notable changes to OpenPersona are documented here.

---

## [0.22.0] — 2026-07-19

### Added — Marketplace & gated delivery
- CLI buyer auth + gated private-pack delivery (`lib/remote/private-store.js`, auth helpers)
- Fork inherits root-creator lineage and records purchase provenance on install
- Market publish flow opens the sell page after upload; royalty-chain E2E walkthrough docs

### Added — Social / ACN
- Local contact book + ACN read sync
- Presence-aware agent-to-agent messaging, offline inbox polling, Contact Trust Gate
- ACN subnet management, broadcast messaging, heartbeat keepalive
- Transport declaration layer for A2A persistent connections

### Added — Signal Protocol loop
- `openpersona state responses <slug>` closes the host↔persona signal loop (`emitSignal` marks processed)
- Meta-skill + `AGENTS.md` document five state commands: read / write / signal / responses / promote

### Added — Persona quality tooling
- `persona-evaluator` skill (pack-content embedding, role-aware CLI, constitution gate hardening)
- Skill Install Trust Chain: constitution compliance pre-check on install
- `SKILL-RUBRIC` docs iterations + `validate-skills.mjs` wired into `npm test`

### Fixed
- Feedback directory resolution: explicit `OPENCLAW_HOME` / `OPENPERSONA_HOME` win over implicit `~/.openclaw` on both `refine.js` and `state-sync.template.js` (with regression tests)
- CI: retry Node test-runner IPC deserialize flakes up to 3 times; matrix `fail-fast: false`
- Porter respects pack `.gitignore` for runtime-sensitive export exclusions
- Curator / installer dotted-keys sync and related packaging fixes

### Maintainer
- `scripts/setup-r2-global.mjs` for Cloudflare R2 private-pack smoke setup
- `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` as **devDependencies** (lean published CLI; lazy-require in private-store unchanged)

---

## [0.21.1] — 2026-04-19

### Fixed — post-v0.21.0 audit remediation

**Critical**
- `openpersona skill update` was 100% broken. `lib/skill/updater.js` mis-used the downloader return value (`{ dir, skipCopy }`), treating the whole object as a path. Every `skill update` failed with a phantom "No SKILL.md found" error. Fixed to destructure `result.dir` correctly.
- `openpersona skill update` now prunes stale files. `fs.copy({ overwrite: true })` only replaces same-named entries — it did not remove files deleted in the new version. Now `fs.emptyDir(target)` runs before each copy so updates truly mirror the source.
- `openpersona skill install` no longer marks the skill as the active persona. Previously `registrySetActive(slug)` was called unconditionally, so installing any skill would overwrite the current active-persona marker, polluting `openpersona status`, `openpersona persona list`, and handoff generation. Skills are tools/instructions — not personas — and now stay out of the active-persona state entirely.

**High**
- `openpersona list` and `openpersona persona list` now filter out `resourceType === 'skill'` entries. Skill packs and persona packs share `persona-registry.json` but are distinct resources; the persona listing no longer leaks skill entries.
- `openpersona skill install --all` now records every target directory in a new `installTargets[]` registry field. `openpersona skill uninstall` iterates over the full list and removes every location, eliminating orphaned files from multi-target installs.
- `lib/skill/uninstaller.js` legacy-fallback paths are now resolved at call time instead of module load time. Fixes incorrect cleanup when cwd changes between CLI invocation and uninstall.
- `openpersona install` / `persona install` / `skill install` now clean up the temporary download directory on every exit path (success, validation failure, installer error) — no more tmp residue under `$TMPDIR/openpersona-dl/`.

**Low / housekeeping**
- Cross-platform path segment checks: `installer.js` now normalizes `path.sep` before substring matching on `.agents/skills`, `.claude/skills`, `.cursor/skills`, `.hermes/skills` (prep for Windows support).
- Removed unused `bio` local in `installSkill`.
- `scripts/run-tests.js` now recurses into subdirectories so `tests/skill/*.test.js` is picked up by `npm test`. Previously the 29 v0.21.0 skill-lifecycle tests and the new v0.21.1 regression tests were silently skipped from the main test flow.

### Registry schema additions

`persona-registry.json` entries now carry:
- `installTargets: string[]` — every directory the resource was written to (new in 0.21.1)
- `installTarget: string` — primary / first install target (kept for backward compatibility; equals `installTargets[0]`)

Older entries without `installTargets` are still understood by `uninstallSkill` and `updateSkill` via a `[installTarget || path]` fallback.

### New tests

`tests/skill/skill-v0.21.1-fixes.test.js` adds 8 regression tests:
1. Installing a skill does not overwrite the current active persona.
2. `installSkill` records `installTargets[]` as an array (with a singleton `--runtime` case).
3. `resolveTargets({ all: true })` always includes `.agents/skills/<slug>/` and every entry is unique.
4. `uninstallSkill` removes every directory in `installTargets[]`, not just the primary.
5. `listPersonas()` excludes `resourceType === 'skill'` entries.
6. `updateSkill` honors the `{ dir }` downloader contract and overwrites every `installTargets[]` directory with fresh content.
7. `updateSkill` prunes files deleted between versions (no stale residue in the target).
8. `updateSkill` exits 1 when the downloader returns no directory.

### Test runner

`npm test` now runs **688 tests** across 116 suites (was 651 / 102 in 0.21.0 — the skill tests were previously orphaned from the main flow).

---

## [0.21.0] — 2026-04-19

### New: Unified CLI Architecture

OpenPersona now uses a fully symmetric resource-namespaced CLI (`kubectl`-style). All persona-ecosystem resources live under one entry point.

**New command namespaces:**

- `openpersona skill install/update/uninstall/list/search/publish/info` — full agent skill pack lifecycle
- `openpersona persona <action>` — namespace aliases for all 18 existing root persona commands
- `openpersona model install/publish` — stub (placeholder for v1.0 persona model registry)

**Smart root router:**

`openpersona install <target>` now auto-detects pack type and routes accordingly:
- Has `persona.json` → installs to `~/.openpersona/` (persona pack)
- Only `SKILL.md` → installs to `.agents/skills/` (skill pack)

**New flags on `openpersona install` and `openpersona skill install`:**
- `--runtime=<claude|cursor|openclaw|hermes|openpersona>` — install to a specific agent's skill dir
- `--global` — install to `~/.agents/skills/` (user-global AGENTS.md convention)
- `--all` — mirror to all detected runtime dirs in CWD

**Default skill install target:** `.agents/skills/<slug>/` — the AGENTS.md universal convention, auto-discovered by Cursor, Claude Code, and OpenClaw without extra configuration.

### New Modules

- `lib/skill/installer.js` — skill installer with multi-target support
- `lib/skill/uninstaller.js` — skill uninstaller (registry-based installTarget lookup)
- `lib/skill/updater.js` — skill updater (re-downloads from recorded source URL)
- `lib/skill/publisher.js` — skill publisher (POST to openpersona.co/api/skills/publish; graceful fallback if endpoint not yet live)
- `lib/skill/searcher.js` — skill searcher (queries openpersona.co/api/skills; graceful 404 fallback)

### Registry Changes

- `lib/registry/index.js` `registryAdd()` now accepts an `opts` object with:
  - `installTarget` — absolute path where the skill/persona was installed (used by `uninstall` and `update`)
  - `source` — original GitHub owner/repo or local path
  - `resourceType` — `'persona'` (default) or `'skill'`
- All new skill installs record `installTarget` for reliable uninstall/update

### Behavior Change

- `openpersona install <SKILL.md-only pack>` now installs to `.agents/skills/` (was: `~/.openpersona/`)
- This was undocumented behavior; existing persona-pack installs are unchanged

### Documentation

- `skills/open-persona/SKILL.md` — companion skill install commands updated from `npx skills add` to `openpersona skill install`
- `skills/brand-persona-skill/README.md` — updated install instructions
- `README.md` — new "Unified Command Surface" section with migration guide
- `skills/open-persona/SKILL.md` version bumped to 0.21.0

### Tests

- Added `tests/skill/skill-lifecycle.test.js` with 29 new test cases
- Total: 680 tests, 0 failures (was 651)

### Accumulated since 0.20.0

- `skills/secondme-skill/` — SecondMe persona skill pack integration
- `skills/entrepreneur-skill/` — Entrepreneur persona skill pack
- `skills/brand-persona-skill/` — Brand agent meta-skill (distill any commercial entity into an agent)
- `openpersona dataset install/publish` — HuggingFace persona dataset directory
- MLX and Unsloth training backends in persona-model-trainer
- Curator normalization improvements (`lib/remote/curator.js`)
- Publisher fetch timeout fix (`lib/publisher/index.js`) — 10s hard limit prevents indefinite hanging
- npm package size reduced from 33.4MB to 234kB via `package.json files[]` allowlist

---

## [0.20.0] and earlier

See git log for earlier changes.
