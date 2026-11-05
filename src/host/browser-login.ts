/**
 * Browser sign-in, modelled on magpie's own plugin contract.
 *
 * magpie's plugins declare `auth.methods[].authorize()`, which returns
 * `{ url, instructions, method: 'auto' | 'code', callback }`. With `auto` the
 * host opens `url` and the plugin's own `callback` settles the credential -
 * either by catching a loopback redirect or by polling the vendor. This module
 * is that host side, and the two implemented flows are ported from the plugins
 * actually installed on the magpie server
 * (`.../plugins/node_modules/@magpie-community/opencode-*-auth/index.mjs`):
 *
 *   trae-cn   loopback `/authorize`; the page sends `userJwt` + `refreshToken`
 *             as query parameters (NOT `Cloud-IDE-JWT`, NOT `/callback`);
 *             authorize URL `https://www.trae.cn/authorization?…`
 *   qoder-*   PKCE device flow: `{web}/device/selectAccounts?…`, then poll
 *             `{openapi}/api/v1/deviceToken/poll`, then `/api/v1/me/jobToken`
 *
 * Every credential is collected inside this process. Nothing is written to disk
 * here: the caller stores it through the account book once the session is done.
 */

import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { exec } from 'node:child_process'
import type { VendorId } from '../types.ts'
import { vendorMeta } from '../vendors.ts'
import { httpRequest } from './http.ts'

export type LoginMode = 'loopback' | 'device-poll' | 'manual'
export type LoginState = 'waiting' | 'done' | 'error' | 'cancelled'

/** Where the browser goes and how the credential comes back. */
export interface LoginFlow {
  mode: LoginMode
  url: string
  instructions: string
  /** Resolves with the credential set, or rejects with a readable reason. */
  wait(): Promise<Record<string, string>>
  /** Release any listener the flow opened. */
  close(): void
}

export interface LoginSession {
  id: string
  vendor: VendorId
  state: LoginState
  createdAt: number
  mode: LoginMode
  url: string
  instructions: string
  secret?: Record<string, string>
  error?: string
}

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000
const SESSION_TTL_MS = 10 * 60 * 1000

const sessions = new Map<string, LoginSession>()
const closers = new Map<string, () => void>()

// --------------------------------------------------------------- utilities

