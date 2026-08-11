'use strict';

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', 'providers', 'registry.json');

let cached = null;

function loadRegistry(registryPath = REGISTRY_PATH) {
  if (cached && registryPath === REGISTRY_PATH) return cached;
  const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (!Array.isArray(raw.providers)) {
    throw new Error('persona-seed registry.json missing providers[]');
  }
  const byId = new Map();
  const byHf = new Map();
  for (const entry of raw.providers) {
    if (!entry.id || !entry.module) {
      throw new Error('registry provider entries require id and module');
    }
    if (byId.has(entry.id)) {
      throw new Error(`duplicate provider id in registry: ${entry.id}`);
    }
    byId.set(entry.id, entry);
    for (const repo of entry.hfRepos || []) {
      const key = String(repo).toLowerCase();
      if (byHf.has(key)) {
        throw new Error(`hfRepo ${repo} mapped to multiple providers`);
      }
      byHf.set(key, entry);
    }
  }
  const loaded = { raw, byId, byHf, path: registryPath };
  if (registryPath === REGISTRY_PATH) cached = loaded;
  return loaded;
}

function resetRegistryCache() {
  cached = null;
}

function listProviders(opts = {}) {
  const { raw } = loadRegistry(opts.registryPath);
  return raw.providers.filter((p) => {
    if (opts.status && p.status !== opts.status) return false;
    if (opts.family && p.family !== opts.family) return false;
    return true;
  });
}

function resolveEntry(idOrRepo, opts = {}) {
  const reg = loadRegistry(opts.registryPath);
  if (!idOrRepo) {
    const def = reg.raw.defaultProvider;
    const entry = reg.byId.get(def);
    if (!entry) throw new Error(`defaultProvider "${def}" not in registry`);
    return entry;
  }
  if (reg.byId.has(idOrRepo)) return reg.byId.get(idOrRepo);
  const hfKey = String(idOrRepo).toLowerCase();
  if (reg.byHf.has(hfKey)) return reg.byHf.get(hfKey);
  throw new Error(
    `Unknown provider or hfRepo "${idOrRepo}". Known ids: ${[...reg.byId.keys()].join(', ')}`
  );
}

function loadProviderModule(entry, opts = {}) {
  const base = path.dirname(opts.registryPath || REGISTRY_PATH);
  const modPath = path.resolve(base, entry.module);
  // Fresh require path resolution; cache is node module cache (fine for CLI)
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(modPath);
}

function resolveProvider(idOrRepo, opts = {}) {
  const entry = resolveEntry(idOrRepo, opts);
  const mod = loadProviderModule(entry, opts);
  return { entry, provider: mod };
}

function seedCapableRepos(opts = {}) {
  return listProviders(opts).flatMap((p) =>
    (p.hfRepos || []).map((repo) => ({
      repo,
      providerId: p.id,
      family: p.family,
      status: p.status,
      directoryUrls: p.directoryUrls || [],
    }))
  );
}

module.exports = {
  REGISTRY_PATH,
  loadRegistry,
  resetRegistryCache,
  listProviders,
  resolveEntry,
  resolveProvider,
  seedCapableRepos,
};
