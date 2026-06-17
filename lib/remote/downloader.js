/**
 * OpenPersona - Download persona pack from registry or GitHub
 */
const path = require('path');
const fs = require('fs-extra');
const { printInfo, OP_SKILLS_DIR, validateName, OPENPERSONA_DIRECTORY, OPENPERSONA_SKILLS_REGISTRY } = require('../utils');
const { parsePackRef } = require('./private-store');

const TMP_DIR = path.join(require('os').tmpdir(), 'openpersona-dl');
const OFFICIAL_REGISTRY = OPENPERSONA_SKILLS_REGISTRY;
const REGISTRY_LISTING = OPENPERSONA_DIRECTORY;

/**
 * Returns true if `dir` contains a valid skill pack root:
 *   - persona.json (OpenPersona format), OR
 *   - soul/persona.json (OpenPersona legacy), OR
 *   - SKILL.md (universal agent skill pack format)
 */
function isValidPackRoot(dir) {
  const hasSkillMd =
    fs.existsSync(path.join(dir, 'SKILL.md')) ||
    fs.existsSync(path.join(dir, 'SKILL', 'SKILL.md')) ||
    fs.existsSync(path.join(dir, 'skill', 'SKILL.md'));
  return (
    fs.existsSync(path.join(dir, 'persona.json')) ||
    fs.existsSync(path.join(dir, 'soul', 'persona.json')) ||
    hasSkillMd
  );
}

async function download(target, registry = 'acnlabs', options = {}) {
  await fs.ensureDir(TMP_DIR);
  const outDir = path.join(TMP_DIR, `persona-${Date.now()}`);

  // op://private/<slug>[@<version>] → gated private delivery (paid closed-source).
  // Checked BEFORE the '/' branch because the ref contains slashes.
  if (target.startsWith('op://')) {
    const dir = await downloadPrivate(target, outDir, options);
    return { dir, skipCopy: false };
  }

  // owner/repo format → GitHub
  if (target.includes('/')) {
    const [ownerRepo, subPathRaw] = target.split('#', 2);
    const subPath = subPathRaw ? subPathRaw.replace(/^\/+|\/+$/g, '') : null;
    const dir = await downloadFromGitHub(ownerRepo, outDir, subPath);
    return { dir, skipCopy: false };
  }
  return await downloadFromRegistry(target, registry, outDir);
}

async function downloadFromRegistry(slug, registry, outDir) {
  if (registry === 'acnlabs' || registry === 'clawhub') {
    validateName(slug, 'slug');

    printInfo(`Downloading persona "${slug}" from acnlabs/persona-skills...`);
    const zipPath = path.join(TMP_DIR, `persona-skills-${Date.now()}.zip`);
    try {
      await downloadZip(OFFICIAL_REGISTRY, zipPath);
    } catch (e) {
      throw new Error(`Failed to reach persona registry: ${e.message}`);
    }

    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    const extractDir = path.join(TMP_DIR, `persona-skills-extract-${Date.now()}`);
    zip.extractAllTo(extractDir, true);
    try { fs.unlinkSync(zipPath); } catch (_) {}

    // The zip extracts as a single root folder (e.g. persona-skills-main/)
    const entries = fs.readdirSync(extractDir);
    const repoRoot = entries.length === 1
      ? path.join(extractDir, entries[0])
      : extractDir;

    const slugDir = path.join(repoRoot, slug);
    if (!fs.existsSync(slugDir) || !isValidPackRoot(slugDir)) {
      await fs.remove(extractDir).catch(() => {});
      throw new Error(
        `Persona "${slug}" not found in the official registry.\n` +
        `Browse available personas at ${REGISTRY_LISTING}`
      );
    }

    await fs.copy(slugDir, outDir);
    // Clean up the full registry archive — only the target persona was needed
    await fs.remove(extractDir).catch(() => {});
    return { dir: outDir, skipCopy: false };
  }
  throw new Error(`Unsupported registry: ${registry}`);
}

async function downloadFromGitHub(ownerRepo, outDir, subPath = null) {
  // Validate owner/repo format to prevent URL injection
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(ownerRepo)) {
    throw new Error(`Invalid GitHub repo format: "${ownerRepo}" — expected owner/repo`);
  }

  // Try main branch first, fall back to master — mirrors registry.js validateRepo behaviour
  const branches = ['main', 'master'];
  const zipPath = path.join(TMP_DIR, `repo-${Date.now()}.zip`);
  let lastError;
  for (const branch of branches) {
    const url = `https://github.com/${ownerRepo}/archive/refs/heads/${branch}.zip`;
    try {
      await downloadZip(url, zipPath);
      lastError = null;
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(outDir, true);
      try { fs.unlinkSync(zipPath); } catch (_) {}

      const baseName = path.basename(ownerRepo);
      const extracted = path.join(outDir, `${baseName}-${branch}`);
      if (!fs.existsSync(extracted)) {
        const entries = fs.readdirSync(outDir);
        const found = entries.find((e) => {
          const p = path.join(outDir, e);
          return fs.statSync(p).isDirectory() && isValidPackRoot(p);
        });
        if (found) return path.join(outDir, found);
        throw new Error('Not a valid skill pack: neither persona.json nor SKILL.md found');
      }

      if (subPath) {
        const selected = path.join(extracted, subPath);
        if (!fs.existsSync(selected) || !isValidPackRoot(selected)) {
          throw new Error(`Requested subpath "${subPath}" is not a valid skill pack in ${ownerRepo}`);
        }
        return selected;
      }

      if (!isValidPackRoot(extracted)) {
        const subdirs = fs.readdirSync(extracted)
          .filter((d) => {
            const p = path.join(extracted, d);
            return fs.statSync(p).isDirectory() && isValidPackRoot(p);
          });
        if (subdirs.length === 1) return path.join(extracted, subdirs[0]);
        if (subdirs.length > 1) {
          const sample = subdirs.slice(0, 5).map((d) => `  - ${ownerRepo}#${d}`).join('\n');
          throw new Error(
            `Multiple skill packs detected in ${ownerRepo}. Please specify which one to install using #subpath.\n` +
            `Examples:\n${sample}`
          );
        }
        throw new Error('Not a valid skill pack: neither persona.json nor SKILL.md found');
      }
      return extracted;
    } catch (e) {
      try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (_) {}
      lastError = e;
    }
  }
  throw lastError || new Error(`Failed to download ${ownerRepo}`);
}

