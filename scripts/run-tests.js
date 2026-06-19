#!/usr/bin/env node
'use strict';

/**
 * Cross-version test runner for Node 18/20/22.
 * Discovers tests/*.js and runs them via node --test.
 * Avoids Node 21+ directory recursion change and npm script glob expansion issues.
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

function runTestFile(file) {
  return spawnSync(
    process.execPath,
    ['--require', preload, '--test', '--test-concurrency=1', file],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

for (const file of files) {
  const rel = path.relative(root, file);
  let result = runTestFile(file);
  const combined = `${result.stdout || ''}${result.stderr || ''}`;
  if ((result.status ?? 1) !== 0 && DESERIALIZE_RE.test(combined)) {
    process.stderr.write(`\n[retry] IPC deserialize flake in ${rel}, re-running once…\n`);
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
