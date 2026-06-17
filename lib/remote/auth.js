/**
 * CLI buyer authentication — Auth0 Device Authorization Flow.
 *
 * docs/MARKETPLACE-GATED-DELIVERY.md §6.0a: the buyer identity is single-sourced
 * to Auth0. For CLI installs of paid closed-source packs (`op://private/...`),
 * the CLI obtains an Auth0 access token via the OAuth 2.0 Device Authorization
 * Grant (RFC 8628) and stores it locally. The token is later forwarded as a
 * Bearer to the OP gateway `deliver` endpoint, which verifies it against Auth0
 * (same audience as Store) and derives `buyer_id` from `sub`.
 *
 * No browser-redirect handling is needed: the user visits a verification URL,
 * approves, and the CLI polls the token endpoint.
 *
 * Config (env):
 *   OPENPERSONA_AUTH0_DOMAIN     e.g. your-tenant.us.auth0.com  (or *_ISSUER)
 *   OPENPERSONA_AUTH0_CLIENT_ID  native app with device flow enabled
 *   OPENPERSONA_AUTH0_AUDIENCE   default https://api.agentplanet.org
 *
 * The HTTP transport, clock and sleep are injectable for testing.
 */
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const https = require('https');

const DEFAULT_AUDIENCE = 'https://api.agentplanet.org';
const DEFAULT_SCOPE = 'openid profile offline_access';

function opHome() {
  return process.env.OPENPERSONA_HOME || path.join(os.homedir(), '.openpersona');
}

/** Absolute path to the local credential store. */
function authFilePath() {
  return path.join(opHome(), 'auth.json');
}

/**
 * Resolve Auth0 config from env. Returns null when not configured (callers emit
 * a friendly "set OPENPERSONA_AUTH0_* / contact the marketplace operator" hint).
 */
function resolveAuthConfig(env = process.env) {
  let domain = env.OPENPERSONA_AUTH0_DOMAIN || env.OPENPERSONA_AUTH0_ISSUER || '';
  domain = String(domain).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const clientId = env.OPENPERSONA_AUTH0_CLIENT_ID;
  if (!domain || !clientId) return null;
  return {
    domain,
    clientId,
    audience: env.OPENPERSONA_AUTH0_AUDIENCE || DEFAULT_AUDIENCE,
    scope: env.OPENPERSONA_AUTH0_SCOPE || DEFAULT_SCOPE,
  };
}

// ── credential store ────────────────────────────────────────────────────────

function loadAuth() {
  try {
    return fs.readJsonSync(authFilePath());
  } catch (_) {
    return null;
  }
}