/** Open a URL in the operating system's default browser. */
export function openBrowser(url: string): void {
  // Tests set this so a route check never pops a real browser window.
  if (process.env['DSH_MAGPIE_CONNECT_NO_BROWSER'] === '1') return
  const quoted = url.replace(/"/g, '%22')
  const command =
    process.platform === 'win32'
      ? `cmd /c start "" "${quoted}"`
      : process.platform === 'darwin'
        ? `open "${quoted}"`
        : `xdg-open "${quoted}"`
  exec(command, () => {
    // Non-fatal: the panel shows the URL too, so a failure is recoverable.
  })
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function page(ok: boolean, title: string, detail: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Magpie Connect</title></head>
<body style="font:15px/1.6 system-ui,sans-serif;padding:40px;max-width:560px;margin:0 auto">
<h2 style="color:${ok ? '#2f9e6a' : '#cc4b48'};margin:0 0 8px">${title}</h2><p>${detail}</p></body></html>`
}

// ------------------------------------------------------------------- flows

/**
 * Trae CN, ported from `opencode-trae-auth/index.mjs` `browserSignIn()`.
 * The callback URL must be resolved before the authorize page can be built, so
 * this flow is async: it listens first, then hands back the URL.
 */
async function traeCnFlow(): Promise<LoginFlow> {
  const device = { machineId: randomUUID(), deviceId: randomBytes(8).toString('hex') }
  const trace = randomUUID()
  let over = false
  let settle: (value: Record<string, string>) => void = () => undefined
  let fail: (reason: Error) => void = () => undefined
  const done = new Promise<Record<string, string>>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  const finish = (fn: () => void): void => {
    if (over) return
    over = true
    fn()
  }

  const server = createServer((request, response) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors).end()
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const html = (body: string): void => {
      response.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(body)
    }
    if (url.pathname !== '/authorize') {
      response.writeHead(404, cors).end()
      return
    }
    if (over) {
      html(page(false, '这次登录已结束', '请在 DSH 里重新发起。'))
      return
    }
    const query = url.searchParams
    const error = query.get('error')
    if (error !== null) {
      const reason = query.get('error_description') ?? error
      finish(() => fail(new Error(`Trae CN 拒绝登录：${reason}`)))
      html(page(false, '登录没有完成', reason))
      return
    }
    const jwt = query.get('userJwt') ?? query.get('jwt') ?? ''
    const refresh = query.get('refreshToken') ?? ''
    if (jwt.length === 0) {
      html(page(false, '没有收到凭证', 'Trae CN 没有回传 userJwt，请回到 DSH 重新发起登录。'))
      return
    }
    finish(() =>
      settle({
        token: jwt,
        ...(refresh.length > 0 ? { refresh } : {}),
        deviceId: device.deviceId,
      }),
    )
    html(page(true, '登录完成', 'Trae CN 账号已接入，可以关闭这个页面。'))
  })

  const timer = setTimeout(() => finish(() => fail(new Error('登录超时（5 分钟），请重试'))), SIGN_IN_TIMEOUT_MS)
  void done.then(() => clearTimeout(timer)).catch(() => clearTimeout(timer))

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', (error) => reject(new Error(`本地回调端口启动失败：${error.message}`)))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })

  const query = new URLSearchParams({
    login_version: '1',
    auth_from: 'solo',
    login_channel: 'native_ide',
    plugin_version: '2.3.24254',
    auth_type: 'local',
    client_id: 'ono9krqynydwx5',
    redirect: '0',
    login_trace_id: trace,
    auth_callback_url: `http://127.0.0.1:${port}/authorize`,
    machine_id: device.machineId,
    device_id: device.deviceId,
    x_device_id: device.deviceId,
    x_machine_id: device.machineId,
    x_device_brand: 'ASUS TUF Gaming A15 FA507RM_FA507RM',
    x_device_type: 'windows',
    x_os_version: 'Windows 10 Pro',
    x_env: '',
    x_app_version: '3.3.65',
    x_app_type: 'stable',
    hide_saas_login: 'false',
  })

  return {
    mode: 'loopback',
    url: `https://www.trae.cn/authorization?${query.toString()}`,
    instructions: '在浏览器里登录 trae.cn 并允许授权；登录会自行回到本机完成，无需复制任何东西。',
    wait: () => done,
    close: () => {
      clearTimeout(timer)
      server.close()
      finish(() => fail(new Error('已取消')))
    },
  }
}

/**
 * Qoder, ported from `opencode-qoder-auth/index.mjs` `deviceSignIn()`:
 * PKCE device authorization, then `deviceToken/poll`, then a job token.
 */
