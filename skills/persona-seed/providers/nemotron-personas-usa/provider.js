'use strict';

const fs = require('fs');
const path = require('path');

const PROVIDER_ID = 'nemotron-personas-usa';
const DEFAULT_CORPUS = path.join(__dirname, 'fixtures', 'sample-corpus.json');
const FIXTURE_DATASET = 'persona-seed/providers/nemotron-personas-usa/fixtures/sample-corpus';
const PUBLIC_DATASET = 'nvidia/Nemotron-Personas-USA';

/** @type {{ path: string, mtimeMs: number, data: object[] } | null} */
let corpusCache = null;

function corpusPath() {
  return process.env.NEMOTRON_CORPUS_PATH
    ? path.resolve(process.env.NEMOTRON_CORPUS_PATH)
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
    data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  }
  if (!Array.isArray(data)) {
    throw new Error(`nemotron-personas-usa: corpus must be a JSON array or .jsonl: ${resolved}`);
  }
  corpusCache = { path: resolved, mtimeMs: stat.mtimeMs, data };
  return data;
}

function asArray(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v;
  return [v];
}

function splitList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v)
    .split(/[;,|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .trim();
}

function ageBracket(age) {
  const n = Number(age);
  if (!Number.isFinite(n)) return null;
  if (n < 18) return 'under-18';
  if (n <= 24) return '18-24';
  if (n <= 34) return '25-34';
  if (n <= 44) return '35-44';
  if (n <= 54) return '45-54';
  if (n <= 64) return '55-64';
  return '65+';
}

function regionOf(row) {
  return [row.city, row.state, row.country].filter(Boolean).join(', ') || null;
}

function haystack(row) {
  return [
    row.persona,
    row.professional_persona,
    row.sports_persona,
    row.arts_persona,
    row.travel_persona,
    row.culinary_persona,
    row.cultural_background,
    row.skills_and_expertise,
    row.skills_and_expertise_list,
    row.hobbies_and_interests,
    row.hobbies_and_interests_list,
    row.career_goals_and_ambitions,
    row.occupation,
    row.education_level,
    row.bachelors_field,
    row.city,
    row.state,
    row.country,
    String(row.age ?? ''),
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

function scoreRecord(row, intent) {
  const text = haystack(row);
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
    if (r && text.includes(norm(r))) {
      score += 2;
      hits.push(`region:${r}`);
    }
  }
  for (const loc of asArray(intent.locale)) {
    const n = norm(loc);
    const isEn = n === 'en' || n === 'english' || n.startsWith('en-');
    const usa = norm(row.country) === 'usa' || norm(row.country) === 'us';
    if ((isEn && usa) || (!isEn && text.includes(n))) {
      score += 2;
      hits.push(`locale:${loc}`);
    }
  }
  for (const age of asArray(intent.ageBracket)) {
    if (age && norm(ageBracket(row.age)) === norm(age)) {
      score += 1;
      hits.push(`age:${age}`);
    }
  }
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

function toCandidate(row, score, hits) {
  return {
    id: row.uuid || row.id,
    provider: PROVIDER_ID,
    summary: row.persona || row.professional_persona || `${row.occupation || 'persona'} · ${regionOf(row) || 'USA'}`,
    highlights: {
      region: regionOf(row),
      traits: splitList(row.hobbies_and_interests_list).slice(0, 5),
      domain: asArray(row.occupation),
      groundingType: 'synthetic',
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
    name: 'Nemotron Personas USA',
    dataset: fixture ? FIXTURE_DATASET : PUBLIC_DATASET,
    corpusMode: fixture ? 'fixture' : 'external',
    licenseNotes: fixture
      ? 'Offline fixture (5 sample rows). Set NEMOTRON_CORPUS_PATH to a decoded JSON/JSONL export of nvidia/Nemotron-Personas-USA.'
      : 'External corpus derived from nvidia/Nemotron-Personas-USA. Respect NVIDIA dataset license/terms. Archetype seed only.',
    offline: fixture,
    corpusPath: corpusPath(),
  };
}

function search(intent = {}) {
  const limit = Math.min(Math.max(intent.limit || 5, 1), 20);
  const corpus = loadCorpus();
  const requirePositive = hasPositiveFilters(intent);
  const ranked = [];

  for (const row of corpus) {
    const { score, hits, text } = scoreRecord(row, intent);
    if (isExcluded(text, intent)) continue;
    if (requirePositive && score <= 0) continue;
    ranked.push(toCandidate(row, score, hits));
  }

  ranked.sort((x, y) => y.score - x.score);
  return ranked.slice(0, limit);
}

function fetch(id) {
  const row = loadCorpus().find((r) => r.uuid === id || r.id === id);
  if (!row) throw new Error(`nemotron-personas-usa: record not found: ${id}`);
  return row;
}

function toSeed(raw) {
  const skills = splitList(raw.skills_and_expertise_list);
  const interests = splitList(raw.hobbies_and_interests_list);
  const sensitiveFlags = [];
  const blob = `${raw.persona || ''} ${raw.occupation || ''} ${raw.professional_persona || ''}`;
  if (/clinic|medical|health|physician|nurse|patient/i.test(blob)) {
    sensitiveFlags.push('healthcare_domain');
  }

  const education = [raw.education_level, raw.bachelors_field].filter(Boolean).join(' · ') || null;
  const fixture = isFixtureCorpus();
  const summary =
    raw.persona ||
    raw.professional_persona ||
    'Seed profile from Nemotron Personas USA.';

  return {
    schemaVersion: '0.1.0',
    provenance: {
      provider: PROVIDER_ID,
      recordId: String(raw.uuid || raw.id),
      dataset: fixture ? FIXTURE_DATASET : PUBLIC_DATASET,
      corpusMode: fixture ? 'fixture' : 'external',
      licenseNotes: fixture
        ? 'Offline fixture row — not a Hugging Face uuid.'
        : 'Row from nvidia/Nemotron-Personas-USA export. Archetype only — not a real-person twin.',
      groundingType: 'synthetic',
      retrievedAt: new Date().toISOString(),
    },
    identity: {
      suggestedName: null,
      suggestedSlug: null,
      summary,
      locale: ['en'],
      region: regionOf(raw),
      ageBracket: ageBracket(raw.age),
      occupation: raw.occupation || null,
      education,
    },
    character: {
      traits: [],
      values: [],
      motivations: raw.career_goals_and_ambitions ? [raw.career_goals_and_ambitions] : [],
      speakingHints: [],
      interests,
      riskTolerance: null,
      formalityBaseline: 0,
    },
    capabilities: {
      domains: asArray(raw.occupation),
      skills,
      tools: skills,
    },
    constraints: {
      hardExclusions: [],
      sensitiveFlags,
      suggestedImmutableTraits: ['honest', 'helpful'],
    },
    evidence: {
      attributeHighlights: [
        raw.occupation && { field: 'occupation', value: String(raw.occupation) },
        raw.age != null && { field: 'age', value: String(raw.age) },
        regionOf(raw) && { field: 'region', value: regionOf(raw) },
        education && { field: 'education', value: education },
      ].filter(Boolean),
      rawDescriptions: [
        raw.persona,
        raw.professional_persona,
        raw.cultural_background,
      ].filter(Boolean),
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
