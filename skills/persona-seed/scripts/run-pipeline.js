#!/usr/bin/env node
'use strict';

/**
 * End-to-end: search → toSeed → map → generate → write provenance.
 * Usage:
 *   node run-pipeline.js --intent '{"domain":["software"],"traits":["precise"]}' \
 *     --name "Seeded Nova" --slug seeded-nova --role assistant --out /tmp/op-seed-out
 *
 * Or pick a record:
 *   node run-pipeline.js --id fixture-001 --name "Seeded Nova" --slug seeded-nova --out /tmp/op-seed-out
 *   node run-pipeline.js --repo MatrAIx2026/MatrAIx_Persona_1M --id fixture-001 --name "…" --out /tmp/out
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { resolveProviderWithEntry } = require('./search');
const { mapSeedToPersona } = require('./map-seed-to-persona');
const { writeProvenance } = require('./write-provenance');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (
      a === '--intent' ||
      a === '--id' ||
      a === '--provider' ||
      a === '--repo' ||
      a === '--name' ||
      a === '--slug' ||
      a === '--role' ||
      a === '--out' ||
      a === '--overrides'
    ) {
      out[a.slice(2)] = argv[++i];
    } else if (a === '--dry-map') {
      out.dryMap = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function run(args) {
  const { entry, provider } = resolveProviderWithEntry(args.provider || args.repo);
  let recordId = args.id;

  if (!recordId) {
    let intent = {};
    if (args.intent) {
      intent = JSON.parse(
        args.intent.startsWith('{') ? args.intent : fs.readFileSync(args.intent, 'utf8')
      );
    } else if (args._[0]) {
      intent = { query: args._.join(' '), limit: 5 };
    } else {
      intent = { limit: 5 };
    }
    intent.limit = intent.limit || 5;
    const hits = provider.search(intent);
    if (!hits.length) {
      throw new Error('search returned no candidates; broaden intent or pass --id');
    }
    recordId = hits[0].id;
    process.stderr.write(
      `[persona-seed] search top=${recordId} score=${hits[0].score} (${hits.length} hit(s))\n`
    );
  }

  if (!args.name) {
    throw new Error('--name <personaName> is required');
  }

  const raw = provider.fetch(recordId);
  const seed = provider.toSeed(raw);

  let overrides = {
    personaName: args.name,
    slug: args.slug,
    role: args.role || 'assistant',
  };
  if (args.overrides) {
    const extra = JSON.parse(
      args.overrides.startsWith('{') ? args.overrides : fs.readFileSync(args.overrides, 'utf8')
    );
    overrides = { ...overrides, ...extra, personaName: args.name || extra.personaName };
    if (args.slug) overrides.slug = args.slug;
    if (args.role) overrides.role = args.role;
  }

  const persona = mapSeedToPersona(seed, overrides);
  const outRoot = path.resolve(args.out || path.join(os.tmpdir(), 'persona-seed-pipeline'));
  fs.mkdirSync(outRoot, { recursive: true });

  const seedPath = path.join(outRoot, 'seed-profile.json');
  const personaPath = path.join(outRoot, 'persona.json');
  fs.writeFileSync(seedPath, `${JSON.stringify(seed, null, 2)}\n`);
  fs.writeFileSync(personaPath, `${JSON.stringify(persona, null, 2)}\n`);

  if (args.dryMap) {
    return { seedPath, personaPath, recordId, dryMap: true };
  }

  // Lazy-require generator so --dry-map works without full framework load side effects in odd envs
  const { generate } = require(path.resolve(__dirname, '../../../lib/generator'));
  const { skillDir } = await generate(persona, outRoot);
  const provenancePath = writeProvenance(skillDir, seed);

  return {
    recordId,
    providerId: entry.id,
    family: entry.family,
    seedPath,
    personaPath,
    skillDir,
    provenancePath,
    corpusMode: seed.provenance.corpusMode,
    slug: persona.soul.identity.slug,
  };
}

if (require.main === module) {
  run(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { run };
