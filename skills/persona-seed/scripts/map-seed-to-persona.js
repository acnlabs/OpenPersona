#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Shared SeedProfile → persona.json mapper.
 * Fills structural defaults from a base-shaped skeleton.
 * Does not invent a display name when overrides omit it — caller must pass identity overrides.
 */

/** Root keys safe to merge from overrides.extra (never soul/body/evolution). */
const EXTRA_ALLOWED_ROOT_KEYS = new Set([
  'faculties',
  'skills',
  'economy',
  'vitality',
  'social',
  'rhythm',
  'memory',
  'additionalAllowedTools',
  'version',
  'author',
  'packType',
]);

function slugify(name) {
  const ascii = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (ascii) return ascii;
  const hash = crypto.createHash('sha256').update(String(name || '')).digest('hex').slice(0, 8);
  return `persona-${hash}`;
}

function buildSpeakingStyle(seed, override) {
  if (override) return override;
  const hints = seed.character?.speakingHints || [];
  if (!hints.length) {
    return 'Clear and natural. Adapts to the user while staying consistent with the seeded personality.';
  }
  return `Follow these speaking tendencies: ${hints.join('; ')}. Stay consistent with the seeded traits without caricature.`;
}

function buildBoundaries(seed, override) {
  if (override) return override;
  const flags = seed.constraints?.sensitiveFlags || [];
  const lines = [
    'Follow the OpenPersona Universal Constitution (Safety > Honesty > Helpfulness).',
    'Honest about being an AI. Do not claim to be a real person represented by the seed corpus.',
  ];
  if (flags.includes('healthcare_domain')) {
    lines.push(
      'No clinical diagnosis or prescribing. Encourage licensed professionals for medical decisions.'
    );
  }
  return lines.join(' ');
}

function buildBackground(seed) {
  const parts = [seed.identity?.summary].filter(Boolean);
  const occ = seed.identity?.occupation;
  const region = seed.identity?.region;
  if (occ || region) {
    parts.push(`Seeded context: ${[occ, region].filter(Boolean).join(' · ')}.`);
  }
  const interests = seed.character?.interests || [];
  if (interests.length) parts.push(`Interests include ${interests.slice(0, 6).join(', ')}.`);
  return parts.join('\n\n');
}

function applyExtra(persona, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
    throw new Error('overrides.extra must be a plain object when provided');
  }
  for (const key of Object.keys(extra)) {
    if (!EXTRA_ALLOWED_ROOT_KEYS.has(key)) {
      throw new Error(
        `overrides.extra has disallowed root key "${key}". ` +
          `Allowed: ${[...EXTRA_ALLOWED_ROOT_KEYS].join(', ')}. ` +
          'Do not override soul/body/evolution via extra.'
      );
    }
    persona[key] = extra[key];
  }
}

/**
 * @param {object} seed SeedProfile
 * @param {object} overrides
 * @param {string} overrides.personaName required
 * @param {string} [overrides.slug]
 * @param {string} [overrides.role]
 * @param {string} [overrides.bio]
 * @param {string} [overrides.personality]
 * @param {string} [overrides.speakingStyle]
 * @param {string} [overrides.boundaries]
 * @param {object} [overrides.extra] whitelisted root keys only
 */
function mapSeedToPersona(seed, overrides = {}) {
  if (!overrides.personaName) {
    throw new Error('mapSeedToPersona requires overrides.personaName (fill SeedProfile gaps first)');
  }

  const slug = overrides.slug || slugify(overrides.personaName);
  const role = overrides.role || 'assistant';
  const traits = seed.character?.traits || [];
  const personality =
    overrides.personality ||
    (traits.length ? traits.join(', ') : 'adaptive, attentive, honest');

  const immutable = Array.from(
    new Set([...(seed.constraints?.suggestedImmutableTraits || []), 'honest', 'helpful'])
  );

  const formality =
    typeof seed.character?.formalityBaseline === 'number'
      ? seed.character.formalityBaseline
      : 0;
  const minFormality = Math.max(-10, Math.min(formality - 3, 9));
  const maxFormality = Math.min(10, Math.max(formality + 3, minFormality + 1));

  const persona = {
    soul: {
      identity: {
        personaName: overrides.personaName,
        slug,
        role,
        bio: overrides.bio || seed.identity?.summary || `${overrides.personaName} persona`,
      },
      character: {
        personality,
        speakingStyle: buildSpeakingStyle(seed, overrides.speakingStyle),
        boundaries: buildBoundaries(seed, overrides.boundaries),
        background: buildBackground(seed),
      },
    },
    body: {
      runtime: {
        framework: 'openclaw',
      },
    },
    faculties: [{ name: 'memory' }],
    skills: [],
    evolution: {
      instance: {
        enabled: true,
        relationshipProgression: true,
        moodTracking: true,
        traitEmergence: true,
        speakingStyleDrift: true,
        interestDiscovery: true,
        boundaries: {
          immutableTraits: immutable,
          minFormality,
          maxFormality,
        },
      },
    },
    social: {
      acn: { enabled: true, gateway: 'https://acn-production.up.railway.app' },
      onchain: { chain: 'base' },
      a2a: { enabled: true, protocol: '0.3.0' },
    },
    rhythm: {
      heartbeat: { enabled: false },
    },
    version: '0.1.0',
    author: overrides.author || 'persona-seed',
  };

  if (overrides.extra !== undefined) {
    applyExtra(persona, overrides.extra);
  }

  return persona;
}

function main() {
  const args = process.argv.slice(2);
  let seedPath;
  let overrides = {};
  let outPath;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seed') seedPath = args[++i];
    else if (args[i] === '--overrides') {
      const raw = args[++i];
      overrides = JSON.parse(raw.startsWith('{') ? raw : fs.readFileSync(raw, 'utf8'));
    } else if (args[i] === '--out') outPath = args[++i];
  }

  if (!seedPath) {
    process.stderr.write(
      'Usage: map-seed-to-persona.js --seed <seed.json> --overrides <json|file> [--out persona.json]\n'
    );
    process.exit(1);
  }

  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const persona = mapSeedToPersona(seed, overrides);
  const text = `${JSON.stringify(persona, null, 2)}\n`;
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, text);
  } else {
    process.stdout.write(text);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { mapSeedToPersona, slugify, EXTRA_ALLOWED_ROOT_KEYS };
