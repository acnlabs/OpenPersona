'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const auth = require('../lib/remote/auth');

let tmpHome;
let origHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'op-auth-'));
  origHome = process.env.OPENPERSONA_HOME;
  process.env.OPENPERSONA_HOME = tmpHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.OPENPERSONA_HOME;
  else process.env.OPENPERSONA_HOME = origHome;
  try { fs.removeSync(tmpHome); } catch (_) { /* ignore */ }
});

const cfg = { domain: 'tenant.us.auth0.com', clientId: 'cli-app', audience: 'https://api.agentplanet.org', scope: 'openid profile offline_access' };

// Build an injectable POST that replays queued responses and records calls.
function queuedPost(responses) {
  const calls = [];
  const fn = async (url, form) => {
    calls.push({ url, form });
    const next = responses.shift();
    if (!next) throw new Error('no more queued responses');
    return next;
  };
  fn.calls = calls;
  return fn;
}

test('resolveAuthConfig: null without required env, strips issuer scheme/slash, defaults', () => {
  assert.equal(auth.resolveAuthConfig({}), null);
  assert.equal(auth.resolveAuthConfig({ OPENPERSONA_AUTH0_DOMAIN: 'x' }), null); // missing client id

  const c = auth.resolveAuthConfig({
    OPENPERSONA_AUTH0_ISSUER: 'https://tenant.us.auth0.com/',
    OPENPERSONA_AUTH0_CLIENT_ID: 'cli-app',
  });
  assert.equal(c.domain, 'tenant.us.auth0.com');
  assert.equal(c.clientId, 'cli-app');
  assert.equal(c.audience, auth.DEFAULT_AUDIENCE);
  assert.match(c.scope, /offline_access/);
});

test('saveAuth/loadAuth/clearAuth round-trip under OPENPERSONA_HOME', () => {
  assert.equal(auth.loadAuth(), null);
  const rec = { access_token: 'a', refresh_token: 'r', expires_at: 123 };
  const file = auth.saveAuth(rec);
  assert.ok(file.startsWith(tmpHome));
  assert.deepEqual(auth.loadAuth(), rec);
  assert.equal(auth.clearAuth(), true);
  assert.equal(auth.loadAuth(), null);
});

test('isExpired: no token, no expiry, within margin, far future', () => {
  assert.equal(auth.isExpired(null), true);
  assert.equal(auth.isExpired({ access_token: 'a' }), false); // no expires_at → usable
  const now = 1_000_000;
  assert.equal(auth.isExpired({ access_token: 'a', expires_at: now + 30_000 }, now), true); // within 60s margin
  assert.equal(auth.isExpired({ access_token: 'a', expires_at: now + 120_000 }, now), false);
});

test('deviceLogin: polls past authorization_pending, saves token with expiry', async () => {
  const post = queuedPost([
    { status: 200, json: { device_code: 'dev', user_code: 'WXYZ', verification_uri_complete: 'https://login/activate?code=WXYZ', interval: 1, expires_in: 900 } },
    { status: 400, json: { error: 'authorization_pending' } },
    { status: 200, json: { access_token: 'AT', refresh_token: 'RT', token_type: 'Bearer', expires_in: 3600, scope: 'openid' } },
  ]);
  const prompts = [];
  const record = await auth.deviceLogin({
    config: cfg,
    _post: post,
    _sleep: async () => {},
    _now: () => 1_000_000,
    onPrompt: (l) => prompts.push(l),
  });
  assert.equal(record.access_token, 'AT');
  assert.equal(record.refresh_token, 'RT');
  assert.equal(record.expires_at, 1_000_000 + 3600 * 1000);
  assert.equal(record.audience, cfg.audience);
  // Persisted to disk.
  assert.equal(auth.loadAuth().access_token, 'AT');
  // First POST is the device/code request with audience.
  assert.match(post.calls[0].url, /\/oauth\/device\/code$/);
  assert.equal(post.calls[0].form.audience, cfg.audience);
  // Verification URL surfaced to the user.
  assert.ok(prompts.some((l) => l.includes('login/activate')));
});

test('deviceLogin: device/code failure throws a friendly error', async () => {
  const post = queuedPost([{ status: 403, json: { error: 'unauthorized_client', error_description: 'device flow disabled' } }]);
  await assert.rejects(
    auth.deviceLogin({ config: cfg, _post: post, _sleep: async () => {}, _now: () => 0 }),
    /device flow disabled/,
  );
});

test('deviceLogin: access_denied throws', async () => {
  const post = queuedPost([
    { status: 200, json: { device_code: 'dev', verification_uri_complete: 'https://login', interval: 1, expires_in: 900 } },
    { status: 403, json: { error: 'access_denied' } },
  ]);
  await assert.rejects(
    auth.deviceLogin({ config: cfg, _post: post, _sleep: async () => {}, _now: () => 0, onPrompt: () => {} }),
    /denied/,
  );
});

test('deviceLogin: unconfigured throws guidance', async () => {
  await assert.rejects(
    auth.deviceLogin({ config: null, _post: queuedPost([]), _now: () => 0 }),
    /Auth0 is not configured/,
  );
});

test('refreshToken: returns updated record with refresh_token; null without', async () => {
  const post = queuedPost([{ status: 200, json: { access_token: 'AT2', expires_in: 3600 } }]);
  const rec = await auth.refreshToken({ access_token: 'AT1', refresh_token: 'RT' }, { config: cfg, _post: post, _now: () => 5_000 });
  assert.equal(rec.access_token, 'AT2');
  assert.equal(rec.refresh_token, 'RT'); // preserved when not rotated
  assert.equal(rec.expires_at, 5_000 + 3600 * 1000);

  assert.equal(await auth.refreshToken({ access_token: 'x' }, { config: cfg, _post: queuedPost([]) }), null);
});

test('getAccessToken: valid → returns; expired+refresh → refreshed; expired no-refresh → null', async () => {
  const now = 2_000_000;
  // valid
  assert.equal(
    await auth.getAccessToken({ _auth: { access_token: 'GOOD', expires_at: now + 120_000 }, _now: () => now }),
    'GOOD',
  );
  // expired but refreshable
  const post = queuedPost([{ status: 200, json: { access_token: 'FRESH', expires_in: 3600 } }]);
  assert.equal(
    await auth.getAccessToken({ _auth: { access_token: 'OLD', refresh_token: 'RT', expires_at: now - 1 }, config: cfg, _post: post, _now: () => now }),
    'FRESH',
  );
  // expired, no refresh token
  assert.equal(
    await auth.getAccessToken({ _auth: { access_token: 'OLD', expires_at: now - 1 }, config: cfg, _post: queuedPost([]), _now: () => now }),
    null,
  );
  // not logged in
  assert.equal(await auth.getAccessToken({ _auth: null }), null);
});
