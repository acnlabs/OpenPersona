#!/usr/bin/env node
'use strict';

/**
 * Validate / normalize a decoded persona corpus for MATRAIX_CORPUS_PATH.
 *
 * Expected record shape (same as fixtures/sample-corpus.json):
 * {
 *   "id": "string",
 *   "groundingType": "synthetic" | "human_grounded" | "unknown",
 *   "description": "string",
 *   "attributes": { ... string | string[] values ... }
 * }
 *
 * Hugging Face release (MatrAIx2026/MatrAIx_Persona_1M) ships packed Parquet —
 * decode offline (Python + pyarrow per dataset card), then point this tool at
 * the resulting JSON array / JSONL.
 *
 * Usage:
 *   node prepare-corpus.js --validate /path/to/corpus.json
 *   node prepare-corpus.js --validate /path/to/corpus.jsonl --limit 100
 *   node prepare-corpus.js --print-fixture-schema
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const FIXTURE = path.join(
  __dirname,
  '..',
  'providers',
  'matraix-persona-1m',
  'fixtures',
  'sample-corpus.json'
);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--validate') out.validate = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--print-fixture-schema') out.printSchema = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function validateRecord(rec, index) {
  const errors = [];
  if (!rec || typeof rec !== 'object') {
    return [`[${index}] not an object`];
  }
  if (!rec.id || typeof rec.id !== 'string') errors.push(`[${index}] missing string id`);
  if (!rec.attributes || typeof rec.attributes !== 'object') {
    errors.push(`[${index}] missing attributes object`);
  }
  if (rec.description != null && typeof rec.description !== 'string') {
    errors.push(`[${index}] description must be string when present`);
  }
  return errors;
}

async function loadRecords(filePath, limit) {
  if (filePath.endsWith('.jsonl')) {
    const records = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let i = 0;
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      records.push(JSON.parse(trimmed));
      i++;
      if (limit && i >= limit) break;
    }
    return records;
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(data)) {
    throw new Error('JSON corpus must be an array of records');
  }
  return limit ? data.slice(0, limit) : data;
}

async function validate(filePath, limit) {
  const records = await loadRecords(filePath, limit);
  const errors = [];
  const ids = new Set();
  for (let i = 0; i < records.length; i++) {
    errors.push(...validateRecord(records[i], i));
    if (records[i]?.id) {
      if (ids.has(records[i].id)) errors.push(`[${i}] duplicate id ${records[i].id}`);
      ids.add(records[i].id);
    }
  }
  return {
    ok: errors.length === 0,
    count: records.length,
    errors: errors.slice(0, 50),
    truncatedErrors: errors.length > 50,
  };
}

function printHelp() {
  process.stdout.write(`prepare-corpus.js — validate decoded MatrAIx-shaped JSON for persona-seed

Decode the HF parquet yourself (see dataset card), emit JSON/JSONL in the fixture shape, then:

  export MATRAIX_CORPUS_PATH=/path/to/corpus.json
  node scripts/search.js --intent '{"domain":["software"]}'

Commands:
  --validate <file> [--limit N]
  --print-fixture-schema
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.validate && !args.printSchema)) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  if (args.printSchema) {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    process.stdout.write(
      `${JSON.stringify(
        {
          recordShape: {
            id: 'string',
            groundingType: 'synthetic|human_grounded|unknown',
            description: 'string',
            attributes: 'object of string | string[]',
          },
          example: fixture[0],
          downloadHint:
            'huggingface-cli download MatrAIx2026/MatrAIx_Persona_1M --repo-type dataset --local-dir ./matraix-1m',
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const result = await validate(args.validate, args.limit);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { validateRecord, validate, loadRecords };
