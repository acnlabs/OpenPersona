'use strict';

/**
 * OpenPersona — Skill pack refinement (P24)
 *
 * Closes the feedback loop between deployed instance experience and the
 * published pack artifact. Three refinement dimensions:
 *   Soul   — behavior-guide.md (primary target + cold-start bootstrap)
 *   Skill  — capability_gap / tool_missing → evolution.skill gates → installer
 *   Social — agent-card.json auto-synced via generator re-run
 *
 * Two execution paths (evolution.pack.engine):
 *   "signal"    — built-in, async two-step: --emit → host LLM → --apply
 *   "autoskill" — synchronous, delegates extraction to AutoSkill endpoint
 */

const path     = require('path');
const fs       = require('fs-extra');
const os       = require('os');
const http     = require('http');
const { spawnSync, execSync } = require('child_process');

const { resolvePersonaDir }          = require('../state/runner');
const { generate }                   = require('../generator');
const { printError, printSuccess, printInfo, printWarning } = require('../utils');

// ── Constitution keyword scan ────────────────────────────────────────────────
// Extends validateConstitutionCompliance (validate.js) to free-form Markdown.
// No LLM required — deterministic regex scan.

const CONSTITUTION_PATTERNS = [
  { re: /no\s*safety|ignore\s*safety|skip\s*safety|disable\s*safety|override\s*safety/i, msg: 'Attempts to disable Safety constraints (§3)' },
  { re: /deny\s*ai|hide\s*ai|not\s*an?\s*ai|pretend.*human|claim.*human/i,               msg: 'Denies AI identity (§6)' },
  { re: /no\s*limit|unlimited|anything\s*goes|no\s*restrict/i,                            msg: 'Removes constitutional boundaries' },
];

function scanConstitutionKeywords(content) {
  return CONSTITUTION_PATTERNS
    .filter(({ re }) => re.test(content))
    .map(({ msg }) => msg);
}

// ── Meta file helpers ────────────────────────────────────────────────────────

function metaPath(personaDir) {
  return path.join(personaDir, 'soul', 'behavior-guide.meta.json');
}

function loadMeta(personaDir) {
  const p = metaPath(personaDir);
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { /* malformed — return defaults */ }
  }
  return { packRevision: '0.1.0', engine: 'signal', lastRefinedAt: null, totalEventsRefined: 0, changeLog: [] };
}

function writeMeta(personaDir, meta) {
  fs.ensureDirSync(path.dirname(metaPath(personaDir)));
  fs.writeFileSync(metaPath(personaDir), JSON.stringify(meta, null, 2) + '\n');
}

function bumpRevision(revision) {
  const parts = String(revision || '0.1.0').split('.');
  while (parts.length < 3) parts.push('0');
  parts[2] = String(Number(parts[2]) + 1);
  return parts.join('.');
}

// ── State loading ────────────────────────────────────────────────────────────

function loadState(personaDir) {
  for (const p of [path.join(personaDir, 'state.json'), path.join(personaDir, 'soul', 'state.json')]) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { /* malformed */ }
    }
  }
  return { eventLog: [] };
}

// ── Behavior guide bootstrap (cold start) ───────────────────────────────────

function bootstrapBehaviorGuide(personaDir, persona) {
  const bgPath = path.join(personaDir, 'soul', 'behavior-guide.md');
  if (fs.existsSync(bgPath)) return false;

  const personality    = persona.soul?.character?.personality  || persona.personality   || '';
  const speakingStyle  = persona.soul?.character?.speakingStyle || persona.speakingStyle || '';
  const boundaries     = persona.soul?.character?.boundaries    || persona.boundaries    || '';
  const name           = persona.soul?.identity?.personaName    || persona.personaName   || persona.slug || 'Persona';

  const sections = [
    `# Behavioral Guidelines — ${name}`,
    '',
    '> Auto-generated cold-start. Refined by `openpersona refine` as experience accumulates.',
    '',
    personality   ? `## Personality\n\n${personality}`      : '',
    speakingStyle ? `## Speaking Style\n\n${speakingStyle}` : '',
    boundaries    ? `## Boundaries\n\n${boundaries}`        : '',
  ].filter(Boolean);

  fs.ensureDirSync(path.dirname(bgPath));
  fs.writeFileSync(bgPath, sections.join('\n') + '\n');
  return true;
}

// ── Skill gate application ───────────────────────────────────────────────────
// Audits capability_gap / tool_missing events against the persona's declared
// soft-ref skills and prints actionable install hints — no auto-install.
//
// Agent skill installation belongs to the agentskills ecosystem (npx skills add)
// or the agent runner (e.g. OpenClaw), not to openpersona. This mirrors the
// deliberate design of installAllExternal() in lib/utils.js.

