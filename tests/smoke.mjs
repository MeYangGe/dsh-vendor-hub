/**
 * End-to-end smoke test over the real source modules (node strips the types).
 *
 * It exercises the three things the plugin must get right and that a compile
 * cannot prove:
 *   1. the credential book never leaks a secret into a status document;
 *   2. an adapter's answer is parsed into allowance windows;
 *   3. a check-in runs once, claims when the vendor says it is claimable, and
 *      does not ask again the same Beijing day.
 *
 * Every vendor response below is a fixture this test installs as `fetch`; no
 * network is touched.
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'mmp-test-'))
process.env['DSH_MAGPIE_CONNECT_DATA_DIR'] = dir

const store = await import('../src/host/store.ts')
const engine = await import('../src/host/engine.ts')
const { mountRoutes } = await import('../src/host/routes.ts')
const { createServer } = await import('node:http')

const logger = { warn: () => {}, info: () => {} }
const options = { version: '0.1.0-test', logger }

const calls = []
let checkinClaimed = false

/** The real transport, kept aside so the route test can talk to its own server. */
const realFetch = globalThis.fetch.bind(globalThis)

globalThis.fetch = async (url, init = {}) => {
  const href = String(url)
  calls.push(`${init.method ?? 'GET'} ${href}`)
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  if (href.includes('/trae/api/v2/pay/ide_user_ent_usage')) {
    return json({
      code: 0,
      data: { user: 'tester', is_credits_billing: true, credits: { limit: 1000, used: 250, unlimited: false } },
    })
  }
  if (href.includes('/trae/api/v2/ug/checkin_credits/status')) {
    return json({ code: 0, data: { claimable: !checkinClaimed, credits: 100, streak: 3 } })
  }
  if (href.includes('/trae/api/v2/ug/checkin_credits/claim')) {
    checkinClaimed = true
    return json({ code: 0, data: { credits: 100, streak: 4 } })
  }
  return json({ code: 404, message: 'unexpected ' + href }, 404)
}

// ---------------------------------------------------------------- 1. book
const saved = store.saveAccount({
  vendor: 'trae-cn',
  label: '主力',
  account: 'tester@example.com',
  secret: { token: 'JWT-TEST-TOKEN', deviceId: '123456789012345' },
})
assert.equal(store.listAccounts().length, 1, '账号应写入')
assert.equal(saved.id, store.accountIdOf('trae-cn', { token: 'JWT-TEST-TOKEN', deviceId: '123456789012345' }))

const rawBook = JSON.stringify(JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'accounts.json'), 'utf8')))
assert.ok(rawBook.includes('JWT-TEST-TOKEN'), '凭证文件里应有 secret')

// ------------------------------------------------------------- 2. quota
const status = await engine.refreshAccount(saved, options)
assert.ok(status.quota, '应读到额度：' + JSON.stringify(status.error))
const window = status.quota.windows[0]
assert.equal(window.total, 1000)
assert.equal(window.used, 250)
assert.equal(window.remaining, 750)
assert.equal(window.percentLeft, 75)

// The status document must never carry a secret.
const doc = engine.buildStatus(options, { enabled: false, nextAt: null, lastAt: null })
const serialized = JSON.stringify(doc)
assert.ok(!serialized.includes('JWT-TEST-TOKEN'), 'status 文档不得包含凭证')
assert.ok(!serialized.includes('123456789012345'), 'status 文档不得包含设备 id')
assert.equal(doc.totals.creditsLeft, 750)
assert.equal(doc.totals.readOk, 1)

// ----------------------------------------------------------- 3. checkin
const first = await engine.checkinAccount(saved, options, false)
assert.equal(first.outcome, 'claimed', first.message)
assert.ok(calls.some((c) => c.endsWith('/claim')), '应发出领取请求')

const before = calls.length
const second = await engine.checkinAccount(saved, options, false)
assert.equal(second.outcome, 'claimed', '同日第二次应返回缓存结论')
assert.equal(calls.length, before, '同日第二次不应再请求上游')

// A manual press does re-ask, and now the vendor says already-today.
const third = await engine.checkinAccount(saved, options, true)
assert.equal(third.outcome, 'already', third.message)
assert.ok(calls.length > before, '手动签到应重新问上游')

// ------------------------------------------------------------ 4. routes
const routes = mountRoutes({
  options,
  scheduler: () => ({ enabled: false, nextAt: null, lastAt: store.readLog(1)[0]?.at ?? null }),
  reschedule: () => {},
})
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const route = routes.find((entry) => entry.path === path)
  if (route === undefined) {
    response.writeHead(404).end('{}')
    return
  }
  await route.handler(request, response)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const origin = `http://127.0.0.1:${port}`
const statusResponse = await realFetch(`${origin}/plugins/dsh-magpie-connect/status`)
assert.equal(statusResponse.status, 200)
const statusDoc = await statusResponse.json()
assert.equal(statusDoc.schema, 1)
assert.ok(!JSON.stringify(statusDoc).includes('JWT-TEST-TOKEN'), 'status 路由不得泄露凭证')

const crossOrigin = await realFetch(`${origin}/plugins/dsh-magpie-connect/auth`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  body: JSON.stringify({ action: 'save', vendor: 'trae-cn', secret: { token: 'x' } }),
})
assert.equal(crossOrigin.status, 403, '跨源写入必须 403')

const sameOrigin = await realFetch(`${origin}/plugins/dsh-magpie-connect/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify({ autoCheckin: false, checkinMinute: 9 * 60 + 30 }),
})
assert.equal(sameOrigin.status, 200)
const savedSettings = await sameOrigin.json()
assert.equal(savedSettings.value.autoCheckin, false)
assert.equal(savedSettings.value.checkinMinute, 570)

const accountsResponse = await realFetch(`${origin}/plugins/dsh-magpie-connect/accounts`)
const accountsDoc = await accountsResponse.json()
assert.equal(accountsDoc.accounts.length, 1)
assert.ok(!JSON.stringify(accountsDoc).includes('JWT-TEST-TOKEN'), 'accounts 路由不得泄露凭证')

server.close()

// ------------------------------------------------------- 5. scheduler math
const next = engine.nextCheckinAt(600, Date.UTC(2026, 10, 5, 0, 0, 0))
assert.equal(new Date(next).toISOString(), '2026-11-05T02:00:00.000Z', '10:00 北京时间 = 02:00 UTC')

// -------------------------------------------------------------- teardown
assert.ok(existsSync(join(dir, 'settings.json')), '设置应落盘')
rmSync(dir, { recursive: true, force: true })
console.log('smoke OK · ' + calls.length + ' 次上游请求 · 账号/额度/签到/路由全部通过')