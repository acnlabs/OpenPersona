'use strict';
/**
 * OpenPersona - Private gated download tests (docs/MARKETPLACE-GATED-DELIVERY.md §2.3c)
 *
 * Exercises the op://private/... branch of lib/remote/downloader.js end to end
 * against a local HTTP server that stands in for the OP gateway `deliver`
 * endpoint (returns a presigned URL) and the object store (serves the zip).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const fs = require('fs-extra');
const AdmZip = require('adm-zip');

const { download } = require('../lib/remote/downloader');

function makePackZip(zipPath) {
  const zip = new AdmZip();
  zip.addFile('persona.json', Buffer.from(JSON.stringify({ slug: 'paid-sam', personaName: 'Sam', bio: 'paid' })));
  zip.addFile('SKILL.md', Buffer.from('# Paid Sam'));
  zip.writeZip(zipPath);
}

describe('downloader op://private gated delivery', () => {
  let server;
  let baseUrl;
  let zipPath;
  let tmp;
  // Per-request behaviour switch so each test drives a scenario.
  let mode = 'ok';
  let lastDeliverReq = null;

  let origLog;
  before(async () => {
    // Silence the CLI's printInfo (console.log) — interleaving stdout with the
    // node:test runner IPC stream can corrupt it on Node 20.x.
    origLog = console.log;
    console.log = () => {};
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'op-dl-private-'));
    zipPath = path.join(tmp, 'pack.zip');
    makePackZip(zipPath);

    server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/deliver') {
        lastDeliverReq = {
          orderId: u.searchParams.get('order_id'),
          slug: u.searchParams.get('slug'),
          version: u.searchParams.get('version'),
          auth: req.headers.authorization || null,
        };
        if (mode === '403') { res.statusCode = 403; res.end('forbidden'); return; }
        if (mode === '409') { res.statusCode = 409; res.end('refunded'); return; }
        if (mode === '429') { res.statusCode = 429; res.end('too many'); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ url: `${baseUrl}/blob/pack.zip`, version: '1.0.0', pack_ref: 'op://private/paid-sam@1.0.0' }));
        return;
      }
      if (u.pathname === '/blob/pack.zip') {
        const buf = fs.readFileSync(zipPath);
        res.setHeader('Content-Type', 'application/zip');
        res.end(buf);
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.remove(tmp);
    if (origLog) console.log = origLog;
  });

  it('redeems entitlement and extracts a valid pack', async () => {
    mode = 'ok';
    const { dir, skipCopy } = await download('op://private/paid-sam@1.0.0', 'acnlabs', {
      deliverEndpoint: `${baseUrl}/deliver`,
      orderId: 'order_123',
      token: 'sess_abc',
    });
    assert.equal(skipCopy, false);
    assert.ok(fs.existsSync(path.join(dir, 'persona.json')));
    // deliver was called with the parsed slug/version + bearer token
    assert.equal(lastDeliverReq.orderId, 'order_123');
    assert.equal(lastDeliverReq.slug, 'paid-sam');
    assert.equal(lastDeliverReq.version, '1.0.0');
    assert.equal(lastDeliverReq.auth, 'Bearer sess_abc');
    await fs.remove(dir);
  });

  it('requires an order id (purchase) before delivery', async () => {
    await assert.rejects(
      download('op://private/paid-sam', 'acnlabs', { deliverEndpoint: `${baseUrl}/deliver` }),
      /requires a purchase/
    );
  });

  it('maps 403 to an entitlement-mismatch error', async () => {
    mode = '403';
    await assert.rejects(
      download('op://private/paid-sam@1.0.0', 'acnlabs', { deliverEndpoint: `${baseUrl}/deliver`, orderId: 'o', token: 't' }),
      /403/
    );
  });

  it('maps 409 to a refunded/void error', async () => {
    mode = '409';
    await assert.rejects(
      download('op://private/paid-sam@1.0.0', 'acnlabs', { deliverEndpoint: `${baseUrl}/deliver`, orderId: 'o', token: 't' }),
      /409|void/
    );
  });

  it('maps 429 to a max-redemptions error', async () => {
    mode = '429';
    await assert.rejects(
      download('op://private/paid-sam@1.0.0', 'acnlabs', { deliverEndpoint: `${baseUrl}/deliver`, orderId: 'o', token: 't' }),
      /429|limit/
    );
  });

  it('rejects an unsupported op:// namespace', async () => {
    await assert.rejects(
      download('op://public/foo', 'acnlabs', { deliverEndpoint: `${baseUrl}/deliver`, orderId: 'o' }),
      /Unsupported pack_ref namespace/
    );
  });
});
