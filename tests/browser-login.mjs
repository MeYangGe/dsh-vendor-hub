/**
 * Browser sign-in checks, run against the built Host bundle.
 *
 * Nothing here signs in for real: it asserts what the plugin would do on screen,
 * which is the part that can be proven without a vendor account -
 *
 *   - a loopback vendor (Trae CN) really binds 127.0.0.1 and puts that exact
 *     callback into the authorize URL it opens;
 *   - a PKCE device vendor (Qoder) sends a challenge, a nonce and the client id
 *     the real magpie plugin sends;
 *   - a vendor with no third-party grant (WorkBuddy) reports an honest refusal
 *     instead of pretending to wait forever;
 *   - the status route never returns the credential itself.
 */

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'mmp-login-'))
process.env['DSH_MAGPIE_CONNECT_DATA_DIR'] = dir
process.env['DSH_MAGPIE_CONNECT_NO_BROWSER'] = '1'

const mod = await import('../lib/index.js')

const routes = []
const ctx = {
  config: {},
  logger: { info() {}, warn() {}, error() {} },
  effect(fn) {
    const disposer = fn()
    return disposer
  },
  inject(deps, run) {
    if (!deps.includes('webServer')) return
    run({ webServer: { register(route) { routes.push(route); return () => {} } } })
  },
  on() { return () => {} },
  provide() {},
}

mod.apply(ctx)

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const route = routes.find((item) => item.path === path)
  if (route === undefined) {
    response.writeHead(404).end(JSON.stringify({ error: 'no_route' }))
    return
  }
  await route.handler(request, response)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}/plugins/dsh-magpie-connect`

function post(path, body) {
  return fetch(base + path, {
    method: 'POST',
    headers: {
      origin: base,
      host: `127.0.0.1:${port}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function get(path) {
  return fetch(base + path)
}

// --- Trae CN: a real loopback callback, port and all ------------------------

{
  const response = await post('/auth/browser/start', { vendor: 'trae-cn' })
  const json = await response.json()
  assert.equal(response.status, 200)
  assert.equal(json.state, 'waiting', `trae-cn 应进入等待：${JSON.stringify(json)}`)
  const url = new URL(json.url)
  assert.equal(url.origin, 'https://www.trae.cn')
  assert.equal(url.pathname, '/authorization')
  const callback = url.searchParams.get('auth_callback_url')
  assert.match(callback ?? '', /^http:\/\/127\.0\.0\.1:\d+\/authorize$/, 'trae 回调必须是回环 /authorize')
  assert.equal(url.searchParams.get('client_id'), 'ono9krqynydwx5', 'trae client_id 应与 magpie 一致')
  assert.equal(url.searchParams.get('login_channel'), 'native_ide')
  // The loopback listener the URL names must actually be accepting connections.
  const probe = await fetch(callback.replace('/authorize', '/authorize?userJwt=probe&refreshToken=r'))
  assert.equal(probe.status, 200)
  const probeBody = await probe.text()
  assert.match(probeBody, /登录完成/)

  // ... and the status route must have flipped to done, without leaking the token.
  const status = await (await get(`/auth/browser/status?session=${json.session}`)).json()
  assert.ok(['saved', 'done'].includes(status.state), `trae 状态应完成：${JSON.stringify(status)}`)
  assert.equal(status.token, undefined, '状态不得回传凭证')
  assert.equal(status.secret, undefined, '状态不得回传凭证')
  console.log('trae-cn  · 回环回调 → waiting →', status.state)
}

// --- Qoder CN: PKCE device flow --------------------------------------------

{
  const response = await post('/auth/browser/start', { vendor: 'qoder-cn' })
  const json = await response.json()
  assert.equal(response.status, 200)
  assert.equal(json.state, 'waiting')
  const url = new URL(json.url)
  assert.equal(url.origin, 'https://qoder.cn')
  assert.equal(url.pathname, '/device/selectAccounts')
  assert.equal(url.searchParams.get('challenge_method'), 'S256')
  assert.equal(url.searchParams.get('client_id'), 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb')
  assert.match(url.searchParams.get('challenge') ?? '', /^[A-Za-z0-9_-]{40,}$/, 'challenge 应是 b64url')
  assert.match(url.searchParams.get('nonce') ?? '', /^[0-9a-f-]{36}$/)
  // Cancel so the poll loop stops before it ever reaches the network.
  await post('/auth/browser/cancel', { session: json.session })
  const status = await (await get(`/auth/browser/status?session=${json.session}`)).json()
  assert.equal(status.state, 'cancelled')
  console.log('qoder-cn · device 授权 → cancelled')
}

// --- WorkBuddy: honest refusal, not a fake wait ----------------------------

{
  const response = await post('/auth/browser/start', { vendor: 'workbuddy' })
  const json = await response.json()
  assert.equal(response.status, 200)
  assert.equal(new URL(json.url).origin, 'https://copilot.tencent.com')
  // Give the rejected flow one tick to settle.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const status = await (await get(`/auth/browser/status?session=${json.session}`)).json()
  assert.equal(status.state, 'error', `workbuddy 应明确失败：${JSON.stringify(status)}`)
  assert.match(String(status.note), /未移植|官方页面/)
  console.log('workbuddy · 官方页 + 明确说明 →', status.state)
}

// --- guards ----------------------------------------------------------------

assert.equal((await post('/auth/browser/start', { vendor: 'nope' })).status, 400)
assert.equal((await get('/auth/browser/status?session=deadbeef')).status, 404)
{
  const cross = await fetch(base + '/auth/browser/start', {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ vendor: 'trae-cn' }),
  })
  assert.equal(cross.status, 403, '跨源必须拒绝')
}

server.close()
rmSync(dir, { recursive: true, force: true })
console.log('browser-login OK · trae 回环 / qoder PKCE / 拒绝项 / 跨源防护')