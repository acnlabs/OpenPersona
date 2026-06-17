'use strict';
/**
 * OpenPersona - Private pack listing (producer) tests
 * docs/MARKETPLACE-GATED-DELIVERY.md §2.3a + §2.6
 *
 *  - resolvePackSlug / resolvePackVersion (persona.json + overrides)
 *  - producePackZip: export → sanitize gate (rejects unsanitized packs)
 *  - publishPrivatePack: produce + upload (injected S3 client), tmp-zip cleanup
 *  - registerProduct: Store POST helper (injected + via local HTTP server)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const fs = require('fs-extra');
const AdmZip = require('adm-zip');

const lister = require('../lib/remote/lister');

class FakeCommand {
  constructor(input) { this.input = input; }
}

function fakeGlobalEnv(overrides = {}) {
  return {
    OP_STORE_GLOBAL_ENDPOINT: 'https://r2.example.com',
    OP_STORE_GLOBAL_BUCKET: 'op-private',
    OP_STORE_GLOBAL_KEY_ID: 'AKIA_TEST',
    OP_STORE_GLOBAL_SECRET: 'secret_test',
    ...overrides,
  };
}

const GITIGNORE = [
  'acn-registration.json',
  'state.json',
  'handoff.json',
  'soul/self-narrative.md',
  'social/contacts.json',
  'social/contacts.jsonl',
  'social/.poller-cursor.json',
  '',
].join('\n');

async function makePackDir(base, { slug = 'sam', version = '1.2.0', withGitignore = true, withState = true } = {}) {
  const dir = await fs.mkdtemp(path.join(base, 'pack-'));
  await fs.writeFile(path.join(dir, 'persona.json'), JSON.stringify({ slug, version, personaName: 'Sam', bio: 'b' }));
  await fs.writeFile(path.join(dir, 'SKILL.md'), '# Sam');
  await fs.ensureDir(path.join(dir, 'soul'));
  await fs.writeFile(path.join(dir, 'soul', 'injection.md'), 'soul');
  if (withState) await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ mood: 'happy' }));
  if (withGitignore) await fs.writeFile(path.join(dir, '.gitignore'), GITIGNORE);
  return dir;
}

describe('lister slug/version resolution', () => {
  let base;
  before(async () => { base = await fs.mkdtemp(path.join(os.tmpdir(), 'op-lister-res-')); });
  after(async () => { await fs.remove(base); });

  it('reads slug + version from persona.json', async () => {
    const dir = await makePackDir(base, { slug: 'nova', version: '3.1.0' });
    assert.equal(lister.resolvePackSlug(dir), 'nova');
    assert.equal(lister.resolvePackVersion(dir), '3.1.0');
  });

  it('honors overrides', async () => {
    const dir = await makePackDir(base);
    assert.equal(lister.resolvePackSlug(dir, 'custom'), 'custom');
    assert.equal(lister.resolvePackVersion(dir, '9.9.9'), '9.9.9');
  });

  it('defaults version when persona.json has none', async () => {
    const dir = await fs.mkdtemp(path.join(base, 'nover-'));
    await fs.writeFile(path.join(dir, 'persona.json'), JSON.stringify({ slug: 's' }));
    assert.equal(lister.resolvePackVersion(dir), lister.DEFAULT_VERSION);
  });

  it('throws when slug missing', async () => {
    const dir = await fs.mkdtemp(path.join(base, 'noslug-'));
    await fs.writeFile(path.join(dir, 'persona.json'), JSON.stringify({ version: '1' }));
    assert.throws(() => lister.resolvePackSlug(dir), /missing "slug"/);
  });
});

describe('lister producePackZip sanitize gate', () => {
  let base;
  before(async () => { base = await fs.mkdtemp(path.join(os.tmpdir(), 'op-lister-zip-')); });
  after(async () => { await fs.remove(base); });

  it('produces a sanitized zip (state.json gitignored → excluded)', async () => {
    const dir = await makePackDir(base, { withGitignore: true, withState: true });
    const out = path.join(base, 'ok.zip');
    const zip = lister.producePackZip(dir, out);
    const names = new AdmZip(zip).getEntries().map((e) => e.entryName);
    assert.ok(names.includes('persona.json'));
    assert.ok(!names.some((n) => n === 'state.json'));
  });

  it('rejects an unsanitized pack (state.json present, no .gitignore)', async () => {
    const dir = await makePackDir(base, { withGitignore: false, withState: true });
    const out = path.join(base, 'bad.zip');
    assert.throws(() => lister.producePackZip(dir, out), /not sanitized/);
  });
});

describe('lister publishPrivatePack (injected S3)', () => {
  let base;
  before(async () => { base = await fs.mkdtemp(path.join(os.tmpdir(), 'op-lister-pub-')); });
  after(async () => { await fs.remove(base); });

  it('produces + uploads, returns pack_ref and cleans tmp zip', async () => {
    const dir = await makePackDir(base, { slug: 'sam', version: '1.2.0' });
    const sent = [];
    const res = await lister.publishPrivatePack({
      packDir: dir, region: 'global', env: fakeGlobalEnv(),
      _client: { send: async (c) => { sent.push(c); return {}; } },
      _commands: { PutObjectCommand: FakeCommand, GetObjectCommand: FakeCommand },
    });
    assert.equal(res.packRef, 'op://private/sam@1.2.0');
    assert.equal(res.key, 'sam/1.2.0.zip');
    assert.equal(res.slug, 'sam');
    assert.equal(res.version, '1.2.0');
    assert.equal(res.zipPath, null); // tmp zip cleaned up
    assert.equal(sent.length, 1);
    assert.equal(sent[0].input.Key, 'sam/1.2.0.zip');
  });

  it('keeps the zip when zipOut is given', async () => {
    const dir = await makePackDir(base, { slug: 'kept', version: '2.0.0' });
    const keep = path.join(base, 'kept.zip');
    const res = await lister.publishPrivatePack({
      packDir: dir, region: 'global', env: fakeGlobalEnv(), zipOut: keep,
      _client: { send: async () => ({}) },
      _commands: { PutObjectCommand: FakeCommand, GetObjectCommand: FakeCommand },
    });
    assert.equal(res.zipPath, keep);
    assert.ok(fs.existsSync(keep));
  });

  it('fails fast on missing storage config before producing the zip', async () => {
    const dir = await makePackDir(base);
    await assert.rejects(
      lister.publishPrivatePack({ packDir: dir, region: 'global', env: {} }),
      /Missing storage config/
    );
  });

  it('requires packDir', async () => {
    await assert.rejects(lister.publishPrivatePack({}), /requires packDir/);
  });
});

describe('lister registerProduct (Store POST)', () => {
  it('posts pack_ref + commerce passthrough and returns Store JSON (injected)', async () => {
    let captured = null;
    const _post = async (url, headers, body) => {
      captured = { url, headers, body };
      return { status: 201, json: { product_id: 'p_1', pack_ref: body.pack_ref, generation: 0 }, text: '' };
    };
    const res = await lister.registerProduct({
      storeEndpoint: 'https://store/api/store',
      internalToken: 'tok',
      packRef: 'op://private/sam@1.2.0',
      slug: 'sam', version: '1.2.0',
      extraFields: { price: 999, currency: 'credits' },
      _post,
    });
    assert.equal(res.product_id, 'p_1');
    assert.equal(captured.url, 'https://store/api/store/persona/products');
    assert.equal(captured.headers['X-Internal-Token'], 'tok');
    assert.equal(captured.body.pack_ref, 'op://private/sam@1.2.0');
    assert.equal(captured.body.price, 999);
  });

  it('throws on non-2xx Store response', async () => {
    const _post = async () => ({ status: 400, json: null, text: 'bad request' });
    await assert.rejects(
      lister.registerProduct({ storeEndpoint: 'https://s/api/store', internalToken: 't', packRef: 'op://private/x@1', _post }),
      /registration failed \(HTTP 400\)/
    );
  });

  it('validates required args', async () => {
    await assert.rejects(lister.registerProduct({ internalToken: 't', packRef: 'r' }), /requires storeEndpoint/);
    await assert.rejects(lister.registerProduct({ storeEndpoint: 's', packRef: 'r' }), /requires internalToken/);
    await assert.rejects(lister.registerProduct({ storeEndpoint: 's', internalToken: 't' }), /requires packRef/);
  });

  it('works end to end against a local HTTP server', async () => {
    let received = null;
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        received = { token: req.headers['x-internal-token'], body: JSON.parse(data), path: req.url };
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ product_id: 'p_local', pack_ref: received.body.pack_ref }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = server.address().port;
      const res = await lister.registerProduct({
        storeEndpoint: `http://127.0.0.1:${port}/api/store`,
        internalToken: 'sek',
        packRef: 'op://private/sam@1.0.0',
        slug: 'sam', version: '1.0.0',
        extraFields: { price: 500 },
      });
      assert.equal(res.product_id, 'p_local');
      assert.equal(received.token, 'sek');
      assert.equal(received.path, '/api/store/persona/products');
      assert.equal(received.body.price, 500);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
