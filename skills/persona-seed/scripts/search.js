#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {
  listProviders,
  resolveProvider,
  seedCapableRepos,
  loadRegistry,
} = require('./registry');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (
      a === '--intent' ||
      a === '--id' ||
      a === '--provider' ||
      a === '--repo' ||
      a === '--out'
    ) {
      out[a.slice(2)] = argv[++i];
    } else if (a === '--fetch') {
      out.fetch = true;
    } else if (a === '--to-seed') {
      out.toSeed = true;
    } else if (a === '--capabilities') {
      out.capabilities = true;
    } else if (a === '--list-providers') {
      out.listProviders = true;
    } else if (a === '--seed-capable') {
      out.seedCapable = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.listProviders) {
    const reg = loadRegistry();
    process.stdout.write(
      `${JSON.stringify(
        {
          defaultProvider: reg.raw.defaultProvider,
          families: reg.raw.families,
          providers: listProviders(),
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (args.seedCapable) {
    process.stdout.write(`${JSON.stringify(seedCapableRepos(), null, 2)}\n`);
    return;
  }

  const idOrRepo = args.provider || args.repo;
  const { entry, provider } = resolveProvider(idOrRepo);

  if (args.capabilities) {
    const caps = {
      ...provider.capabilities(),
      registry: {
        id: entry.id,
        family: entry.family,
        status: entry.status,
        hfRepos: entry.hfRepos || [],
        directoryUrls: entry.directoryUrls || [],
      },
    };
    process.stdout.write(`${JSON.stringify(caps, null, 2)}\n`);
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
    intent = JSON.parse(
      args.intent.startsWith('{') ? args.intent : fs.readFileSync(args.intent, 'utf8')
    );
  } else if (args._[0]) {
    intent = { query: args._.join(' '), limit: 5 };
  }

  if (entry.id) intent.provider = entry.id;
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

module.exports = {
  resolveProvider: (id) => resolveProvider(id).provider,
  resolveProviderWithEntry: resolveProvider,
  listProviders,
  seedCapableRepos,
};