/**
 * Gated private delivery (docs/MARKETPLACE-GATED-DELIVERY.md §2.3c).
 *
 * Resolves an `op://private/<slug>[@<version>]` reference through the OP
 * gateway `deliver` endpoint, which calls Store `redeem` and returns a
 * short-lived presigned URL. The bytes never pass through Store — this client
 * only consumes the presigned URL and installs the resulting zip.
 *
 * Entitlement context (order id + authenticated session) is required and is
 * taken from options or environment — never minted here.
 *
 * @param {string} target - op://private/<slug>[@<version>]
 * @param {string} outDir
 * @param {object} [options]
 * @param {string} [options.deliverEndpoint] - overrides OPENPERSONA_DELIVER_ENDPOINT
 * @param {string} [options.orderId] - overrides OPENPERSONA_ORDER_ID
 * @param {string} [options.token] - overrides OPENPERSONA_TOKEN (bearer)
 * @returns {Promise<string>} Path to the extracted pack root
 */
async function downloadPrivate(target, outDir, options = {}) {
  const { slug, version } = parsePackRef(target);

  const deliverEndpoint = options.deliverEndpoint
    || process.env.OPENPERSONA_DELIVER_ENDPOINT
    || `${OPENPERSONA_DIRECTORY}/api/persona/deliver`;
  const orderId = options.orderId || process.env.OPENPERSONA_ORDER_ID;
  let token = options.token || process.env.OPENPERSONA_TOKEN;
  // Fall back to the locally stored Auth0 login token (`openpersona login`).
  if (!token) {
    try { token = await require('./auth').getAccessToken(); } catch (_) { /* not logged in */ }
  }

  if (!orderId) {
    throw new Error(
      `Private pack "${slug}" requires a purchase.\n` +
      `Download it from your "My Purchases" page, or pass --order <id> (with \`openpersona login\`) to install via CLI.`
    );
  }
  if (!token) {
    throw new Error(
      `Private pack "${slug}" requires a signed-in buyer.\n` +
      `Run \`openpersona login\` first, or set OPENPERSONA_TOKEN to a valid buyer token.`
    );
  }

  const url = new URL(deliverEndpoint);
  url.searchParams.set('order_id', orderId);
  url.searchParams.set('slug', slug);
  if (version) url.searchParams.set('version', version);

  printInfo(`Redeeming entitlement for "${slug}"...`);
  const delivery = await fetchJson(url.toString(), token);
  if (!delivery || !delivery.url) {
    throw new Error('Delivery endpoint did not return a download URL.');
  }

  const zipPath = path.join(TMP_DIR, `private-${Date.now()}.zip`);
  await downloadZip(delivery.url, zipPath);

  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(outDir, true);
  try { fs.unlinkSync(zipPath); } catch (_) {}

  if (isValidPackRoot(outDir)) return outDir;
  // zip may wrap the pack in a single subfolder
  const entries = fs.readdirSync(outDir).filter((e) => {
    const p = path.join(outDir, e);
    return fs.statSync(p).isDirectory() && isValidPackRoot(p);
  });
  if (entries.length === 1) return path.join(outDir, entries[0]);
  throw new Error('Delivered archive is not a valid persona pack (no persona.json or SKILL.md found).');
}

/**
 * GET JSON from a URL with an optional bearer token, following redirects.
 */
function fetchJson(url, token) {
  return new Promise((resolve, reject) => {
    const MAX_HOPS = 5;
    const follow = (u, hops) => {
      if (hops > MAX_HOPS) {
        reject(new Error(`Too many redirects (>${MAX_HOPS}) fetching ${url}`));
        return;
      }
      const mod = u.startsWith('https') ? require('https') : require('http');
      const headers = { 'User-Agent': 'OpenPersona/1.0', Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      mod.get(u, { headers }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          follow(res.headers.location, hops + 1);
          return;
        }
        if (res.statusCode === 403) { reject(new Error('Delivery denied (403) — entitlement does not match the authenticated buyer.')); return; }
        if (res.statusCode === 409) { reject(new Error('Order refunded (409) — entitlement is void.')); return; }
        if (res.statusCode === 429) { reject(new Error('Download limit reached (429) — max redemptions exceeded.')); return; }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} from ${u}`)); return; }
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Invalid JSON from delivery endpoint: ${e.message}`)); }
        });
      }).on('error', reject);
    };
    follow(url, 0);
  });
}

/**
 * Download a file from a URL (follows redirects) and save to dest path.
 */
function downloadZip(url, dest) {
  return new Promise((resolve, reject) => {
    const MAX_HOPS = 5;
    const follow = (u, hops) => {
      if (hops > MAX_HOPS) {
        reject(new Error(`Too many redirects (>${MAX_HOPS}) downloading ${url}`));
        return;
      }
      const mod = u.startsWith('https') ? require('https') : require('http');
      mod.get(u, { headers: { 'User-Agent': 'OpenPersona/1.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          follow(res.headers.location, hops + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${u}`));
          return;
        }
        const file = require('fs').createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url, 0);
  });
}

module.exports = { download };
