#!/usr/bin/env node
/**
 * OpenPersona CLI - Full persona package manager
 * Commands: create | install | search | uninstall | update | list | switch | publish | curate |
 *           reset | evolve-report | contribute | export | import | acn-register | state |
 *           dataset | skill | persona | model
 */
const path = require('path');
const os   = require('os');
const fs = require('fs-extra');
const { program } = require('commander');
const inquirer = require('inquirer');
const chalk = require('chalk');
const { generate } = require('../lib/generator');
const { install } = require('../lib/lifecycle/installer');
const { download } = require('../lib/remote/downloader');
const { search } = require('../lib/remote/searcher');
const { uninstall } = require('../lib/lifecycle/uninstaller');
const publishAdapter = require('../lib/publisher');
const datasetPublisher = require('../lib/dataset/publisher');
const skillInstaller = require('../lib/skill/installer');
const skillUninstaller = require('../lib/skill/uninstaller');
const skillUpdater = require('../lib/skill/updater');
const skillPublisher = require('../lib/skill/publisher');
const skillSearcher = require('../lib/skill/searcher');
const { curate } = require('../lib/remote/curator');
const { contribute } = require('../lib/lifecycle/contributor');
const { switchPersona, listPersonas } = require('../lib/lifecycle/switcher');
const { registerWithAcn } = require('../lib/remote/registrar');
const { OP_PERSONA_HOME, resolveSoulFile, printError, printSuccess, printInfo, printWarning } = require('../lib/utils');
const { resolvePersonaDir, runStateSyncCommand } = require('../lib/state/runner');
const { forkPersona } = require('../lib/lifecycle/forker');
const { exportPersona, importPersona } = require('../lib/lifecycle/porter');

const PKG_ROOT = path.resolve(__dirname, '..');
const PRESETS_DIR = path.join(PKG_ROOT, 'presets');

const { version: CLI_VERSION } = require('../package.json');

program
  .name('openpersona')
  .description('OpenPersona - Create, manage, and orchestrate agent personas')
  .version(CLI_VERSION);

if (process.argv.length === 2) {
  process.argv.push('create');
}

