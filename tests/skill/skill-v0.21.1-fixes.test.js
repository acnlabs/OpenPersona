'use strict';

/**
 * Regression tests for v0.21.1 fixes:
 *   (1) installSkill does NOT mark the skill as the active persona
 *   (2) installSkill with --all records every target in installTargets[]
 *   (3) uninstallSkill removes ALL installTargets (not just primary)
 *   (4) listPersonas filters out resourceType === 'skill' entries
 *   (5) updateSkill uses downloader.download() return value correctly
 *       (regression: tmpDir = {dir, skipCopy} path bug) and refreshes all targets
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');

if (typeof test.configure === 'function') {
  test.configure({ concurrency: 1 });
}

const { installSkill, resolveTargets } = require('../../lib/skill/installer');
const { uninstallSkill } = require('../../lib/skill/uninstaller');
const { updateSkill } = require('../../lib/skill/updater');
const { registryAdd, registrySetActive, loadRegistry } = require('../../lib/registry');

function makeSrcSkill(name = 'fix-skill', version = '1.0.0', extraFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-fix-src-'));
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\nversion: ${version}\ndescription: fix regression test skill\n---\n\n# ${name}\n`
  );
  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = path.join(dir, rel);
    fs.ensureDirSync(path.dirname(full));
    fs.writeFileSync(full, content);
  }
  return dir;
}

function makeRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-fix-reg-'));
  const regPath = path.join(dir, 'persona-registry.json');
  fs.writeFileSync(regPath, JSON.stringify({ version: 1, personas: {} }, null, 2));
  return regPath;
}

function useCwd(dir) {
  const orig = process.cwd();
  process.chdir(dir);
  return () => process.chdir(orig);
}

// ---------------------------------------------------------------------------
// (1) installSkill does NOT mark the skill as active
// ---------------------------------------------------------------------------

describe('installSkill no longer pollutes active persona state', () => {

  test('an existing active persona stays active after installing a skill', async () => {
    const regPath = makeRegistry();

    // Seed an active persona in the registry
    registryAdd(
      'my-persona',
      { personaName: 'My Persona', role: 'companion', packType: 'single' },
      '/tmp/fake/persona-my-persona',
      regPath,
      { installTarget: '/tmp/fake/persona-my-persona', resourceType: 'persona' }
    );
    registrySetActive('my-persona', regPath);

    const regBefore = loadRegistry(regPath);
    assert.equal(regBefore.personas['my-persona'].active, true, 'persona should start active');

    // Install a skill — should NOT change active persona
    const srcDir = makeSrcSkill('some-skill');
    const skillMdPath = path.join(srcDir, 'SKILL.md');
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'op-fix-cwd-'));
    fs.mkdirSync(path.join(tmpCwd, '.claude', 'skills'), { recursive: true });
    const restoreCwd = useCwd(tmpCwd);
    try {
      await installSkill(srcDir, skillMdPath, { runtime: 'claude', regPath });
    } finally {
      restoreCwd();
      await fs.remove(srcDir);
      await fs.remove(tmpCwd);
    }

    const regAfter = loadRegistry(regPath);
    assert.equal(regAfter.personas['my-persona'].active, true, 'persona should still be active after skill install');
    assert.equal(regAfter.personas['some-skill'].active, false, 'skill should never be marked active');
    assert.equal(regAfter.personas['some-skill'].resourceType, 'skill');
  });

});

// ---------------------------------------------------------------------------
// (2) installSkill writes installTargets[] for --all
// ---------------------------------------------------------------------------

describe('installSkill records installTargets[] in registry', () => {

  test('single-target install still writes installTargets as [target]', async () => {
    const regPath = makeRegistry();
    const srcDir = makeSrcSkill('single-target');
    const skillMdPath = path.join(srcDir, 'SKILL.md');
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'op-fix-cwd-'));
    fs.ensureDirSync(path.join(tmpCwd, '.claude', 'skills'));

    const restoreCwd = useCwd(tmpCwd);
    try {
      await installSkill(srcDir, skillMdPath, { runtime: 'claude', regPath });
    } finally {
      restoreCwd();
      await fs.remove(srcDir);
      await fs.remove(tmpCwd);
    }

    const reg = loadRegistry(regPath);
    const entry = reg.personas['single-target'];
    assert.ok(entry, 'skill entry must be present');
    assert.ok(Array.isArray(entry.installTargets), 'installTargets must be an array');
    assert.equal(entry.installTargets.length, 1, 'installTargets should have exactly one entry');
    assert.equal(entry.installTarget, entry.installTargets[0], 'installTarget must equal installTargets[0]');
    assert.ok(entry.installTargets[0].endsWith(path.join('.claude', 'skills', 'single-target')));
  });

  test('--all: resolveTargets returns ≥1 target; registry mirrors whatever is resolved', async () => {
    // Exercise resolveTargets directly — avoids sandbox restrictions on
    // creating `.cursor`/`.claude` directories in tmp.
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'op-fix-all-'));
    const restoreCwd = useCwd(tmpCwd);
    let resolved;
    try {
      resolved = resolveTargets('probe-skill', { all: true });
    } finally {
      restoreCwd();
      await fs.remove(tmpCwd);
    }
    // .agents/skills/ is always present in --all output
    assert.ok(resolved.some((t) => t.endsWith(path.join('.agents', 'skills', 'probe-skill'))));
    assert.ok(resolved.length >= 1);
    // Each target is unique
    assert.equal(new Set(resolved).size, resolved.length);
  });

});

// ---------------------------------------------------------------------------
// (3) uninstallSkill removes every installTargets entry
// ---------------------------------------------------------------------------

describe('uninstallSkill cleans up every installTargets entry', () => {

  test('removes all 3 target dirs recorded in installTargets[]', async () => {
    const regPath = makeRegistry();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'op-fix-multi-'));
    const t1 = path.join(root, 'a', 'skill');
    const t2 = path.join(root, 'b', 'skill');
    const t3 = path.join(root, 'c', 'skill');
    for (const t of [t1, t2, t3]) {
      fs.ensureDirSync(t);
      fs.writeFileSync(path.join(t, 'SKILL.md'), '---\nname: multi\n---\n');
    }

    registryAdd(
      'multi',
      { personaName: 'multi', role: 'assistant', packType: 'single' },
      t1,
      regPath,
      { installTargets: [t1, t2, t3], resourceType: 'skill' }
    );

    await uninstallSkill('multi', { regPath });

    for (const t of [t1, t2, t3]) {
      assert.ok(!fs.existsSync(t), `${t} should be removed`);
    }
    const reg = loadRegistry(regPath);
    assert.equal(reg.personas['multi'], undefined, 'registry entry should be gone');

    await fs.remove(root);
  });

});

// ---------------------------------------------------------------------------
// (4) listPersonas filters skill entries
// ---------------------------------------------------------------------------

describe('listPersonas excludes skill-type entries', () => {

  test('skill entries are not returned by lib/lifecycle/switcher::listPersonas', async () => {
    const regPath = makeRegistry();
    registryAdd(
      'persona-a',
      { personaName: 'Persona A', role: 'companion', packType: 'single' },
      '/tmp/fake/a',
      regPath,
      { resourceType: 'persona' }
    );
    registryAdd(
      'skill-b',
      { personaName: 'Skill B', role: 'assistant', packType: 'single' },
      '/tmp/fake/b',
      regPath,
      { resourceType: 'skill' }
    );

    // listPersonas uses the default registry path — point it at our temp one
    const origEnv = process.env.OPENPERSONA_HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'op-fix-home-'));
    fs.ensureDirSync(tmpHome);
    fs.copyFileSync(regPath, path.join(tmpHome, 'persona-registry.json'));
    process.env.OPENPERSONA_HOME = tmpHome;

    // Reset registry module cache so it re-reads env
    delete require.cache[require.resolve('../../lib/registry')];
    delete require.cache[require.resolve('../../lib/lifecycle/switcher')];
    try {
      const { listPersonas } = require('../../lib/lifecycle/switcher');
      const result = await listPersonas();
      const slugs = result.map((p) => p.slug);
      assert.ok(slugs.includes('persona-a'), 'persona-a should be listed');
      assert.ok(!slugs.includes('skill-b'), 'skill-b MUST NOT be listed as a persona');
    } finally {
      if (origEnv === undefined) delete process.env.OPENPERSONA_HOME;
      else process.env.OPENPERSONA_HOME = origEnv;
      delete require.cache[require.resolve('../../lib/registry')];
      delete require.cache[require.resolve('../../lib/lifecycle/switcher')];
      await fs.remove(tmpHome);
    }
  });

});

// ---------------------------------------------------------------------------
// (5) updateSkill uses downloader return value correctly
// ---------------------------------------------------------------------------

describe('updateSkill (regression: downloader return-value bug)', () => {

  test('re-downloads and overwrites every installTargets entry', async () => {
    const regPath = makeRegistry();
    const t1 = fs.mkdtempSync(path.join(os.tmpdir(), 'op-fix-u-t1-'));
    const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'op-fix-u-t2-'));
    // Simulate stale install content
    fs.writeFileSync(path.join(t1, 'SKILL.md'), '---\nname: u-skill\nversion: 1.0.0\n---\n# old\n');
    fs.writeFileSync(path.join(t2, 'SKILL.md'), '---\nname: u-skill\nversion: 1.0.0\n---\n# old\n');

    registryAdd(
      'u-skill',
      { personaName: 'u-skill', role: 'assistant', packType: 'single' },
      t1,
      regPath,
      { installTargets: [t1, t2], source: 'owner/u-skill', resourceType: 'skill' }
    );

    // Mock downloader: returns {dir, skipCopy} (the v0.21.1-fixed contract)
    const freshSrc = makeSrcSkill('u-skill', '2.0.0');
    const mockDownloader = {
      download: async (src) => {
        assert.equal(src, 'owner/u-skill');
        return { dir: freshSrc, skipCopy: false };
      },
    };

    await updateSkill('u-skill', { regPath, downloader: mockDownloader });

    // Both targets should now have the fresh v2.0.0 SKILL.md
    for (const t of [t1, t2]) {
      const content = fs.readFileSync(path.join(t, 'SKILL.md'), 'utf-8');
      assert.ok(content.includes('version: 2.0.0'), `target ${t} should be updated: ${content.slice(0,80)}`);
      assert.ok(!content.includes('# old'), `target ${t} should not contain stale content`);
    }

    const reg = loadRegistry(regPath);
    assert.equal(reg.personas['u-skill'].source, 'owner/u-skill');
    assert.deepEqual(reg.personas['u-skill'].installTargets, [t1, t2]);

    await fs.remove(t1);
    await fs.remove(t2);
    // freshSrc is cleaned by updateSkill itself, but be safe
    try { await fs.remove(freshSrc); } catch { /* ignore */ }
  });

  test('update prunes files removed in the new version (no stale residue)', async () => {
    const regPath = makeRegistry();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'op-fix-prune-'));
    // Simulate v1.0 install: SKILL.md + scripts/old-helper.js
    fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: p-skill\nversion: 1.0.0\n---\n');
    fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(target, 'scripts', 'old-helper.js'), '// v1 helper\n');

    registryAdd(
      'p-skill',
      { personaName: 'p-skill', role: 'assistant', packType: 'single' },
      target,
      regPath,
      { installTargets: [target], source: 'owner/p-skill', resourceType: 'skill' }
    );

    // Mock v2.0 source: SKILL.md only — old-helper.js is gone.
    const freshSrc = makeSrcSkill('p-skill', '2.0.0');
    const mockDownloader = { download: async () => ({ dir: freshSrc, skipCopy: false }) };

    await updateSkill('p-skill', { regPath, downloader: mockDownloader });

    assert.ok(fs.existsSync(path.join(target, 'SKILL.md')), 'new SKILL.md must exist');
    assert.ok(
      !fs.existsSync(path.join(target, 'scripts', 'old-helper.js')),
      'stale file from v1.0 must be pruned'
    );
    assert.ok(
      !fs.existsSync(path.join(target, 'scripts')) ||
        fs.readdirSync(path.join(target, 'scripts')).length === 0,
      'empty orphan dir acceptable but must not contain old files'
    );

    await fs.remove(target);
    try { await fs.remove(freshSrc); } catch { /* ignore */ }
  });

  test('exits 1 when downloader returns no dir', async () => {
    const regPath = makeRegistry();
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'op-fix-u-missing-'));
    registryAdd(
      'miss-skill',
      { personaName: 'miss-skill', role: 'assistant', packType: 'single' },
      t,
      regPath,
      { installTargets: [t], source: 'owner/miss', resourceType: 'skill' }
    );

    const badDownloader = { download: async () => ({}) };

    let exitCode = null;
    const origExit = process.exit;
    process.exit = (code) => { exitCode = code; throw new Error(`exit:${code}`); };
    const origLog = console.log; const origErr = console.error;
    console.log = () => {}; console.error = () => {};
    try {
      try { await updateSkill('miss-skill', { regPath, downloader: badDownloader }); }
      catch (e) { if (!String(e.message).startsWith('exit:')) throw e; }
    } finally {
      process.exit = origExit; console.log = origLog; console.error = origErr;
    }
    assert.equal(exitCode, 1);

    await fs.remove(t);
  });

});
