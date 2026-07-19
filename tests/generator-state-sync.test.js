/**
 * OpenPersona - Generator tests: state-sync — script generation, signals, body.interface
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs-extra');
const { generate } = require('../lib/generator');
const { loadRegistry, saveRegistry, registryAdd, registryRemove, registrySetActive, REGISTRY_PATH } = require('../lib/registry');
const { generateHandoff, renderHandoff } = require('../lib/lifecycle/switcher');

const TMP = path.join(require('os').tmpdir(), 'openpersona-test-state-' + Date.now());

describe('state-sync script generation', () => {
  const TMP_SS = path.join(require('os').tmpdir(), 'openpersona-statesync-test-' + Date.now());

  it('generates scripts/state-sync.js for all personas', async () => {
    const persona = {
      personaName: 'SyncTest',
      slug: 'sync-test',
      bio: 'state sync tester',
      personality: 'methodical',
      speakingStyle: 'Precise',
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);

    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');
    assert.ok(fs.existsSync(syncScript), 'scripts/state-sync.js must be generated');

    const content = fs.readFileSync(syncScript, 'utf-8');
    assert.ok(content.includes('readState'), 'script must contain readState function');
    assert.ok(content.includes('writeState'), 'script must contain writeState function');
    assert.ok(content.includes('emitSignal'), 'script must contain emitSignal function');
    assert.ok(content.includes('capability_gap'), 'script must list valid signal types');
    assert.ok(
      content.includes('OPENPERSONA_HOME') && content.includes('resolveFeedbackDir'),
      'script must resolve feedback dir with explicit OPENPERSONA_HOME precedence'
    );

    await fs.remove(TMP_SS);
  });

  it('state-sync.js prefers OPENPERSONA_HOME over implicit ~/.openclaw', async () => {
    const persona = {
      personaName: 'FeedbackHomeTest',
      slug: 'feedback-home-test',
      bio: 'feedback home precedence tester',
      personality: 'precise',
      speakingStyle: 'Direct',
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);

    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');
    const opHome = path.join(TMP_SS, 'op-home-explicit');
    const env = { ...process.env, OPENPERSONA_HOME: opHome };
    delete env.OPENCLAW_HOME;

    execSync(`node "${syncScript}" signal capability_gap '{"need":"test"}'`, {
      encoding: 'utf-8',
      cwd: skillDir,
      env,
    });

    const signalsPath = path.join(opHome, 'feedback', 'signals.json');
    assert.ok(
      fs.existsSync(signalsPath),
      'signals.json must land under OPENPERSONA_HOME even when ~/.openclaw exists on the machine'
    );

    await fs.remove(TMP_SS);
  });

  it('state-sync.js read returns exists:true for all personas (state.json is unconditional)', async () => {
    const persona = {
      personaName: 'NoState',
      slug: 'no-state',
      bio: 'persona without explicit evolution config',
      personality: 'calm',
      speakingStyle: 'Simple',
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);

    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');
    const out = execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir });
    const result = JSON.parse(out);
    assert.strictEqual(result.exists, true, 'state.json is generated for all personas — exists must always be true');
    assert.strictEqual(result.slug, 'no-state', 'slug must be read from state.json');

    await fs.remove(TMP_SS);
  });

  it('state-sync.js read returns evolution state for evolution-enabled persona', async () => {
    const persona = {
      personaName: 'EvoSync',
      slug: 'evo-sync',
      bio: 'evolution sync tester',
      personality: 'curious',
      speakingStyle: 'Warm',
      evolution: { enabled: true },
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);

    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');
    const out = execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir });
    const result = JSON.parse(out);
    assert.strictEqual(result.exists, true, 'read on evolution persona should return exists:true');
    assert.strictEqual(result.slug, 'evo-sync', 'state slug should match persona slug');
    assert.ok(result.mood !== undefined, 'state should include mood');
    assert.ok('relationship' in result, 'state should include relationship');
    assert.ok('evolvedTraits' in result, 'read output must use evolvedTraits (not traits) to match write patch field names');
    assert.ok(!('traits' in result), 'read output must not expose deprecated traits key');
    assert.ok(Array.isArray(result.pendingCommands), 'read output must include pendingCommands array');

    await fs.remove(TMP_SS);
  });

  it('state-sync.js pendingCommands: host enqueues, agent reads, agent clears', async () => {
    const persona = {
      personaName: 'PendingCmdTest',
      slug: 'pending-cmd-test',
      bio: 'pending commands tester',
      personality: 'responsive',
      speakingStyle: 'Direct',
      evolution: { enabled: true },
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // Step 1: host enqueues a capability_unlock command
    const cmd = { type: 'capability_unlock', payload: { skill: 'web_search' }, source: 'host' };
    const enqueuePatch = JSON.stringify({ pendingCommands: [cmd] });
    execSync(`node "${syncScript}" write '${enqueuePatch}'`, { encoding: 'utf-8', cwd: skillDir });

    // Step 2: agent reads state — pendingCommands must contain the queued command
    const readOut = execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir });
    const readResult = JSON.parse(readOut);
    assert.ok(Array.isArray(readResult.pendingCommands), 'pendingCommands must be an array in read output');
    assert.strictEqual(readResult.pendingCommands.length, 1, 'one pending command must be present');
    assert.strictEqual(readResult.pendingCommands[0].type, 'capability_unlock', 'command type must match');
    assert.deepStrictEqual(readResult.pendingCommands[0].payload, { skill: 'web_search' }, 'payload must be preserved');
    assert.strictEqual(readResult.pendingCommands[0].source, 'host', 'source must be preserved');

    // Step 3: agent clears pendingCommands after processing
    const clearPatch = JSON.stringify({ pendingCommands: [] });
    execSync(`node "${syncScript}" write '${clearPatch}'`, { encoding: 'utf-8', cwd: skillDir });

    // Step 4: next read must show empty queue
    const afterReadOut = execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir });
    const afterResult = JSON.parse(afterReadOut);
    assert.strictEqual(afterResult.pendingCommands.length, 0, 'pendingCommands must be empty after agent clears');

    await fs.remove(TMP_SS);
  });

  it('state-sync.js pendingCommands: multiple commands queue correctly', async () => {
    const persona = {
      personaName: 'MultiCmdTest',
      slug: 'multi-cmd-test',
      bio: 'multi command tester',
      personality: 'methodical',
      speakingStyle: 'Precise',
      evolution: { enabled: true },
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    const cmds = [
      { type: 'capability_unlock', payload: { skill: 'web_search' }, source: 'host' },
      { type: 'context_inject', payload: { message: 'User is in a hurry today' }, source: 'runner' },
      { type: 'system_message', payload: { message: 'Scheduled maintenance tonight' }, source: 'host' },
    ];
    execSync(`node "${syncScript}" write '${JSON.stringify({ pendingCommands: cmds })}'`, { encoding: 'utf-8', cwd: skillDir });

    const readOut = execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir });
    const result = JSON.parse(readOut);
    assert.strictEqual(result.pendingCommands.length, 3, 'all three commands must be present');
    assert.strictEqual(result.pendingCommands[1].type, 'context_inject', 'second command type must match');

    await fs.remove(TMP_SS);
  });

  it('state-sync.js write persists changes and rolls back via stateHistory', async () => {
    const persona = {
      personaName: 'WriteTest',
      slug: 'write-test',
      bio: 'write sync tester',
      personality: 'stable',
      speakingStyle: 'Direct',
      evolution: { enabled: true },
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);

    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    const patch = JSON.stringify({ mood: { current: 'joyful' }, eventLog: [{ type: 'mood_shift', trigger: 'test event', delta: 'mood shifted', source: 'test' }] });
    const writeOut = execSync(`node "${syncScript}" write '${patch}'`, { encoding: 'utf-8', cwd: skillDir });
    const writeResult = JSON.parse(writeOut);
    assert.strictEqual(writeResult.success, true, 'write should succeed');

    const readOut = execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir });
    const readResult = JSON.parse(readOut);
    // mood must be an object (deep-merged), not a string
    assert.ok(readResult.mood && typeof readResult.mood === 'object', 'mood must remain an object after write (deep-merge)');
    assert.strictEqual(readResult.mood.current, 'joyful', 'mood.current should be updated');
    // deep-merge must preserve other mood fields
    assert.ok('intensity' in readResult.mood, 'mood.intensity must be preserved by deep-merge');
    assert.ok('baseline' in readResult.mood, 'mood.baseline must be preserved by deep-merge');
    assert.ok(readResult.recentEvents.some((e) => e.trigger === 'test event'), 'event should appear in recentEvents');

    // Verify stateHistory snapshot was created
    const statePath = path.join(skillDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.ok(Array.isArray(state.stateHistory) && state.stateHistory.length >= 1, 'stateHistory should have a snapshot');

    await fs.remove(TMP_SS);
  });

  it('state-sync.js write rejects non-object patch', async () => {
    const persona = {
      personaName: 'ValidationTest',
      slug: 'validation-test',
      bio: 'validation tester',
      personality: 'precise',
      speakingStyle: 'Direct',
      evolution: { enabled: true },
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);

    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // null patch should fail with exit code 1
    assert.throws(
      () => execSync(`node "${syncScript}" write 'null'`, { encoding: 'utf-8', cwd: skillDir }),
      (err) => err.stderr.includes('must be a JSON object'),
      'null patch must be rejected'
    );

    await fs.remove(TMP_SS);
  });

  it('state-sync.js write protects immutable fields', async () => {
    const persona = {
      personaName: 'ImmutableTest',
      slug: 'immutable-test',
      bio: 'immutable fields tester',
      personality: 'stable',
      speakingStyle: 'Direct',
      evolution: { enabled: true },
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);

    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    const patch = JSON.stringify({ personaSlug: 'hacked', version: '99.0', mood: { current: 'happy' } });
    execSync(`node "${syncScript}" write '${patch}'`, { encoding: 'utf-8', cwd: skillDir });

    const statePath = path.join(skillDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.strictEqual(state.personaSlug, 'immutable-test', 'personaSlug must not be overwritten');
    assert.strictEqual(state.version, '1.0.0', 'version must not be overwritten');
    assert.strictEqual(state.mood.current, 'happy', 'non-immutable fields should still be patched');

    await fs.remove(TMP_SS);
  });

  it('state-sync.js write snapshot does not include eventLog', async () => {
    const persona = {
      personaName: 'SnapshotTest',
      slug: 'snapshot-test',
      bio: 'snapshot tester',
      personality: 'methodical',
      speakingStyle: 'Precise',
      evolution: { enabled: true },
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);

    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // Write with an eventLog entry
    const patch = JSON.stringify({ mood: { current: 'curious' }, eventLog: [{ type: 'mood_shift', trigger: 'event one', delta: 'mood changed', source: 'test' }] });
    execSync(`node "${syncScript}" write '${patch}'`, { encoding: 'utf-8', cwd: skillDir });

    const statePath = path.join(skillDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.ok(Array.isArray(state.stateHistory) && state.stateHistory.length >= 1, 'stateHistory should have a snapshot');
    // Snapshot must not include eventLog (anti-bloat)
    assert.ok(!('eventLog' in state.stateHistory[0]), 'snapshot must not include eventLog');
    // Snapshot must not include stateHistory (no recursion)
    assert.ok(!('stateHistory' in state.stateHistory[0]), 'snapshot must not include stateHistory');
    // Snapshot must not include pendingCommands (ephemeral, not rollback state)
    assert.ok(!('pendingCommands' in state.stateHistory[0]), 'snapshot must not include pendingCommands');

    await fs.remove(TMP_SS);
  });

  it('SKILL.md includes Interface (Lifecycle Protocol) under Body', async () => {
    const persona = {
      personaName: 'LifecycleTest',
      slug: 'lifecycle-test',
      bio: 'lifecycle tester',
      personality: 'curious',
      speakingStyle: 'Casual',
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);

    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    assert.ok(skillMd.includes('## Body'), 'SKILL.md must include ## Body section');
    assert.ok(skillMd.includes('### Interface (Lifecycle Protocol)'), 'Lifecycle Protocol must be under ## Body as ### Interface');
    assert.ok(skillMd.includes('state-sync.js'), 'Interface section must reference state-sync.js');
    assert.ok(skillMd.includes('Signal Protocol'), 'Interface section must include Signal Protocol guidance');

    await fs.remove(TMP_SS);
  });

  it('SKILL.md Lifecycle section includes read/write commands when evolution enabled', async () => {
    const persona = {
      personaName: 'EvoLifecycle',
      slug: 'evo-lifecycle',
      bio: 'evolution lifecycle tester',
      personality: 'curious',
      speakingStyle: 'Warm',
      evolution: { enabled: true },
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);

    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    assert.ok(skillMd.includes('state-sync.js read'), 'evolution persona SKILL.md must include read command');
    assert.ok(skillMd.includes('state-sync.js write'), 'evolution persona SKILL.md must include write command');

    await fs.remove(TMP_SS);
  });

  it('SKILL.md Generated Files table includes state-sync.js', async () => {
    const persona = {
      personaName: 'FilesTableTest',
      slug: 'files-table-test',
      bio: 'generated files table tester',
      personality: 'organized',
      speakingStyle: 'Precise',
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);

    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    assert.ok(skillMd.includes('scripts/state-sync.js'), 'Generated Files table must include scripts/state-sync.js');

    await fs.remove(TMP_SS);
  });

  it('state-sync.js signal emits to signals.json and caps at 200 entries', async () => {
    const persona = {
      personaName: 'SignalTest',
      slug: 'signal-test',
      bio: 'signal emitter tester',
      personality: 'assertive',
      speakingStyle: 'Direct',
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);

    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');
    const payload = JSON.stringify({ need: 'web_search', reason: 'user asked for news', priority: 'high' });

    // Use OPENCLAW_HOME to isolate signals.json to temp dir (OPENCLAW_HOME is the explicit override)
    const openclawHome = path.join(TMP_SS, 'signal-test-openclaw');
    const signalEnv = { ...process.env, OPENCLAW_HOME: openclawHome };

    // Emit a capability_gap signal
    const out = execSync(`node "${syncScript}" signal capability_gap '${payload}'`, {
      encoding: 'utf-8',
      cwd: skillDir,
      env: signalEnv,
    });
    const result = JSON.parse(out);
    assert.strictEqual(result.success, true, 'signal emit should succeed');
    assert.strictEqual(result.signal.type, 'capability_gap', 'signal type must be capability_gap');
    assert.strictEqual(result.signal.slug, 'signal-test', 'signal slug must match persona slug');
    assert.deepStrictEqual(result.signal.payload, { need: 'web_search', reason: 'user asked for news', priority: 'high' }, 'payload must be preserved');
    assert.strictEqual(result.response, null, 'response must be null when no host has responded');

    // Verify signals.json was written to OPENCLAW_HOME
    const signalsPath = path.join(openclawHome, 'feedback', 'signals.json');
    assert.ok(fs.existsSync(signalsPath), 'signals.json must be created under OPENCLAW_HOME');
    const signals = JSON.parse(fs.readFileSync(signalsPath, 'utf-8'));
    assert.ok(Array.isArray(signals) && signals.length === 1, 'signals.json must contain the emitted signal');
    assert.strictEqual(signals[0].type, 'capability_gap', 'stored signal type must match');

    // Verify 200-entry cap: emit 205 more signals and confirm array stays at 200
    for (let i = 0; i < 205; i++) {
      execSync(`node "${syncScript}" signal tool_missing '{"tool":"t${i}"}'`, {
        encoding: 'utf-8',
        cwd: skillDir,
        env: signalEnv,
      });
    }
    const capped = JSON.parse(fs.readFileSync(signalsPath, 'utf-8'));
    assert.ok(capped.length <= 200, `signals.json must be capped at 200 entries, got ${capped.length}`);

    await fs.remove(TMP_SS);
  });

  it('state-sync.js signal rejects invalid type', async () => {
    const persona = {
      personaName: 'BadSignalTest',
      slug: 'bad-signal-test',
      bio: 'invalid signal tester',
      personality: 'methodical',
      speakingStyle: 'Precise',
    };
    await fs.ensureDir(TMP_SS);
    const { skillDir } = await generate(persona, TMP_SS);

    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    assert.throws(
      () => execSync(`node "${syncScript}" signal invalid_type '{}'`, { encoding: 'utf-8', cwd: skillDir }),
      (err) => err.stderr.includes('Invalid signal type'),
      'invalid signal type must be rejected with an error message'
    );

    await fs.remove(TMP_SS);
  });

  it('state-sync.js responses returns empty when no signal-responses.json exists', async () => {
    const persona = {
      personaName: 'RespEmpty',
      slug: 'resp-empty',
      bio: 'responses empty tester',
      personality: 'calm',
      speakingStyle: 'Concise',
    };
    const TMP_RE = path.join(require('os').tmpdir(), 'op-test-resp-empty-' + Date.now());
    await fs.ensureDir(TMP_RE);
    const { skillDir } = await generate(persona, TMP_RE);

    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');
    const openclawHome = path.join(TMP_RE, 'openclaw');
    const env = { ...process.env, OPENCLAW_HOME: openclawHome };

    const out = execSync(`node "${syncScript}" responses`, { encoding: 'utf-8', cwd: skillDir, env });
    const result = JSON.parse(out);
    assert.strictEqual(result.total, 0, 'total must be 0 when no responses file exists');
    assert.deepStrictEqual(result.responses, [], 'responses array must be empty');

    await fs.remove(TMP_RE);
  });

  it('state-sync.js responses consumes pending responses and marks them processed', async () => {
    const persona = {
      personaName: 'RespConsume',
      slug: 'resp-consume',
      bio: 'responses consume tester',
      personality: 'methodical',
      speakingStyle: 'Direct',
    };
    const TMP_RC = path.join(require('os').tmpdir(), 'op-test-resp-consume-' + Date.now());
    await fs.ensureDir(TMP_RC);
    const { skillDir } = await generate(persona, TMP_RC);

    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');
    const openclawHome = path.join(TMP_RC, 'openclaw');
    const feedbackDir = path.join(openclawHome, 'feedback');
    const responsesPath = path.join(feedbackDir, 'signal-responses.json');
    const env = { ...process.env, OPENCLAW_HOME: openclawHome };

    // Write two responses: one for this slug (pending), one for another slug
    await fs.ensureDir(feedbackDir);
    const fakeResponses = [
      { type: 'capability_gap', slug: 'resp-consume', status: 'resolved', response: { capability: 'web_search' }, processed: false, timestamp: new Date().toISOString() },
      { type: 'scheduling',     slug: 'other-persona', status: 'resolved', response: { jobId: 'j1' },              processed: false, timestamp: new Date().toISOString() },
    ];
    fs.writeFileSync(responsesPath, JSON.stringify(fakeResponses, null, 2));

    // First read — should return the pending entry and mark it processed
    const out1 = execSync(`node "${syncScript}" responses`, { encoding: 'utf-8', cwd: skillDir, env });
    const r1 = JSON.parse(out1);
    assert.strictEqual(r1.total, 1, 'must return 1 pending response for this slug');
    assert.strictEqual(r1.responses[0].type, 'capability_gap', 'returned response must have correct type');
    assert.strictEqual(r1.peek, false, 'peek must be false by default');

    // After consume, the file entry must be marked processed
    const stored = JSON.parse(fs.readFileSync(responsesPath, 'utf-8'));
    assert.ok(stored[0].processed === true, 'consumed response must be marked processed:true in file');
    assert.ok(stored[1].processed === false, 'other slug entry must remain unprocessed');

    // Second read — same slug should return 0 (already consumed)
    const out2 = execSync(`node "${syncScript}" responses`, { encoding: 'utf-8', cwd: skillDir, env });
    const r2 = JSON.parse(out2);
    assert.strictEqual(r2.total, 0, 'second read must return 0 — already consumed');

    await fs.remove(TMP_RC);
  });

  it('state-sync.js responses --peek reads without marking processed', async () => {
    const persona = {
      personaName: 'RespPeek',
      slug: 'resp-peek',
      bio: 'responses peek tester',
      personality: 'curious',
      speakingStyle: 'Inquisitive',
    };
    const TMP_RP = path.join(require('os').tmpdir(), 'op-test-resp-peek-' + Date.now());
    await fs.ensureDir(TMP_RP);
    const { skillDir } = await generate(persona, TMP_RP);

    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');
    const openclawHome = path.join(TMP_RP, 'openclaw');
    const feedbackDir = path.join(openclawHome, 'feedback');
    const responsesPath = path.join(feedbackDir, 'signal-responses.json');
    const env = { ...process.env, OPENCLAW_HOME: openclawHome };

    await fs.ensureDir(feedbackDir);
    const fakeResponses = [
      { type: 'scheduling', slug: 'resp-peek', status: 'resolved', response: { jobId: 'j99' }, processed: false, timestamp: new Date().toISOString() },
    ];
    fs.writeFileSync(responsesPath, JSON.stringify(fakeResponses, null, 2));

    // Peek — must return the response but NOT mark it processed
    const out = execSync(`node "${syncScript}" responses --peek`, { encoding: 'utf-8', cwd: skillDir, env });
    const result = JSON.parse(out);
    assert.strictEqual(result.total, 1, 'peek must return the pending response');
    assert.strictEqual(result.peek, true, 'peek flag must be true in output');

    const stored = JSON.parse(fs.readFileSync(responsesPath, 'utf-8'));
    assert.ok(stored[0].processed === false, '--peek must NOT mark the response as processed');

    await fs.remove(TMP_RP);
  });

  it('state-sync.js responses [type] filters by signal type', async () => {
    const persona = {
      personaName: 'RespFilter',
      slug: 'resp-filter',
      bio: 'responses filter tester',
      personality: 'analytical',
      speakingStyle: 'Technical',
    };
    const TMP_RF = path.join(require('os').tmpdir(), 'op-test-resp-filter-' + Date.now());
    await fs.ensureDir(TMP_RF);
    const { skillDir } = await generate(persona, TMP_RF);

    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');
    const openclawHome = path.join(TMP_RF, 'openclaw');
    const feedbackDir = path.join(openclawHome, 'feedback');
    const responsesPath = path.join(feedbackDir, 'signal-responses.json');
    const env = { ...process.env, OPENCLAW_HOME: openclawHome };

    await fs.ensureDir(feedbackDir);
    const fakeResponses = [
      { type: 'capability_gap',    slug: 'resp-filter', status: 'resolved', response: { ok: 1 }, processed: false, timestamp: new Date().toISOString() },
      { type: 'agent_communication', slug: 'resp-filter', status: 'resolved', response: { ok: 2 }, processed: false, timestamp: new Date().toISOString() },
    ];
    fs.writeFileSync(responsesPath, JSON.stringify(fakeResponses, null, 2));

    // Filter to agent_communication only
    const out = execSync(`node "${syncScript}" responses agent_communication`, { encoding: 'utf-8', cwd: skillDir, env });
    const result = JSON.parse(out);
    assert.strictEqual(result.total, 1, 'type filter must return only matching responses');
    assert.strictEqual(result.responses[0].type, 'agent_communication', 'returned response must match type filter');

    // capability_gap entry must remain unprocessed (not touched by type-filtered consume)
    const stored = JSON.parse(fs.readFileSync(responsesPath, 'utf-8'));
    assert.ok(stored[0].processed === false, 'capability_gap must remain unprocessed when type filter excludes it');
    assert.ok(stored[1].processed === true,  'agent_communication must be marked processed');

    await fs.remove(TMP_RF);
  });

  it('state-sync.js emitSignal marks matching response as processed', async () => {
    const persona = {
      personaName: 'EmitConsumeTest',
      slug: 'emit-consume',
      bio: 'emit+consume loop tester',
      personality: 'thorough',
      speakingStyle: 'Precise',
    };
    const TMP_EC = path.join(require('os').tmpdir(), 'op-test-emit-consume-' + Date.now());
    await fs.ensureDir(TMP_EC);
    const { skillDir } = await generate(persona, TMP_EC);

    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');
    const openclawHome = path.join(TMP_EC, 'openclaw');
    const feedbackDir = path.join(openclawHome, 'feedback');
    const responsesPath = path.join(feedbackDir, 'signal-responses.json');
    const env = { ...process.env, OPENCLAW_HOME: openclawHome };

    await fs.ensureDir(feedbackDir);
    // Pre-seed a resolved capability_gap response for this persona
    fs.writeFileSync(responsesPath, JSON.stringify([
      { type: 'capability_gap', slug: 'emit-consume', status: 'resolved',
        response: { capability: 'web_search', message: 'Installed.' }, processed: false,
        timestamp: new Date().toISOString() },
    ], null, 2));

    // Emit a capability_gap signal — emitSignal should find and return the pending response
    const out = execSync(`node "${syncScript}" signal capability_gap '{"need":"web_search"}'`, {
      encoding: 'utf-8', cwd: skillDir, env,
    });
    const result = JSON.parse(out);
    assert.strictEqual(result.success, true, 'signal emit must succeed');
    assert.ok(result.response !== null, 'emitSignal must return the pending host response');
    assert.strictEqual(result.response.status, 'resolved', 'returned response status must be resolved');

    // The response must now be marked as processed in the file
    const stored = JSON.parse(fs.readFileSync(responsesPath, 'utf-8'));
    assert.ok(stored[0].processed === true, 'emitSignal must mark the consumed response as processed:true');

    await fs.remove(TMP_EC);
  });
});

describe('body.interface schema and generation', () => {
  const TMP_BI = path.join(require('os').tmpdir(), 'op-test-body-interface');

  it('soul-state.schema.json contains pendingCommands and eventLog fields', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'evolution', 'soul-state.schema.json'), 'utf-8'));
    assert.ok('pendingCommands' in schema.properties, 'soul-state.schema.json must declare pendingCommands property');
    assert.ok('eventLog' in schema.properties, 'soul-state.schema.json must declare eventLog property');
    assert.ok('speakingStyleDrift' in schema.properties, 'soul-state.schema.json must declare speakingStyleDrift property');
    assert.ok('stateHistory' in schema.properties, 'soul-state.schema.json must declare stateHistory property');
    assert.ok('version' in schema.properties, 'soul-state.schema.json must declare version property');
    assert.strictEqual(schema.properties.pendingCommands.type, 'array', 'pendingCommands must be an array');
    assert.strictEqual(schema.properties.eventLog.type, 'array', 'eventLog must be an array');
    assert.strictEqual(schema.properties.eventLog.maxItems, 50, 'eventLog must have maxItems 50');
  });

  it('body.interface declared → hasInterfaceConfig true + Interface Contract block in SKILL.md', async () => {
    const persona = {
      personaName: 'InterfaceTest',
      slug: 'interface-test',
      bio: 'tests body.interface config rendering',
      personality: 'methodical',
      speakingStyle: 'Precise',
      body: {
        runtime: { platform: 'openclaw', channels: ['chat'] },
        interface: {
          signals: { enabled: true, allowedTypes: ['capability_gap', 'tool_missing'] },
          pendingCommands: { enabled: false },
        },
      },
    };
    await fs.ensureDir(TMP_BI);
    const { skillDir } = await generate(persona, TMP_BI);
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    assert.ok(skillMd.includes('Interface Contract'), 'SKILL.md must contain Interface Contract section when body.interface is declared');
    assert.ok(skillMd.includes('capability_gap, tool_missing'), 'SKILL.md must include signal allowedTypes');
    assert.ok(skillMd.includes('disabled'), 'SKILL.md must show disabled for pendingCommands.enabled=false');

    await fs.remove(TMP_BI);
  });

  it('body.interface not declared → no Interface Contract block in SKILL.md', async () => {
    const persona = {
      personaName: 'NoInterfaceTest',
      slug: 'no-interface-test',
      bio: 'tests absence of body.interface config',
      personality: 'methodical',
      speakingStyle: 'Precise',
    };
    await fs.ensureDir(TMP_BI);
    const { skillDir } = await generate(persona, TMP_BI);
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');

    assert.ok(!skillMd.includes('Interface Contract'), 'SKILL.md must NOT contain Interface Contract section when body.interface is absent');

    await fs.remove(TMP_BI);
  });

  it('state-sync.js signal blocked when body.interface.signals.enabled is false', async () => {
    const persona = {
      personaName: 'SignalBlockTest',
      slug: 'signal-block-test',
      bio: 'tests signal enforcement via interface policy',
      personality: 'methodical',
      speakingStyle: 'Precise',
      body: {
        runtime: { platform: 'openclaw', channels: ['chat'] },
        interface: { signals: { enabled: false } },
      },
    };
    await fs.ensureDir(TMP_BI);
    const { skillDir } = await generate(persona, TMP_BI);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    assert.throws(
      () => execSync(`node "${syncScript}" signal capability_gap '{"need":"test"}'`, { encoding: 'utf-8', cwd: skillDir }),
      (err) => err.stderr.includes('Signal blocked') && err.stderr.includes('enabled is false'),
      'signal must be blocked when body.interface.signals.enabled is false'
    );

    await fs.remove(TMP_BI);
  });

  it('state-sync.js signal blocked when type not in body.interface.signals.allowedTypes', async () => {
    const persona = {
      personaName: 'AllowedTypesTest',
      slug: 'allowed-types-test',
      bio: 'tests allowedTypes enforcement',
      personality: 'methodical',
      speakingStyle: 'Precise',
      body: {
        runtime: { platform: 'openclaw', channels: ['chat'] },
        interface: { signals: { enabled: true, allowedTypes: ['capability_gap'] } },
      },
    };
    await fs.ensureDir(TMP_BI);
    const { skillDir } = await generate(persona, TMP_BI);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // Blocked: tool_missing is not in allowedTypes
    assert.throws(
      () => execSync(`node "${syncScript}" signal tool_missing '{"tool":"email"}'`, { encoding: 'utf-8', cwd: skillDir }),
      (err) => err.stderr.includes('Signal blocked') && err.stderr.includes('allowedTypes'),
      'signal must be blocked when type is not in allowedTypes'
    );

    // Allowed: capability_gap is in allowedTypes — should succeed
    const openclawHome = path.join(TMP_BI, 'allowed-types-openclaw');
    const out = execSync(
      `node "${syncScript}" signal capability_gap '{"need":"test"}'`,
      { encoding: 'utf-8', cwd: skillDir, env: { ...process.env, OPENCLAW_HOME: openclawHome } }
    );
    const result = JSON.parse(out);
    assert.strictEqual(result.success, true, 'permitted signal type must succeed');

    await fs.remove(TMP_BI);
  });
});

describe('P17 evolution constraint gate — writeState enforces evolution.boundaries', () => {
  const TMP_P17 = path.join(require('os').tmpdir(), 'op-test-p17-' + Date.now());

  it('immutableTraits: violating evolvedTraits entries are filtered out, compliant entries preserved', async () => {
    const persona = {
      personaName: 'ImmutableTest',
      slug: 'immutable-test',
      bio: 'evolution constraint tester',
      personality: 'steadfast',
      speakingStyle: 'Direct',
      evolution: {
        enabled: true,
        boundaries: { immutableTraits: ['optimism', 'empathy'] },
      },
    };
    await fs.ensureDir(TMP_P17);
    const { skillDir } = await generate(persona, TMP_P17);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // Patch contains two violating traits and one valid trait
    const patch = JSON.stringify({
      evolvedTraits: [
        { trait: 'optimism', value: 0.9 },   // immutable — must be blocked
        { trait: 'empathy', value: 0.8 },     // immutable — must be blocked
        { trait: 'curiosity', value: 0.7 },   // allowed — must be preserved
      ],
    });

    // Write should succeed (exit 0) even with violations — violations are filtered, not hard-rejected
    const result = execSync(`node "${syncScript}" write '${patch}' 2>&1`, {
      encoding: 'utf-8', cwd: skillDir, shell: true,
    });
    assert.ok(result.includes('[evolution-gate]'), 'writeState must emit [evolution-gate] warning for immutableTraits violation');

    // Read back and verify only the allowed trait was persisted
    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    assert.ok(Array.isArray(state.evolvedTraits), 'evolvedTraits must be an array in persisted state');
    const traitNames = state.evolvedTraits.map((e) => (typeof e === 'string' ? e : e.trait));
    assert.ok(!traitNames.includes('optimism'), 'immutable trait "optimism" must NOT be persisted');
    assert.ok(!traitNames.includes('empathy'), 'immutable trait "empathy" must NOT be persisted');
    assert.ok(traitNames.includes('curiosity'), 'allowed trait "curiosity" must be persisted');

    await fs.remove(TMP_P17);
  });

  it('formality bounds: speakingStyleDrift.formality below min is clamped to minFormality', async () => {
    const persona = {
      personaName: 'FormalityTest',
      slug: 'formality-test',
      bio: 'formality bound tester',
      personality: 'professional',
      speakingStyle: 'Formal',
      evolution: {
        enabled: true,
        boundaries: { minFormality: 4, maxFormality: 8 },
      },
    };
    await fs.ensureDir(TMP_P17);
    const { skillDir } = await generate(persona, TMP_P17);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // Patch formality below min
    const patch = JSON.stringify({ speakingStyleDrift: { formality: 1 } });
    execSync(`node "${syncScript}" write '${patch}' 2>/dev/null || true`, {
      encoding: 'utf-8', cwd: skillDir, shell: true,
    });

    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    assert.ok(state.speakingStyleDrift, 'speakingStyleDrift must be persisted');
    assert.strictEqual(state.speakingStyleDrift.formality, 4, 'formality must be clamped to minFormality=4');

    await fs.remove(TMP_P17);
  });

  it('formality bounds: speakingStyleDrift.formality above max is clamped to maxFormality', async () => {
    const persona = {
      personaName: 'FormalityMaxTest',
      slug: 'formality-max-test',
      bio: 'formality max bound tester',
      personality: 'professional',
      speakingStyle: 'Formal',
      evolution: {
        enabled: true,
        boundaries: { minFormality: 4, maxFormality: 8 },
      },
    };
    await fs.ensureDir(TMP_P17);
    const { skillDir } = await generate(persona, TMP_P17);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // Patch formality above max
    const patch = JSON.stringify({ speakingStyleDrift: { formality: 10 } });
    execSync(`node "${syncScript}" write '${patch}' 2>/dev/null || true`, {
      encoding: 'utf-8', cwd: skillDir, shell: true,
    });

    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    assert.strictEqual(state.speakingStyleDrift.formality, 8, 'formality must be clamped to maxFormality=8');

    await fs.remove(TMP_P17);
  });

  it('relationship.stage: valid single-step forward progression is accepted (gate active)', async () => {
    const persona = {
      personaName: 'StageForwardTest',
      slug: 'stage-forward-test',
      bio: 'stage progression tester',
      personality: 'warm',
      speakingStyle: 'Friendly',
      evolution: { enabled: true, boundaries: {} },
    };
    await fs.ensureDir(TMP_P17);
    const { skillDir } = await generate(persona, TMP_P17);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // Initial state: stranger → advance to acquaintance (valid single step)
    execSync(`node "${syncScript}" write '${JSON.stringify({ relationship: { stage: 'acquaintance' } })}'`, {
      encoding: 'utf-8', cwd: skillDir,
    });

    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    assert.strictEqual(state.relationship.stage, 'acquaintance', 'valid single-step forward progression must be accepted');

    await fs.remove(TMP_P17);
  });

  it('relationship.stage: stage reversal is blocked, other relationship fields preserved', async () => {
    const persona = {
      personaName: 'StageBackTest',
      slug: 'stage-back-test',
      bio: 'stage reversal blocker tester',
      personality: 'warm',
      speakingStyle: 'Friendly',
      evolution: { enabled: true, boundaries: {} },
    };
    await fs.ensureDir(TMP_P17);
    const { skillDir } = await generate(persona, TMP_P17);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // First advance to friend
    execSync(`node "${syncScript}" write '${JSON.stringify({ relationship: { stage: 'acquaintance' } })}'`, { encoding: 'utf-8', cwd: skillDir });
    execSync(`node "${syncScript}" write '${JSON.stringify({ relationship: { stage: 'friend' } })}'`, { encoding: 'utf-8', cwd: skillDir });

    // Now attempt reversal to stranger — should be blocked
    const result = execSync(
      `node "${syncScript}" write '${JSON.stringify({ relationship: { stage: 'stranger', interactionCount: 99 } })}' 2>&1 || true`,
      { encoding: 'utf-8', cwd: skillDir, shell: true },
    );
    assert.ok(result.includes('[evolution-gate]'), 'stage reversal must emit [evolution-gate] warning');

    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    assert.strictEqual(state.relationship.stage, 'friend', 'stage must remain at "friend" after reversal is blocked');
    assert.strictEqual(state.relationship.interactionCount, 99, 'non-stage relationship fields must still be applied');

    await fs.remove(TMP_P17);
  });

  it('relationship.stage: skipping stages is blocked', async () => {
    const persona = {
      personaName: 'StageSkipTest',
      slug: 'stage-skip-test',
      bio: 'stage skip blocker tester',
      personality: 'warm',
      speakingStyle: 'Friendly',
      evolution: { enabled: true, boundaries: {} },
    };
    await fs.ensureDir(TMP_P17);
    const { skillDir } = await generate(persona, TMP_P17);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // Initial: stranger — attempt to skip to friend (skipping acquaintance)
    const result = execSync(
      `node "${syncScript}" write '${JSON.stringify({ relationship: { stage: 'friend' } })}' 2>&1 || true`,
      { encoding: 'utf-8', cwd: skillDir, shell: true },
    );
    assert.ok(result.includes('[evolution-gate]'), 'stage skip must emit [evolution-gate] warning');

    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    assert.strictEqual(state.relationship.stage, 'stranger', 'stage must remain at "stranger" after skip attempt is blocked');

    await fs.remove(TMP_P17);
  });

  it('immutableTraits: all traits blocked → existing evolvedTraits are NOT wiped', async () => {
    const persona = {
      personaName: 'AllBlockedTest',
      slug: 'all-blocked-test',
      bio: 'all-immutable trait tester',
      personality: 'steadfast',
      speakingStyle: 'Direct',
      evolution: {
        enabled: true,
        boundaries: { immutableTraits: ['optimism', 'empathy'] },
      },
    };
    await fs.ensureDir(TMP_P17);
    const { skillDir } = await generate(persona, TMP_P17);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // First write: establish existing evolved traits
    execSync(`node "${syncScript}" write '${JSON.stringify({ evolvedTraits: [{ trait: 'curiosity', value: 0.7 }] })}'`, {
      encoding: 'utf-8', cwd: skillDir,
    });

    // Second write: only immutable traits — all will be filtered, key should be dropped entirely
    execSync(`node "${syncScript}" write '${JSON.stringify({ evolvedTraits: [{ trait: 'optimism', value: 0.9 }, { trait: 'empathy', value: 0.8 }] })}' 2>/dev/null || true`, {
      encoding: 'utf-8', cwd: skillDir, shell: true,
    });

    // Existing 'curiosity' trait must still be present — empty array must NOT have replaced it
    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    assert.ok(Array.isArray(state.evolvedTraits), 'evolvedTraits must remain an array');
    const traitNames = state.evolvedTraits.map((e) => (typeof e === 'string' ? e : e.trait));
    assert.ok(traitNames.includes('curiosity'), 'pre-existing trait "curiosity" must NOT be wiped when all patch traits are blocked');
    assert.ok(!traitNames.includes('optimism'), 'blocked immutable trait must not appear');

    await fs.remove(TMP_P17);
  });

  it('relationship.stage: unknown current stage → any valid proposed stage is accepted', async () => {
    const persona = {
      personaName: 'UnknownStageTest',
      slug: 'unknown-stage-test',
      bio: 'unknown stage recovery tester',
      personality: 'resilient',
      speakingStyle: 'Direct',
      evolution: { enabled: true, boundaries: {} },
    };
    await fs.ensureDir(TMP_P17);
    const { skillDir } = await generate(persona, TMP_P17);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // Manually corrupt the stage to an unknown value
    const statePath = require('path').join(skillDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.relationship = { ...state.relationship, stage: 'custom_unknown_stage' };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    // Any valid stage should be accepted — gate must not over-block when current is unknown
    execSync(`node "${syncScript}" write '${JSON.stringify({ relationship: { stage: 'friend' } })}'`, {
      encoding: 'utf-8', cwd: skillDir,
    });

    const after = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    assert.strictEqual(after.relationship.stage, 'friend', 'valid stage must be accepted when current stage is unknown');

    await fs.remove(TMP_P17);
  });

  it('formality bounds: negative minFormality — below-baseline value is accepted', async () => {
    const persona = {
      personaName: 'NegBoundsTest',
      slug: 'neg-bounds-test',
      bio: 'below-baseline formality tester',
      personality: 'casual',
      speakingStyle: 'Relaxed',
      evolution: {
        enabled: true,
        boundaries: { minFormality: -3, maxFormality: 2 },
      },
    };
    await fs.ensureDir(TMP_P17);
    const { skillDir } = await generate(persona, TMP_P17);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // -2 is within [-3, 2] — must pass through unchanged
    execSync(`node "${syncScript}" write '${JSON.stringify({ speakingStyleDrift: { formality: -2 } })}'`, {
      encoding: 'utf-8', cwd: skillDir,
    });
    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    assert.strictEqual(state.speakingStyleDrift.formality, -2, 'below-baseline value within bounds must be accepted');

    // -5 is below min (-3) — must be clamped to -3
    execSync(`node "${syncScript}" write '${JSON.stringify({ speakingStyleDrift: { formality: -5 } })}' 2>/dev/null || true`, {
      encoding: 'utf-8', cwd: skillDir, shell: true,
    });
    const state2 = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    assert.strictEqual(state2.speakingStyleDrift.formality, -3, 'value below negative min must be clamped to minFormality=-3');

    await fs.remove(TMP_P17);
  });

  it('no evolution.boundaries → writeState passes through all fields unchanged', async () => {
    const persona = {
      personaName: 'NoBoundsTest',
      slug: 'no-bounds-test',
      bio: 'no-boundaries passthrough tester',
      personality: 'flexible',
      speakingStyle: 'Casual',
      evolution: { enabled: true },
    };
    await fs.ensureDir(TMP_P17);
    const { skillDir } = await generate(persona, TMP_P17);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // Patch with all constrained fields — should all pass through unmodified
    const patch = JSON.stringify({
      evolvedTraits: [{ trait: 'anything', value: 0.9 }],
      speakingStyleDrift: { formality: 1 },
      relationship: { stage: 'intimate' },
    });
    execSync(`node "${syncScript}" write '${patch}'`, { encoding: 'utf-8', cwd: skillDir });

    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    assert.strictEqual(state.speakingStyleDrift.formality, 1, 'formality must pass through without clamping when no boundaries declared');
    assert.strictEqual(state.relationship.stage, 'intimate', 'stage must pass through without validation when no boundaries declared');

    await fs.remove(TMP_P17);
  });
});

// ── P4-A: Skill Trust Gate — state-sync.js runtime enforcement ────────────

const TMP_TRUST = path.join(require('os').tmpdir(), 'openpersona-test-trust-' + Date.now());

describe('P4-A skill trust gate — state-sync.js runtime enforcement', () => {
  it('capability_unlock below minTrustLevel is blocked and emits [skill-trust-gate] warning', async () => {
    const persona = {
      personaName: 'TrustGateTest',
      slug: 'trust-gate-test',
      bio: 'skill trust gate tester',
      personality: 'strict',
      speakingStyle: 'Precise',
      evolution: { skill: { allowNewInstall: true, minTrustLevel: 'community' } },
    };
    await fs.ensureDir(TMP_TRUST);
    const { skillDir } = await generate(persona, TMP_TRUST);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // Write a capability_unlock command with trust: 'unverified' (below 'community' threshold)
    const patch = JSON.stringify({
      pendingCommands: [{ type: 'capability_unlock', payload: { skill: 'dodgy-skill', trust: 'unverified' }, source: 'host' }],
    });
    const output = execSync(
      `node "${syncScript}" write '${patch}' 2>&1 || true`,
      { encoding: 'utf-8', cwd: skillDir, shell: true },
    );
    assert.ok(output.includes('[skill-trust-gate]'), 'must emit [skill-trust-gate] warning on stderr');
    assert.ok(output.includes('dodgy-skill'), 'warning must name the blocked skill');
    assert.ok(output.includes('trust_below_threshold') || output.includes('unverified'), 'warning must mention trust reason');

    // The command must be absent from state (blocked before write)
    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    const pendingCmds = state.pendingCommands || [];
    const hasBlocked = pendingCmds.some((c) => c.payload && c.payload.skill === 'dodgy-skill');
    assert.ok(!hasBlocked, 'blocked capability_unlock must not appear in state.pendingCommands');

    await fs.remove(TMP_TRUST);
  });

  it('capability_unlock meeting minTrustLevel passes through unchanged', async () => {
    const persona = {
      personaName: 'TrustPassTest',
      slug: 'trust-pass-test',
      bio: 'trust gate pass-through tester',
      personality: 'open',
      speakingStyle: 'Friendly',
      evolution: { skill: { allowNewInstall: true, minTrustLevel: 'community' } },
    };
    await fs.ensureDir(TMP_TRUST);
    const { skillDir } = await generate(persona, TMP_TRUST);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    const patch = JSON.stringify({
      pendingCommands: [{ type: 'capability_unlock', payload: { skill: 'verified-skill', trust: 'verified' }, source: 'host' }],
    });
    execSync(`node "${syncScript}" write '${patch}'`, { encoding: 'utf-8', cwd: skillDir });

    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    const pendingCmds = state.pendingCommands || [];
    const found = pendingCmds.some((c) => c.payload && c.payload.skill === 'verified-skill');
    assert.ok(found, 'capability_unlock with sufficient trust must pass through to state');

    await fs.remove(TMP_TRUST);
  });

  it('capability_unlock with exact minTrustLevel (community → community) passes through', async () => {
    const persona = {
      personaName: 'TrustExactTest',
      slug: 'trust-exact-test',
      bio: 'trust exact threshold tester',
      personality: 'balanced',
      speakingStyle: 'Neutral',
      evolution: { skill: { minTrustLevel: 'community' } },
    };
    await fs.ensureDir(TMP_TRUST);
    const { skillDir } = await generate(persona, TMP_TRUST);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    const patch = JSON.stringify({
      pendingCommands: [{ type: 'capability_unlock', payload: { skill: 'community-skill', trust: 'community' }, source: 'host' }],
    });
    execSync(`node "${syncScript}" write '${patch}'`, { encoding: 'utf-8', cwd: skillDir });

    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    const found = (state.pendingCommands || []).some((c) => c.payload && c.payload.skill === 'community-skill');
    assert.ok(found, 'command at exactly the trust threshold must be accepted');

    await fs.remove(TMP_TRUST);
  });

  it('non-capability_unlock commands are unaffected by trust gate', async () => {
    const persona = {
      personaName: 'TrustOtherCmd',
      slug: 'trust-other-cmd',
      bio: 'trust gate non-capability command tester',
      personality: 'flexible',
      speakingStyle: 'Casual',
      evolution: { skill: { minTrustLevel: 'verified' } },
    };
    await fs.ensureDir(TMP_TRUST);
    const { skillDir } = await generate(persona, TMP_TRUST);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    const patch = JSON.stringify({
      pendingCommands: [{ type: 'context_inject', payload: { message: 'hello' }, source: 'host' }],
    });
    execSync(`node "${syncScript}" write '${patch}'`, { encoding: 'utf-8', cwd: skillDir });

    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    const found = (state.pendingCommands || []).some((c) => c.type === 'context_inject');
    assert.ok(found, 'non-capability_unlock command must pass through regardless of trust gate');

    await fs.remove(TMP_TRUST);
  });

  it('all capability_unlock blocked → pre-existing queue NOT wiped (mirrors P17 evolvedTraits fix)', async () => {
    const persona = {
      personaName: 'TrustWipeGuard',
      slug: 'trust-wipe-guard',
      bio: 'all-blocked wipe prevention tester',
      personality: 'strict',
      speakingStyle: 'Precise',
      evolution: { skill: { minTrustLevel: 'verified' } },
    };
    await fs.ensureDir(TMP_TRUST);
    const { skillDir } = await generate(persona, TMP_TRUST);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    // First write: establish a legitimate verified command in the queue
    execSync(`node "${syncScript}" write '${JSON.stringify({ pendingCommands: [{ type: 'capability_unlock', payload: { skill: 'legit-skill', trust: 'verified' }, source: 'host' }] })}'`, {
      encoding: 'utf-8', cwd: skillDir,
    });

    // Second write: all-unverified batch — should be fully blocked; existing queue preserved
    execSync(
      `node "${syncScript}" write '${JSON.stringify({ pendingCommands: [{ type: 'capability_unlock', payload: { skill: 'dodgy', trust: 'unverified' }, source: 'host' }] })}' 2>/dev/null || true`,
      { encoding: 'utf-8', cwd: skillDir, shell: true },
    );

    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    const cmds = state.pendingCommands || [];
    assert.ok(cmds.some((c) => c.payload && c.payload.skill === 'legit-skill'),
      'pre-existing verified command must NOT be wiped when all new commands are blocked');
    assert.ok(!cmds.some((c) => c.payload && c.payload.skill === 'dodgy'),
      'blocked unverified command must not appear');

    await fs.remove(TMP_TRUST);
  });

  it('no minTrustLevel declared → all capability_unlock commands pass through', async () => {
    const persona = {
      personaName: 'TrustNoPolicy',
      slug: 'trust-no-policy',
      bio: 'no trust policy tester',
      personality: 'permissive',
      speakingStyle: 'Open',
      evolution: { skill: { allowNewInstall: true } },
    };
    await fs.ensureDir(TMP_TRUST);
    const { skillDir } = await generate(persona, TMP_TRUST);
    const { execSync } = require('child_process');
    const syncScript = path.join(skillDir, 'scripts', 'state-sync.js');

    const patch = JSON.stringify({
      pendingCommands: [{ type: 'capability_unlock', payload: { skill: 'any-skill', trust: 'unverified' }, source: 'host' }],
    });
    execSync(`node "${syncScript}" write '${patch}'`, { encoding: 'utf-8', cwd: skillDir });

    const state = JSON.parse(execSync(`node "${syncScript}" read`, { encoding: 'utf-8', cwd: skillDir }));
    const found = (state.pendingCommands || []).some((c) => c.payload && c.payload.skill === 'any-skill');
    assert.ok(found, 'without minTrustLevel policy, all commands must pass through');

    await fs.remove(TMP_TRUST);
  });
});
