'use strict';

/**
 * OpenPersona - Private pack listing (producer side)
 *
 * The OP asset-layer half of the paid-pack listing flow
 * (docs/MARKETPLACE-GATED-DELIVERY.md §2.3a + §2.6):
 *
 *   export/fork → sanitize gate → upload to private storage → pack_ref
 *
 * `registerProduct` is the thin Store-registration helper (§5
 * `POST /api/store/persona/products`). It is gateway-side (requires the
 * internal token) and kept here as an injectable unit so the co-located
 * gateway can reuse the same code path; it is NOT wired into the seller CLI,
 * which only produces + uploads bytes and prints the resulting pack_ref.
 */

const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { exportPersona } = require('../lifecycle/porter');
const { assertPackSanitized, uploadPack, resolveStoreConfig } = require('./private-store');
const { resolveSoulFile } = require('../utils');

const DEFAULT_VERSION = '0.1.0';

/**
 * Resolve the version to publish under, from persona.json (or an override).
 * @param {string} packDir
 * @param {string} [override]
 * @returns {string}
 */
function resolvePackVersion(packDir, override) {
  if (override && String(override).trim()) return String(override).trim();
  try {
    const personaPath = resolveSoulFile(packDir, 'persona.json');
    if (fs.existsSync(personaPath)) {
      const persona = JSON.parse(fs.readFileSync(personaPath, 'utf-8'));
      if (typeof persona.version === 'string' && persona.version.trim()) {
        return persona.version.trim();
      }
    }
  } catch { /* fall through to default */ }
  return DEFAULT_VERSION;
}

/**
 * Resolve the slug to publish under, from persona.json (or an override).
 */
function resolvePackSlug(packDir, override) {
  if (override && String(override).trim()) return String(override).trim();
  const personaPath = resolveSoulFile(packDir, 'persona.json');
  if (!fs.existsSync(personaPath)) {
    throw new Error('persona.json not found in pack directory');
  }
  const persona = JSON.parse(fs.readFileSync(personaPath, 'utf-8'));
  if (!persona.slug) throw new Error('persona.json is missing "slug"');
  return persona.slug;
}

/**
 * Produce a sanitized pack zip from an installed persona directory.
 * exportPersona already strips gitignored runtime files; assertPackSanitized is
 * the hard gate that proves it (docs §2.5) before any upload.
 *
 * @param {string} packDir
 * @param {string} [outZip] - destination zip (defaults to a tmp file)
 * @returns {string} path to the produced, sanitized zip
 */
function producePackZip(packDir, outZip) {
  const dest = outZip || path.join(os.tmpdir(), `op-list-${Date.now()}.zip`);
  const zip = exportPersona(packDir, dest);
  assertPackSanitized(zip);
  return zip;
}

/**
 * Produce + sanitize + upload a private pack, returning its pack_ref.
 *
 * @param {object} opts
 * @param {string} opts.packDir - installed persona pack directory
 * @param {string} [opts.slug] - overrides persona.json slug
 * @param {string} [opts.version] - overrides persona.json version
 * @param {string} [opts.region] - 'global' | 'cn'
 * @param {string} [opts.zipOut] - keep the produced zip at this path
 * @param {object} [opts.env]
 * @param {object} [opts._client] - injected S3 client (tests)
 * @param {object} [opts._commands] - injected S3 command classes (tests)
 * @returns {Promise<{ packRef, key, slug, version, region, bucket, zipPath }>}
 */
async function publishPrivatePack(opts = {}) {
  const { packDir, region, env, zipOut, _client, _commands } = opts;
  if (!packDir) throw new Error('publishPrivatePack requires packDir');
  if (!fs.existsSync(packDir)) throw new Error(`Pack directory not found: ${packDir}`);

  const slug = resolvePackSlug(packDir, opts.slug);
  const version = resolvePackVersion(packDir, opts.version);

  // Fail fast on missing storage config before producing the zip.
  resolveStoreConfig(region, env);

  const zipPath = producePackZip(packDir, zipOut);
  try {
    const result = await uploadPack({ slug, version, zipPath, region, env, _client, _commands });
    return { ...result, slug, version, zipPath: zipOut ? zipPath : null };
  } finally {
    // Clean up the tmp zip unless the caller asked to keep it.
    if (!zipOut) { try { await fs.remove(zipPath); } catch { /* ignore */ } }
  }
}

/**
 * Register a listed pack with Store (`POST /api/store/persona/products`, §5).
 * Gateway-side: requires the internal token. `extraFields` carries commerce
 * fields owned by Store/the gateway (price, currency, preview, …) — OP does
 * not hardcode them.
 *
 * @param {object} opts
 * @param {string} opts.storeEndpoint - base Store API (e.g. https://store/api/store)
 * @param {string} opts.internalToken - X-Internal-Token value
 * @param {string} opts.packRef
 * @param {string} opts.slug
 * @param {string} opts.version
 * @param {object} [opts.extraFields] - commerce passthrough fields
 * @param {function} [opts._post] - injected POST(url, headers, body) → {status, json} (tests)
 * @returns {Promise<object>} Store response JSON
 */
async function registerProduct(opts = {}) {
  const { storeEndpoint, internalToken, packRef, slug, version, extraFields = {}, _post } = opts;
  if (!storeEndpoint) throw new Error('registerProduct requires storeEndpoint');
  if (!internalToken) throw new Error('registerProduct requires internalToken');
  if (!packRef) throw new Error('registerProduct requires packRef');

  const url = `${storeEndpoint.replace(/\/+$/, '')}/persona/products`;
  const body = { pack_ref: packRef, slug, version, ...extraFields };
  const headers = { 'Content-Type': 'application/json', 'X-Internal-Token': internalToken };

  const post = _post || httpPostJson;
  const res = await post(url, headers, body);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Store product registration failed (HTTP ${res.status})${res.text ? ': ' + res.text : ''}`);
  }
  return res.json;
}

/**
 * Minimal JSON POST with redirect-free single hop.
 * @returns {Promise<{status:number, json:object|null, text:string}>}
 */
function httpPostJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const payload = JSON.stringify(body);
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'openpersona-cli' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = {
  DEFAULT_VERSION,
  resolvePackVersion,
  resolvePackSlug,
  producePackZip,
  publishPrivatePack,
  registerProduct,
};
