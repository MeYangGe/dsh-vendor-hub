/**
 * Load the built Host bundle the way the harness does: a fake cordis context
 * supplies `logger`, `effect` and `webServer`, `apply()` runs, and the routes it
 * registers are then served over a real HTTP listener.
 *
 * This is a check on `lib/index.js` - the artifact the host loads - not on the
 * TypeScript sources, and it is what proves the bundle has no runtime
 * `@deepseek-ai/*` dependency of its own.
 */

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'mmp-host-'))
process.env['DSH_MAGPIE_CONNECT_DATA_DIR'] = dir

const mod = await import('../lib/index.js')

assert.equal(typeof mod.apply, 'function', 'bundle 应导出 apply')
assert.equal(mod.name, 'magpie-connect')
assert.ok(!JSON.stringify(mod.inject).includes('react'), 'host 半侧不应依赖 react')

const routes = []
const disposers = []
const logs = []
const ctx = {
  config: {},
  logger: {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
  },
  effect(fn, label) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  inject(deps, run) {
    if (!deps.includes('webServer')) return
    run({ webServer: { register(route) { routes.push(route); return () => {} } } })
  },
  on() {
    return () => {}
  },
  provide() {},
}

mod.apply(ctx)

assert.equal(routes.length, 10, `应挂载 7 条路由，实际 ${routes.length}：${routes.map((r) => r.path).join(', ')}`)
for (const route of routes) {
  assert.equal(route.kind, 'exact', '路由必须是 exact')
  assert.ok(route.path.startsWith('/plugins/dsh-magpie-connect/'), route.path)
}
assert.ok(logs.some(([level]) => level === 'info'), '应留下挂载日志')

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const route = routes.find((entry) => entry.path === path)
  if (route === undefined) {
    response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no_route"}')
    return
  }
  await route.handler(request, response)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const origin = `http://127.0.0.1:${port}`

const status = await fetch(`${origin}/plugins/dsh-magpie-connect/status`)
assert.equal(status.status, 200)
const doc = await status.json()
assert.equal(doc.schema, 1)
assert.equal(doc.version, '0.1.0')
assert.deepEqual(doc.accounts, [], '空账本应返回空账号列表')
assert.equal(doc.problems.length, 0, '空账本不应在 problems 里重复引导')
assert.equal(doc.scheduler.enabled, true, '默认开启自动签到')

const settings = await fetch(`${origin}/plugins/dsh-magpie-connect/settings`)
const settingsDoc = await settings.json()
assert.equal(settingsDoc.value.pollMs, 300_000)

const bad = await fetch(`${origin}/plugins/dsh-magpie-connect/auth`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  body: '{}',
})
assert.equal(bad.status, 403, '跨源写入必须 403')

const unknown = await fetch(`${origin}/plugins/dsh-magpie-connect/auth`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: origin },
  body: JSON.stringify({ action: 'save', vendor: 'nope', secret: { token: 'x' } }),
})
assert.equal(unknown.status, 400, '未知供应商必须 400')

server.close()
for (const dispose of disposers) dispose()
rmSync(dir, { recursive: true, force: true })
console.log('host-load OK · 10 条路由（含浏览器登录）· 空账本/设置/跨源防护全部通过 · ' + logs.length + ' 条日志')