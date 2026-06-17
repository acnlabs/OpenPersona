'use strict';

/**
 * OpenPersona - Private pack storage (S3-compatible, dual-region)
 *
 * Server-side helper for the paid/closed-source gated-delivery flow
 * (docs/MARKETPLACE-GATED-DELIVERY.md §2). Used by the upload (listing) flow
 * and the gateway `deliver` endpoint — NOT by the end-user CLI install path
 * (which only consumes the presigned URL produced here).
 *
 * Design goals:
 *  - One S3 SDK, two regions. R2 (global) and MinIO (cn → future COS) are all
 *    S3-compatible; only endpoint + credentials differ, never the driver.
 *  - Lean CLI: `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` are
 *    lazy-required, so a normal `openpersona install` never loads the SDK.
 *    Server/deploy environments must install these packages.
 *  - Testable without a real bucket or network: the S3 client and presigner
 *    can be injected (`_client` / `_presign`), and the pure helpers
 *    (parsePackRef / packRefToKey / assertPackSanitized / resolveStoreConfig)
 *    require neither.
 *
 * `pack_ref` contract (docs §2.4): op://private/<slug>@<version>
 * Object key convention (docs §2.3a): <slug>/<version>.zip
 */

const fs = require('fs-extra');
const { validateName } = require('../utils');

// Forbidden runtime artefacts that must never ship inside a listed paid pack.
// Mirrors the generator's .gitignore (lib/generator/index.js) — the export/fork
// flows already strip these, this is the hard gate that proves it before upload.
// docs §2.5 "脱敏强制".
const SANITIZE_FORBIDDEN = Object.freeze([
  'state.json',
  'acn-registration.json',
  'handoff.json',
  'soul/self-narrative.md',
  'social/contacts.json',
  'social/contacts.jsonl',
  'social/.poller-cursor.json',
]);

const DEFAULT_PRESIGN_EXPIRY_SECONDS = 300; // 5 minutes — docs §2.3b

class SanitizationError extends Error {
  constructor(offenders) {
    super(
      `Pack is not sanitized — found forbidden runtime files: ${offenders.join(', ')}.\n` +
      `Re-run \`openpersona export\` (or \`fork\`) to strip state/registration/self-narrative before listing a paid pack.`
    );
    this.name = 'SanitizationError';
    this.offenders = offenders;
  }
}

// ---------------------------------------------------------------------------
// pack_ref helpers (pure, no SDK / network)
// ---------------------------------------------------------------------------

/**
 * Parse an `op://private/<slug>[@<version>]` reference.
 * @param {string} packRef
 * @returns {{ slug: string, version: string|null }}
 */
function parsePackRef(packRef) {
  if (typeof packRef !== 'string' || !packRef.startsWith('op://')) {
    throw new Error(`Invalid pack_ref: "${packRef}" — expected op://private/<slug>[@<version>]`);
  }
  const rest = packRef.slice('op://'.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) {
    throw new Error(`Invalid pack_ref: "${packRef}" — missing namespace/slug`);
  }
  const namespace = rest.slice(0, slashIdx);
  if (namespace !== 'private') {
    throw new Error(`Unsupported pack_ref namespace: "${namespace}" — only op://private/ is supported`);
  }
  const tail = rest.slice(slashIdx + 1);
  if (!tail) {
    throw new Error(`Invalid pack_ref: "${packRef}" — missing slug`);
  }
  const atIdx = tail.indexOf('@');
  const slug = atIdx === -1 ? tail : tail.slice(0, atIdx);
  const version = atIdx === -1 ? null : tail.slice(atIdx + 1);
  validateName(slug, 'slug');
  if (version !== null && !version) {
    throw new Error(`Invalid pack_ref: "${packRef}" — empty version after '@'`);
  }
  return { slug, version };
}

/**
 * Build a canonical pack_ref string.
 * @param {string} slug
 * @param {string} version
 * @returns {string} op://private/<slug>@<version>
 */
function buildPackRef(slug, version) {
  validateName(slug, 'slug');
  if (!version) throw new Error('buildPackRef requires a version');
  return `op://private/${slug}@${version}`;
}

/**
 * Map a pack reference to its object storage key: <slug>/<version>.zip
 * @param {string|{slug:string,version:string}} packRefOrParsed
 * @param {string} [version]
 * @returns {string}
 */
