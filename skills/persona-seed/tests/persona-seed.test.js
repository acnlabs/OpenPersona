'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const matraix = require('../providers/matraix-persona-1m/provider');
const { mapSeedToPersona, slugify } = require('../scripts/map-seed-to-persona');
const { writeProvenance } = require('../scripts/write-provenance');
const { run: runPipeline } = require('../scripts/run-pipeline');
const { validate } = require('../scripts/prepare-corpus');
const { generate } = require('../../../lib/generator');

describe('persona-seed / matraix-persona-1m', () => {
  it('capabilities exposes fixture mode by default', () => {
    const caps = matraix.capabilities();
    assert.equal(caps.id, 'matraix-persona-1m');
    assert.equal(caps.corpusMode, 'fixture');
    assert.match(caps.dataset, /fixtures\/sample-corpus/);
  });

  it('search filters by domain and traits', () => {
    const hits = matraix.search({
      domain: ['software'],
      traits: ['precise'],
      limit: 5,
    });
    assert.ok(hits.length >= 1);
    assert.ok(hits.some((h) => h.id === 'fixture-001'));
    assert.ok(hits[0].score > 0);
  });

  it('search returns empty when positive filters match nothing', () => {
    const hits = matraix.search({ domain: ['astrobiology'], limit: 5 });
    assert.deepEqual(hits, []);
  });

  it('search hard-excludes matches and does not fall back to full corpus', () => {
    const hits = matraix.search({ exclude: ['software'], limit: 10 });
    assert.ok(hits.length >= 1);
    assert.ok(!hits.some((h) => h.id === 'fixture-001'));
    assert.ok(!hits.some((h) => h.id === 'fixture-005'));
  });

  it('toSeed fills gaps and fixture provenance', () => {
    const seed = matraix.toSeed(matraix.fetch('fixture-001'));
    assert.equal(seed.schemaVersion, '0.1.0');
    assert.equal(seed.provenance.provider, 'matraix-persona-1m');
    assert.equal(seed.provenance.recordId, 'fixture-001');
    assert.equal(seed.provenance.corpusMode, 'fixture');
    assert.match(seed.provenance.dataset, /fixtures\/sample-corpus/);
    assert.ok(seed.identity.summary.length > 0);
    assert.ok(seed.gaps.includes('personaName'));
    assert.ok(seed.gaps.includes('role'));
  });

  it('healthcare seed flags sensitive domain', () => {
    const seed = matraix.toSeed(matraix.fetch('fixture-003'));
    assert.ok(seed.constraints.sensitiveFlags.includes('healthcare_domain'));
  });
});

