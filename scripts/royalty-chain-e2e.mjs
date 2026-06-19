#!/usr/bin/env node
/**
 * Live Store E2E — recipe-method royalty chain (internal token).
 *
 * Covers: product create → pay-external → accept-external (split release)
 *         → redeem lineage fields → cleanup unlist.
 *
 * Usage (from repo root):
 *   node --env-file=frontend/.env.local scripts/royalty-chain-e2e.mjs
 *
 * Requires: STORE_API_BASE, INTERNAL_API_TOKEN in env.
 */

const BASE = process.env.STORE_API_BASE
const TOKEN = process.env.INTERNAL_API_TOKEN
if (!BASE || !TOKEN) {
  console.error('Missing STORE_API_BASE / INTERNAL_API_TOKEN')
  process.exit(2)
}

const H = { 'Content-Type': 'application/json', 'X-Internal-Token': TOKEN }
const sfx = Date.now().toString(36)
const root = `e2e-root-${sfx}`
const seller = `e2e-seller-${sfx}`
const buyer = `e2e-buyer-${sfx}`
const packRef = `op://private/e2e-royalty-${sfx}@1.0.0`
const AMOUNT = 1000
const EXP_ROYALTY_GEN1 = 30 // 3% of 1000

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; return false }
  console.log('  ✓', msg)
  return true
}

const run = async () => {
  console.log('Store:', BASE)
  console.log('root=%s seller=%s buyer=%s gen=1 amount=%s', root, seller, buyer, AMOUNT)

  const prod = await call('POST', '/persona/products', {
    seller_id: seller,
    seller_type: 'user',
    name: 'E2E Royalty Fork Pack',
    description: 'temporary e2e listing',
    credits_price: AMOUNT,
    persona_metadata: {
      pack_ref: packRef,
      root_creator: root,
      generation: 1,
      version: '1.0.0',
    },
  })
  console.log('\n1) create persona product →', prod.status)
  const pid = prod.data?.product_id || prod.data?.id
  if (!assert(prod.status === 200 && pid, `product created (${pid || JSON.stringify(prod.data)})`)) return

  try {
    const order = await call('POST', `/persona/products/${encodeURIComponent(pid)}/order`)
    console.log('2) create order →', order.status)
    const oid = order.data?.order_id
    if (!assert(order.status === 200 && oid, `order created (${oid})`)) return

    const pay = await call('POST', `/orders/${encodeURIComponent(oid)}/pay-external`, {
      buyer_id: buyer,
      channel: 'e2e-test',
      external_txn_id: `e2e-pay-${sfx}`,
    })
    console.log('3) pay-external →', pay.status, 'state=', pay.data?.state)
    if (!assert(
      pay.status === 200 && (pay.data?.state === 'fulfilling' || pay.data?.state === 'completed'),
      `order paid (state=${pay.data?.state})`,
    )) return

    const red = await call('POST', `/persona/orders/${encodeURIComponent(oid)}/redeem`, { buyer_id: buyer })
    console.log('4) redeem →', red.status)
    assert(red.status === 200, 'redeem succeeded')
    assert(red.data?.root_creator === root, `root_creator=${red.data?.root_creator}`)
    assert(red.data?.generation === 1, `generation=${red.data?.generation}`)

    const acc = await call('POST', `/orders/${encodeURIComponent(oid)}/accept-external`, { buyer_id: buyer })
    console.log('5) accept-external →', acc.status, 'state=', acc.data?.state)
    assert(acc.status === 200, 'accept succeeded')
    assert(acc.data?.state === 'completed', `order completed (state=${acc.data?.state})`)
    assert(Boolean(acc.data?.hold_released_at), `hold released (${acc.data?.hold_released_at})`)

    // Expected split for gen=1 @ 1000: fee=100, royalty=30, seller=870
    console.log('\nExpected royalty split (gen=1): platform=100 root=%s royalty=%d seller=870', root, EXP_ROYALTY_GEN1)
    console.log('(Wallet balances require Auth0 user — verify in /wallet after real purchase)')
  } finally {
    const un = await call('POST', `/persona/products/${encodeURIComponent(pid)}/unlist`, { seller_id: seller })
    console.log('\n6) cleanup unlist →', un.status)
  }
}

run().then(() => {
  console.log(process.exitCode ? '\nRESULT: FAILED' : '\nRESULT: PASSED')
  process.exit(process.exitCode || 0)
}).catch((e) => { console.error('ERROR', e); process.exit(1) })
