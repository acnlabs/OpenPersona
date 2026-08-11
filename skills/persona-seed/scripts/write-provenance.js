#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Write seed provenance beside the generated pack (not into persona.json root).
 * Target: <packDir>/soul/seed-provenance.json
 */

function writeProvenance(packDir, seedOrProvenance) {
  const provenance = seedOrProvenance.provenance || seedOrProvenance;
  if (!provenance || !provenance.provider || !provenance.recordId) {
    throw new Error('writeProvenance requires provenance.provider and provenance.recordId');
  }

  const soulDir = path.join(packDir, 'soul');
  fs.mkdirSync(soulDir, { recursive: true });
  const outPath = path.join(soulDir, 'seed-provenance.json');
  const payload = {
    schemaVersion: '0.1.0',
    ...provenance,
    writtenAt: new Date().toISOString(),
  };
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  return outPath;
}

function main() {
  const args = process.argv.slice(2);
  let packDir;
  let seedPath;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pack') packDir = args[++i];
    else if (args[i] === '--seed') seedPath = args[++i];
  }

  if (!packDir || !seedPath) {
    process.stderr.write('Usage: write-provenance.js --pack <packDir> --seed <seedProfile.json>\n');
    process.exit(1);
  }

  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const outPath = writeProvenance(packDir, seed);
  process.stdout.write(`${outPath}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { writeProvenance };