function packRefToKey(packRefOrParsed, version) {
  let slug;
  let ver = version;
  if (typeof packRefOrParsed === 'string') {
    if (packRefOrParsed.startsWith('op://')) {
      const parsed = parsePackRef(packRefOrParsed);
      slug = parsed.slug;
      ver = ver || parsed.version;
    } else {
      slug = validateName(packRefOrParsed, 'slug');
    }
  } else if (packRefOrParsed && typeof packRefOrParsed === 'object') {
    slug = validateName(packRefOrParsed.slug, 'slug');
    ver = ver || packRefOrParsed.version;
  } else {
    throw new Error('packRefToKey: invalid argument');
  }
  if (!ver) throw new Error('packRefToKey requires a version to build the object key');
  return `${slug}/${ver}.zip`;
}

// ---------------------------------------------------------------------------
// Sanitization gate (uses AdmZip on a local zip — no network)
// ---------------------------------------------------------------------------

/**
 * Assert a pack zip does not contain forbidden runtime files (docs §2.5).
 * Throws SanitizationError listing offenders.
 * @param {string} zipPath - Path to the pack zip produced by export/fork
 */
function assertPackSanitized(zipPath) {
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Pack zip not found: ${zipPath}`);
  }
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().map((e) => e.entryName.replace(/^\.\//, '').replace(/\\/g, '/'));
  const forbidden = new Set(SANITIZE_FORBIDDEN);
  const offenders = [];
  for (const name of entries) {
    // Match both root-level and any nested pack root (e.g. "persona-x/state.json")
    const base = name.replace(/\/+$/, '');
    if (forbidden.has(base)) {
      offenders.push(base);
      continue;
    }
    for (const f of forbidden) {
      if (base === f || base.endsWith(`/${f}`)) {
        offenders.push(base);
        break;
      }
    }
  }
  if (offenders.length) {
    throw new SanitizationError([...new Set(offenders)]);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Region config (env-driven, one code path per region)
// ---------------------------------------------------------------------------

const REGION_ENV = Object.freeze({
  global: 'OP_STORE_GLOBAL', // Cloudflare R2
  cn: 'OP_STORE_CN',         // MinIO (→ Tencent COS)
});

/**
 * Resolve S3-compatible storage config for a region from environment.
 * @param {string} [region] - 'global' | 'cn'; defaults to OP_STORE_DEFAULT_REGION or 'global'
 * @param {object} [env=process.env]
 * @returns {{ region, endpoint, bucket, accessKeyId, secretAccessKey, awsRegion, forcePathStyle, publicEndpoint }}
 */
function resolveStoreConfig(region, env = process.env) {
  const r = region || env.OP_STORE_DEFAULT_REGION || 'global';
  const prefix = REGION_ENV[r];
  if (!prefix) {
    throw new Error(`Unknown storage region: "${r}" — expected one of: ${Object.keys(REGION_ENV).join(', ')}`);
  }
  const get = (suffix) => env[`${prefix}_${suffix}`];
  const endpoint = get('ENDPOINT');
  const bucket = get('BUCKET');
  const accessKeyId = get('KEY_ID');
  const secretAccessKey = get('SECRET');
  const missing = [];
  if (!endpoint) missing.push(`${prefix}_ENDPOINT`);
  if (!bucket) missing.push(`${prefix}_BUCKET`);
  if (!accessKeyId) missing.push(`${prefix}_KEY_ID`);
  if (!secretAccessKey) missing.push(`${prefix}_SECRET`);
  if (missing.length) {
    throw new Error(`Missing storage config for region "${r}": set ${missing.join(', ')}`);
  }
  // R2 uses region "auto" + virtual-hosted style; MinIO uses path-style by default.
  const isR2 = r === 'global';
  const awsRegion = get('REGION') || (isR2 ? 'auto' : 'us-east-1');
  const forcePathStyleEnv = get('FORCE_PATH_STYLE');
  const forcePathStyle = forcePathStyleEnv !== undefined
    ? /^(1|true|yes)$/i.test(String(forcePathStyleEnv))
    : !isR2; // MinIO defaults to path-style
  // Public endpoint used for signing so the signed host matches the URL the
  // client can reach (docs §2.3b — MINIO_SERVER_URL behind nginx). Falls back
  // to the operational endpoint.
  const publicEndpoint = get('PUBLIC_ENDPOINT') || endpoint;
  return { region: r, endpoint, bucket, accessKeyId, secretAccessKey, awsRegion, forcePathStyle, publicEndpoint };
}

// ---------------------------------------------------------------------------
// S3 adapter (lazy SDK, injectable for tests)
// ---------------------------------------------------------------------------

function loadS3() {
  try {
    return require('@aws-sdk/client-s3');
  } catch (e) {
    throw new Error(
      'Private storage requires the AWS S3 SDK. Install it in the server/deploy environment:\n' +
      '  npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner'
    );
  }
}

function loadPresigner() {
  try {
    return require('@aws-sdk/s3-request-presigner');
  } catch (e) {
    throw new Error(
      'Presigned URLs require @aws-sdk/s3-request-presigner. Install it in the server/deploy environment:\n' +
      '  npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner'
    );
  }
}

function buildClient(config, _client) {
  if (_client) return _client;
  const { S3Client } = loadS3();
  return new S3Client({
    region: config.awsRegion,
    endpoint: config.publicEndpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

// Resolve S3 command classes — injectable (`opts._commands`) so tests can run
// without the real SDK installed.
function loadCommands(opts = {}) {
  if (opts._commands) return opts._commands;
  const sdk = loadS3();
  return { PutObjectCommand: sdk.PutObjectCommand, GetObjectCommand: sdk.GetObjectCommand };
}

/**
 * Upload a sanitized pack zip to private storage.
 * Always runs the sanitization gate first (docs §2.5) — refuses raw install dirs.
 *
 * @param {object} opts
 * @param {string} opts.slug
 * @param {string} opts.version
 * @param {string} opts.zipPath - Path to the export/fork-produced zip
 * @param {string} [opts.region] - 'global' | 'cn'
 * @param {boolean} [opts.skipSanitizeCheck=false] - escape hatch (NOT recommended)
 * @param {object} [opts.env]
 * @param {object} [opts._client] - injected S3 client (tests)
 * @returns {Promise<{ packRef: string, key: string, region: string, bucket: string }>}
 */
async function uploadPack(opts = {}) {
  const { slug, version, zipPath, region, env, _client } = opts;
  if (!slug) throw new Error('uploadPack requires slug');
  if (!version) throw new Error('uploadPack requires version');
  if (!zipPath) throw new Error('uploadPack requires zipPath');

  if (!opts.skipSanitizeCheck) {
    assertPackSanitized(zipPath);
  }

  const config = resolveStoreConfig(region, env);
  const key = packRefToKey({ slug, version });
  const client = buildClient(config, _client);
  const { PutObjectCommand } = loadCommands(opts);

  const body = await fs.readFile(zipPath);
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: 'application/zip',
  }));

  return { packRef: buildPackRef(slug, version), key, region: config.region, bucket: config.bucket };
}

/**
 * Sign a short-lived GET URL for a stored pack (docs §2.3b).
 *
 * @param {object} opts
 * @param {string} [opts.packRef] - op://private/<slug>@<version>
 * @param {string} [opts.key] - explicit object key (overrides packRef)
 * @param {string} [opts.region] - 'global' | 'cn'
 * @param {number} [opts.expiresIn=300] - seconds
 * @param {object} [opts.env]
 * @param {object} [opts._client] - injected S3 client (tests)
 * @param {function} [opts._presign] - injected getSignedUrl (tests)
 * @returns {Promise<{ url: string, key: string, expiresIn: number, region: string }>}
 */
async function getPresignedUrl(opts = {}) {
  const { packRef, region, env, _client, _presign } = opts;
  const expiresIn = opts.expiresIn || DEFAULT_PRESIGN_EXPIRY_SECONDS;
  let key = opts.key;
  if (!key) {
    if (!packRef) throw new Error('getPresignedUrl requires packRef or key');
    key = packRefToKey(packRef);
  }
  const config = resolveStoreConfig(region, env);
  const client = buildClient(config, _client);
  const { GetObjectCommand } = loadCommands(opts);
  const getSignedUrl = _presign || loadPresigner().getSignedUrl;
  const command = new GetObjectCommand({ Bucket: config.bucket, Key: key });
  const url = await getSignedUrl(client, command, { expiresIn });
  return { url, key, expiresIn, region: config.region };
}

module.exports = {
  SANITIZE_FORBIDDEN,
  DEFAULT_PRESIGN_EXPIRY_SECONDS,
  SanitizationError,
  parsePackRef,
  buildPackRef,
  packRefToKey,
  assertPackSanitized,
  resolveStoreConfig,
  uploadPack,
  getPresignedUrl,
};
