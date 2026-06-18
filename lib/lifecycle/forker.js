/**
 * OpenPersona - Persona fork logic
 *
 * Derives a child persona from an installed parent:
 *   - Inherits evolution.boundaries, faculties, skills, body.runtime
 *   - Resets state.json (pack root) and soul/self-narrative.md (fresh runtime state)
 *   - Writes soul/lineage.json (parent slug, constitution hash, generation depth)
 */
const path = require('path');
const fs = require('fs-extra');
const { generate } = require('../generator');
const { install, computeConstitutionHash } = require('./installer');
const { resolvePersonaDir } = require('../state/runner');
const { printError, printSuccess, printInfo, printWarning, OP_SKILLS_DIR, resolveSoulFile } = require('../utils');

// Compute the memory directory for a persona slug.
// Read OPENCLAW_HOME at call time (not module load) so tests can override it.
// MEMORY_BASE_PATH is intentionally NOT used here: memory.js treats it as a
// full persona-specific path (not a base dir), so it cannot be used to derive
// paths for arbitrary slugs. OPENCLAW_HOME is the correct root for forker.js.
function memoryDir(slug) {
  const clawHome = process.env.OPENCLAW_HOME || path.join(require('os').homedir(), '.openclaw');
  return path.join(clawHome, 'memory', `persona-${slug}`);
}

/**
 * Fork an installed persona into a specialized child.
 *
 * @param {string} parentSlug - Slug of the installed parent persona
 * @param {object} options
 * @param {string} options.as - Slug for the child persona (required)
 * @param {string} [options.name] - Override child persona name
 * @param {string} [options.bio] - Override bio
 * @param {string} [options.personality] - Override personality
 * @param {string} [options.reason='specialization'] - Fork reason written to lineage.json
 * @param {string} [options.output=process.cwd()] - Output directory
 * @param {boolean} [options.install=false] - Auto-install after generation
 * @returns {Promise<{ skillDir: string, lineage: object }>}
 */
async function forkPersona(parentSlug, options = {}) {
  // options.parentDir allows tests to bypass resolvePersonaDir without registry writes
  const parentDir = options.parentDir || resolvePersonaDir(parentSlug);
  if (!parentDir) {
    throw new Error(`Persona not found: "${parentSlug}". Install it first with: openpersona install <source>`);
  }

  const parentPersonaPath = resolveSoulFile(parentDir, 'persona.json');
  if (!fs.existsSync(parentPersonaPath)) {
    throw new Error(`Persona not found: "${parentSlug}". Install it first with: openpersona install <source>`);
  }

  const newSlug = options.as;
  if (!newSlug) throw new Error('options.as (child slug) is required');

  const childDir = path.join(OP_SKILLS_DIR, `persona-${newSlug}`);
  if (fs.existsSync(childDir)) {
    throw new Error(`Persona already exists: persona-${newSlug}. Choose a different slug.`);
  }

  const parentPersona = JSON.parse(fs.readFileSync(parentPersonaPath, 'utf-8'));

  const parentLineagePath = path.join(parentDir, 'soul', 'lineage.json');
  const parentLineage = fs.existsSync(parentLineagePath)
    ? JSON.parse(fs.readFileSync(parentLineagePath, 'utf-8'))
    : null;
  const generation = parentLineage ? (parentLineage.generation || 0) + 1 : 1;

  // Build forked persona — override selectively
  const forkedPersona = JSON.parse(JSON.stringify(parentPersona));
  forkedPersona.slug = newSlug;
  forkedPersona.personaName = options.name || `${parentPersona.personaName}-${newSlug}`;
  forkedPersona.forkOf = parentSlug;
  if (options.bio) forkedPersona.bio = options.bio;
  if (options.personality) forkedPersona.personality = options.personality;

  const outputDir = path.resolve(options.output || process.cwd());
  const { skillDir } = await generate(forkedPersona, outputDir);

  // Compute constitution hash for lineage integrity verification.
  // Covers constitution.md + constitution-addendum.md (if present) via computeConstitutionHash.
  const constitutionHash = computeConstitutionHash(path.join(skillDir, 'soul'));

  // Read parent's pack revision — enables fork-to-parent diff (P24 fork lineage connection)
  let parentPackRevision = null;
  const parentMetaPath = path.join(parentDir, 'soul', 'behavior-guide.meta.json');
  if (fs.existsSync(parentMetaPath)) {
    try {
      const parentMeta = JSON.parse(fs.readFileSync(parentMetaPath, 'utf-8'));
      parentPackRevision = parentMeta.packRevision || null;
    } catch { /* meta absent or malformed — omit field */ }
  }

  // Inherit royalty lineage from the parent so a resale of this child still
  // credits the original author. rootPackRef falls back to the parent slug ref
  // when the parent itself is the root (gen-0 original bought from the Store).
  const rootCreator = parentLineage?.rootCreator || null;
  const rootPackRef = parentLineage?.rootPackRef || null;

  const lineage = {
    generation,
    parentSlug,
    parentEndpoint: null,
    parentAddress: null,
    forkReason: options.reason || 'specialization',
    forkedAt: new Date().toISOString(),
    constitutionHash,
    ...(rootCreator && { rootCreator }),
    ...(rootPackRef && { rootPackRef }),
    ...(parentPackRevision !== null && { parentPackRevision }),
    children: [],
  };
  await fs.writeFile(
    path.join(skillDir, 'soul', 'lineage.json'),
    JSON.stringify(lineage, null, 2)
  );

  // Memory inheritance — copy parent's memories.jsonl when policy is "copy"
  const inheritance = parentPersona.memory?.inheritance || 'none';
  if (inheritance === 'copy') {
    const parentMemFile = path.join(memoryDir(parentSlug), 'memories.jsonl');
    if (fs.existsSync(parentMemFile)) {
      const childMemDir = memoryDir(newSlug);
      await fs.ensureDir(childMemDir);
      await fs.copy(parentMemFile, path.join(childMemDir, 'memories.jsonl'));
      printSuccess(`Copied parent memory store to persona-${newSlug}`);
    } else {
      printWarning(`memory.inheritance: "copy" requested but parent has no memories.jsonl — child starts empty`);
    }
  }

  if (options.install) {
    await install(skillDir);
  }

  return { skillDir, lineage };
}

module.exports = { forkPersona };