describe('persona-seed / mapper + provenance', () => {
  let tmp;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-seed-'));
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('mapSeedToPersona requires personaName', () => {
    const seed = matraix.toSeed(matraix.fetch('fixture-002'));
    assert.throws(() => mapSeedToPersona(seed, {}), /personaName/);
  });

  it('mapSeedToPersona emits required soul fields', () => {
    const seed = matraix.toSeed(matraix.fetch('fixture-002'));
    const persona = mapSeedToPersona(seed, {
      personaName: 'Coach Ada',
      slug: 'coach-ada',
      role: 'mentor',
    });
    assert.equal(persona.soul.identity.personaName, 'Coach Ada');
    assert.equal(persona.soul.identity.slug, 'coach-ada');
    assert.equal(persona.soul.identity.role, 'mentor');
    assert.ok(persona.soul.character.personality);
    assert.ok(persona.soul.character.speakingStyle);
    assert.ok(persona.evolution.instance.enabled);
  });

  it('slugify keeps ascii and hashes non-latin names', () => {
    assert.equal(slugify('Coach Ada'), 'coach-ada');
    const zh = slugify('导师小明');
    assert.match(zh, /^persona-[a-f0-9]{8}$/);
    assert.equal(slugify('导师小明'), zh);
  });

  it('rejects disallowed overrides.extra root keys', () => {
    const seed = matraix.toSeed(matraix.fetch('fixture-002'));
    assert.throws(
      () =>
        mapSeedToPersona(seed, {
          personaName: 'X',
          extra: { soul: { identity: {} } },
        }),
      /disallowed root key/
    );
  });

  it('writeProvenance writes soul/seed-provenance.json', () => {
    const seed = matraix.toSeed(matraix.fetch('fixture-001'));
    const packDir = path.join(tmp, 'pack');
    const out = writeProvenance(packDir, seed);
    assert.equal(path.basename(out), 'seed-provenance.json');
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(written.provider, 'matraix-persona-1m');
    assert.equal(written.recordId, 'fixture-001');
    assert.equal(written.corpusMode, 'fixture');
  });

  it('mapped persona passes generate gate', async () => {
    const seed = matraix.toSeed(matraix.fetch('fixture-001'));
    const persona = mapSeedToPersona(seed, {
      personaName: 'Seeded Gate',
      slug: 'seeded-gate-e2e',
      role: 'assistant',
    });
    const outDir = path.join(tmp, 'gen');
    fs.mkdirSync(outDir, { recursive: true });
    const { skillDir } = await generate(persona, outDir);
    assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(skillDir, 'persona.json')));
    assert.ok(fs.existsSync(path.join(skillDir, 'soul', 'injection.md')));
    writeProvenance(skillDir, seed);
    const prov = JSON.parse(
      fs.readFileSync(path.join(skillDir, 'soul', 'seed-provenance.json'), 'utf8')
    );
    assert.equal(prov.recordId, 'fixture-001');
    assert.equal(prov.corpusMode, 'fixture');
  });
});

describe('persona-seed / run-pipeline', () => {
  it('search → seed → map → generate → provenance', async () => {
    const out = path.join(os.tmpdir(), `persona-seed-pipeline-${Date.now()}`);
    const result = await runPipeline({
      intent: JSON.stringify({ domain: ['software'], traits: ['precise'], limit: 3 }),
      name: 'Pipeline Nova',
      slug: 'pipeline-nova-e2e',
      role: 'assistant',
      out,
    });
    assert.equal(result.recordId, 'fixture-001');
    assert.ok(fs.existsSync(result.skillDir));
    assert.ok(fs.existsSync(result.provenancePath));
    assert.ok(fs.existsSync(path.join(result.skillDir, 'SKILL.md')));
    fs.rmSync(out, { recursive: true, force: true });
  });
});

describe('persona-seed / prepare-corpus', () => {
  it('validates the offline fixture corpus', async () => {
    const fixture = path.join(
      __dirname,
      '..',
      'providers',
      'matraix-persona-1m',
      'fixtures',
      'sample-corpus.json'
    );
    const result = await validate(fixture);
    assert.equal(result.ok, true);
    assert.equal(result.count, 5);
  });
});

describe('persona-seed / jsonl corpus', () => {
  it('search works when MATRAIX_CORPUS_PATH is jsonl', () => {
    const jsonlPath = path.join(os.tmpdir(), `persona-seed-corpus-${Date.now()}.jsonl`);
    const fixture = path.join(
      __dirname,
      '..',
      'providers',
      'matraix-persona-1m',
      'fixtures',
      'sample-corpus.json'
    );
    const rows = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    fs.writeFileSync(jsonlPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const prev = process.env.MATRAIX_CORPUS_PATH;
    process.env.MATRAIX_CORPUS_PATH = jsonlPath;
    matraix.resetCorpusCache();
    try {
      const caps = matraix.capabilities();
      assert.equal(caps.corpusMode, 'external');
      const hits = matraix.search({ domain: ['software'], traits: ['precise'], limit: 3 });
      assert.ok(hits.some((h) => h.id === 'fixture-001'));
    } finally {
      if (prev === undefined) delete process.env.MATRAIX_CORPUS_PATH;
      else process.env.MATRAIX_CORPUS_PATH = prev;
      matraix.resetCorpusCache();
      fs.rmSync(jsonlPath, { force: true });
    }
  });
});