function saveAuth(data) {
  const file = authFilePath();
  fs.ensureDirSync(path.dirname(file));
  fs.writeJsonSync(file, data, { spaces: 2 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort on non-POSIX */ }
  return file;
}

function clearAuth() {
  try { fs.removeSync(authFilePath()); return true; } catch (_) { return false; }
}

/** Treat a token as expired 60s before its real expiry (clock-skew margin). */
function isExpired(auth, now = Date.now()) {
  if (!auth || !auth.access_token) return true;
  if (!auth.expires_at) return false; // no expiry recorded → assume usable
  return now >= auth.expires_at - 60_000;
}

// ── HTTP (form-urlencoded POST to Auth0) ──────────────────────────────────────

function postForm(urlStr, form) {
  const body = new URLSearchParams(form).toString();
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : {}; } catch (_) { json = { raw: data }; }
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the device authorization flow to completion.
 *
 * @param {object} [opts]
 * @param {object} [opts.config]  - resolved Auth0 config (defaults to env)
 * @param {(line:string)=>void} [opts.onPrompt] - shows the verification URL/code
 * @param {function} [opts._post]  - injectable POST(url, form) → {status, json}
 * @param {function} [opts._sleep] - injectable sleep(ms)
 * @param {function} [opts._now]   - injectable () => epoch ms
 * @returns {Promise<object>} the saved credential record
 */
async function deviceLogin(opts = {}) {
  const config = opts.config || resolveAuthConfig();
  if (!config) {
    throw new Error(
      'Auth0 is not configured for this CLI. Set OPENPERSONA_AUTH0_DOMAIN and ' +
      'OPENPERSONA_AUTH0_CLIENT_ID (and optionally OPENPERSONA_AUTH0_AUDIENCE), ' +
      'or ask the marketplace operator for the buyer login app.',
    );
  }
  const post = opts._post || postForm;
  const nap = opts._sleep || sleep;
  const now = opts._now || Date.now;
  const onPrompt = opts.onPrompt || ((l) => process.stdout.write(l + '\n'));

  // 1. Request a device + user code.
  const dc = await post(`https://${config.domain}/oauth/device/code`, {
    client_id: config.clientId,
    scope: config.scope,
    audience: config.audience,
  });
  if (dc.status < 200 || dc.status >= 300 || !dc.json || !dc.json.device_code) {
    const msg = (dc.json && (dc.json.error_description || dc.json.error)) || `HTTP ${dc.status}`;
    throw new Error(`Could not start device login: ${msg}`);
  }
  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    expires_in = 900,
  } = dc.json;
  let interval = (dc.json.interval || 5) * 1000;

  onPrompt('To sign in, open this URL in your browser:');
  onPrompt(`  ${verification_uri_complete || verification_uri}`);
  if (user_code) onPrompt(`Confirm this code is shown: ${user_code}`);
  onPrompt('Waiting for approval...');

  // 2. Poll the token endpoint until the user approves (or it expires).
  const deadline = now() + expires_in * 1000;
  while (now() < deadline) {
    await nap(interval);
    const tok = await post(`https://${config.domain}/oauth/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code,
      client_id: config.clientId,
    });
    if (tok.status >= 200 && tok.status < 300 && tok.json && tok.json.access_token) {
      const t = tok.json;
      const record = {
        access_token: t.access_token,
        refresh_token: t.refresh_token || null,
        id_token: t.id_token || null,
        token_type: t.token_type || 'Bearer',
        scope: t.scope || config.scope,
        audience: config.audience,
        expires_at: t.expires_in ? now() + t.expires_in * 1000 : null,
        obtained_at: new Date(now()).toISOString(),
      };
      saveAuth(record);
      return record;
    }
    const err = tok.json && tok.json.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5000; continue; }
    if (err === 'expired_token') throw new Error('Login timed out — please run `openpersona login` again.');
    if (err === 'access_denied') throw new Error('Login was denied.');
    const msg = (tok.json && (tok.json.error_description || tok.json.error)) || `HTTP ${tok.status}`;
    throw new Error(`Device login failed: ${msg}`);
  }
  throw new Error('Login timed out — please run `openpersona login` again.');
}

/**
 * Refresh an access token using a stored refresh_token. Returns the updated
 * record, or null when refresh is impossible/declined.
 */
async function refreshToken(auth, opts = {}) {
  const config = opts.config || resolveAuthConfig();
  if (!config || !auth || !auth.refresh_token) return null;
  const post = opts._post || postForm;
  const now = opts._now || Date.now;
  const tok = await post(`https://${config.domain}/oauth/token`, {
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: auth.refresh_token,
  });
  if (tok.status < 200 || tok.status >= 300 || !tok.json || !tok.json.access_token) return null;
  const t = tok.json;
  const record = {
    ...auth,
    access_token: t.access_token,
    refresh_token: t.refresh_token || auth.refresh_token,
    id_token: t.id_token || auth.id_token || null,
    token_type: t.token_type || 'Bearer',
    scope: t.scope || auth.scope,
    expires_at: t.expires_in ? now() + t.expires_in * 1000 : null,
    obtained_at: new Date(now()).toISOString(),
  };
  saveAuth(record);
  return record;
}

/**
 * Return a currently-valid access token (refreshing if needed), or null when
 * the user is not logged in / cannot be refreshed.
 */
async function getAccessToken(opts = {}) {
  const now = opts._now || Date.now;
  let auth = opts._auth || loadAuth();
  if (!auth || !auth.access_token) return null;
  if (!isExpired(auth, now())) return auth.access_token;
  const refreshed = await refreshToken(auth, opts);
  return refreshed ? refreshed.access_token : null;
}

module.exports = {
  DEFAULT_AUDIENCE,
  authFilePath,
  resolveAuthConfig,
  loadAuth,
  saveAuth,
  clearAuth,
  isExpired,
  deviceLogin,
  refreshToken,
  getAccessToken,
};
