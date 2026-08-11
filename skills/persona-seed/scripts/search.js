#!/usr/bin/env node
'use strict';

const matraix = require('../providers/matraix-persona-1m/provider');

const PROVIDERS = {
  [matraix.PROVIDER_ID]: matraix,
};

function resolveProvider(id) {
  const key = id || matraix.PROVIDER_ID;
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new Error(
      `Unknown provider "${key}". Registered: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }
  return provider;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--intent' || a === '--id' || a === '--provider' || a === '--out') {
      out[a.slice(2)] = argv[++i];
    } else if (a === '--fetch') {
      out.fetch = true;
    } else if (a === '--to-seed') {
      out.toSeed = true;
    } else if (a === '--capabilities') {
      out.capabilities = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider = resolveProvider(args.provider);

  if (args.capabilities) {
    process.stdout.write(`${JSON.stringify(provider.capabilities(), null, 2)}\n`);
    return;
  }

  if (args.fetch || args.toSeed) {
    const id = args.id || args._[0];
    if (!id) throw new Error('fetch/to-seed requires --id <recordId>');
    const raw = provider.fetch(id);
    const payload = args.toSeed ? provider.toSeed(raw) : raw;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  let intent = {};
  if (args.intent) {
    intent = JSON.parse(args.intent.startsWith('{') ? args.intent : require('fs').readFileSync(args.intent, 'utf8'));
  } else if (args._[0]) {
    intent = { query: args._.join(' '), limit: 5 };
  }

  if (args.provider) intent.provider = args.provider;
  const results = provider.search(intent);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { PROVIDERS, resolveProvider };