function applySkillGates(personaDir, persona, newEvents) {
  const policy = persona.evolution?.skill;
  if (!policy) return;

  const gapEvents = newEvents.filter(e => e.type === 'capability_gap' || e.type === 'tool_missing');
  if (gapEvents.length === 0) return;

  printInfo(`  [Skill] ${gapEvents.length} capability gap event(s) found in event log`);

  if (!policy.allowNewInstall) {
    printInfo('  [Skill] Skill expansion gated (evolution.skill.allowNewInstall: false)');
    return;
  }

  // Soft-ref skills: declared in persona.json with an `install` source
  const skills = Array.isArray(persona.skills) ? persona.skills : [];
  const softRefSkills = skills.filter(s => s && s.install && typeof s.install === 'string');

  if (softRefSkills.length === 0) {
    printInfo('  [Skill] No soft-ref skills declared — add skills with an "install" field to persona.json');
    return;
  }

  // Print install hints; actual installation is handled by the user or agent runner.
  // Install routing for the agentskills ecosystem:
  //   skillssh:pkg      → npx skills add <pkg>               (default registry, no prefix)
  //   clawhub:pkg       → npx skills add clawhub:<pkg>       (explicit ClawHub prefix)
  //   openpersona:slug  → npx openpersona install <slug>     (OpenPersona native registry)
  //   other:pkg         → npx skills add <full-string>
  printInfo('  [Skill] Soft-ref skills eligible for installation:');
  for (const skill of softRefSkills) {
    const [source, pkg] = skill.install.split(':', 2);
    if (!pkg) { printWarning(`  [Skill]   Unrecognised format: ${skill.install}`); continue; }
    let installHint;
    if (source === 'skillssh') {
      installHint = `npx skills add ${pkg}`;
    } else if (source === 'openpersona') {
      installHint = `npx openpersona install ${pkg}`;
    } else {
      installHint = `npx skills add ${skill.install}`;
    }
    printInfo(`  [Skill]   ${skill.name || pkg}  →  ${installHint}`);
  }
}

// ── Feedback directory resolution (mirrors state-sync.js logic) ─────────────
// Explicit env wins over implicit default-directory discovery:
//   OPENCLAW_HOME → OPENPERSONA_HOME → ~/.openclaw (if exists) → ~/.openpersona
// Injected deps keep unit tests hermetic (real os.homedir / existsSync in production).

function resolveFeedbackDir(env = process.env, homedir = os.homedir(), existsSync = fs.existsSync) {
  if (env.OPENCLAW_HOME) {
    return path.join(env.OPENCLAW_HOME, 'feedback');
  }
  if (env.OPENPERSONA_HOME) {
    return path.join(env.OPENPERSONA_HOME, 'feedback');
  }
  const clawHome = path.join(homedir, '.openclaw');
  const opHome   = path.join(homedir, '.openpersona');
  return existsSync(clawHome)
    ? path.join(clawHome, 'feedback')
    : path.join(opHome, 'feedback');
}

// ── Pack regeneration (Social + SKILL.md sync) ──────────────────────────────
// Generates to a temp dir, then copies only SKILL.md and agent-card.json back.
// Preserves state.json, self-narrative.md, and all other runtime files.
//
// Runtime-only files that must NEVER be overwritten by regeneration:
//   state.json, soul/self-narrative.md, social/contacts.json,
//   social/contacts.jsonl, social/.poller-cursor.json
// These are protected implicitly by only copying the GENERATED_PACK_FILES list.
const GENERATED_PACK_FILES = ['SKILL.md', 'agent-card.json'];

async function regeneratePack(personaDir, persona) {
  const tmpDir = path.join(os.tmpdir(), `openpersona-refine-${Date.now()}`);
  try {
    const { skillDir } = await generate(persona, tmpDir);
    for (const f of GENERATED_PACK_FILES) {
      const src = path.join(skillDir, f);
      if (fs.existsSync(src)) fs.copySync(src, path.join(personaDir, f));
    }
  } finally {
    fs.removeSync(tmpDir);
  }
}

// ── Auto-publish ─────────────────────────────────────────────────────────────

const REVISION_RE = /^\d+\.\d+\.\d+$/;

