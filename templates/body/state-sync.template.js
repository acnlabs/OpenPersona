#!/usr/bin/env node
/**
 * state-sync.js — Runtime state bridge for OpenPersona personas
 *
 * Commands:
 *   read                               — Print current evolution state summary (last 5 events)
 *   write <json-patch>                 — Merge JSON patch into state.json (pack root)
 *   signal <type> [payload-json]       — Emit signal to host via ~/.openclaw/feedback/
 *   responses [type] [--peek]          — Read (and consume) pending host responses
 *
 * Signal types: scheduling, file_io, tool_missing, capability_gap, resource_limit, agent_communication
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PERSONA_DIR = path.resolve(__dirname, '..');
const STATE_PATH = path.join(PERSONA_DIR, 'state.json');
// Signals: explicit env wins over implicit default-directory discovery
//   OPENCLAW_HOME → OPENPERSONA_HOME → ~/.openclaw (if exists) → ~/.openpersona
function resolveFeedbackDir() {
  if (process.env.OPENCLAW_HOME) {
    return path.join(process.env.OPENCLAW_HOME, 'feedback');
  }
  if (process.env.OPENPERSONA_HOME) {
    return path.join(process.env.OPENPERSONA_HOME, 'feedback');
  }
  const clawHome = path.join(os.homedir(), '.openclaw');
  const opHome   = path.join(os.homedir(), '.openpersona');
  return fs.existsSync(clawHome)
    ? path.join(clawHome, 'feedback')
    : path.join(opHome, 'feedback');
}
const FEEDBACK_DIR = resolveFeedbackDir();
const SIGNALS_PATH = path.join(FEEDBACK_DIR, 'signals.json');
const SIGNAL_RESPONSES_PATH = path.join(FEEDBACK_DIR, 'signal-responses.json');

const [, , command, ...args] = process.argv;

function readState() {
  if (!fs.existsSync(STATE_PATH)) {
    console.log(JSON.stringify({ exists: false, message: 'state.json not found — persona may need to be regenerated with a current version of OpenPersona.' }));
    return;
  }
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    console.log(JSON.stringify({
      exists: true,
      slug: state.personaSlug || state.slug,
      relationship: state.relationship,
      mood: state.mood,
      evolvedTraits: state.evolvedTraits || state.traits,
      speakingStyleDrift: state.speakingStyleDrift,
      interests: state.interests,
      recentEvents: (state.eventLog || []).slice(-5),
      pendingCommands: state.pendingCommands || [],
      lastUpdatedAt: state.lastUpdatedAt,
    }, null, 2));
  } catch (e) {
    console.error('state-sync read error:', e.message);
    process.exit(1);
  }
}

function writeState(patchJson) {
  if (!fs.existsSync(STATE_PATH)) {
    console.log(JSON.stringify({ success: false, message: 'state.json not found — persona may need to be regenerated with a current version of OpenPersona.' }));
    return;
  }
  let patch;
  try {
    patch = JSON.parse(patchJson);
  } catch (e) {
    console.error('Invalid JSON patch:', e.message);
    process.exit(1);
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    console.error('Invalid patch: must be a JSON object, got ' + (Array.isArray(patch) ? 'array' : typeof patch));
    process.exit(1);
  }
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));

    // Snapshot to stateHistory — strip stateHistory, eventLog, and pendingCommands (ephemeral, not rollback state)
    const snapshot = { ...state, stateHistory: undefined, eventLog: undefined, pendingCommands: undefined };
    state.stateHistory = state.stateHistory || [];
    if (state.stateHistory.length >= 10) state.stateHistory.shift();
    state.stateHistory.push(snapshot);

    // Apply patch — immutable identity fields are never overwritten
    const IMMUTABLE = new Set(['$schema', 'version', 'personaSlug', 'createdAt']);
    const { eventLog: newEvents, ...rest } = patch;

    // Evolution Constraint Gate — enforce evolution.boundaries declared in persona.json.
    // Pattern mirrors emitSignal's body.interface.signals enforcement: read persona.json,
    // apply declared policy, clamp/filter violations rather than rejecting the whole patch.
    const personaJsonPath = path.join(PERSONA_DIR, 'persona.json');
    let evolutionBoundaries = null;
    let evolutionSkillPolicy = null;
    if (fs.existsSync(personaJsonPath)) {
      try {
        const personaData = JSON.parse(fs.readFileSync(personaJsonPath, 'utf-8'));
        // evolution.instance.boundaries is the canonical path (P23+);
        // fall back to evolution.boundaries for pre-P23 persona.json files.
        const evo = personaData.evolution || {};
        evolutionBoundaries = (evo.instance && evo.instance.boundaries) || evo.boundaries || null;
        evolutionSkillPolicy = evo.skill || null;
      } catch { /* graceful degradation — skip enforcement if persona.json is unreadable */ }
    }

    if (evolutionBoundaries) {
      // 1. immutableTraits — filter violating evolvedTraits entries from the patch
      if (Array.isArray(evolutionBoundaries.immutableTraits) && evolutionBoundaries.immutableTraits.length > 0
          && Array.isArray(rest.evolvedTraits)) {
        const immutable = new Set(evolutionBoundaries.immutableTraits.map((t) => t.toLowerCase()));
        const before = rest.evolvedTraits.length;
        rest.evolvedTraits = rest.evolvedTraits.filter((entry) => {
          const name = (typeof entry === 'string' ? entry : (entry.trait || entry.name || '')).toLowerCase();
          return !immutable.has(name);
        });
        if (rest.evolvedTraits.length < before) {
          console.error('state-sync: [evolution-gate] ' + (before - rest.evolvedTraits.length)
            + ' evolvedTraits entr' + (before - rest.evolvedTraits.length === 1 ? 'y' : 'ies')
            + ' blocked — trait is declared immutable in evolution.instance.boundaries.immutableTraits (or legacy evolution.boundaries.immutableTraits)');
          // If all proposed traits were blocked, remove the key entirely rather than
          // applying an empty array — prevents wiping existing evolved state.
          if (rest.evolvedTraits.length === 0) {
            delete rest.evolvedTraits;
          }
        }
      }

      // 2. formality bounds — clamp speakingStyleDrift.formality to [minFormality, maxFormality]
      if (rest.speakingStyleDrift && typeof rest.speakingStyleDrift === 'object'
          && rest.speakingStyleDrift.formality !== undefined) {
        const f = rest.speakingStyleDrift.formality;
        const min = evolutionBoundaries.minFormality;
        const max = evolutionBoundaries.maxFormality;
        if (min !== undefined && f < min) {
          console.error('state-sync: [evolution-gate] speakingStyleDrift.formality (' + f + ') clamped to minFormality (' + min + ')');
          rest.speakingStyleDrift = { ...rest.speakingStyleDrift, formality: min };
        } else if (max !== undefined && f > max) {
          console.error('state-sync: [evolution-gate] speakingStyleDrift.formality (' + f + ') clamped to maxFormality (' + max + ')');
          rest.speakingStyleDrift = { ...rest.speakingStyleDrift, formality: max };
        }
      }

      // 3. relationship.stage — only allow same-stage or single-step forward progression
      if (rest.relationship && typeof rest.relationship === 'object'
          && rest.relationship.stage !== undefined) {
        const STAGE_ORDER = ['stranger', 'acquaintance', 'friend', 'close_friend', 'intimate'];
        const currentStage = (state.relationship && state.relationship.stage) || 'stranger';
        const currentIdx = STAGE_ORDER.indexOf(currentStage);
        const proposedIdx = STAGE_ORDER.indexOf(rest.relationship.stage);
        let stageViolation = null;
        if (proposedIdx === -1) {
          stageViolation = 'relationship.stage "' + rest.relationship.stage + '" is not a valid stage — must be one of: ' + STAGE_ORDER.join(', ');
        } else if (currentIdx === -1) {
          // Current stage is unknown (corrupted/custom) — skip progression enforcement,
          // allow any valid proposed stage rather than over-blocking.
        } else if (proposedIdx < currentIdx) {
          stageViolation = 'relationship.stage cannot go backward (' + currentStage + ' → ' + rest.relationship.stage + ') — stage reversal blocked';
        } else if (proposedIdx > currentIdx + 1) {
          stageViolation = 'relationship.stage cannot skip stages (' + currentStage + ' → ' + rest.relationship.stage + ') — must progress one step at a time';
        }
        if (stageViolation) {
          console.error('state-sync: [evolution-gate] ' + stageViolation);
          const { stage: _blocked, ...restRelationship } = rest.relationship;
          rest.relationship = restRelationship;
        }
      }
    }

    // Skill Trust Gate — filter incoming capability_unlock pendingCommands that fail minTrustLevel.
    // Runs when new commands are written to the queue (patch.pendingCommands is a non-empty array).
    // Trust hierarchy: verified > community > unverified.
    // Blocked commands are dropped from the patch and a capability_gap signal is emitted.
    const TRUST_ORDER = ['unverified', 'community', 'verified'];
    if (Array.isArray(rest.pendingCommands) && rest.pendingCommands.length > 0
        && evolutionSkillPolicy && evolutionSkillPolicy.minTrustLevel) {
      const minIdx = TRUST_ORDER.indexOf(evolutionSkillPolicy.minTrustLevel);
      if (minIdx >= 0) {
        const blocked = [];
        rest.pendingCommands = rest.pendingCommands.filter((cmd) => {
          if (!cmd || cmd.type !== 'capability_unlock') return true;
          const skillTrust = (cmd.payload && cmd.payload.trust) || 'unverified';
          const trustIdx = TRUST_ORDER.indexOf(skillTrust);
          if (trustIdx < minIdx) { blocked.push(cmd); return false; }
          return true;
        });
        for (const cmd of blocked) {
          const skillName = (cmd.payload && cmd.payload.skill) || 'unknown';
          const trust = (cmd.payload && cmd.payload.trust) || 'unverified';
          console.error('state-sync: [skill-trust-gate] capability_unlock blocked for "' + skillName
            + '" (trust: ' + trust + ', required: ' + evolutionSkillPolicy.minTrustLevel + ')');
          try {
            const sig = {
              type: 'capability_gap',
              slug: state.personaSlug || state.slug || 'unknown',
              timestamp: new Date().toISOString(),
              payload: { skill: skillName, reason: 'trust_below_threshold',
                required: evolutionSkillPolicy.minTrustLevel, actual: trust },
            };
            let sigs = [];
            if (fs.existsSync(SIGNALS_PATH)) {
              try { sigs = JSON.parse(fs.readFileSync(SIGNALS_PATH, 'utf-8')); if (!Array.isArray(sigs)) sigs = []; } catch {}
            }
            sigs.push(sig);
            if (sigs.length > 200) sigs = sigs.slice(-200);
            fs.mkdirSync(path.dirname(SIGNALS_PATH), { recursive: true });
            fs.writeFileSync(SIGNALS_PATH, JSON.stringify(sigs, null, 2));
          } catch {}
        }
        // If all commands were blocked, drop the key entirely — prevents wiping pre-existing
        // queue entries that haven't been processed yet (mirrors P17 evolvedTraits[] fix).
        if (rest.pendingCommands.length === 0) {
          delete rest.pendingCommands;
        }
      }
    }

    const NESTED = ['mood', 'relationship', 'speakingStyleDrift', 'interests'];
    for (const key of Object.keys(rest)) {
      if (IMMUTABLE.has(key)) continue;
      if (NESTED.includes(key) && rest[key] && typeof rest[key] === 'object' && !Array.isArray(rest[key])
          && state[key] && typeof state[key] === 'object') {
        state[key] = { ...state[key], ...rest[key] };
      } else {
        state[key] = rest[key];
      }
    }
    if (Array.isArray(newEvents) && newEvents.length > 0) {
      const VALID_EVENT_TYPES = new Set([
        'relationship_signal', 'mood_shift', 'trait_emergence',
        'interest_discovery', 'milestone', 'speaking_style_drift',
      ]);
      state.eventLog = state.eventLog || [];
      for (const ev of newEvents) {
        if (!ev || typeof ev !== 'object') continue;
        if (!ev.type || !VALID_EVENT_TYPES.has(ev.type)) {
          console.error('state-sync: invalid eventLog entry type "' + ev.type + '" — must be one of: ' + [...VALID_EVENT_TYPES].join(', '));
          process.exit(1);
        }
        if (!ev.trigger || !ev.delta || !ev.source) {
          console.error('state-sync: eventLog entry missing required fields (trigger, delta, source)');
          process.exit(1);
        }
        state.eventLog.push({ ...ev, timestamp: ev.timestamp || new Date().toISOString() });
      }
      if (state.eventLog.length > 50) state.eventLog = state.eventLog.slice(-50);
    }

    state.lastUpdatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log(JSON.stringify({ success: true, lastUpdatedAt: state.lastUpdatedAt }));
  } catch (e) {
    console.error('state-sync write error:', e.message);
    process.exit(1);
  }
}

