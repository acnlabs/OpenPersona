'use strict';

const fs = require('fs');
const path = require('path');

const PROVIDER_ID = 'matraix-persona-1m';
const DEFAULT_CORPUS = path.join(__dirname, 'fixtures', 'sample-corpus.json');
const FIXTURE_DATASET = 'persona-seed/providers/matraix-persona-1m/fixtures/sample-corpus';
const PUBLIC_DATASET = 'MatrAIx2026/MatrAIx_Persona_1M';

const FORMALITY_MAP = {
  Casual: -3,
  'Warm-formal': 1,
  Neutral: 0,
  Formal: 3,
};

/** @type {{ path: string, mtimeMs: number, data: object[] } | null} */
let corpusCache = null;

function corpusPath() {
  return process.env.MATRAIX_CORPUS_PATH
    ? path.resolve(process.env.MATRAIX_CORPUS_PATH)
    : DEFAULT_CORPUS;
}

function isFixtureCorpus() {
  return corpusPath() === path.resolve(DEFAULT_CORPUS);
}

function resetCorpusCache() {
  corpusCache = null;
}

function loadJsonl(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

function loadCorpus() {
  const resolved = corpusPath();
  const stat = fs.statSync(resolved);
  if (
    corpusCache &&
    corpusCache.path === resolved &&
    corpusCache.mtimeMs === stat.mtimeMs
  ) {
    return corpusCache.data;
  }

  let data;
  if (resolved.endsWith('.jsonl')) {
    data = loadJsonl(resolved);
  } else {
    const raw = fs.readFileSync(resolved, 'utf8');
    data = JSON.parse(raw);
  }
  if (!Array.isArray(data)) {
    throw new Error(
      `matraix-persona-1m: corpus must be a JSON array or .jsonl: ${resolved}`
    );
  }
  corpusCache = { path: resolved, mtimeMs: stat.mtimeMs, data };
  return data;
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .trim();
}

function haystack(record) {
  const a = record.attributes || {};
  return [
    record.description,
    a.region,
    a.age_bracket,
    a.primary_language,
    a.occupation,
    a.occupation_domain,
    a.highest_education,
    a.risk_tolerance,
    ...asArray(a.personality_traits),
    ...asArray(a.values),
    ...asArray(a.motivations),
    ...asArray(a.interests),
    ...asArray(a.speaking_style_hints),
    ...asArray(a.tools),
  ]
    .map(norm)
    .join(' ');
}

function hasPositiveFilters(intent) {
  return ['traits', 'domain', 'region', 'locale', 'ageBracket'].some(
    (k) => asArray(intent[k]).length > 0
  );
}

function isExcluded(text, intent) {
  return asArray(intent.exclude).some((ex) => ex && text.includes(norm(ex)));
}

function scoreRecord(record, intent) {
  const text = haystack(record);
  const a = record.attributes || {};
  let score = 0;
  const hits = [];

  for (const t of asArray(intent.traits)) {
    if (t && text.includes(norm(t))) {
      score += 3;
      hits.push(`trait:${t}`);
    }
  }
  for (const d of asArray(intent.domain)) {
    if (d && text.includes(norm(d))) {
      score += 3;
      hits.push(`domain:${d}`);
    }
  }
  for (const r of asArray(intent.region)) {
    if (r && norm(a.region).includes(norm(r))) {
      score += 2;
      hits.push(`region:${r}`);
    }
  }
  for (const loc of asArray(intent.locale)) {
    if (loc && text.includes(norm(loc))) {
      score += 2;
      hits.push(`locale:${loc}`);
    }
  }
  for (const age of asArray(intent.ageBracket)) {
    if (age && norm(a.age_bracket) === norm(age)) {
      score += 1;
      hits.push(`age:${age}`);
    }
  }

  // Free-text tokens (lightweight attribute boost before agent rerank)
  if (intent.query) {
    for (const tok of norm(intent.query)
      .split(/[^a-z0-9\u4e00-\u9fff]+/)
      .filter((x) => x.length > 2)) {
      if (text.includes(tok)) {
        score += 1;
        hits.push(`query:${tok}`);
      }
    }
  }

  return { score, hits, text };
}

function toCandidate(record, score, hits) {
  const a = record.attributes || {};
  return {
    id: record.id,
    provider: PROVIDER_ID,
    summary:
      record.description || `${a.occupation || 'persona'} · ${a.region || 'unknown region'}`,
    highlights: {
      region: a.region || null,
      traits: asArray(a.personality_traits).slice(0, 5),
      domain: asArray(a.occupation_domain),
      groundingType: record.groundingType || 'unknown',
      corpusMode: isFixtureCorpus() ? 'fixture' : 'external',
      hits,
    },
    score,
  };
}

function capabilities() {
  const fixture = isFixtureCorpus();
  return {
    id: PROVIDER_ID,
    name: 'MatrAIx Persona 1M',
    dataset: fixture ? FIXTURE_DATASET : PUBLIC_DATASET,
    corpusMode: fixture ? 'fixture' : 'external',
    licenseNotes: fixture
      ? 'Offline fixture (5 sample rows) for development. Not the Hugging Face 1M release. Set MATRAIX_CORPUS_PATH to a decoded JSON array for external corpus search.'
      : 'External decoded corpus path. Prefer rows derived from MatrAIx2026/MatrAIx_Persona_1M; underlying source licenses still apply. Use as archetype seed, not digital twin.',
    offline: fixture,
    corpusPath: corpusPath(),
  };
}

/**
 * Attribute filter search.
 * - `exclude` hard-removes matches (never returned).
 * - Positive filters (traits/domain/region/locale/ageBracket) require score > 0.
 * - Empty filters / query-only: browse mode (may include score 0).
 * - Never falls back to an unfiltered corpus when filters match nothing.
 */
function search(intent = {}) {
  const limit = Math.min(Math.max(intent.limit || 5, 1), 20);
  const corpus = loadCorpus();
  const requirePositive = hasPositiveFilters(intent);
  const ranked = [];

  for (const record of corpus) {
    const { score, hits, text } = scoreRecord(record, intent);
    if (isExcluded(text, intent)) continue;
    if (requirePositive && score <= 0) continue;
    ranked.push(toCandidate(record, score, hits));
  }

  ranked.sort((x, y) => y.score - x.score);
  return ranked.slice(0, limit);
}

function fetch(id) {
  const record = loadCorpus().find((r) => r.id === id);
  if (!record) throw new Error(`matraix-persona-1m: record not found: ${id}`);
  return record;
}

function localeFromLanguage(lang) {
  if (!lang) return [];
  const n = norm(lang);
  if (n.includes('chinese') || n === 'zh' || n.includes('中文')) return ['zh'];
  if (n.includes('english') || n === 'en') return ['en'];
  if (n.includes('spanish') || n === 'es') return ['es'];
  return [lang];
}

function toSeed(raw) {
  const a = raw.attributes || {};
  const domain = asArray(a.occupation_domain);
  const sensitiveFlags = [];
  if (domain.some((d) => /health|medical|clinical/i.test(d))) {
    sensitiveFlags.push('healthcare_domain');
  }

  const highlights = [];
  for (const [field, value] of Object.entries(a)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value.length) highlights.push({ field, value: value.join(', ') });
    } else {
      highlights.push({ field, value: String(value) });
    }
  }

  const fixture = isFixtureCorpus();

  return {
    schemaVersion: '0.1.0',
    provenance: {
      provider: PROVIDER_ID,
      recordId: raw.id,
      dataset: fixture ? FIXTURE_DATASET : PUBLIC_DATASET,
      corpusMode: fixture ? 'fixture' : 'external',
      licenseNotes: fixture
        ? 'Offline fixture row for development — not a MatrAIx Persona 1M Hugging Face record id.'
        : 'External corpus row. Source licenses apply. Archetype only — not a real-person twin.',
      groundingType: raw.groundingType || 'unknown',
      retrievedAt: new Date().toISOString(),
    },
    identity: {
      suggestedName: null,
      suggestedSlug: null,
      summary: raw.description || 'Seed profile from MatrAIx Persona 1M.',
      locale: localeFromLanguage(a.primary_language),
      region: a.region || null,
      ageBracket: a.age_bracket || null,
      occupation: a.occupation || null,
      education: a.highest_education || null,
    },
    character: {
      traits: asArray(a.personality_traits),
      values: asArray(a.values),
      motivations: asArray(a.motivations),
      speakingHints: asArray(a.speaking_style_hints),
      interests: asArray(a.interests),
      riskTolerance: a.risk_tolerance || null,
      formalityBaseline:
        a.communication_formality != null
          ? FORMALITY_MAP[a.communication_formality] ?? 0
          : null,
    },
    capabilities: {
      domains: domain,
      skills: asArray(a.tools),
      tools: asArray(a.tools),
    },
    constraints: {
      hardExclusions: [],
      sensitiveFlags,
      suggestedImmutableTraits: ['honest', 'helpful'],
    },
    evidence: {
      attributeHighlights: highlights.slice(0, 24),
      rawDescriptions: raw.description ? [raw.description] : [],
    },
    gaps: ['personaName', 'slug', 'role', 'boundaries'],
  };
}

module.exports = {
  PROVIDER_ID,
  capabilities,
  search,
  fetch,
  toSeed,
  resetCorpusCache,
  isFixtureCorpus,
};