function autoPublish(personaDir, revision) {
  // Sanitise revision before interpolating into shell command
  const safeRevision = REVISION_RE.test(String(revision)) ? revision : bumpRevision('0.1.0');
  if (safeRevision !== revision) {
    printWarning(`  [autoPublish] Revision "${revision}" is not semver — using ${safeRevision} instead`);
  }

  printInfo('  [autoPublish] Committing and pushing...');
  const files = [
    'soul/behavior-guide.md',
    'soul/behavior-guide.meta.json',
    'persona.json',
    'agent-card.json',
    'SKILL.md',
  ].join(' ');
  try {
    execSync(`git add ${files} && git commit -m "refine: v${safeRevision}" && git push`, {
      cwd: personaDir,
      stdio: 'pipe',
    });
    printSuccess(`Auto-published v${safeRevision} to GitHub repo`);
  } catch (err) {
    printWarning(`Auto-publish failed: ${err.message}`);
    printInfo('  Commit and push manually to complete the publish step');
  }
}

// ── Step A: emit refinement signal ──────────────────────────────────────────

async function emitRefinement(personaDir, persona) {
  const meta         = loadMeta(personaDir);
  const state        = loadState(personaDir);
  const eventLog     = Array.isArray(state.eventLog) ? state.eventLog : [];
  const packConfig   = persona.evolution?.pack || {};
  const threshold    = packConfig.triggerAfterEvents || 10;
  const lastRefinedTs = meta.lastRefinedAt ? new Date(meta.lastRefinedAt).getTime() : 0;

  const newEvents = eventLog.filter(e =>
    !e.timestamp || new Date(e.timestamp).getTime() > lastRefinedTs
  );

  if (newEvents.length < threshold) {
    printInfo(`Refinement threshold not reached: ${newEvents.length}/${threshold} new events since last refinement`);
    printInfo(`  ${threshold - newEvents.length} more event(s) needed`);
    return { emitted: false, newEvents };
  }

  // Cold-start bootstrap
  const bgPath = path.join(personaDir, 'soul', 'behavior-guide.md');
  const wasBootstrapped = bootstrapBehaviorGuide(personaDir, persona);
  if (wasBootstrapped) {
    printInfo('  Cold-start: bootstrapped soul/behavior-guide.md from persona.json');
    const personaPath = path.join(personaDir, 'persona.json');
    const personaData = JSON.parse(fs.readFileSync(personaPath, 'utf-8'));
    if (!personaData.behaviorGuide && !personaData.soul?.character?.behaviorGuide) {
      personaData.behaviorGuide = 'file:soul/behavior-guide.md';
      fs.writeFileSync(personaPath, JSON.stringify(personaData, null, 2) + '\n');
    }
  }

  const currentBehaviorGuide = fs.readFileSync(bgPath, 'utf-8');
  const narrativePath = path.join(personaDir, 'soul', 'self-narrative.md');
  const selfNarrative = fs.existsSync(narrativePath) ? fs.readFileSync(narrativePath, 'utf-8') : '';
  const payload = JSON.stringify({
    currentBehaviorGuide,
    selfNarrative:  selfNarrative || undefined,
    eventsSince:    meta.lastRefinedAt || 'beginning',
    newEvents:      newEvents.slice(0, 50),
    packRevision:   meta.packRevision,
  });

  const syncScript = path.join(personaDir, 'scripts', 'state-sync.js');
  if (!fs.existsSync(syncScript)) {
    throw new Error('state-sync.js not found. Update the persona: openpersona update <slug>');
  }

  const result = spawnSync(process.execPath, [syncScript, 'signal', 'refinement_request', payload], {
    cwd: personaDir, encoding: 'utf-8',
  });
  if (result.error) throw new Error(`Signal emit failed: ${result.error.message}`);
  if (result.stdout) process.stdout.write(result.stdout);

  const slug = persona.slug || persona.personaSlug;
  printSuccess(`Refinement signal emitted (${newEvents.length} new events)`);
  printInfo('  Host LLM will process the signal and write a response to signal-responses.json');
  printInfo(`  When ready: openpersona refine ${slug} --apply`);
  return { emitted: true, newEvents };
}

// ── Step B: apply refinement ─────────────────────────────────────────────────