function emitSignal(type, payloadJson) {
  const validTypes = ['scheduling', 'file_io', 'tool_missing', 'capability_gap', 'resource_limit', 'agent_communication'];
  if (!validTypes.includes(type)) {
    console.error('Invalid signal type: ' + type + '. Valid: ' + validTypes.join(', '));
    process.exit(1);
  }
  let payload = {};
  if (payloadJson) {
    try { payload = JSON.parse(payloadJson); }
    catch (e) { console.error('Invalid payload JSON:', e.message); process.exit(1); }
  }
  let slug = 'unknown';
  const personaJsonPath = path.join(PERSONA_DIR, 'persona.json');
  if (fs.existsSync(personaJsonPath)) {
    try {
      const personaData = JSON.parse(fs.readFileSync(personaJsonPath, 'utf-8'));
      slug = personaData.slug || 'unknown';
      // Enforce body.interface.signals policy declared in persona.json
      const signalPolicy = personaData.body && personaData.body.interface && personaData.body.interface.signals;
      if (signalPolicy) {
        if (signalPolicy.enabled === false) {
          console.error('Signal blocked: body.interface.signals.enabled is false for this persona.');
          process.exit(1);
        }
        if (Array.isArray(signalPolicy.allowedTypes) && signalPolicy.allowedTypes.length > 0) {
          if (!signalPolicy.allowedTypes.includes(type)) {
            console.error('Signal blocked: type "' + type + '" not in body.interface.signals.allowedTypes (' + signalPolicy.allowedTypes.join(', ') + ').');
            process.exit(1);
          }
        }
      }
    } catch {}
  }
  const signal = { type, slug, timestamp: new Date().toISOString(), payload };
  try {
    fs.mkdirSync(path.dirname(SIGNALS_PATH), { recursive: true });
    let signals = [];
    if (fs.existsSync(SIGNALS_PATH)) {
      try { signals = JSON.parse(fs.readFileSync(SIGNALS_PATH, 'utf-8')); if (!Array.isArray(signals)) signals = []; } catch {}
    }
    signals.push(signal);
    if (signals.length > 200) signals = signals.slice(-200);
    fs.writeFileSync(SIGNALS_PATH, JSON.stringify(signals, null, 2));
    // Read the latest unprocessed host response for this type and mark it consumed.
    let response = null;
    if (fs.existsSync(SIGNAL_RESPONSES_PATH)) {
      try {
        const allResponses = JSON.parse(fs.readFileSync(SIGNAL_RESPONSES_PATH, 'utf-8'));
        if (Array.isArray(allResponses)) {
          let lastIdx = -1;
          for (let i = 0; i < allResponses.length; i++) {
            const r = allResponses[i];
            if (r.type === type && r.slug === slug && !r.processed) lastIdx = i;
          }
          if (lastIdx >= 0) {
            response = allResponses[lastIdx];
            allResponses[lastIdx] = { ...response, processed: true };
            fs.writeFileSync(SIGNAL_RESPONSES_PATH, JSON.stringify(allResponses, null, 2));
          }
        }
      } catch {}
    }
    console.log(JSON.stringify({ success: true, signal, response }));
  } catch (e) {
    console.error('state-sync signal error:', e.message);
    process.exit(1);
  }
}

