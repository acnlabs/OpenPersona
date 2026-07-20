#!/usr/bin/env node
'use strict';

/**
 * Cross-version test runner for Node 18/20/22.
 * Discovers tests/*.js and runs them via node --test.
 * Avoids Node 21+ directory recursion change and npm script glob expansion issues.
 *
 * Also mitigates nodejs/node#56802 ("Unable to deserialize cloned data") by:
 *   1. Preferring --test-isolation=none when the runtime supports it (no IPC)
 *   2. Retrying known deserialize flakes with backoff when isolation is unavailable
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'tests');
const preload = path.join(__dirname, 'test-preload.js');

if (!fs.existsSync(testsDir)) {
  console.error('tests/ directory not found');
  process.exit(1);
}

function collectTests(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTests(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = collectTests(testsDir).sort();

if (files.length === 0) {
  console.error('No test files found in tests/');
  process.exit(1);
}

const DESERIALIZE_RE = /Unable to deserialize cloned data/;
const MAX_DESERIALIZE_ATTEMPTS = 5;

/** @type {string[]|null} */
let cachedIsolationArgs = null;

function isolationArgs() {
  if (cachedIsolationArgs !== null) return cachedIsolationArgs;
  // Prefer in-process isolation — removes the IPC structured-clone path entirely.
  for (const flag of ['--test-isolation=none', '--experimental-test-isolation=none']) {
    const probe = spawnSync(process.execPath, [flag, '-e', '0'], {
      encoding: 'utf8',
    });
    const combined = `${probe.stdout || ''}${probe.stderr || ''}`;
    if ((probe.status ?? 1) === 0 && !/bad option|unrecognized/i.test(combined)) {
      cachedIsolationArgs = [flag];
      return cachedIsolationArgs;
    }
  }
  cachedIsolationArgs = [];
  return cachedIsolationArgs;
}

function runTestFile(file) {
  const args = [
    '--require', preload,
    ...isolationArgs(),
    '--test',
    '--test-concurrency=1',
    file,
  ];
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function isDeserializeFlake(result) {
  const combined = `${result.stdout || ''}${result.stderr || ''}`;
  return (result.status ?? 1) !== 0 && DESERIALIZE_RE.test(combined);
}

function pause(ms) {
  const pauseUntil = Date.now() + ms;
  while (Date.now() < pauseUntil) { /* spin */ }
}

const iso = isolationArgs();
if (iso.length > 0) {
  process.stderr.write(`[run-tests] using ${iso.join(' ')} (avoids IPC deserialize flake)\n`);
} else {
  process.stderr.write(
    '[run-tests] test-isolation=none unsupported; will retry deserialize flakes up to '
    + `${MAX_DESERIALIZE_ATTEMPTS} times\n`
  );
}

for (const file of files) {
  const rel = path.relative(root, file);
  let result = runTestFile(file);
  let attempt = 1;
  while (isDeserializeFlake(result) && attempt < MAX_DESERIALIZE_ATTEMPTS) {
    attempt += 1;
    const delay = 200 * attempt;
    process.stderr.write(
      `\n[retry] IPC deserialize flake in ${rel}, re-running (${attempt}/${MAX_DESERIALIZE_ATTEMPTS}) after ${delay}ms…\n`
    );
    pause(delay);
    result = runTestFile(file);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const status = result.status ?? 1;
  if (status !== 0) {
    console.error(`\nTest file failed: ${rel} (exit ${status})`);
    process.exit(status);
  }
}

process.exit(0);