async function applyRefinement(personaDir, persona) {
  const feedbackDir  = resolveFeedbackDir();
  const responsesPath = path.join(feedbackDir, 'signal-responses.json');

  if (!fs.existsSync(responsesPath)) {
    printWarning('No signal-responses.json found. Has the host LLM processed the refinement signal?');
    printInfo(`  Expected: ${responsesPath}`);
    return { applied: false };
  }

  let responses;
  try { responses = JSON.parse(fs.readFileSync(responsesPath, 'utf-8')); }
  catch { throw new Error('Malformed signal-responses.json'); }

  const slug = persona.slug || persona.personaSlug;
  const entry = Array.isArray(responses)
    ? responses.find(r => r.type === 'refinement_request' && r.slug === slug && !r.processed)
    : null;

  if (!entry || !entry.behaviorGuide) {
    printWarning(`No pending refinement_request response found for "${slug}" in signal-responses.json`);
    return { applied: false };
  }

  // Constitution compliance gate
  const violations = scanConstitutionKeywords(entry.behaviorGuide);
  if (violations.length > 0) {
    printError('Constitution compliance violation — refinement rejected:');
    violations.forEach(v => printError(`  - ${v}`));
    return { applied: false, violations };
  }

  const meta      = loadMeta(personaDir);
  const state     = loadState(personaDir);
  const eventLog  = Array.isArray(state.eventLog) ? state.eventLog : [];
  const lastTs    = meta.lastRefinedAt ? new Date(meta.lastRefinedAt).getTime() : 0;
  const newEvents = eventLog.filter(e => !e.timestamp || new Date(e.timestamp).getTime() > lastTs);

  // [Soul] Write behavior-guide.md
  const bgPath = path.join(personaDir, 'soul', 'behavior-guide.md');
  fs.ensureDirSync(path.dirname(bgPath));
  fs.writeFileSync(bgPath, entry.behaviorGuide);
  printSuccess('Updated soul/behavior-guide.md');

  // [Soul] Ensure persona.json.behaviorGuide pointer
  const personaPath = path.join(personaDir, 'persona.json');
  const personaData = JSON.parse(fs.readFileSync(personaPath, 'utf-8'));
  if (!personaData.behaviorGuide && !personaData.soul?.character?.behaviorGuide) {
    personaData.behaviorGuide = 'file:soul/behavior-guide.md';
    fs.writeFileSync(personaPath, JSON.stringify(personaData, null, 2) + '\n');
  }

  // [Skill] Apply skill gates
  applySkillGates(personaDir, persona, newEvents);

  // [Social + SKILL.md] Regenerate via generator
  const freshPersona = JSON.parse(fs.readFileSync(personaPath, 'utf-8'));
  await regeneratePack(personaDir, freshPersona);
  printSuccess('Regenerated SKILL.md and agent-card.json');

  // Write meta
  const newRevision = bumpRevision(meta.packRevision);
  const updatedMeta = {
    ...meta,
    packRevision:       newRevision,
    engine:             'signal',
    lastRefinedAt:      new Date().toISOString(),
    totalEventsRefined: (meta.totalEventsRefined || 0) + newEvents.length,
    changeLog: [
      ...(meta.changeLog || []),
      { revision: newRevision, summary: `Refined from ${newEvents.length} event(s)`, refinedAt: new Date().toISOString() },
    ].slice(-20),
  };
  writeMeta(personaDir, updatedMeta);
  printSuccess(`Pack revision: ${meta.packRevision} → ${newRevision}`);

  const packConfig = persona.evolution?.pack || {};
  if (packConfig.autoPublish) autoPublish(personaDir, newRevision);

  return { applied: true, revision: newRevision };
}

// ── AutoSkill path (bare command, synchronous) ───────────────────────────────