/**
 * Read pending signal responses from the host.
 *
 * @param {string|null} typeFilter - Optional signal type to filter by
 * @param {boolean}     peek       - If true, read without marking as processed
 */
function readResponses(typeFilter, peek) {
  let slug = 'unknown';
  const personaJsonPath = path.join(PERSONA_DIR, 'persona.json');
  if (fs.existsSync(personaJsonPath)) {
    try {
      const personaData = JSON.parse(fs.readFileSync(personaJsonPath, 'utf-8'));
      slug = personaData.slug || 'unknown';
    } catch {}
  }

  if (!fs.existsSync(SIGNAL_RESPONSES_PATH)) {
    console.log(JSON.stringify({ slug, responses: [], total: 0, peek: !!peek }));
    return;
  }

  let allResponses = [];
  try {
    allResponses = JSON.parse(fs.readFileSync(SIGNAL_RESPONSES_PATH, 'utf-8'));
    if (!Array.isArray(allResponses)) allResponses = [];
  } catch (e) {
    console.error('state-sync responses error: ' + e.message);
    process.exit(1);
  }

  const pending = allResponses.filter(
    (r) => r.slug === slug && !r.processed && (!typeFilter || r.type === typeFilter)
  );

  if (!peek && pending.length > 0) {
    // Mark matched entries as processed in-place
    for (const r of allResponses) {
      if (r.slug === slug && !r.processed && (!typeFilter || r.type === typeFilter)) {
        r.processed = true;
      }
    }
    try {
      fs.writeFileSync(SIGNAL_RESPONSES_PATH, JSON.stringify(allResponses, null, 2));
    } catch (e) {
      console.error('state-sync responses: failed to mark processed: ' + e.message);
    }
  }

  console.log(JSON.stringify({ slug, responses: pending, total: pending.length, peek: !!peek }));
}

switch (command) {
  case 'read':
    readState();
    break;
  case 'write':
    if (!args[0]) { console.error('Usage: node scripts/state-sync.js write <json-patch>'); process.exit(1); }
    writeState(args.join(' '));
    break;
  case 'signal':
    if (!args[0]) { console.error('Usage: node scripts/state-sync.js signal <type> [payload-json]'); process.exit(1); }
    emitSignal(args[0], args[1] || null);
    break;
  case 'responses': {
    // args: [type?] [peek?]
    // Accept --peek flag anywhere in args or literal 'peek' token
    const peekFlag = args.includes('--peek') || args.includes('peek');
    const typeArg  = args.find((a) => a && a !== '--peek' && a !== 'peek') || null;
    readResponses(typeArg, peekFlag);
    break;
  }
  default:
    console.error([
      'Usage: node scripts/state-sync.js <command>',
      '  read                               — Print evolution state summary',
      '  write <json-patch>                 — Persist state changes to state.json (pack root)',
      '  signal <type> [payload-json]       — Emit signal to host runtime',
      '  responses [type] [--peek]          — Read (and consume) pending host responses',
    ].join('\n'));
    process.exit(1);
}
