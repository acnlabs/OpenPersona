'use strict';
/**
 * OpenPersona - Private pack storage tests (docs/MARKETPLACE-GATED-DELIVERY.md §2)
 *
 * Covers the pure + injectable surface of lib/remote/private-store.js without a
 * real bucket or the AWS SDK installed:
 *  - parsePackRef / buildPackRef / packRefToKey
 *  - assertPackSanitized (脱敏强制 gate)
 *  - resolveStoreConfig (dual-region env parsing)
 *  - uploadPack / getPresignedUrl with injected S3 client + commands + signer
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('fs-extra');
const AdmZip = require('adm-zip');

const store = require('../lib/remote/private-store');

// Fake S3 command class — captures its input for assertions.
class FakeCommand {
  constructor(input) { this.input = input; }
}

function fakeEnv(region = 'global', overrides = {}) {
  const prefix = region === 'cn' ? 'OP_STORE_CN' : 'OP_STORE_GLOBAL';
  return {
    [`${prefix}_ENDPOINT`]: region === 'cn' ? 'https://persona.acnlabs.cn/s3' : 'https://r2.example.com',
    [`${prefix}_BUCKET`]: 'op-private',
    [`${prefix}_KEY_ID`]: 'AKIA_TEST',
    [`${prefix}_SECRET`]: 'secret_test',
    ...overrides,
  };
}

describe('private-store pack_ref helpers', () => {
  it('parses op://private/<slug>@<version>', () => {
    assert.deepEqual(store.parsePackRef('op://private/samantha@1.2.0'), { slug: 'samantha', version: '1.2.0' });
  });

  it('parses op://private/<slug> without version', () => {
    assert.deepEqual(store.parsePackRef('op://private/samantha'), { slug: 'samantha', version: null });
  });

  it('rejects non-op refs', () => {
    assert.throws(() => store.parsePackRef('owner/repo'), /Invalid pack_ref/);
  });

  it('rejects unsupported namespace', () => {
    assert.throws(() => store.parsePackRef('op://public/foo'), /Unsupported pack_ref namespace/);
  });

  it('rejects empty version after @', () => {
    assert.throws(() => store.parsePackRef('op://private/foo@'), /empty version/);
  });

  it('builds canonical pack_ref', () => {
    assert.equal(store.buildPackRef('samantha', '1.0.0'), 'op://private/samantha@1.0.0');
  });

  it('buildPackRef requires a version', () => {
    assert.throws(() => store.buildPackRef('samantha'), /requires a version/);
  });

  it('maps pack_ref → <slug>/<version>.zip', () => {
    assert.equal(store.packRefToKey('op://private/samantha@1.0.0'), 'samantha/1.0.0.zip');
    assert.equal(store.packRefToKey({ slug: 'bob', version: '2.1.0' }), 'bob/2.1.0.zip');
  });

  it('packRefToKey requires a version', () => {
    assert.throws(() => store.packRefToKey('op://private/samantha'), /requires a version/);
  });
});

describe('private-store sanitization gate', () => {
  let dir;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op-private-store-'));
  });
  after(async () => { await fs.remove(dir); });

  function makeZip(name, files) {
    const zip = new AdmZip();
    for (const [entry, content] of Object.entries(files)) {
      zip.addFile(entry, Buffer.from(content));
    }
    const p = path.join(dir, name);
    zip.writeZip(p);
    return p;
  }

  it('passes a clean pack', () => {
    const p = makeZip('clean.zip', {
      'persona.json': '{"slug":"x"}',
      'SKILL.md': '# X',
      'soul/injection.md': 'soul',
    });
    assert.equal(store.assertPackSanitized(p), true);
  });

  it('rejects a pack containing state.json', () => {
    const p = makeZip('dirty-state.zip', {
      'persona.json': '{"slug":"x"}',
      'state.json': '{"mood":"happy"}',
    });
    assert.throws(() => store.assertPackSanitized(p), (e) => {
      assert.equal(e.name, 'SanitizationError');
      assert.ok(e.offenders.includes('state.json'));
      return true;
    });
  });

  it('rejects acn-registration.json even nested under a pack root folder', () => {
    const p = makeZip('dirty-nested.zip', {
      'persona-x/persona.json': '{"slug":"x"}',
      'persona-x/acn-registration.json': '{"api_key":"sk-secret"}',
    });
    assert.throws(() => store.assertPackSanitized(p), /acn-registration\.json/);
  });

  it('rejects soul/self-narrative.md and social contacts', () => {
    const p1 = makeZip('dirty-narrative.zip', { 'persona.json': '{}', 'soul/self-narrative.md': 'x' });
    assert.throws(() => store.assertPackSanitized(p1), /self-narrative\.md/);
    const p2 = makeZip('dirty-contacts.zip', { 'persona.json': '{}', 'social/contacts.json': '{}' });
    assert.throws(() => store.assertPackSanitized(p2), /contacts\.json/);
  });

  it('throws on missing zip', () => {
    assert.throws(() => store.assertPackSanitized(path.join(dir, 'nope.zip')), /not found/);
  });
});

describe('private-store resolveStoreConfig', () => {
  it('resolves global (R2) config with auto region + virtual-hosted style', () => {
    const c = store.resolveStoreConfig('global', fakeEnv('global'));
    assert.equal(c.region, 'global');
    assert.equal(c.awsRegion, 'auto');
    assert.equal(c.forcePathStyle, false);
    assert.equal(c.bucket, 'op-private');
  });

  it('resolves cn (MinIO) config with path-style default', () => {
    const c = store.resolveStoreConfig('cn', fakeEnv('cn'));
    assert.equal(c.region, 'cn');
    assert.equal(c.awsRegion, 'us-east-1');
    assert.equal(c.forcePathStyle, true);
  });

  it('uses PUBLIC_ENDPOINT for signing when set', () => {
    const env = fakeEnv('cn', { OP_STORE_CN_PUBLIC_ENDPOINT: 'https://persona.acnlabs.cn/minio' });
    const c = store.resolveStoreConfig('cn', env);
    assert.equal(c.publicEndpoint, 'https://persona.acnlabs.cn/minio');
  });

  it('defaults region from OP_STORE_DEFAULT_REGION', () => {
    const env = fakeEnv('cn', { OP_STORE_DEFAULT_REGION: 'cn' });
    const c = store.resolveStoreConfig(undefined, env);
    assert.equal(c.region, 'cn');
  });

  it('throws listing missing keys', () => {
    assert.throws(() => store.resolveStoreConfig('global', { OP_STORE_GLOBAL_ENDPOINT: 'x' }),
      /OP_STORE_GLOBAL_BUCKET/);
  });

  it('throws on unknown region', () => {
    assert.throws(() => store.resolveStoreConfig('mars', fakeEnv('global')), /Unknown storage region/);
  });
});

describe('private-store uploadPack (injected client)', () => {
  let dir;
  before(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op-upload-')); });
  after(async () => { await fs.remove(dir); });

  function cleanZip() {
    const zip = new AdmZip();
    zip.addFile('persona.json', Buffer.from('{"slug":"sam"}'));
    zip.addFile('SKILL.md', Buffer.from('# Sam'));
    const p = path.join(dir, 'clean.zip');
    zip.writeZip(p);
    return p;
  }

  it('runs sanitize gate then uploads, returning pack_ref + key', async () => {
    const zipPath = cleanZip();
    const sent = [];
    const fakeClient = { send: async (cmd) => { sent.push(cmd); return {}; } };
    const res = await store.uploadPack({
      slug: 'sam', version: '1.0.0', zipPath,
      region: 'global', env: fakeEnv('global'),
      _client: fakeClient,
      _commands: { PutObjectCommand: FakeCommand, GetObjectCommand: FakeCommand },
    });
    assert.equal(res.packRef, 'op://private/sam@1.0.0');
    assert.equal(res.key, 'sam/1.0.0.zip');
    assert.equal(res.region, 'global');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].input.Bucket, 'op-private');
    assert.equal(sent[0].input.Key, 'sam/1.0.0.zip');
    assert.equal(sent[0].input.ContentType, 'application/zip');
  });

  it('refuses to upload an unsanitized pack', async () => {
    const zip = new AdmZip();
    zip.addFile('persona.json', Buffer.from('{}'));
    zip.addFile('state.json', Buffer.from('{"mood":"x"}'));
    const p = path.join(dir, 'dirty.zip');
    zip.writeZip(p);
    await assert.rejects(
      store.uploadPack({ slug: 'sam', version: '1.0.0', zipPath: p, region: 'global', env: fakeEnv('global'), _client: { send: async () => ({}) }, _commands: { PutObjectCommand: FakeCommand, GetObjectCommand: FakeCommand } }),
      /not sanitized/
    );
  });

  it('validates required args', async () => {
    await assert.rejects(store.uploadPack({ version: '1.0.0', zipPath: 'x' }), /requires slug/);
    await assert.rejects(store.uploadPack({ slug: 's', zipPath: 'x' }), /requires version/);
    await assert.rejects(store.uploadPack({ slug: 's', version: '1' }), /requires zipPath/);
  });
});

describe('private-store getPresignedUrl (injected signer)', () => {
  it('signs a GET url for a pack_ref', async () => {
    const presign = async (client, command, opts) =>
      `https://r2.example.com/${command.input.Bucket}/${command.input.Key}?exp=${opts.expiresIn}`;
    const res = await store.getPresignedUrl({
      packRef: 'op://private/sam@1.0.0',
      region: 'global', env: fakeEnv('global'),
      _client: {}, _presign: presign,
      _commands: { PutObjectCommand: FakeCommand, GetObjectCommand: FakeCommand },
    });
    assert.equal(res.key, 'sam/1.0.0.zip');
    assert.equal(res.expiresIn, store.DEFAULT_PRESIGN_EXPIRY_SECONDS);
    assert.equal(res.url, 'https://r2.example.com/op-private/sam/1.0.0.zip?exp=300');
  });

  it('honors explicit key + expiresIn', async () => {
    const presign = async (c, cmd, o) => `signed:${cmd.input.Key}:${o.expiresIn}`;
    const res = await store.getPresignedUrl({
      key: 'custom/key.zip', expiresIn: 60,
      region: 'cn', env: fakeEnv('cn'),
      _client: {}, _presign: presign,
      _commands: { PutObjectCommand: FakeCommand, GetObjectCommand: FakeCommand },
    });
    assert.equal(res.url, 'signed:custom/key.zip:60');
    assert.equal(res.expiresIn, 60);
  });

  it('requires packRef or key', async () => {
    await assert.rejects(
      store.getPresignedUrl({ region: 'global', env: fakeEnv('global'), _client: {}, _presign: async () => 'x', _commands: { GetObjectCommand: FakeCommand } }),
      /requires packRef or key/
    );
  });
});