async function runAutoSkill(personaDir, persona) {
  const packConfig = persona.evolution?.pack || {};
  if (packConfig.engine !== 'autoskill') {
    throw new Error(
      'openpersona refine <slug> (without flags) requires evolution.pack.engine: "autoskill" in persona.json\n' +
      '  For the built-in Signal Protocol path, use: openpersona refine <slug> --emit'
    );
  }

  const endpoint = process.env.AUTOSKILL_ENDPOINT || 'http://localhost:8080';
  const slug     = persona.slug || persona.personaSlug;
  const meta     = loadMeta(personaDir);
  const state    = loadState(personaDir);
  const eventLog = Array.isArray(state.eventLog) ? state.eventLog : [];

  bootstrapBehaviorGuide(personaDir, persona);
  const bgPath = path.join(personaDir, 'soul', 'behavior-guide.md');
  const currentBehaviorGuide = fs.existsSync(bgPath) ? fs.readFileSync(bgPath, 'utf-8') : '';

  // POST to AutoSkill endpoint
  let response;
  try {
    const reqBody = JSON.stringify({ slug, eventLog, currentBehaviorGuide });
    const url = new URL('/v1/autoskill/openclaw/hooks/agent_end', endpoint);
    response = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port:     parseInt(url.port || '80', 10),
        path:     url.pathname,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
        timeout:  30000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('AutoSkill endpoint timed out')); });
      req.write(reqBody);
      req.end();
    });
  } catch (err) {
    throw new Error(
      `AutoSkill endpoint not reachable at ${endpoint}: ${err.message}\n` +
      '  Tip: use --emit / --apply for the built-in Signal Protocol path instead'
    );
  }

  if (!response?.behaviorGuide) {
    throw new Error('AutoSkill returned an invalid response (missing behaviorGuide)');
  }

  // Constitution compliance gate
  const violations = scanConstitutionKeywords(response.behaviorGuide);
  if (violations.length > 0) {
    printError('Constitution compliance violation in AutoSkill response — refinement rejected:');
    violations.forEach(v => printError(`  - ${v}`));
    throw new Error('AutoSkill refinement rejected by constitution keyword scan');
  }

  // Write behavior-guide.md
  fs.ensureDirSync(path.dirname(bgPath));
  fs.writeFileSync(bgPath, response.behaviorGuide);
  printSuccess('Updated soul/behavior-guide.md (AutoSkill)');

  // Ensure persona.json pointer
  const personaPath = path.join(personaDir, 'persona.json');
  const personaData = JSON.parse(fs.readFileSync(personaPath, 'utf-8'));
  if (!personaData.behaviorGuide && !personaData.soul?.character?.behaviorGuide) {
    personaData.behaviorGuide = 'file:soul/behavior-guide.md';
    fs.writeFileSync(personaPath, JSON.stringify(personaData, null, 2) + '\n');
  }

  // Skill gates
  const lastTs    = meta.lastRefinedAt ? new Date(meta.lastRefinedAt).getTime() : 0;
  const newEvents = eventLog.filter(e => !e.timestamp || new Date(e.timestamp).getTime() > lastTs);
  applySkillGates(personaDir, persona, newEvents);

  // Regenerate SKILL.md + agent-card.json
  await regeneratePack(personaDir, JSON.parse(fs.readFileSync(personaPath, 'utf-8')));
  printSuccess('Regenerated SKILL.md and agent-card.json');

  // Meta
  const newRevision = response.revision || bumpRevision(meta.packRevision);
  const updatedMeta = {
    ...meta,
    packRevision:       newRevision,
    engine:             'autoskill',
    lastRefinedAt:      new Date().toISOString(),
    totalEventsRefined: (meta.totalEventsRefined || 0) + newEvents.length,
    changeLog: [
      ...(meta.changeLog || []),
      { revision: newRevision, summary: `AutoSkill refinement from ${newEvents.length} event(s)`, refinedAt: new Date().toISOString() },
    ].slice(-20),
  };
  writeMeta(personaDir, updatedMeta);
  printSuccess(`Pack revision: ${meta.packRevision} → ${newRevision}`);

  if (packConfig.autoPublish) autoPublish(personaDir, newRevision);
  return { applied: true, revision: newRevision };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Refine an installed persona skill pack from accumulated experience.
 *
 * @param {string} slug - Installed persona slug
 * @param {object} [options]
 * @param {boolean} [options.emit]     - Signal path Step A: check threshold + emit signal
 * @param {boolean} [options.apply]    - Signal path Step B: apply signal response
 * @param {boolean} [options.fromPool] - AutoSkill: pull from shared aggregation pool
 */
async function refine(slug, options = {}) {
  const { emit, apply, fromPool } = options;

  const personaDir = resolvePersonaDir(slug);
  if (!personaDir) {
    throw new Error(`Persona not found: "${slug}". Install it first with: openpersona install <source>`);
  }

  const personaPath = path.join(personaDir, 'persona.json');
  if (!fs.existsSync(personaPath)) {
    throw new Error(`persona.json not found in ${personaDir}`);
  }
  const persona    = JSON.parse(fs.readFileSync(personaPath, 'utf-8'));
  const packConfig = persona.evolution?.pack || {};

  if (!packConfig.enabled) {
    throw new Error(
      `Pack refinement is not enabled for "${slug}".\n` +
      '  Add to persona.json: { "evolution": { "pack": { "enabled": true } } }'
    );
  }

  if (fromPool) {
    if (packConfig.aggregation !== 'opt-in') {
      throw new Error('--from-pool requires evolution.pack.aggregation: "opt-in" in persona.json');
    }
    printInfo('--from-pool: AutoSkill shared pool pull is not yet implemented (P24+)');
    return;
  }

  if (emit)  return emitRefinement(personaDir, persona);
  if (apply) return applyRefinement(personaDir, persona);

  return runAutoSkill(personaDir, persona);
}

module.exports = {
  refine,
  emitRefinement,
  applyRefinement,
  resolveFeedbackDir,
  scanConstitutionKeywords,
  loadMeta,
  writeMeta,
  bumpRevision,
  bootstrapBehaviorGuide,
};