program
  .command('create')
  .description('Create a new persona skill pack (interactive wizard)')
  .option('--preset <name>', 'Use preset (base, samantha, ai-girlfriend, life-assistant, health-butler, stoic-mentor)')
  .option('--config <path>', 'Load external persona.json')
  .option('--output <dir>', 'Output directory', process.cwd())
  .option('--install', 'Install to ~/.openpersona after generation')
  .option('--dry-run', 'Preview only, do not write files')
  .action(async (options) => {
    let persona = {};
    if (options.preset) {
      const presetDir = path.join(PRESETS_DIR, options.preset);
      const presetPath = path.join(presetDir, 'persona.json');
      if (!fs.existsSync(presetPath)) {
        printError(`Preset not found: ${options.preset}`);
        process.exit(1);
      }
      persona = JSON.parse(fs.readFileSync(presetPath, 'utf-8'));
    } else if (options.config) {
      const configPath = path.resolve(options.config);
      if (!fs.existsSync(configPath)) {
        printError(`Config not found: ${configPath}`);
        process.exit(1);
      }
      persona = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } else {
      // Non-interactive guard: agents and CI environments have no TTY.
      // Hanging on prompts is worse than a clear error — fail fast.
      if (!process.stdin.isTTY) {
        printError(
          'No --preset or --config provided and stdin is not a TTY (non-interactive environment).\n' +
          '  Agent usage:   npx openpersona create --config ./persona.json --install\n' +
          '  Preset usage:  npx openpersona create --preset base --install\n' +
          '  Human wizard:  run in an interactive terminal without flags'
        );
        process.exit(1);
      }
      const { mode } = await inquirer.prompt([{
        type: 'list',
        name: 'mode',
        message: 'How would you like to create your persona?',
        choices: [
          { name: 'Base        — blank-slate with memory + voice + evolution (recommended)', value: 'base' },
          { name: 'Preset      — pick a pre-built character (samantha, stoic-mentor, life-assistant…)', value: 'preset' },
          { name: 'From scratch — guided wizard', value: 'custom' },
        ],
      }]);

      if (mode === 'base') {
        options.preset = 'base';
        persona = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, 'base', 'persona.json'), 'utf-8'));
      } else if (mode === 'preset') {
        const presetChoices = fs.readdirSync(PRESETS_DIR)
          .filter((d) => fs.existsSync(path.join(PRESETS_DIR, d, 'persona.json')))
          .filter((d) => d !== 'base');
        const { presetName } = await inquirer.prompt([{
          type: 'list',
          name: 'presetName',
          message: 'Choose a preset:',
          choices: presetChoices,
        }]);
        options.preset = presetName;
        persona = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, presetName, 'persona.json'), 'utf-8'));
      } else {
        const { slugify } = require('../lib/utils');
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'personaName',
            message: 'Persona name:',
            default: 'Alex',
          },
          {
            type: 'input',
            name: 'slug',
            message: 'Slug (directory name + CLI commands):',
            default: (a) => slugify(a.personaName),
          },
          {
            type: 'list',
            name: 'role',
            message: 'Role (what is this persona to the user?):',
            choices: [
              { name: 'assistant  — general-purpose helper', value: 'assistant' },
              { name: 'companion  — emotional connection, evolving relationship', value: 'companion' },
              { name: 'coach      — accountability, guidance, skill-building', value: 'coach' },
              { name: 'mentor     — wisdom, long-term growth', value: 'mentor' },
              { name: 'character  — fictional persona / roleplay', value: 'character' },
              { name: 'other      — enter your own', value: 'other' },
            ],
          },
          {
            type: 'input',
            name: 'roleCustom',
            message: 'Enter custom role:',
            when: (a) => a.role === 'other',
          },
          {
            type: 'input',
            name: 'bio',
            message: 'One-line bio:',
            default: 'An adaptive AI persona ready to help and grow through interaction',
          },
          {
            type: 'input',
            name: 'personality',
            message: 'Personality (comma-separated traits):',
            default: 'curious, direct, honest',
          },
          {
            type: 'input',
            name: 'speakingStyle',
            message: 'Speaking style:',
            default: 'Clear and natural; adapts tone to context',
          },
          {
            type: 'list',
            name: 'framework',
            message: 'Agent runner (which AI agent will host this persona?):',
            choices: [
              { name: 'openclaw   — OpenClaw (default)', value: 'openclaw' },
              { name: 'cursor     — Cursor IDE agent', value: 'cursor' },
              { name: 'claude-code — Claude Code CLI', value: 'claude-code' },
              { name: 'codex      — OpenAI Codex', value: 'codex' },
              { name: 'other      — enter manually', value: 'other' },
              { name: 'skip       — set later', value: '' },
            ],
          },
          {
            type: 'input',
            name: 'frameworkCustom',
            message: 'Enter framework name:',
            when: (a) => a.framework === 'other',
          },
          {
            type: 'checkbox',
            name: 'extraFaculties',
            message: 'Optional faculties (memory is auto-included by the framework):',
            choices: [
              { name: 'voice — text-to-speech (ElevenLabs / OpenAI TTS)', value: 'voice' },
            ],
          },
          {
            type: 'checkbox',
            name: 'skills',
            message: 'Built-in skills (on-demand actions):',
            choices: [
              { name: 'selfie   — AI image generation', value: 'selfie' },
              { name: 'music    — music composition', value: 'music' },
              { name: 'reminder — scheduled reminders', value: 'reminder' },
            ],
          },
          {
            type: 'confirm',
            name: 'evolutionEnabled',
            message: 'Enable soul evolution? (personality grows through interaction)',
            default: true,
          },
          {
            type: 'input',
            name: 'immutableTraits',
            message: 'Immutable traits — will never drift (comma-separated):',
            default: 'honest, curious',
            when: (a) => a.evolutionEnabled,
          },
        ]);

        const role = answers.role === 'other' ? (answers.roleCustom || '').trim() || 'assistant' : answers.role;
        const framework = answers.framework === 'other' ? (answers.frameworkCustom || '').trim() : answers.framework;
        const faculties = (answers.extraFaculties || []).map((name) => ({ name }));
        const skills = (answers.skills || []).map((name) => ({ name }));
        const immutableTraits = answers.immutableTraits
          ? answers.immutableTraits.split(',').map((t) => t.trim()).filter(Boolean)
          : ['honest', 'curious'];

        persona = {
          soul: {
            identity: {
              personaName: answers.personaName,
              slug: answers.slug,
              role,
              bio: answers.bio,
            },
            character: {
              personality: answers.personality,
              speakingStyle: answers.speakingStyle,
            },
          },
          ...(framework ? { body: { runtime: { framework } } } : {}),
          ...(faculties.length ? { faculties } : {}),
          ...(skills.length ? { skills } : {}),
          ...(answers.evolutionEnabled ? {
            evolution: {
              instance: {
                enabled: true,
                boundaries: {
                  immutableTraits,
                  minFormality: -3,
                  maxFormality: 6,
                },
              },
            },
          } : {}),
        };
      }
    }

    try {
      const outputDir = path.resolve(options.output);
      if (options.dryRun) {
        // Resolve grouped soul format before accessing top-level fields
        const flatName = persona.personaName || persona.soul?.identity?.personaName;
        const flatSlug = persona.slug || persona.soul?.identity?.slug;
        const { slugify } = require('../lib/utils');
        printInfo('Dry run — preview only, no files written.');
        printInfo(`Would generate: persona-${flatSlug || slugify(flatName)}/`);
        printInfo(`  SKILL.md, soul/, references/, agent-card.json, acn-config.json, scripts/, state.json`);
        if (persona.evolution?.enabled || persona.evolution?.instance?.enabled) {
          printInfo(`  soul/self-narrative.md (★Experimental — evolution enabled)`);
        }
        const faculties = (persona.faculties || []).map((f) => (typeof f === 'string' ? f : f.name));
        const skills = (persona.skills || []).map((s) => (typeof s === 'string' ? s : s.name));
        if (faculties.length) printInfo(`  Faculties: ${faculties.join(', ')}`);
        if (skills.length) printInfo(`  Skills: ${skills.join(', ')}`);
        return;
      }
      const { skillDir } = await generate(persona, outputDir);
      printSuccess('Generated: ' + skillDir);
      if (options.install) {
        await install(skillDir);
      } else {
        printInfo('Run: npx openpersona create --config ./persona.json --output . --install');
      }
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

program
  .command('install <target>')
  .description('Install persona or skill pack (smart router — auto-detects type). In v1.0 this will also handle datasets and models.')
  .option('--registry <name>', 'Registry (acnlabs, skillssh)', 'acnlabs')
  .option('--runtime <name>', 'For skill packs: target runtime (claude|cursor|openclaw|hermes|openpersona)')
  .option('--global', 'For skill packs: install to ~/.agents/skills/ (user-global)')
  .option('--all', 'For skill packs: install to all detected runtime dirs in CWD')
  .option('--force', 'Bypass constitution compliance check (not recommended — review flagged content first)')
  .option('--order <id>', 'For op://private packs: the purchase order id (from "My Purchases")')
  .addHelpText('after', [
    '',
    'Examples:',
    '  openpersona install acnlabs/anyone-skill        (auto-routes: persona or skill)',
    '  openpersona install owner/repo --runtime=claude (force skill → .claude/skills/)',
    '  openpersona install owner/repo --global         (force skill → ~/.agents/skills/)',
    '  openpersona install op://private/<slug> --order <id>  (paid pack — run `openpersona login` first)',
    '',
    'Use `openpersona persona install` for persona-only guaranteed routing.',
    'Use `openpersona skill install` for skill-only guaranteed routing.',
  ].join('\n'))
  .action(async (target, options) => {
    let dir;
    let skipCopy = false;
    try {
      const result = await download(target, options.registry, { orderId: options.order });
      dir = result.dir;
      skipCopy = !!result.skipCopy;

      // Detect pack type and route accordingly
      const hasPersonaJson = fs.existsSync(path.join(dir, 'persona.json')) ||
        fs.existsSync(path.join(dir, 'soul', 'persona.json'));
      const skillMdCandidates = [
        path.join(dir, 'SKILL.md'),
        path.join(dir, 'SKILL', 'SKILL.md'),
        path.join(dir, 'skill', 'SKILL.md'),
      ];
      const skillMdPath = skillMdCandidates.find((p) => fs.existsSync(p));

      if (hasPersonaJson) {
        if (options.runtime || options.all) {
          printWarning('--runtime / --all ignored for persona packs (use `openpersona skill install` for skill packs)');
        }
        printInfo('Detected: persona pack → installing to ~/.openpersona/');
        await install(dir, skipCopy ? { skipCopy: true, source: target } : { source: target });
      } else if (skillMdPath) {
        printInfo('Detected: skill pack → installing to .agents/skills/');
        await skillInstaller.installSkill(dir, skillMdPath, {
          runtime: options.runtime,
          global: options.global,
          all: options.all,
          force: options.force,
          source: target,
        });
      } else {
        printError('Not a valid pack: no persona.json or SKILL.md found in the downloaded repository.');
        printInfo('Make sure the repo contains a SKILL.md (skill pack) or persona.json (persona pack).');
        process.exit(1);
      }
    } catch (e) {
      printError(e.message);
      process.exit(1);
    } finally {
      if (dir && !skipCopy) {
        try { await fs.remove(dir); } catch { /* ignore */ }
      }
    }
  });

program
  .command('login')
  .description('Sign in as a buyer (Auth0 device flow) to install paid op://private packs')
  .action(async () => {
    const cliAuth = require('../lib/remote/auth');
    try {
      const record = await cliAuth.deviceLogin();
      printSuccess('Signed in.');
      if (record.expires_at) {
        printInfo(`Token valid until ${new Date(record.expires_at).toLocaleString()}.`);
      }
      printInfo(`Credentials stored at ${cliAuth.authFilePath()}`);
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

program
  .command('logout')
  .description('Remove the locally stored buyer credentials')
  .action(async () => {
    const cliAuth = require('../lib/remote/auth');
    const removed = cliAuth.clearAuth();
    if (removed) printSuccess('Signed out.');
    else printInfo('No stored credentials to remove.');
  });

program
  .command('whoami')
  .description('Show the current buyer login status')
  .action(async () => {
    const cliAuth = require('../lib/remote/auth');
    const auth = cliAuth.loadAuth();
    if (!auth || !auth.access_token) {
      printInfo('Not signed in. Run `openpersona login` to install paid packs.');
      return;
    }
    const expired = cliAuth.isExpired(auth);
    printInfo(`Signed in${auth.audience ? ` (audience: ${auth.audience})` : ''}.`);
    if (auth.expires_at) {
      printInfo(`Token ${expired ? 'EXPIRED at' : 'valid until'} ${new Date(auth.expires_at).toLocaleString()}.`);
    }
    if (expired && auth.refresh_token) printInfo('It will refresh automatically on next install.');
    else if (expired) printInfo('Run `openpersona login` to refresh.');
  });

program
  .command('search <query>')
  .description('Search personas in the OpenPersona directory. Note: in v1.0 this will aggregate all resources. Use `openpersona persona search` for persona-only stable behavior.')
  .option('--type <type>', 'Filter by pack type: single or multi')
  .action(async (query, options) => {
    try {
      await search(query, { type: options.type });
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

program
  .command('uninstall <slug>')
  .description('Uninstall persona')
  .action(async (slug) => {
    try {
      await uninstall(slug);
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

program
  .command('update <slug>')
  .description('Update installed persona')
  .action(async (slug) => {
    const skillDir = resolvePersonaDir(slug);
    if (!skillDir) {
      printError(`Persona not found: "${slug}". Install it first with: openpersona install <source>`);
      process.exit(1);
    }
    const personaPath = resolveSoulFile(skillDir, 'persona.json');
    if (!fs.existsSync(personaPath)) {
      printError('persona.json not found');
      process.exit(1);
    }
    const persona = JSON.parse(fs.readFileSync(personaPath, 'utf-8'));
    const tmpDir = path.join(require('os').tmpdir(), 'openpersona-update-' + Date.now());
    await fs.ensureDir(tmpDir);
    const { skillDir: newDir } = await generate(persona, tmpDir);
    // Preserve runtime evolution artifacts — these represent accumulated persona growth
    const runtimeArtifacts = [
      'state.json',
      'soul/self-narrative.md',
      // lineage.json records fork parentage + constitution hash — must survive updates
      // so trust chain verification (installer.js verifyConstitutionHash) keeps working
      'soul/lineage.json',
    ];
    for (const rel of runtimeArtifacts) {
      const src = path.join(skillDir, rel);
      const dst = path.join(newDir, rel);
      if (fs.existsSync(src)) {
        await fs.copy(src, dst);
      }
    }
    await fs.remove(skillDir);
    await fs.move(newDir, skillDir);
    await fs.remove(tmpDir);
    await install(skillDir, { skipCopy: true });
    printSuccess('Updated persona-' + slug);
  });

program
  .command('fork <parent-slug>')
  .description('Fork an installed persona into a specialized child')
  .requiredOption('--as <new-slug>', 'Slug for the child persona')
  .option('--name <name>', 'Child persona name (default: "<ParentName>-<new-slug>")')
  .option('--bio <bio>', 'Override bio')
  .option('--personality <keywords>', 'Override personality (comma-separated)')
  .option('--reason <text>', 'Fork reason, written into lineage.json', 'specialization')
  .option('--output <dir>', 'Output directory', process.cwd())
  .option('--install', 'Install to ~/.openpersona after generation')
  .action(async (parentSlug, options) => {
    try {
      const { skillDir, lineage } = await forkPersona(parentSlug, {
        as: options.as,
        name: options.name,
        bio: options.bio,
        personality: options.personality,
        reason: options.reason,
        output: options.output,
        install: options.install,
      });
      printSuccess(`Forked: ${skillDir}`);
      printInfo(`  Parent: persona-${parentSlug}  →  Child: persona-${options.as} (generation ${lineage.generation})`);
      printInfo(`  Constitution hash: ${lineage.constitutionHash.slice(0, 16)}...`);
      if (!options.install) {
        printInfo(`To install: npx openpersona install ${skillDir}`);
      }
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List installed personas. Note: in v1.0 this will aggregate all resources. Use `openpersona persona list` for persona-only stable behavior.')
  .action(async () => {
    const personas = await listPersonas();
    if (personas.length === 0) {
      printInfo('No personas installed.');
      return;
    }
    for (const p of personas) {
      const marker = p.active ? chalk.green(' ← active') : '';
      const status = p.enabled ? '' : chalk.dim(' (disabled)');
      const typeTag = p.packType && p.packType !== 'single' ? chalk.cyan(` [${p.packType}]`) : '';
      console.log(`  ${p.personaName} (persona-${p.slug})${typeTag}${marker}${status}`);
    }
  });

program
  .command('switch <slug>')
  .description('Switch active persona')
  .action(async (slug) => {
    try {
      await switchPersona(slug);
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

program
  .command('publish <owner/repo>')
  .description('Validate a GitHub repo as a persona pack and register it with the OpenPersona directory (e.g. alice/my-persona)')
  .action(async (ownerRepo) => {
    try {
      await publishAdapter.publish(ownerRepo);
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

program
  .command('curate <owner/repo>')
  .description('Curator-only: actively collect a popular persona pack from the market into the OpenPersona directory (requires OPENPERSONA_CURATOR_TOKEN)')
  .option('--type <type>', 'Pack type: single (default), multi, or tool', 'single')
  .option('--role <role>', 'Override role for non-OpenPersona packs (companion/assistant/mentor/character/tool/...). Defaults to value in persona.json, or "companion" if absent.')
  .option('--token <token>', 'Curator authentication token (falls back to OPENPERSONA_CURATOR_TOKEN env)')
  .option('--tags <tags>', 'Comma-separated tag list for discovery (e.g. "companion,wellness"). See CURATION-STANDARDS.md for the full tag taxonomy.')
  .option('--min-stars <n>', 'Minimum GitHub star count (default: 500). Override for exceptional cases.', '500')
  .action(async (ownerRepo, options) => {
    try {
      await curate(ownerRepo, { packType: options.type, role: options.role, token: options.token, tags: options.tags, minStars: parseInt(options.minStars, 10) });
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

program
  .command('reset <slug>')
  .description('★Experimental: Reset soul evolution state')
  .action(async (slug) => {
    const skillDir = resolvePersonaDir(slug);
    if (!skillDir) {
      printError(`Persona not found: "${slug}". Install it first with: openpersona install <source>`);
      process.exit(1);
    }
    const personaPath = resolveSoulFile(skillDir, 'persona.json');
    const soulStatePath = resolveSoulFile(skillDir, 'state.json');
    if (!fs.existsSync(personaPath) || !fs.existsSync(soulStatePath)) {
      printError('Persona or soul state not found');
      process.exit(1);
    }
    const persona = JSON.parse(fs.readFileSync(personaPath, 'utf-8'));
    const templatePath = path.join(PKG_ROOT, 'templates', 'soul', 'soul-state.template.json');
    const tpl = fs.readFileSync(templatePath, 'utf-8');
    const Mustache = require('mustache');
    const now = new Date().toISOString();
    const moodBaseline = persona.personality?.split(',')[0]?.trim() || 'neutral';
    const soulState = Mustache.render(tpl, { slug, createdAt: now, lastUpdatedAt: now, moodBaseline });
    fs.writeFileSync(soulStatePath, soulState);
    printSuccess('Reset soul evolution state');
  });

program
  .command('evolve-report <slug>')
  .description('★Experimental: Show evolution report for a persona')
  .action(async (slug) => {
    try {
      const { evolveReport } = require('../lib/state/evolution');
      await evolveReport(slug);
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

program
  .command('contribute [slug]')
  .description('Persona Harvest — submit persona improvements as a PR to the community')
  .option('--mode <mode>', 'Contribution scope: preset or framework', 'preset')
  .option('--dry-run', 'Show diff only, do not create PR')
  .action(async (slug, options) => {
    try {
      if (options.mode === 'preset' && !slug) {
        printError('Slug required for preset contributions. Example: npx openpersona contribute samantha');
        process.exit(1);
      }
      await contribute(slug, { mode: options.mode, dryRun: options.dryRun });
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

program
  .command('acn-register [slug]')
  .description('Register a persona with ACN (Agent Communication Network)')
  .option('--endpoint <url>', 'Agent A2A endpoint URL (replaces <RUNTIME_ENDPOINT> placeholder)')
  .option('--dir <path>', 'Path to persona pack directory (overrides slug lookup)')
  .option('--dry-run', 'Preview registration payload without calling ACN')
  .action(async (slug, options) => {
    let skillDir;

    if (options.dir) {
      skillDir = path.resolve(options.dir);
    } else if (slug) {
      skillDir = resolvePersonaDir(slug);
    } else {
      // Try current directory
      skillDir = process.cwd();
    }

    if (!require('fs-extra').existsSync(path.join(skillDir, 'acn-config.json'))) {
      printError(`No acn-config.json found in ${skillDir}. Provide a slug or --dir pointing to a generated persona pack.`);
      process.exit(1);
    }

    try {
      const result = await registerWithAcn(skillDir, {
        endpoint: options.endpoint,
        dryRun: options.dryRun,
      });

      if (options.dryRun) return;

      printSuccess(`Registered with ACN!`);
      printInfo(`  Agent ID:   ${result.agent_id}`);
      printInfo(`  Status:     ${result.status}`);
      printInfo(`  Claim URL:  ${result.claim_url}`);
      printInfo(`  Card URL:   ${result.agent_card_url}`);
      printInfo(`  Heartbeat:  ${result.heartbeat_endpoint}`);
      printInfo(`  Saved:      acn-registration.json`);
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

program
  .command('export <slug>')
  .description('Export persona pack (with soul state) as a zip archive')
  .option('-o, --output <path>', 'Output file path')
  .action(async (slug, options) => {
    const skillDir = resolvePersonaDir(slug);
    if (!skillDir) {
      printError(`Persona not found: "${slug}". Install it first with: openpersona install <source>`);
      process.exit(1);
    }
    try {
      const outPath = exportPersona(skillDir, options.output);
      printSuccess(`Exported to ${outPath}`);
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

program
  .command('import <file>')
  .description('Import persona pack from a zip archive and install')
  .option('-o, --output <dir>', 'Extract directory (temp, auto-cleaned)')
  .action(async (file, options) => {
    try {
      const destDir = await importPersona(file, { extractDir: options.output });
      printSuccess(`Imported and installed from ${file}`);
      printInfo(`  Installed to: ${destDir}`);
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

// ── Marketplace: private paid-pack listing (asset layer) ─────────────────────
//
// Produces a sanitized pack zip and uploads it to private object storage,
// returning the op://private/<slug>@<version> pack_ref. Store product
// registration (price/royalty/preview) is the gateway's job — this command
// only handles the OP-owned bytes (docs/MARKETPLACE-GATED-DELIVERY.md §2.3a).

const marketCmd = program
  .command('market')
  .description('Private paid-pack listing (export → sanitize → upload to private storage)');

marketCmd
  .command('publish <slug>')
  .description('Produce a sanitized pack and upload it to private storage; prints the pack_ref')
  .option('--version <version>', 'Version to publish under (defaults to persona.json version)')
  .option('--region <region>', 'Storage region: global (R2) or cn (MinIO)', 'global')
  .option('--keep-zip <path>', 'Keep the produced pack zip at this path')
  .action(async (slug, options) => {
    const { publishPrivatePack } = require('../lib/remote/lister');
    const skillDir = resolvePersonaDir(slug);
    if (!skillDir) {
      printError(`Persona not found: "${slug}". Install it first with: openpersona install <source>`);
      process.exit(1);
    }
    try {
      printInfo(`Producing sanitized pack for "${slug}"...`);
      const res = await publishPrivatePack({
        packDir: skillDir,
        region: options.region,
        version: options.version,
        zipOut: options.keepZip,
      });
      printSuccess(`Uploaded private pack: ${res.packRef}`);
      printInfo(`  Region:    ${res.region}`);
      printInfo(`  Object:    ${res.bucket}/${res.key}`);
      if (res.zipPath) printInfo(`  Local zip: ${res.zipPath}`);
      printInfo('');
      printInfo('Next: register this pack_ref with Store to set price/royalty/preview:');
      printInfo(`  POST /api/store/persona/products  { "pack_ref": "${res.packRef}", ... }`);
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

// ── Pack refinement (P24) ─────────────────────────────────────────────────────

program
  .command('refine <slug>')
  .description('Refine persona skill pack from accumulated experience (pack-level evolution)')
  .option('--emit',      'Signal path Step A: check threshold and emit refinement_request signal')
  .option('--apply',     'Signal path Step B: read signal response and apply refinement')
  .option('--from-pool', 'AutoSkill path: pull from shared aggregation pool (requires aggregation: opt-in)')
  .action(async (slug, options) => {
    const { refine } = require('../lib/lifecycle/refine');
    try {
      await refine(slug, { emit: options.emit, apply: options.apply, fromPool: options.fromPool });
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

// ── State management commands (runner integration protocol) ──────────────────
//
// These commands are the standard interface for any agent runner to manage
// persona state. Runners call these before/after conversations regardless of
// where the persona pack is installed on disk.
//
// Lookup priority: registry path → default OP_SKILLS_DIR/persona-<slug>
// Delegates to scripts/state-sync.js inside the persona pack (no logic duplication).

// resolvePersonaDir and runStateSyncCommand are imported from lib/state/runner.js

const stateCmd = program
  .command('state')
  .description('Manage persona evolution state (runner integration — works from any directory)');

stateCmd
  .command('read <slug>')
  .description('Print current evolution state summary for a persona')
  .action((slug) => {
    runStateSyncCommand(slug, ['read']);
  });

stateCmd
  .command('write <slug> <patch>')
  .description('Merge JSON patch into persona evolution state')
  .action((slug, patch) => {
    runStateSyncCommand(slug, ['write', patch]);
  });

stateCmd
  .command('signal <slug> <type> [payload]')
  .description('Emit a signal from a persona to its host runtime')
  .action((slug, type, payload) => {
    const args = ['signal', type];
    if (payload) args.push(payload);
    runStateSyncCommand(slug, args);
  });

stateCmd
  .command('promote <slug>')
  .description('Soul-Memory Bridge: scan eventLog for recurring patterns and promote them to evolvedTraits')
  .option('--dry-run', 'Preview promotions without writing to state')
  .action((slug, opts) => {
    const { promoteToInstinct } = require('../lib/state/evolution');

    const personaDir = resolvePersonaDir(slug);
    if (!personaDir) {
      printError(`Persona not found: "${slug}". Install it first with: openpersona install <source>`);
      process.exit(1);
    }

    const personaPath = resolveSoulFile(personaDir, 'persona.json');
    const statePath   = resolveSoulFile(personaDir, 'state.json');

    if (!personaPath || !fs.existsSync(personaPath)) {
      printError(`persona.json not found in ${personaDir}`);
      process.exit(1);
    }

    let persona, state;
    try {
      persona = JSON.parse(fs.readFileSync(personaPath, 'utf-8'));
      state   = statePath && fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf-8')) : {};
    } catch (err) {
      printError(`promote: failed to read persona state: ${err.message}`);
      process.exit(1);
    }

    const eventLog      = state.eventLog     || [];
    const existingTraits = state.evolvedTraits || [];

    if (eventLog.length === 0) {
      printWarning(`promote: no eventLog entries found for ${slug} — nothing to promote`);
      return;
    }

    const newTraits = promoteToInstinct(eventLog, persona, existingTraits);

    if (newTraits.length === 0) {
      printInfo(`promote: no patterns reached threshold — evolvedTraits unchanged`);
      return;
    }

    if (opts.dryRun) {
      printInfo(`promote: ${newTraits.length} trait(s) would be promoted (dry run):`);
      for (const t of newTraits) printInfo(`  + ${t.trait}  (${t.evidenceCount} events)`);
      return;
    }

    const updatedTraits = [...existingTraits, ...newTraits];
    runStateSyncCommand(slug, ['write', JSON.stringify({ evolvedTraits: updatedTraits })]);
    printSuccess(`promote: promoted ${newTraits.length} trait(s) to evolvedTraits for ${slug}:`);
    for (const t of newTraits) printSuccess(`  + ${t.trait}  (${t.evidenceCount} events)`);
  });

stateCmd
  .command('responses <slug>')
  .description('Read (and consume) pending signal responses from the host')
  .option('--type <type>', 'Filter by signal type (scheduling|file_io|tool_missing|capability_gap|resource_limit|agent_communication)')
  .option('--peek',        'Read without marking responses as processed')
  .option('--json',        'Raw JSON output')
  .action((slug, opts) => {
    const args = ['responses'];
    if (opts.type) args.push(opts.type);
    if (opts.peek) args.push('--peek');

    // Delegate to state-sync.js and capture output for pretty-printing
    const personaDir = resolvePersonaDir(slug);
    if (!personaDir) {
      printError(`Persona not found: "${slug}". Install it first with: openpersona install <source>`);
      process.exit(1);
    }
    const syncScript = path.join(personaDir, 'scripts', 'state-sync.js');
    if (!fs.existsSync(syncScript)) {
      printError(`state-sync.js not found in persona-${slug}. Update the persona: openpersona update ${slug}`);
      process.exit(1);
    }
    const { spawnSync } = require('child_process');
    const result = spawnSync(process.execPath, [syncScript, ...args], {
      cwd: personaDir,
      encoding: 'utf-8',
    });
    if (result.error) {
      printError(`Failed to run state-sync.js: ${result.error.message}`);
      process.exit(1);
    }
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) process.exit(result.status || 1);

    if (opts.json) {
      process.stdout.write(result.stdout);
      return;
    }

    // Pretty-print
    let data;
    try { data = JSON.parse(result.stdout); } catch { process.stdout.write(result.stdout); return; }
    const { responses, total, peek } = data;
    if (total === 0) {
      printInfo(`No pending signal responses for "${slug}".`);
      return;
    }
    printInfo(`${peek ? '(peek — not consumed) ' : ''}${total} pending response(s) for "${slug}":`);
    for (const r of responses) {
      const isRejected = r.status === 'rejected' || r.status === 'unreachable';
      const statusIcon = r.status === 'resolved' || r.status === 'fulfilled' ? '✓' : isRejected ? '✗' : '~';
      const printer = isRejected ? printWarning : printInfo;
      printer(`  ${statusIcon}  [${r.type}]  status=${r.status}  ts=${r.timestamp}`);
      if (r.response && typeof r.response === 'object') {
        for (const [k, v] of Object.entries(r.response)) {
          printer(`      ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
        }
      }
    }
  });

// ─── Vitality ─────────────────────────────────────────────────────────────────

const vitalityCmd = program
  .command('vitality')
  .description('Persona Vitality — health scoring, reporting, and future multi-dimension monitoring');

vitalityCmd
  .command('score <slug>')
  .description('Print machine-readable Vitality score (used by Survival Policy and agent runners)')
  .action((slug) => {
    const { calcVitality }    = require('../lib/report/vitality');
    const { JsonFileAdapter } = require('agentbooks/adapters/json-file');

    const dataPath = process.env.AGENTBOOKS_DATA_PATH
      || path.join(OP_PERSONA_HOME, 'economy', `persona-${slug}`);

    const adapter = new JsonFileAdapter(dataPath);
    let report;
    try {
      report = calcVitality(slug, adapter);
    } catch (err) {
      printError(`vitality score: failed to compute for ${slug}: ${err.message}`);
      process.exit(1);
    }

    const fin = report.dimensions.financial;
    const lines = [
      'VITALITY_REPORT',
      `tier=${report.tier}  score=${(report.score * 100).toFixed(1)}%`,
      `diagnosis=${fin.diagnosis}`,
      `prescriptions=${(fin.prescriptions || []).join(',')}`,
    ];
    if (fin.daysToDepletion !== null && fin.daysToDepletion !== undefined) {
      lines.push(`daysToDepletion=${fin.daysToDepletion}`);
    }
    if (fin.dominantCost) lines.push(`dominantCost=${fin.dominantCost}`);
    lines.push(`trend=${fin.trend}`);
    console.log(lines.join('\n'));
  });

vitalityCmd
  .command('report <slug>')
  .description('Render a human-readable HTML Vitality report')
  .option('--output <file>', 'Write HTML to <file> instead of stdout')
  .action((slug, options) => {
    const personaDir = resolvePersonaDir(slug);
    if (!personaDir) {
      printError(`Persona not found: "${slug}". Install it first with: openpersona install <source>`);
      process.exit(1);
    }
    const { renderVitalityHtml } = require('../lib/report/vitality-report');
    let html;
    try {
      html = renderVitalityHtml(personaDir, slug);
    } catch (err) {
      printError(`vitality report: failed to render for ${slug}: ${err.message}`);
      process.exit(1);
    }
    if (options.output) {
      fs.writeFileSync(options.output, html, 'utf-8');
      printSuccess(`Vitality report written to ${options.output}`);
    } else {
      process.stdout.write(html);
    }
  });

// ── canvas ────────────────────────────────────────────────────────────────────

program
  .command('canvas <slug>')
  .description('Generate a Living Canvas persona profile page (P14 Phase 1)')
  .option('--output <file>', 'Write HTML to <file> (default: canvas-<slug>.html)')
  .option('--open', 'Open in default browser after writing')
  .action((slug, options) => {
    const personaDir = resolvePersonaDir(slug);
    if (!personaDir) {
      printError(`Persona not found: "${slug}". Install it first with: openpersona install <source>`);
      process.exit(1);
    }
    const { renderCanvasHtml } = require('../lib/report/canvas');
    let html;
    try {
      html = renderCanvasHtml(personaDir, slug);
    } catch (err) {
      printError(`canvas: failed to render for ${slug}: ${err.message}`);
      process.exit(1);
    }
    const outFile = options.output || `canvas-${slug}.html`;
    fs.writeFileSync(outFile, html, 'utf-8');
    printSuccess(`Living Canvas written to ${outFile}`);
    if (options.open) {
      const { execSync } = require('child_process');
      const cmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start'
        : 'xdg-open';
      try { execSync(`${cmd} "${outFile}"`); } catch { /* ignore */ }
    }
  });

// ── evaluate ──────────────────────────────────────────────────────────────────

program
  .command('evaluate <slug>')
  .description('Score a persona pack across 4 Layers + 5 Systemic Concepts (4+5 quality audit)')
  .option('--json', 'Output raw JSON report')
  .option('--output <file>', 'Write JSON report to <file>')
  .option('--pack-content', 'Embed evaluable persona content (soul/character/behavior-guide) in the JSON report — for LLM-driven semantic evaluation')
  .action((slug, options) => {
    const { evaluatePersona } = require('../lib/lifecycle/evaluator');
    let report;
    try {
      report = evaluatePersona(slug, { includeContent: !!options.packContent });
    } catch (err) {
      printError(`evaluate: ${err.message}`);
      process.exit(1);
    }

    if (options.output) {
      fs.writeFileSync(options.output, JSON.stringify(report, null, 2), 'utf-8');
      printSuccess(`Evaluation report written to ${options.output}`);
      return;
    }

    // --pack-content implies --json: the embedded content has no human-friendly
    // pretty-print, it's machine fodder for an LLM evaluator.
    if (options.json || options.packContent) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }

    // Pretty-print
    const scoreBar = (s) => {
      const filled = Math.round(s);
      return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${s}/10`;
    };

    console.log('');
    console.log(`  ┌─ OpenPersona Evaluation: ${report.slug} ${'─'.repeat(Math.max(0, 40 - report.slug.length))}`);
    console.log(`  │  Overall Score: ${report.overallScore}/10  [${report.band}]`);
    if (report.role) {
      const strictDims = report.dimensions.filter(d => d.severity === 'strict').map(d => d.dimension);
      const lenientDims = report.dimensions.filter(d => d.severity === 'lenient').map(d => d.dimension);
      const hint = [
        strictDims.length ? `strict: ${strictDims.join(', ')}`  : null,
        lenientDims.length ? `lenient: ${lenientDims.join(', ')}` : null,
      ].filter(Boolean).join(' · ');
      console.log(`  │  Role: ${report.role}${hint ? `  (${hint})` : ''}`);
    } else {
      console.log(`  │  Role: (not declared — using default profile)`);
    }
    if (!report.constitution.passed) {
      printWarning(`  │  ⚠ Constitution: FAILED (${report.constitution.violations.length} violation(s))`);
    } else {
      printSuccess(`  │  ✓ Constitution: PASSED`);
    }
    console.log(`  └${'─'.repeat(52)}`);
    console.log('');

    const severityTag = (sev) => {
      if (sev === 'strict')  return ' \x1b[33m[strict]\x1b[0m';
      if (sev === 'lenient') return ' \x1b[90m[lenient]\x1b[0m';
      return '';
    };

    for (const d of report.dimensions) {
      const label = (d.dimension + ':').padEnd(12);
      const neutral = d.neutral ? ' (not declared)' : '';
      console.log(`  ${label} ${scoreBar(d.score)}${neutral}${severityTag(d.severity)}`);
      for (const issue of (d.issues || [])) {
        printWarning(`             ✗ ${issue}`);
      }
      for (const sug of (d.suggestions || [])) {
        printInfo(`             → ${sug}`);
      }
    }

    if (report.constitution.violations.length > 0) {
      console.log('');
      printWarning('  Constitution Violations (§3 Safety):');
      for (const v of report.constitution.violations) {
        printWarning(`    [${v.section}] ${v.label}  (line ${v.lineNumber})`);
      }
    }
    if (report.constitution.warnings.length > 0) {
      console.log('');
      printWarning('  Constitution Concerns (§2/§7):');
      for (const w of report.constitution.warnings) {
        printWarning(`    [${w.section}] ${w.label}  (line ${w.lineNumber})`);
      }
    }

    const sum = report.summary;
    if (sum.strengths.length > 0) {
      console.log('');
      printSuccess(`  Strengths: ${sum.strengths.join(', ')}`);
    }
    if (sum.gaps.length > 0) {
      printWarning(`  Needs Work: ${sum.gaps.join(', ')}`);
    }
    console.log('');
  });

// ---------------------------------------------------------------------------
// dataset — HF dataset directory integration
// ---------------------------------------------------------------------------

const datasetCmd = program
  .command('dataset')
  .description('Hugging Face dataset directory — install and publish persona datasets');

datasetCmd
  .command('install <repo>')
  .description('Record an install event for a HF dataset (increments counter on openpersona.co/datasets)')
  .addHelpText('after', '\nExample:\n  openpersona dataset install proj-persona/PersonaHub')
  .action(async (repo) => {
    try {
      await datasetPublisher.install(repo);
    } catch (err) {
      printError(`dataset install: ${err.message}`);
      process.exit(1);
    }
  });

datasetCmd
  .command('publish <repo>')
  .description('Publish a HF dataset to the OpenPersona dataset directory (openpersona.co/datasets)')
  .addHelpText('after', [
    '',
    'Example:',
    '  openpersona dataset publish proj-persona/PersonaHub',
    '',
    'Note: CLI publish is anonymous (no curated badge).',
    'To get a curated badge, publish via the web UI while logged in with HF.',
  ].join('\n'))
  .action(async (repo) => {
    try {
      await datasetPublisher.publish(repo);
    } catch (err) {
      printError(`dataset publish: ${err.message}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// skill — Agent skill pack lifecycle
// ---------------------------------------------------------------------------

const skillCmd = program
  .command('skill')
  .description('Agent skill registry — install, update, publish, and manage skill packs');

skillCmd
  .command('install <target>')
  .description('Install a skill pack (owner/repo, owner/repo#subpath, local dir, or local zip)')
  .option('--runtime <name>', `Target runtime: ${skillInstaller.VALID_RUNTIMES.join(' | ')}`)
  .option('--global', 'Install to ~/.agents/skills/ (user-global AGENTS.md convention)')
  .option('--all', 'Install to all detected runtime dirs in CWD (.cursor/, .claude/, .agents/)')
  .option('--force', 'Bypass constitution compliance check (not recommended — review flagged content first)')
  .addHelpText('after', [
    '',
    'Examples:',
    '  openpersona skill install acnlabs/anyone-skill',
    '  openpersona skill install owner/repo --global',
    '  openpersona skill install owner/repo --runtime=claude',
    '  openpersona skill install owner/repo --runtime=cursor',
    '  openpersona skill install owner/repo --all',
    '  openpersona skill install ./local-skill-dir',
    '',
    'Default target: .agents/skills/<slug>/  (discoverable by Cursor, Claude Code, OpenClaw)',
  ].join('\n'))
  .action(async (target, options) => {
    let dir;
    let skipCopy = false;
    try {
      const result = await download(target, 'acnlabs');
      dir = result.dir;
      skipCopy = !!result.skipCopy;
      const skillMdCandidates = [
        path.join(dir, 'SKILL.md'),
        path.join(dir, 'SKILL', 'SKILL.md'),
        path.join(dir, 'skill', 'SKILL.md'),
      ];
      const skillMdPath = skillMdCandidates.find((p) => fs.existsSync(p));
      if (!skillMdPath) {
        printError('No SKILL.md found — not a valid skill pack.');
        printInfo('Make sure the repo contains a SKILL.md in the root or SKILL/ directory.');
        process.exit(1);
      }
      // Strong typing: persona packs should use `persona install`
      const hasPersonaJson = fs.existsSync(path.join(dir, 'persona.json')) ||
        fs.existsSync(path.join(dir, 'soul', 'persona.json'));
      if (hasPersonaJson) {
        printError('This is a persona pack (has persona.json), not a skill-only pack.');
        printInfo(`Use: openpersona persona install ${target}`);
        process.exit(1);
      }
      await skillInstaller.installSkill(dir, skillMdPath, {
        runtime: options.runtime,
        global: options.global,
        all: options.all,
        force: options.force,
        source: target,
      });
    } catch (e) {
      printError(e.message);
      process.exit(1);
    } finally {
      if (dir && !skipCopy) {
        try { await fs.remove(dir); } catch { /* ignore */ }
      }
    }
  });

skillCmd
  .command('update <slug>')
  .description('Re-download and overwrite an installed skill from its recorded source URL')
  .addHelpText('after', '\nExample:\n  openpersona skill update anyone-skill')
  .action(async (slug) => {
    try {
      await skillUpdater.updateSkill(slug);
    } catch (e) {
      if (!e._handled) printError(e.message);
      process.exit(1);
    }
  });

skillCmd
  .command('uninstall <slug>')
  .description('Uninstall a skill pack (looks up installTarget from registry)')
  .addHelpText('after', '\nExample:\n  openpersona skill uninstall anyone-skill')
  .action(async (slug) => {
    try {
      await skillUninstaller.uninstallSkill(slug);
    } catch (e) {
      if (!e._handled) printError(e.message);
      process.exit(1);
    }
  });

skillCmd
  .command('list')
  .description('List installed skills (registry + filesystem scan of .agents/skills/)')
  .action(() => {
    const { registered, unregistered } = skillInstaller.listSkills();
    if (registered.length === 0 && unregistered.length === 0) {
      printInfo('No skills installed.');
      printInfo('Install one: openpersona skill install owner/repo');
      return;
    }
    console.log('');
    if (registered.length > 0) {
      console.log('  Registered skills:');
      for (const s of registered) {
        const target = s.installTarget || s.path || '(unknown path)';
        console.log(`    ${s.personaName || s.slug}  (${s.slug})`);
        console.log(`      Location: ${target}`);
        if (s.source) console.log(`      Source  : ${s.source}`);
      }
    }
    if (unregistered.length > 0) {
      console.log('');
      console.log('  Unregistered skills (found on filesystem):');
      for (const s of unregistered) {
        console.log(`    ${s.slug}`);
        console.log(`      Location: ${s.path}`);
        console.log(`      (install via openpersona to register)`);
      }
    }
    console.log('');
  });

skillCmd
  .command('search <query>')
  .description('Search the OpenPersona skill directory')
  .addHelpText('after', '\nExample:\n  openpersona skill search persona')
  .action(async (query) => {
    try {
      await skillSearcher.search(query);
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

skillCmd
  .command('publish <owner/repo>')
  .description('Publish a skill pack to the OpenPersona skill directory (openpersona.co/skills)')
  .addHelpText('after', [
    '',
    'Example:',
    '  openpersona skill publish owner/my-skill',
    '',
    'Your repo must have a valid SKILL.md with name, description, and version in frontmatter.',
  ].join('\n'))
  .action(async (ownerRepo) => {
    try {
      await skillPublisher.publish(ownerRepo);
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

skillCmd
  .command('info <slug>')
  .description('Show local info for an installed skill (registry entry + SKILL.md frontmatter)')
  .action((slug) => {
    const { loadRegistry } = require('../lib/registry');
    const reg = loadRegistry();
    const entry = reg.personas?.[slug];
    if (!entry) {
      printError(`Skill not found in registry: "${slug}"`);
      printInfo('Run `openpersona skill list` to see installed skills.');
      process.exit(1);
    }
    const target = entry.installTarget || entry.path;
    console.log('');
    console.log(`  Skill: ${entry.personaName || slug}`);
    console.log(`  Slug : ${slug}`);
    if (entry.source)    console.log(`  Source  : ${entry.source}`);
    if (target)          console.log(`  Location: ${target}`);
    if (entry.installedAt) console.log(`  Installed: ${entry.installedAt}`);
    if (entry.updatedAt)   console.log(`  Updated  : ${entry.updatedAt}`);

    // Read SKILL.md frontmatter
    if (target) {
      const skillMdCandidates = [
        path.join(target, 'SKILL.md'),
        path.join(target, 'SKILL', 'SKILL.md'),
      ];
      const skillMdPath = skillMdCandidates.find((p) => fs.existsSync(p));
      if (skillMdPath) {
        const fm = skillInstaller.parseFrontmatter(fs.readFileSync(skillMdPath, 'utf-8'));
        if (fm.version)     console.log(`  Version : ${fm.version}`);
        if (fm.description) console.log(`  Desc    : ${fm.description}`);
      }
    }
    console.log('');
  });

// ---------------------------------------------------------------------------
// persona — Namespace aliases for all persona commands (mirrors root commands)
// Lets users use `openpersona persona install`, `openpersona persona list`, etc.
// Root commands remain fully functional — no deprecation warnings in v0.21.0.
// ---------------------------------------------------------------------------

const personaCmd = program
  .command('persona')
  .description('Persona agents — create, install, fork, refine, publish, and more (namespace alias for root commands)');

// Re-export action handlers from existing root command registrations is not
// directly supported by Commander — we register thin wrappers that delegate to
// the same underlying library calls used by root commands.

personaCmd
  .command('create')
  .description('Create a new persona skill pack (interactive wizard)')
  .option('--preset <name>', 'Use preset (base, samantha, ai-girlfriend, life-assistant, health-butler, stoic-mentor)')
  .option('--config <path>', 'Load external persona.json')
  .option('--output <dir>', 'Output directory', process.cwd())
  .option('--install', 'Install to ~/.openpersona after generation')
  .option('--dry-run', 'Preview only, do not write files')
  .action(async (options) => {
    // Delegate to root `create` by re-invoking via process (simplest approach for aliases)
    const args = ['create'];
    if (options.preset)  args.push('--preset', options.preset);
    if (options.config)  args.push('--config', options.config);
    if (options.output)  args.push('--output', options.output);
    if (options.install) args.push('--install');
    if (options.dryRun)  args.push('--dry-run');
    process.argv = [process.argv[0], process.argv[1], ...args];
    // Re-parse — Commander will pick up the root `create` command
    program.parseAsync(['', '', ...args]).catch((e) => { printError(e.message); process.exit(1); });
  });

personaCmd
  .command('install <target>')
  .description('Install a persona pack (strong-typed: errors on SKILL.md-only packs)')
  .option('--registry <name>', 'Registry (acnlabs, skillssh)', 'acnlabs')
  .addHelpText('after', '\nFor skill packs use: openpersona skill install <target>')
  .action(async (target, options) => {
    let dir;
    let skipCopy = false;
    try {
      const result = await download(target, options.registry);
      dir = result.dir;
      skipCopy = !!result.skipCopy;
      const hasPersonaJson = fs.existsSync(path.join(dir, 'persona.json')) ||
        fs.existsSync(path.join(dir, 'soul', 'persona.json'));
      if (!hasPersonaJson) {
        printError('This is a SKILL.md-only pack, not a persona pack.');
        printInfo(`Try: openpersona skill install ${target}`);
        process.exit(1);
      }
      await install(dir, skipCopy ? { skipCopy: true, source: target } : { source: target });
    } catch (e) {
      printError(e.message);
      process.exit(1);
    } finally {
      if (dir && !skipCopy) {
        try { await fs.remove(dir); } catch { /* ignore */ }
      }
    }
  });

personaCmd
  .command('fork <parent-slug>')
  .description('Fork an installed persona into a specialized child')
  .requiredOption('--as <new-slug>', 'Slug for the child persona')
  .option('--name <name>', 'Child persona name')
  .option('--bio <bio>', 'Override bio')
  .option('--personality <keywords>', 'Override personality (comma-separated)')
  .option('--reason <text>', 'Fork reason', 'specialization')
  .option('--output <dir>', 'Output directory', process.cwd())
  .option('--install', 'Install to ~/.openpersona after generation')
  .action(async (parentSlug, options) => {
    try {
      const { skillDir, lineage } = await forkPersona(parentSlug, {
        as: options.as, name: options.name, bio: options.bio,
        personality: options.personality, reason: options.reason,
        output: options.output, install: options.install,
      });
      printSuccess(`Forked: ${skillDir}`);
      printInfo(`  Parent: persona-${parentSlug}  →  Child: persona-${options.as} (generation ${lineage.generation})`);
      if (!options.install) printInfo(`To install: npx openpersona install ${skillDir}`);
    } catch (e) { printError(e.message); process.exit(1); }
  });

personaCmd
  .command('uninstall <slug>')
  .description('Uninstall persona')
  .action(async (slug) => {
    try { await uninstall(slug); }
    catch (e) { printError(e.message); process.exit(1); }
  });

personaCmd
  .command('update <slug>')
  .description('Update installed persona')
  .action(async (slug) => {
    const skillDir = resolvePersonaDir(slug);
    if (!skillDir) { printError(`Persona not found: "${slug}"`); process.exit(1); }
    const personaPath = resolveSoulFile(skillDir, 'persona.json');
    if (!fs.existsSync(personaPath)) { printError('persona.json not found'); process.exit(1); }
    const persona = JSON.parse(fs.readFileSync(personaPath, 'utf-8'));
    const tmpDir = path.join(os.tmpdir(), 'openpersona-update-' + Date.now());
    await fs.ensureDir(tmpDir);
    const { skillDir: newDir } = await generate(persona, tmpDir);
    const runtimeArtifacts = ['state.json', 'soul/self-narrative.md', 'soul/lineage.json'];
    for (const rel of runtimeArtifacts) {
      const src = path.join(skillDir, rel);
      if (fs.existsSync(src)) await fs.copy(src, path.join(newDir, rel));
    }
    await fs.remove(skillDir);
    await fs.move(newDir, skillDir);
    await fs.remove(tmpDir);
    await install(skillDir, { skipCopy: true });
    printSuccess('Updated persona-' + slug);
  });

personaCmd
  .command('list')
  .description('List installed personas')
  .action(async () => {
    const personas = await listPersonas();
    if (personas.length === 0) { printInfo('No personas installed.'); return; }
    for (const p of personas) {
      const marker = p.active ? chalk.green(' ← active') : '';
      const status = p.enabled ? '' : chalk.dim(' (disabled)');
      const typeTag = p.packType && p.packType !== 'single' ? chalk.cyan(` [${p.packType}]`) : '';
      console.log(`  ${p.personaName} (persona-${p.slug})${typeTag}${marker}${status}`);
    }
  });

personaCmd
  .command('search <query>')
  .description('Search personas in the OpenPersona directory')
  .option('--type <type>', 'Filter by pack type: single or multi')
  .action(async (query, options) => {
    try { await search(query, { type: options.type }); }
    catch (e) { printError(e.message); process.exit(1); }
  });

personaCmd
  .command('switch <slug>')
  .description('Switch active persona')
  .action(async (slug) => {
    try { await switchPersona(slug); }
    catch (e) { printError(e.message); process.exit(1); }
  });

personaCmd
  .command('publish <owner/repo>')
  .description('Validate a GitHub repo as a persona pack and register it with the OpenPersona directory')
  .action(async (ownerRepo) => {
    try { await publishAdapter.publish(ownerRepo); }
    catch (e) { printError(e.message); process.exit(1); }
  });

personaCmd
  .command('export <slug>')
  .description('Export persona pack (with soul state) as a zip archive')
  .option('--output <file>', 'Output zip file path')
  .action(async (slug, options) => {
    try { await exportPersona(slug, options); }
    catch (e) { printError(e.message); process.exit(1); }
  });

personaCmd
  .command('import <file>')
  .description('Import persona pack from a zip archive and install')
  .option('--as <slug>', 'Override slug on import')
  .action(async (file, options) => {
    try { await importPersona(file, options); }
    catch (e) { printError(e.message); process.exit(1); }
  });

personaCmd
  .command('contribute [slug]')
  .description('Persona Harvest — submit persona improvements as a PR to the community')
  .option('--slug <slug>', 'Target persona slug')
  .action(async (slug, options) => {
    try { await contribute(slug || options.slug); }
    catch (e) { printError(e.message); process.exit(1); }
  });

personaCmd
  .command('acn-register [slug]')
  .description('Register a persona with ACN (Agent Communication Network)')
  .option('--slug <slug>', 'Persona slug')
  .action(async (slug, options) => {
    try { await registerWithAcn(slug || options.slug); }
    catch (e) { printError(e.message); process.exit(1); }
  });

personaCmd
  .command('reset <slug>')
  .description('★Experimental: Reset soul evolution state')
  .action(async (slug) => {
    const skillDir = resolvePersonaDir(slug);
    if (!skillDir) { printError(`Persona not found: "${slug}"`); process.exit(1); }
    const statePath = path.join(skillDir, 'state.json');
    if (fs.existsSync(statePath)) { await fs.remove(statePath); printSuccess(`Reset state.json for persona-${slug}`); }
    else printInfo(`No state.json found for persona-${slug} — already clean.`);
  });

personaCmd
  .command('evolve-report <slug>')
  .description('★Experimental: Show evolution report for a persona')
  .action(async (slug) => {
    try {
      const { generateEvolveReport } = require('../lib/state/evolution');
      const skillDir = resolvePersonaDir(slug);
      if (!skillDir) { printError(`Persona not found: "${slug}"`); process.exit(1); }
      const report = await generateEvolveReport(skillDir, slug);
      console.log(report);
    } catch (e) { printError(e.message); process.exit(1); }
  });

personaCmd
  .command('refine <slug>')
  .description('Refine persona skill pack from accumulated experience (pack-level evolution)')
  .option('--threshold <n>', 'Min events before refinement triggers', '5')
  .option('--dry-run', 'Preview changes without writing')
  .action(async (slug, options) => {
    try {
      const { refine } = require('../lib/lifecycle/refine');
      await refine(slug, { threshold: parseInt(options.threshold, 10), dryRun: options.dryRun });
    } catch (e) { printError(e.message); process.exit(1); }
  });

personaCmd
  .command('canvas <slug>')
  .description('Generate a Living Canvas persona profile page')
  .option('--output <file>', 'Write HTML to <file>')
  .option('--open', 'Open in default browser after writing')
  .action((slug, options) => {
    const personaDir = resolvePersonaDir(slug);
    if (!personaDir) { printError(`Persona not found: "${slug}"`); process.exit(1); }
    const { renderCanvasHtml } = require('../lib/report/canvas');
    try {
      const html = renderCanvasHtml(personaDir, slug);
      const outFile = options.output || `canvas-${slug}.html`;
      fs.writeFileSync(outFile, html, 'utf-8');
      printSuccess(`Living Canvas written to ${outFile}`);
      if (options.open) {
        const { execSync } = require('child_process');
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        try { execSync(`${cmd} "${outFile}"`); } catch { /* ignore */ }
      }
    } catch (e) { printError(e.message); process.exit(1); }
  });

personaCmd
  .command('curate <owner/repo>')
  .description('Curator-only: actively collect a popular persona pack (requires OPENPERSONA_CURATOR_TOKEN)')
  .option('--type <type>', 'Pack type: single (default), multi, or tool', 'single')
  .option('--role <role>', 'Override role')
  .option('--token <token>', 'Curator authentication token')
  .option('--tags <tags>', 'Comma-separated tag list')
  .option('--min-stars <n>', 'Minimum GitHub star count', '500')
  .action(async (ownerRepo, options) => {
    try {
      await curate(ownerRepo, { packType: options.type, role: options.role, token: options.token, tags: options.tags, minStars: parseInt(options.minStars, 10) });
    } catch (e) { printError(e.message); process.exit(1); }
  });

// ---------------------------------------------------------------------------
// model — Persona model lifecycle (stub — coming in v1.0)
// ---------------------------------------------------------------------------

const modelCmd = program
  .command('model')
  .description('Persona models — install and publish fine-tuned persona models (coming in v1.0)');

const _modelStub = (cmdName) => () => {
  printWarning(`openpersona model ${cmdName} is not yet implemented.`);
  printInfo('For now, use the persona-model-trainer skill directly:');
  printInfo('  openpersona skill install acnlabs/persona-model-trainer');
  printInfo('Full model registry integration is planned for v1.0.');
  process.exit(0);
};

modelCmd
  .command('install <repo>')
  .description('Install a fine-tuned persona model from HuggingFace (coming in v1.0)')
  .action(_modelStub('install'));

modelCmd
  .command('publish <repo>')
  .description('Publish a fine-tuned persona model to the OpenPersona model registry (coming in v1.0)')
  .action(_modelStub('publish'));

// ---------------------------------------------------------------------------
// social — ACN contact book management
// ---------------------------------------------------------------------------

const {
  addContact,
  removeContact,
  lookupContact,
  listContacts,
} = require('../lib/social/contacts');
const {
  fetchAgent,
  searchAgents,
  syncContacts,
  pingAgent,
  sendMessage,
  listSubnets,
  joinSubnet,
  leaveSubnet,
  broadcastMessage,
  sendHeartbeat,
} = require('../lib/social/acn-client');

const socialCmd = program
  .command('social')
  .description('Manage the social contact book for an installed persona (ACN-backed)');

/**
 * Parse a --filter string like "trust=community" or "tag=music" into an object.
 */
function parseFilter(raw) {
  if (!raw) return {};
  const [key, value] = raw.split('=');
  if (!key || !value) return {};
  const k = key.trim().toLowerCase();
  const v = value.trim();
  if (k === 'trust') return { trust: v };
  if (k === 'tag') return { tag: v };
  if (k === 'skill') return { skill: v };
  printWarning(`Unknown filter key "${k}". Supported: trust, tag, skill.`);
  return {};
}

/**
 * Read ACN gateway from installed pack's acn-config.json, or use a default.
 */
function resolveGateway(packDir) {
  try {
    const p = path.join(packDir, 'acn-config.json');
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (cfg.acn_gateway && !cfg.acn_gateway.startsWith('<')) return cfg.acn_gateway;
    }
  } catch { /* ignore */ }
  return 'https://acn-production.up.railway.app';
}

socialCmd
  .command('list <slug>')
  .description('List contacts in the persona\'s contact book')
  .option('--filter <expr>', 'Filter: trust=<level>, tag=<value>, skill=<value>')
  .option('--json', 'Output raw JSON')
  .action((slug, options) => {
    const { resolvePersonaDir } = require('../lib/state/runner');
    if (!resolvePersonaDir(slug)) {
      printError(`Persona not installed: "${slug}". Install first with: openpersona install <source>`);
      process.exit(1);
    }
    const filter = parseFilter(options.filter);
    const contacts = listContacts(slug, filter);
    if (options.json) {
      console.log(JSON.stringify(contacts, null, 2));
    } else if (contacts.length === 0) {
      printInfo('No contacts found.');
    } else {
      contacts.forEach((c) => {
        const skills = (c.skills || []).slice(0, 3).join(', ') || '—';
        console.log(`${chalk.bold(c.name)} [${c.trust_level}] ${c.acn_agent_id}`);
        console.log(`  Skills: ${skills}  Tags: ${(c.tags || []).join(', ') || '—'}  Interactions: ${c.interaction_count || 0}`);
      });
      printInfo(`Total: ${contacts.length} contact(s)`);
    }
  });

socialCmd
  .command('add <slug>')
  .description('Add a contact by ACN agent-id or manual JSON file')
  .option('--from-acn <agent-id>', 'Look up agent from ACN and add to contacts')
  .option('--manual', 'Add manually from a JSON file')
  .option('--file <path>', 'Path to contact JSON file (required with --manual)')
  .option('--trust <level>', 'Override trust level (verified, community, unverified)', 'unverified')
  .action(async (slug, options) => {
    const { resolvePersonaDir } = require('../lib/state/runner');
    const packDir = resolvePersonaDir(slug);
    if (!packDir) {
      printError(`Persona not installed: "${slug}". Install first with: openpersona install <source>`);
      process.exit(1);
    }

    if (options.fromAcn) {
      printInfo(`Looking up agent ${options.fromAcn} from ACN...`);
      const gateway = resolveGateway(packDir);
      let agent;
      try {
        agent = await fetchAgent(gateway, options.fromAcn);
      } catch (e) {
        printError(`Failed to fetch agent from ACN: ${e.message}`);
        process.exit(1);
      }
      if (!agent) {
        printError(`Agent "${options.fromAcn}" not found on ACN.`);
        process.exit(1);
      }
      const contact = {
        acn_agent_id: options.fromAcn,
        name: agent.name || options.fromAcn,
        endpoint: agent.endpoint,
        skills: agent.skills || [],
        subnet_ids: agent.subnet_ids || [],
        agent_card_url: gateway + `/api/v1/agents/${options.fromAcn}/card`,
        trust_level: options.trust,
        last_synced: new Date().toISOString(),
      };
      const entry = addContact(slug, contact, { source: 'acn-sync' });
      printSuccess(`Added contact: ${entry.name} (${entry.acn_agent_id}) [${entry.trust_level}]`);
    } else if (options.manual) {
      if (!options.file) {
        printError('--file <path> is required with --manual');
        process.exit(1);
      }
      let contactData;
      try {
        contactData = JSON.parse(require('fs-extra').readFileSync(options.file, 'utf-8'));
      } catch (e) {
        printError(`Failed to read contact file: ${e.message}`);
        process.exit(1);
      }
      if (options.trust) contactData.trust_level = options.trust;
      const entry = addContact(slug, contactData, { source: 'manual' });
      printSuccess(`Added contact: ${entry.name} (${entry.acn_agent_id}) [${entry.trust_level}]`);
    } else {
      printError('Specify --from-acn <agent-id> or --manual --file <path>');
      process.exit(1);
    }
  });

socialCmd
  .command('lookup <slug> <query>')
  .description('Search local contacts by agent-id, slug, name, skill, or tag')
  .option('--json', 'Output raw JSON')
  .action((slug, query, options) => {
    const { resolvePersonaDir } = require('../lib/state/runner');
    if (!resolvePersonaDir(slug)) {
      printError(`Persona not installed: "${slug}". Install first with: openpersona install <source>`);
      process.exit(1);
    }
    const results = lookupContact(slug, query);
    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
    } else if (results.length === 0) {
      printInfo(`No contacts matching "${query}".`);
    } else {
      results.forEach((c) => {
        console.log(`${chalk.bold(c.name)} [${c.trust_level}] ${c.acn_agent_id}`);
        console.log(`  Skills: ${(c.skills || []).join(', ') || '—'}`);
      });
    }
  });

socialCmd
  .command('search <slug>')
  .description('Search for agents on ACN (remote search)')
  .option('--skills <csv>', 'Comma-separated skill IDs to filter by')
  .option('--subnet <id>', 'Subnet ID to search in')
  .option('--json', 'Output raw JSON')
  .action(async (slug, options) => {
    const { resolvePersonaDir } = require('../lib/state/runner');
    const packDir = resolvePersonaDir(slug);
    if (!packDir) {
      printError(`Persona not installed: "${slug}". Install first with: openpersona install <source>`);
      process.exit(1);
    }
    const gateway = resolveGateway(packDir);
    printInfo(`Searching ACN at ${gateway}...`);
    let agents;
    try {
      agents = await searchAgents(gateway, { skills: options.skills, subnet: options.subnet });
    } catch (e) {
      printError(`ACN search failed: ${e.message}`);
      process.exit(1);
    }
    if (options.json) {
      console.log(JSON.stringify(agents, null, 2));
    } else if (agents.length === 0) {
      printInfo('No agents found matching search criteria.');
    } else {
      agents.forEach((a) => {
        const skills = (a.skills || []).slice(0, 3).join(', ') || '—';
        console.log(`${chalk.bold(a.name || a.agent_id)} [${a.agent_id}]`);
        console.log(`  Skills: ${skills}  Endpoint: ${a.endpoint || '—'}`);
      });
      printInfo(`Found: ${agents.length} agent(s)`);
    }
  });

socialCmd
  .command('sync <slug>')
  .description('Sync all contacts from ACN (refresh endpoint and skills)')
  .option('--dry-run', 'Preview changes without saving')
  .action(async (slug, options) => {
    const { resolvePersonaDir } = require('../lib/state/runner');
    const packDir = resolvePersonaDir(slug);
    if (!packDir) {
      printError(`Persona not installed: "${slug}". Install first with: openpersona install <source>`);
      process.exit(1);
    }
    const gateway = resolveGateway(packDir);
    printInfo(`Syncing contacts from ACN at ${gateway}...`);
    let result;
    try {
      result = await syncContacts(slug, gateway, { dryRun: options.dryRun });
    } catch (e) {
      printError(`Sync failed: ${e.message}`);
      process.exit(1);
    }
    if (options.dryRun) {
      printInfo(`[dry-run] Would refresh: ${result.refreshed} | fail: ${result.failed} | skip: ${result.skipped}`);
    } else {
      printSuccess(`Sync complete — refreshed: ${result.refreshed} | failed: ${result.failed} | skipped: ${result.skipped}`);
      if (result.failed > 0) {
        printWarning(`${result.failed} contact(s) could not be refreshed (offline or deleted on ACN). They are preserved with last_synced=null.`);
      }
    }
  });

socialCmd
  .command('remove <slug> <agent-id>')
  .description('Remove a contact from the contact book')
  .action((slug, agentId) => {
    const { resolvePersonaDir } = require('../lib/state/runner');
    if (!resolvePersonaDir(slug)) {
      printError(`Persona not installed: "${slug}". Install first with: openpersona install <source>`);
      process.exit(1);
    }
    const removed = removeContact(slug, agentId);
    if (removed) {
      printSuccess(`Removed contact: ${agentId}`);
    } else {
      printWarning(`Contact not found: ${agentId}`);
    }
  });

socialCmd
  .command('ping <slug> <agent-id>')
  .description('Check whether a contact\'s endpoint is reachable')
  .action(async (slug, agentId) => {
    const { resolvePersonaDir } = require('../lib/state/runner');
    if (!resolvePersonaDir(slug)) {
      printError(`Persona not installed: "${slug}". Install first with: openpersona install <source>`);
      process.exit(1);
    }
    const contact = lookupContact(slug, agentId);
    if (!contact) {
      printError(`Contact not found: "${agentId}". Add with: openpersona social add ${slug} --from-acn ${agentId}`);
      process.exit(1);
    }
    if (!contact.endpoint) {
      printError(`Contact "${agentId}" has no endpoint. Run: openpersona social sync ${slug}`);
      process.exit(1);
    }
    printInfo(`Pinging ${contact.name || agentId} at ${contact.endpoint} …`);
    const result = await pingAgent(contact.endpoint);
    if (result.online) {
      printSuccess(`Online (${result.latencyMs}ms)`);
    } else {
      printWarning(`Offline or unreachable (${result.latencyMs}ms)`);
      process.exit(1);
    }
  });

socialCmd
  .command('send <slug> <agent-id> <message>')
  .description('Send a message to a contact (direct if online, inbox fallback if offline)')
  .option('--no-fallback', 'Disable ACN inbox fallback — fail if target is offline')
  .option('--type <type>', 'Message type field (e.g. task, greeting, trait_nudge)', 'message')
  .action(async (slug, agentId, message, opts) => {
    const { resolvePersonaDir } = require('../lib/state/runner');
    const personaDir = resolvePersonaDir(slug);
    if (!personaDir) {
      printError(`Persona not installed: "${slug}". Install first with: openpersona install <source>`);
      process.exit(1);
    }

    const contact = lookupContact(slug, agentId);
    if (!contact) {
      printError(`Contact not found: "${agentId}". Add with: openpersona social add ${slug} --from-acn ${agentId}`);
      process.exit(1);
    }

    const gateway = resolveGateway(personaDir, slug);
    if (!gateway && opts.fallback !== false) {
      printWarning('No ACN gateway configured — inbox fallback disabled');
    }

    // Load sender credentials from acn-registration.json (optional).
    // registrar.js writes camelCase (agentId/apiKey); tolerate both spellings.
    let senderAgentId;
    let apiKey;
    const regPath = path.join(personaDir, 'acn-registration.json');
    if (fs.existsSync(regPath)) {
      try {
        const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
        senderAgentId = reg.agentId || reg.agent_id;
        apiKey = reg.apiKey || reg.api_key;
      } catch { /* optional */ }
    }

    const payload = { type: opts.type, text: message };
    const inboxFallback = opts.fallback !== false && !!gateway;

    try {
      const result = await sendMessage(gateway, agentId, contact.endpoint, payload, {
        inboxFallback,
        senderAgentId,
        apiKey,
      });

      if (result.status === 'sent') {
        printSuccess(`Message delivered directly to ${contact.name || agentId} (${result.latencyMs}ms)`);
      } else if (result.status === 'relayed') {
        printSuccess(`${contact.name || agentId} is offline — message relayed via ACN (DLQ-backed)`);
      } else {
        printWarning(`${contact.name || agentId} is offline and relay fallback is disabled. Message not delivered.`);
        process.exit(1);
      }
    } catch (e) {
      printError(`Send failed: ${e.message}`);
      process.exit(1);
    }
  });

socialCmd
  .command('inbox <slug>')
  .description('Poll the ACN offline inbox and inject received messages into state.json pendingCommands')
  .option('--poll', 'Keep polling on a loop (Ctrl-C to stop)')
  .option('--interval <secs>', 'Polling interval in seconds (with --poll)', '30')
  .option('--limit <n>', 'Max messages per poll (ACN hard-cap: 50)', '50')
  .option('--no-ack', 'Peek without clearing inbox (uses client-side cursor). Default is server-side ack.')
  .option('--dry-run', 'Print messages without writing to state.json')
  .action(async (slug, opts) => {
    const { pollInbox } = require('../lib/social/inbox');
    const ack      = opts.ack !== false;  // --no-ack sets opts.ack = false
    const limit    = Math.min(parseInt(opts.limit, 10) || 50, 50);
    const dryRun   = !!opts.dryRun;
    const interval = Math.max(parseInt(opts.interval, 10) || 30, 5) * 1000;

    const runOnce = async () => {
      try {
        const result = await pollInbox(slug, { ack, limit, dryRun });

        if (result.injected === 0 && result.filtered === 0) {
          if (!opts.poll) printInfo('No new messages in ACN inbox.');
          return;
        }

        if (result.filtered > 0) {
          printWarning(
            `${result.filtered} message(s) blocked by Contact Trust Gate and discarded` +
            (ack ? ' (ack=true: already cleared from ACN inbox).' : '.')
          );
        }

        if (result.injected > 0) {
          if (dryRun) {
            printInfo(`[dry-run] ${result.injected} message(s) would be injected into pendingCommands:`);
          } else {
            printSuccess(`Injected ${result.injected} message(s) into ${slug} pendingCommands.`);
          }
          for (const cmd of result.messages) {
            const p = cmd.payload;
            const trust = chalk.dim(`[${p.trust_level}]`);
            const from  = chalk.bold(p.from_name !== p.from_agent ? `${p.from_name} <${p.from_agent}>` : p.from_agent);
            const msgPreview = typeof p.message === 'object'
              ? (p.message.text || JSON.stringify(p.message).slice(0, 80))
              : String(p.message).slice(0, 80);
            console.log(`  ${trust} ${from}  ${chalk.dim(p.received_at)}`);
            console.log(`    ${msgPreview}`);
          }
        }
      } catch (e) {
        printError(`Inbox poll failed: ${e.message}`);
        if (!opts.poll) process.exit(1);
      }
    };

    if (!opts.poll) {
      await runOnce();
    } else {
      printInfo(`Polling ACN inbox for "${slug}" every ${interval / 1000}s (Ctrl-C to stop) …`);
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await runOnce();
        await new Promise((r) => setTimeout(r, interval));
      }
    }
  });

// ---------------------------------------------------------------------------
// social subnet  — ACN subnet membership management
// ---------------------------------------------------------------------------

const subnetCmd = socialCmd
  .command('subnet')
  .description('Manage ACN subnet membership for a persona');

subnetCmd
  .command('list [slug]')
  .description('List all subnets on the ACN gateway. Pass [slug] to highlight the persona\'s current membership.')
  .option('--gateway <url>', 'ACN gateway URL (overrides acn-config.json or default)')
  .action(async (slug, opts) => {
    try {
      // Resolve gateway: --gateway flag > acn-config.json > default
      let gateway = opts.gateway;
      let knownSubnets = new Set();

      if (!gateway) {
        if (slug) {
          const { resolvePersonaDir } = require('../lib/state/runner');
          const personaDir = resolvePersonaDir(slug);
          if (personaDir) {
            gateway = resolveGateway(personaDir);
            // Membership annotation is declaration-based (acn-config.json + persona.json).
            // Subnets joined dynamically via CLI after registration are not tracked locally.
            try {
              const acnCfg = path.join(personaDir, 'acn-config.json');
              if (fs.existsSync(acnCfg)) {
                const cfg = JSON.parse(fs.readFileSync(acnCfg, 'utf-8'));
                (cfg.subnet_ids || []).forEach((id) => knownSubnets.add(id));
              }
              // Also include social.subnets.auto_join from persona.json
              const pjPath = path.join(personaDir, 'persona.json');
              if (fs.existsSync(pjPath)) {
                const pj = JSON.parse(fs.readFileSync(pjPath, 'utf-8'));
                const aj = pj.social && pj.social.subnets && pj.social.subnets.auto_join;
                if (Array.isArray(aj)) aj.forEach((id) => knownSubnets.add(id));
              }
            } catch { /* best-effort */ }
          }
        }
        if (!gateway) gateway = 'https://acn-production.up.railway.app';
      }

      const subnets = await listSubnets(gateway);
      if (subnets.length === 0) {
        printInfo('No subnets found on ACN gateway.');
        return;
      }
      const label = slug ? ` (${chalk.dim('* = member')})` : '';
      printInfo(`Subnets on ${gateway}:${label}`);
      for (const s of subnets) {
        const id = s.subnet_id || s.id || '';
        const member = knownSubnets.has(id) ? chalk.green(' *') : '  ';
        const count = s.agent_count != null ? chalk.dim(` (${s.agent_count} agents)`) : '';
        console.log(`${member} ${chalk.cyan(id)}  ${s.name || ''}${count}`);
      }
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

subnetCmd
  .command('join <slug> <subnet-id>')
  .description('Join a subnet on behalf of the persona')
  .action(async (slug, subnetId) => {
    const { resolvePersonaDir } = require('../lib/state/runner');
    const personaDir = resolvePersonaDir(slug);
    if (!personaDir) {
      printError(`Persona not installed: "${slug}". Install first with: openpersona install <source>`);
      process.exit(1);
    }
    try {
      const regPath = path.join(personaDir, 'acn-registration.json');
      if (!fs.existsSync(regPath)) {
        throw new Error(`ACN credentials not found for "${slug}". Run: openpersona acn-register ${slug}`);
      }
      const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
      const agentId = reg.agentId || reg.agent_id;
      const apiKey  = reg.apiKey  || reg.api_key;
      const gateway = reg.gateway || resolveGateway(personaDir);
      if (!agentId || !apiKey) {
        throw new Error(`ACN credentials incomplete for "${slug}". Run: openpersona acn-register ${slug}`);
      }
      await joinSubnet(gateway, agentId, subnetId, apiKey);
      printSuccess(`Joined subnet "${subnetId}" for persona "${slug}".`);
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

subnetCmd
  .command('leave <slug> <subnet-id>')
  .description('Leave a subnet on behalf of the persona')
  .action(async (slug, subnetId) => {
    const { resolvePersonaDir } = require('../lib/state/runner');
    const personaDir = resolvePersonaDir(slug);
    if (!personaDir) {
      printError(`Persona not installed: "${slug}". Install first with: openpersona install <source>`);
      process.exit(1);
    }
    try {
      const regPath = path.join(personaDir, 'acn-registration.json');
      if (!fs.existsSync(regPath)) {
        throw new Error(`ACN credentials not found for "${slug}". Run: openpersona acn-register ${slug}`);
      }
      const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
      const agentId = reg.agentId || reg.agent_id;
      const apiKey  = reg.apiKey  || reg.api_key;
      const gateway = reg.gateway || resolveGateway(personaDir);
      if (!agentId || !apiKey) {
        throw new Error(`ACN credentials incomplete for "${slug}". Run: openpersona acn-register ${slug}`);
      }
      await leaveSubnet(gateway, agentId, subnetId, apiKey);
      printSuccess(`Left subnet "${subnetId}" for persona "${slug}".`);
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// social broadcast  — broadcast a message to a subnet or agent list
// ---------------------------------------------------------------------------

socialCmd
  .command('broadcast <slug> <message>')
  .description('Broadcast a message to a subnet or explicit agent list')
  .option('--subnet <id>', 'Broadcast to all agents in this subnet')
  .option('--to <agent-ids>', 'Comma-separated list of target agent IDs (alternative to --subnet)')
  .option('--type <type>', 'Message type tag (default: broadcast)', 'broadcast')
  .action(async (slug, message, opts) => {
    const { resolvePersonaDir } = require('../lib/state/runner');
    const personaDir = resolvePersonaDir(slug);
    if (!personaDir) {
      printError(`Persona not installed: "${slug}". Install first with: openpersona install <source>`);
      process.exit(1);
    }
    try {
      if (!opts.subnet && !opts.to) {
        throw new Error('Specify --subnet <id> or --to <agent-id,...>');
      }
      const regPath = path.join(personaDir, 'acn-registration.json');
      if (!fs.existsSync(regPath)) {
        throw new Error(`ACN credentials not found for "${slug}". Run: openpersona acn-register ${slug}`);
      }
      const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
      const agentId = reg.agentId || reg.agent_id;
      const apiKey  = reg.apiKey  || reg.api_key;
      const gateway = reg.gateway || resolveGateway(personaDir);
      if (!agentId || !apiKey) {
        throw new Error(`ACN credentials incomplete for "${slug}". Run: openpersona acn-register ${slug}`);
      }
      const targetIds = opts.to ? opts.to.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      if (targetIds && targetIds.length === 0) {
        throw new Error('--to value produced an empty agent ID list after parsing. Provide at least one valid agent ID.');
      }
      const payload = { type: opts.type, text: message };
      const result = await broadcastMessage(gateway, agentId, apiKey, payload, {
        subnetId: opts.subnet,
        targetIds,
      });
      printSuccess(`Broadcast sent — delivered: ${result.delivered}, failed: ${result.failed}`);
    } catch (e) {
      printError(e.message);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// social heartbeat  — ACN keepalive to maintain online status
// ---------------------------------------------------------------------------

socialCmd
  .command('heartbeat <slug>')
  .description('Send a heartbeat to ACN to maintain online status')
  .option('--daemon',            'Keep sending heartbeats in a loop (Ctrl-C to stop)')
  .option('--interval <secs>',  'Heartbeat interval in seconds (with --daemon)', '60')
  .option('--endpoint <url>',   'Advertise this A2A endpoint URL with the heartbeat')
  .option('--status <status>',  'Agent status to advertise: online | busy | away (omit to leave unchanged)')
  .action(async (slug, opts) => {
    const { resolvePersonaDir } = require('../lib/state/runner');
    const personaDir = resolvePersonaDir(slug);
    if (!personaDir) {
      printError(`Persona not installed: "${slug}". Install first with: openpersona install <source>`);
      process.exit(1);
    }

    const regPath = path.join(personaDir, 'acn-registration.json');
    if (!fs.existsSync(regPath)) {
      printError(`ACN credentials not found for "${slug}". Run: openpersona acn-register ${slug}`);
      process.exit(1);
    }
    let reg;
    try {
      reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    } catch {
      printError('Failed to read acn-registration.json');
      process.exit(1);
    }
    const agentId = reg.agentId || reg.agent_id;
    const apiKey  = reg.apiKey  || reg.api_key;
    const gateway = reg.gateway || resolveGateway(personaDir);
    if (!agentId || !apiKey) {
      printError(`ACN credentials incomplete for "${slug}". Run: openpersona acn-register ${slug}`);
      process.exit(1);
    }

    const hbOpts = {
      ...(opts.status   && { status:   opts.status }),
      ...(opts.endpoint && { endpoint: opts.endpoint }),
    };

    const beat = async () => {
      try {
        await sendHeartbeat(gateway, agentId, apiKey, hbOpts);
        if (opts.daemon) {
          process.stdout.write(`\r${chalk.dim(new Date().toLocaleTimeString())} ${chalk.green('♥')} heartbeat sent`);
        } else {
          printSuccess(`Heartbeat sent for "${slug}" (${agentId})`);
        }
      } catch (e) {
        if (opts.daemon) {
          process.stdout.write(`\r${chalk.dim(new Date().toLocaleTimeString())} ${chalk.red('✗')} heartbeat failed: ${e.message}`);
        } else {
          printError(`Heartbeat failed: ${e.message}`);
          process.exit(1);
        }
      }
    };

    if (!opts.daemon) {
      await beat();
    } else {
      const intervalMs = Math.max(10, parseInt(opts.interval, 10) || 60) * 1000;
      printInfo(`Heartbeat daemon for "${slug}" — every ${intervalMs / 1000}s (Ctrl-C to stop)`);
      process.on('SIGINT', () => {
        process.stdout.write('\n');
        process.exit(0);
      });
      await beat();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((r) => setTimeout(r, intervalMs));
        await beat();
      }
    }
  });

// ---------------------------------------------------------------------------

program.parse();
