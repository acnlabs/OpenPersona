#!/usr/bin/env node
/**
 * One-shot R2 setup for OP global private packs (docs §2.3a).
 *
 * 1) Ensures bucket exists (Cloudflare API, optional)
 * 2) Uploads smoke test object for e2e deliver闭环
 * 3) Prints Vercel env add commands (no secrets echoed)
 *
 * Usage:
 *   export CLOUDFLARE_ACCOUNT_ID=...
 *   export CLOUDFLARE_API_TOKEN=...          # R2 Admin or Account token
 *   export OP_STORE_GLOBAL_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
 *   export OP_STORE_GLOBAL_BUCKET=openpersona-private
 *   export OP_STORE_GLOBAL_KEY_ID=...
 *   export OP_STORE_GLOBAL_SECRET=...
 *   node scripts/setup-r2-global.mjs
 *
 * Optional: CREATE_BUCKET=1 to call CF API create bucket first.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Resolve from repo root (devDependency) — not published with the CLI package.
const require = createRequire(join(ROOT, 'package.json'))
const { S3Client, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3')

/** Load KEY=VALUE lines from .env.r2 (no deps). */
function loadEnvR2() {
  const path = join(ROOT, '.env.r2')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i === -1) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (!process.env[k]) process.env[k] = v
  }
}

loadEnvR2()

const BUCKET = process.env.OP_STORE_GLOBAL_BUCKET || 'openpersona-private'
const ENDPOINT = process.env.OP_STORE_GLOBAL_ENDPOINT
const KEY_ID = process.env.OP_STORE_GLOBAL_KEY_ID
const SECRET = process.env.OP_STORE_GLOBAL_SECRET
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN
const SMOKE_KEY = 'e2e-closure/smoke-pack/v1.zip' // matches pack_ref op://private/e2e-closure/smoke-pack@v1

function req(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing ${name}`)
    process.exit(1)
  }
  return v
}

async function ensureBucketViaApi() {
  if (process.env.CREATE_BUCKET !== '1') return
  req('CLOUDFLARE_ACCOUNT_ID')
  req('CLOUDFLARE_API_TOKEN')
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: BUCKET }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok && !String(body?.errors?.[0]?.message || '').includes('already exists')) {
    console.error('Create bucket failed:', res.status, body)
    process.exit(1)
  }
  console.log(`Bucket ${BUCKET} ready`)
}

function buildSmokeZip() {
  const dir = mkdtempSync(join(tmpdir(), 'op-smoke-'))
  const zipPath = join(dir, 'smoke.zip')
  const skillDir = join(dir, 'pack')
  execSync(`mkdir -p "${skillDir}"`)
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '# Smoke Persona Pack\n\nE2E closure test object for OP gated delivery.\n',
  )
  execSync(`cd "${skillDir}" && zip -r "${zipPath}" .`)
  const buf = readFileSync(zipPath)
  rmSync(dir, { recursive: true, force: true })
  return buf
}

async function main() {
  req('OP_STORE_GLOBAL_ENDPOINT')
  req('OP_STORE_GLOBAL_KEY_ID')
  req('OP_STORE_GLOBAL_SECRET')

  await ensureBucketViaApi()

  const client = new S3Client({
    region: 'auto',
    endpoint: ENDPOINT,
    credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET },
  })

  try {
    await client.send(new HeadBucketCommand({ Bucket: BUCKET }))
  } catch {
    console.error(`Bucket "${BUCKET}" not reachable — create it in Cloudflare R2 dashboard or set CREATE_BUCKET=1`)
    process.exit(1)
  }

  const body = buildSmokeZip()
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: SMOKE_KEY, Body: body, ContentType: 'application/zip' }))
  console.log(`Uploaded s3://${BUCKET}/${SMOKE_KEY} (${body.length} bytes)`)

  if (process.env.PUSH_VERCEL === '1') {
    pushVercelEnv({
      OP_STORE_GLOBAL_ENDPOINT: ENDPOINT,
      OP_STORE_GLOBAL_BUCKET: BUCKET,
      OP_STORE_GLOBAL_KEY_ID: KEY_ID,
      OP_STORE_GLOBAL_SECRET: SECRET,
      OP_STORE_DEFAULT_REGION: 'global',
    })
  } else {
    console.log('\nAdd to Vercel Production (run from frontend/):')
    console.log(`  printf '%s' '${ENDPOINT}' | vercel env add OP_STORE_GLOBAL_ENDPOINT production`)
    console.log(`  printf '%s' '${BUCKET}' | vercel env add OP_STORE_GLOBAL_BUCKET production`)
    console.log(`  printf '%s' '${KEY_ID}' | vercel env add OP_STORE_GLOBAL_KEY_ID production`)
    console.log(`  # OP_STORE_GLOBAL_SECRET — vercel env add OP_STORE_GLOBAL_SECRET production`)
    console.log(`  printf '%s' 'global' | vercel env add OP_STORE_DEFAULT_REGION production`)
    console.log('\nOr re-run with PUSH_VERCEL=1 after .env.r2 is filled.')
    console.log('Then: cd frontend && vercel --prod --yes')
  }
}

function pushVercelEnv(vars) {
  const frontend = join(ROOT, 'frontend')
  for (const [name, value] of Object.entries(vars)) {
    if (!value) continue
    // remove existing if any (ignore errors)
    spawnSync('vercel', ['env', 'rm', name, 'production', '-y'], { cwd: frontend, stdio: 'ignore' })
    const r = spawnSync('vercel', ['env', 'add', name, 'production'], {
      cwd: frontend,
      input: value,
      encoding: 'utf8',
    })
    if (r.status !== 0) {
      console.error(`vercel env add ${name} failed:`, r.stderr || r.stdout)
      process.exit(1)
    }
    console.log(`Vercel env ${name} set`)
  }
  console.log('\nRedeploy: cd frontend && vercel --prod --yes')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