function qoderFlow(vendor: 'qoder-cn' | 'qoder-global'): LoginFlow {
  const site =
    vendor === 'qoder-cn'
      ? {
          name: 'Qoder CN',
          clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
          web: 'https://qoder.cn',
          openapi: 'https://openapi.qoder.com.cn',
        }
      : {
          name: 'Qoder',
          clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
          web: 'https://qoder.com',
          openapi: 'https://openapi.qoder.sh',
        }

  const verifier = base64url(randomBytes(64))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const nonce = randomUUID()
  const machineId = randomUUID()
  let cancelled = false

  const query = new URLSearchParams({
    challenge,
    challenge_method: 'S256',
    nonce,
    machine_id: machineId,
    client_id: site.clientId,
  })

  async function poll(): Promise<Record<string, string>> {
    const deadline = Date.now() + SIGN_IN_TIMEOUT_MS
    let deviceToken = ''
    while (!cancelled) {
      if (Date.now() > deadline) throw new Error('登录超时（5 分钟），请重试')
      try {
        const pollQuery = new URLSearchParams({ nonce, verifier, challenge_method: 'S256' })
        const result = await httpRequest(`${site.openapi}/api/v1/deviceToken/poll?${pollQuery.toString()}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
          timeoutMs: 20_000,
        })
        const body = result.json as Record<string, unknown> | undefined
        const token = typeof body?.['token'] === 'string' ? body['token'].trim() : ''
        if (result.status === 200 && token.length > 0) {
          deviceToken = token
          break
        }
      } catch {
        // A hiccup is not a refusal: ask again.
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    if (deviceToken.length === 0) throw new Error('已取消')
    try {
      const exchange = await httpRequest(`${site.openapi}/api/v1/me/jobToken`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${deviceToken}`,
        },
        body: JSON.stringify({ clientId: site.clientId }),
        timeoutMs: 20_000,
      })
      const body = exchange.json as Record<string, unknown> | undefined
      const jobToken = typeof body?.['token'] === 'string' ? body['token'].trim() : ''
      if (exchange.status === 200 && jobToken.length > 0) return { token: jobToken }
    } catch {
      // Fall back to the device token, which the plugin also accepts.
    }
    return { token: deviceToken }
  }

  return {
    mode: 'device-poll',
    url: `${site.web}/device/selectAccounts?${query.toString()}`,
    instructions: `在浏览器里登录 ${site.name} 并授权这台设备；授权后会自动回传，无需复制。`,
    wait: poll,
    close: () => {
      cancelled = true
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * WorkBuddy, ported from `opencode-workbuddy-auth/index.mjs` `browserSignIn()`.
 *
 * The vendor issues the sign-in itself: ask for a `state`, open the `authUrl` it
 * returns, then poll `auth/token?state=` until the browser finishes. Magpie reads
 * the same flow the desktop app uses, and code 11217 simply means "not yet".
 */
async function workbuddyFlow(vendor: 'workbuddy' | 'workbuddy-ai'): Promise<LoginFlow> {
  const site =
    vendor === 'workbuddy'
      ? { name: 'WorkBuddy', endpoint: 'https://copilot.tencent.com', platform: 'workbuddy' }
      : { name: 'WorkBuddy AI', endpoint: 'https://www.workbuddy.ai', platform: 'workbuddy-ai' }
  const appVersion = '5.9.3'
  const quiet = {
    'x-no-authorization': 'true',
    'x-no-user-id': 'true',
    'x-no-enterprise-id': 'true',
    'x-no-department-info': 'true',
  }

  async function call(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body: unknown = undefined,
  ): Promise<Record<string, unknown> | null> {
    const result = await httpRequest(site.endpoint + path, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': `WorkBuddy/${appVersion}`,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs: 30_000,
    })
    const envelope = (result.json ?? {}) as Record<string, unknown>
    const code = Number.parseInt(String(envelope['code'] ?? '0'), 10) || 0
    const data = (envelope['data'] ?? null) as Record<string, unknown> | null
    if (result.status < 200 || result.status >= 300 || code !== 0) {
      const raw = envelope['msg'] ?? envelope['message'] ?? `HTTP ${result.status}`
      const error = new Error(`${site.name}: ${String(raw)}${code === 0 ? '' : `（code ${code}）`}`) as Error & {
        vendorCode?: number
      }
      error.vendorCode = code
      throw error
    }
    return data
  }

  /** Poll until the vendor answers, tolerating the "still waiting" code. */
  async function until(
    path: string,
    headers: Record<string, string>,
    keepCode: number,
    deadline: number,
  ): Promise<Record<string, unknown>> {
    for (;;) {
      if (Date.now() > deadline) throw new Error(`${site.name} 登录超时（5 分钟），请重试`)
      try {
        const data = await call('GET', path, headers)
        if (data !== null && Object.keys(data).length > 0) return data
      } catch (error) {
        const code = (error as { vendorCode?: number }).vendorCode
        if (code !== keepCode) throw error
      }
      await sleep(1000)
    }
  }

  const state = await call(
    'POST',
    `/v2/plugin/auth/state?platform=${encodeURIComponent(site.platform)}`,
    quiet,
    {},
  )
  const stateToken = typeof state?.['state'] === 'string' ? state['state'] : ''
  const authUrl = typeof state?.['authUrl'] === 'string' ? state['authUrl'] : ''
  if (stateToken.length === 0 || authUrl.length === 0) throw new Error(`${site.name} 没有给出登录页`)

  const url = new URL(authUrl)
  if (url.protocol !== 'https:') throw new Error(`${site.name} 的登录页不是 https`)
  url.searchParams.set('version', appVersion)
  url.searchParams.set('loginSessionId', randomBytes(8).toString('hex'))
  const encoded = encodeURIComponent(stateToken)

  return {
    mode: 'device-poll',
    url: url.toString(),
    instructions: `在浏览器里登录 ${site.name}；登录完成后会自动回传，无需复制。`,
    async wait() {
      const deadline = Date.now() + SIGN_IN_TIMEOUT_MS
      const token = await until(`/v2/plugin/auth/token?state=${encoded}`, {}, 11217, deadline)
      const access = typeof token['access'] === 'string' && token['access'].length > 0 ? token['access'] : ''
      if (access.length === 0) throw new Error(`${site.name} 没有回传 access token`)
      const domain = typeof token['domain'] === 'string' && token['domain'].length > 0 ? token['domain'] : ''
      let uid = ''
      try {
        const account = await until(
          `/v2/plugin/login/account?state=${encoded}`,
          {
            authorization: `Bearer ${access}`,
            ...(domain.length > 0 ? { 'x-domain': domain } : {}),
            'x-no-user-id': 'true',
            'x-no-enterprise-id': 'true',
          },
          12151,
          deadline,
        )
        uid = typeof account['uid'] === 'string' ? account['uid'] : ''
      } catch {
        // The account lookup is a nicety; the token is what matters.
      }
      const refresh = typeof token['refresh'] === 'string' ? token['refresh'] : ''
      return {
        token: access,
        ...(refresh.length > 0 ? { refresh } : {}),
        ...(domain.length > 0 ? { domain } : {}),
        ...(uid.length > 0 ? { uid } : {}),
      }
    },
    close: () => undefined,
  }
}

/**
 * ZCode / BigModel, ported from `opencode-zcode-auth/index.mjs`.
 *
 * `oauth/cli/init` opens a flow, the browser signs in on Z.ai or BigModel, and
 * `oauth/cli/poll/{flow_id}` reports `pending` until it is `ready` with the
 * account's access token.
 */
async function zcodeFlow(): Promise<LoginFlow> {
  const zcode = 'https://zcode.z.ai'
  const appVersion = '3.17.2'
  const pollAuth = 'Bearer ' + randomBytes(32).toString('hex')
  const device = randomUUID()
  let cancelled = false

  async function call(
    method: string,
    path: string,
    body: unknown = undefined,
  ): Promise<Record<string, unknown> | null> {
    const result = await httpRequest(zcode + path, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': `ZCode/${appVersion}`,
        authorization: pollAuth,
        'x-device-mid': device,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs: 30_000,
    })
    const envelope = (result.json ?? {}) as Record<string, unknown>
    const code = envelope['code'] === null || envelope['code'] === undefined ? '' : String(envelope['code'])
    if (result.status < 200 || result.status >= 300 || (code !== '' && code !== '0' && code !== '200')) {
      const raw = envelope['msg'] ?? `HTTP ${result.status}`
      throw new Error(`ZCode: ${String(raw)}${code === '' ? '' : `（code ${code}）`}`)
    }
    return (envelope['data'] ?? null) as Record<string, unknown> | null
  }

  const flow = await call('POST', '/api/v1/oauth/cli/init', { provider: 'zai' })
  const authorizeUrl = typeof flow?.['authorize_url'] === 'string' ? flow['authorize_url'] : ''
  const flowId = typeof flow?.['flow_id'] === 'string' ? flow['flow_id'] : ''
  if (flowId.length === 0) throw new Error('ZCode 没有给出登录流程')
  let page: URL
  try {
    page = new URL(authorizeUrl)
  } catch {
    throw new Error('ZCode 给出的登录页不是合法 URL')
  }
  if (page.protocol !== 'https:') throw new Error('ZCode 的登录页不是 https')

  const back =
    `${zcode}/app/oauth/login?` +
    new URLSearchParams({ redirect: 'zcode://oauth/callback', app_version: appVersion }).toString()
  page.searchParams.set('redirect_uri', back)

  const intervalMs = Math.max(Number(flow?.['poll_interval_sec']) || 0, 1) * 1000
  const expiresAt = Number(flow?.['expires_at']) > 0 ? Number(flow?.['expires_at']) * 1000 : Date.now() + SIGN_IN_TIMEOUT_MS

  return {
    mode: 'device-poll',
    url: page.toString(),
    instructions: '在浏览器里登录 Z.ai；登录完成后会自动回传，无需复制。',
    async wait() {
      for (;;) {
        await sleep(intervalMs)
        if (cancelled) throw new Error('已取消')
        if (Date.now() > expiresAt) throw new Error('ZCode 登录超时，请重试')
        let got: Record<string, unknown> | null = null
        try {
          got = await call('GET', `/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (/HTTP 4\d\d/.test(message)) throw error
          continue
        }
        const status = typeof got?.['status'] === 'string' ? got['status'] : ''
        if (status === 'pending' || status === '') continue
        if (status === 'failed') throw new Error('ZCode 侧的登录被拒绝')
        const zai = got?.['zai'] as Record<string, unknown> | undefined
        const access =
          typeof zai?.['access_token'] === 'string'
            ? zai['access_token']
            : typeof zai?.['accessToken'] === 'string'
              ? zai['accessToken']
              : ''
        if (status !== 'ready' || access.length === 0) throw new Error(`ZCode 返回了意外的状态：${status}`)
        const jwt = typeof got?.['token'] === 'string' ? got['token'] : ''
        return { token: access, ...(jwt.length > 0 ? { jwt } : {}) }
      }
    },
    close: () => {
      cancelled = true
    },
  }
}

/** Vendors whose sign-in the official client owns: open the page, paste by hand. */
function manualFlow(vendor: VendorId, pageUrl: string, why: string): LoginFlow {
  const meta = vendorMeta(vendor)
  return {
    mode: 'manual',
    url: pageUrl,
    instructions: why,
    wait: () =>
      Promise.reject(
        new Error(
          `${meta?.name ?? vendor}：${why} 已在浏览器打开官方页面，取到令牌后粘贴回卡片即可。`,
        ),
      ),
    close: () => undefined,
  }
}

// ------------------------------------------------------------- public API

/** Where each vendor's browser sign-in goes, and how honest that is. */
export async function startLoginFlow(vendor: VendorId): Promise<LoginFlow> {
  switch (vendor) {
    case 'trae-cn':
      return traeCnFlow()
    case 'qoder-cn':
      return qoderFlow('qoder-cn')
    case 'qoder-global':
      return qoderFlow('qoder-global')
    case 'workbuddy':
      return workbuddyFlow('workbuddy')
    case 'workbuddy-ai':
      return workbuddyFlow('workbuddy-ai')
    case 'zcode':
      return zcodeFlow()
    case 'codearts':
      return manualFlow(
        vendor,
        'https://codearts.huaweicloud.com/',
        'CodeArts 是 PKCE + DPoP 的华为云 OAuth（STS 换临时 AK/SK），本插件尚未移植',
      )
    default:
      return manualFlow(vendor, 'https://example.com', '没有该供应商的登录配置')
  }
}

/** Start one vendor's sign-in: create the session, open the browser, begin waiting. */
export async function startBrowserLogin(vendor: VendorId): Promise<LoginSession> {
  cancelSessionsOf(vendor)
  const id = randomBytes(8).toString('hex')
  const flow = await startLoginFlow(vendor)
  const session: LoginSession = {
    id,
    vendor,
    state: 'waiting',
    createdAt: Date.now(),
    mode: flow.mode,
    url: flow.url,
    instructions: flow.instructions,
  }
  sessions.set(id, session)
  closers.set(id, () => flow.close())
  openBrowser(flow.url)

  void flow
    .wait()
    .then((secret) => {
      if (session.state !== 'waiting') return
      session.secret = secret
      session.state = 'done'
    })
    .catch((error: unknown) => {
      if (session.state !== 'waiting') return
      session.state = 'error'
      session.error = error instanceof Error ? error.message : String(error)
      flow.close()
    })

  return session
}

export function pollBrowserLogin(id: string): LoginSession | undefined {
  const session = sessions.get(id)
  if (session === undefined) return undefined
  if (session.state !== 'waiting') closeSession(id)
  if (Date.now() - session.createdAt > SESSION_TTL_MS && session.state === 'waiting') {
    session.state = 'error'
    session.error = '登录超时，请重试'
    closeSession(id)
  }
  return session
}

export function cancelBrowserLogin(id: string): void {
  const session = sessions.get(id)
  if (session !== undefined && session.state === 'waiting') session.state = 'cancelled'
  closeSession(id)
}

function closeSession(id: string): void {
  const close = closers.get(id)
  if (close !== undefined) {
    close()
    closers.delete(id)
  }
}

function cancelSessionsOf(vendor: VendorId): void {
  for (const [id, session] of sessions) {
    if (session.vendor === vendor && session.state === 'waiting') {
      session.state = 'cancelled'
      closeSession(id)
    }
  }
}

/** Drop every listener (called when the plugin's fiber unwinds). */
export function closeAllLogins(): void {
  for (const id of [...closers.keys()]) closeSession(id)
  for (const session of sessions.values()) {
    if (session.state === 'waiting') session.state = 'cancelled'
  }
}