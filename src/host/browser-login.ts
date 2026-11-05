/**
 * Browser sign-in, the way magpie does it.
 *
 * Each login is a short-lived session:
 *   1. a loopback HTTP server binds 127.0.0.1 on a random port;
 *   2. the system browser is opened at the vendor's authorize page, with
 *      `redirect_uri` pointing back at that port;
 *   3. the vendor redirects to `/callback`, which extracts the credential from
 *      the query string the vendor promises (Cloud-IDE-JWT for Trae, `code` for
 *      an OAuth flow, and so on);
 *   4. the browser gets a small "you can close this" page and the session
 *      becomes `done`, which the panel's poll picks up.
 *
 * Sessions are in memory only: a restart drops them, and nothing is written to
 * disk until the caller saves the credential through the normal account book.
 */

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { exec } from 'node:child_process'
import type { VendorId } from '../types.ts'
import { vendorMeta } from '../vendors.ts'

export type LoginState = 'waiting' | 'done' | 'error' | 'cancelled'

/** What one browser login is waiting for. */
export interface LoginSpec {
  /** Query keys that carry the credential, in priority order. */
  tokenParams: string[]
  /** Query keys that carry a refresh token / device id alongside it. */
  extraParams?: string[]
  /**
   * Complete URL the browser should open. `{redirect}` is replaced with the
   * loopback callback; when the vendor's page cannot take a redirect at all, the
   * caller should use {@link manualLoginUrl} instead.
   */
  authorizeUrl: string | null
  /** Where the user gets the credential by hand when there is no redirect. */
  manualLoginUrl: string
}

export interface LoginSession {
  id: string
  vendor: VendorId
  state: LoginState
  createdAt: number
  /** The URL the browser was opened at. */
  url: string
  /** Set once `state === 'done'`. */
  secret?: Record<string, string>
  /** Set once `state === 'error'`. */
  error?: string
  /** Loopback port, for the diagnostic line. */
  port?: number
}

const SESSION_TTL_MS = 10 * 60 * 1000

const sessions = new Map<string, LoginSession>()
const servers = new Map<string, Server>()

/** Per-vendor browser sign-in descriptors. */
export const LOGIN_SPECS: Partial<Record<VendorId, LoginSpec>> = {
  // Trae CN's authorization page sends the browser back to 127.0.0.1 carrying
  // the account's Cloud-IDE-JWT and refresh token (magpie packages/trae).
  'trae-cn': {
    tokenParams: ['Cloud-IDE-JWT', 'cloud-ide-jwt', 'access_token', 'token', 'jwt'],
    extraParams: ['refresh_token', 'device_id'],
    authorizeUrl: 'https://www.trae.cn/authorization?redirect_uri={redirect}&response_type=token',
    manualLoginUrl: 'https://www.trae.cn/',
  },
  // CodeArts (Huawei Cloud) is a PKCE + DPoP OAuth flow; the portal's authorize
  // endpoint is the one magpie's plugin builds its URL from.
  codearts: {
    tokenParams: ['code'],
    authorizeUrl: 'https://codearts.huaweicloud.com/portal/authorize?redirect_uri={redirect}&response_type=code&client_id=codearts-agent&theme=2',
    manualLoginUrl: 'https://codearts.huaweicloud.com/',
  },
  // Tencent's login page issues the token to its own client by polling, so the
  // honest browser path is "sign in there, then take the token it shows you".
  workbuddy: {
    tokenParams: ['access_token', 'token'],
    authorizeUrl: null,
    manualLoginUrl: 'https://copilot.tencent.com/',
  },
  'workbuddy-ai': {
    tokenParams: ['access_token', 'token'],
    authorizeUrl: null,
    manualLoginUrl: 'https://www.workbuddy.ai/',
  },
  // Qoder hands out Personal Access Tokens from its account page; there is no
  // third-party OAuth grant to redirect back.
  'qoder-cn': {
    tokenParams: ['access_token', 'token'],
    authorizeUrl: null,
    manualLoginUrl: 'https://qoder.com.cn/account',
  },
  'qoder-global': {
    tokenParams: ['access_token', 'token'],
    authorizeUrl: null,
    manualLoginUrl: 'https://qoder.com/account',
  },
  zcode: {
    tokenParams: ['access_token', 'token', 'api_key'],
    authorizeUrl: null,
    manualLoginUrl: 'https://zcode.z.ai/',
  },
}

/** Open a URL in the operating system's default browser. */
export function openBrowser(url: string): void {
  const platform = process.platform
  const command =
    platform === 'win32'
      ? `cmd /c start "" "${url.replace(/"/g, '')}"`
      : platform === 'darwin'
        ? `open "${url.replace(/"/g, '')}"`
        : `xdg-open "${url.replace(/"/g, '')}"`
  exec(command, (error) => {
    if (error) {
      // Not fatal: the panel shows the URL so the user can open it themselves.
    }
  })
}

/** Start (or restart) one vendor's browser sign-in. */
export function startBrowserLogin(vendor: VendorId): LoginSession {
  cancelSessionsOf(vendor)
  const spec = LOGIN_SPECS[vendor]
  const meta = vendorMeta(vendor)
  const id = randomBytes(8).toString('hex')

  if (spec === undefined) {
    const session: LoginSession = {
      id,
      vendor,
      state: 'error',
      createdAt: Date.now(),
      url: '',
      error: `没有 ${vendor} 的浏览器登录配置`,
    }
    sessions.set(id, session)
    return session
  }

  // A vendor without a redirect flow still opens its page; the user brings the
  // credential back by hand and the panel says so plainly.
  if (spec.authorizeUrl === null) {
    openBrowser(spec.manualLoginUrl)
    const session: LoginSession = {
      id,
      vendor,
      state: 'waiting',
      createdAt: Date.now(),
      url: spec.manualLoginUrl,
      error: `${meta?.name ?? vendor} 没有开放第三方登录回调，已为你打开官方页面；登录后在页面里取到令牌，粘贴回卡片即可。`,
    }
    sessions.set(id, session)
    return session
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }
    const secret = extractSecret(url, spec)
    const session = sessions.get(id)
    if (secret === undefined) {
      if (session !== undefined) {
        session.state = 'error'
        session.error = '回调里没有找到凭证字段：' + [...url.searchParams.keys()].join(', ')
      }
      respondPage(response, false, '没有收到凭证，回到 DSH 看看卡片上的说明。')
      return
    }
    if (session !== undefined) {
      session.state = 'done'
      session.secret = secret
      delete session.error
    }
    respondPage(response, true, `已完成 ${meta?.name ?? vendor} 的登录，可以关闭这个页面，回到 DSH。`)
  })

  server.on('error', (error) => {
    const session = sessions.get(id)
    if (session !== undefined) {
      session.state = 'error'
      session.error = `本地回调端口启动失败：${error.message}`
    }
  })

  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const redirect = `http://127.0.0.1:${port}/callback`
    const authorizeUrl = (spec.authorizeUrl ?? '').replace('{redirect}', encodeURIComponent(redirect))
    const session: LoginSession = {
      id,
      vendor,
      state: 'waiting',
      createdAt: Date.now(),
      url: authorizeUrl,
      port,
    }
    sessions.set(id, session)
    openBrowser(authorizeUrl)
  })

  servers.set(id, server)
  const placeholder: LoginSession = { id, vendor, state: 'waiting', createdAt: Date.now(), url: '' }
  sessions.set(id, sessions.get(id) ?? placeholder)
  return sessions.get(id) as LoginSession
}

function extractSecret(url: URL, spec: LoginSpec): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const key of spec.tokenParams) {
    const value = url.searchParams.get(key)
    if (value !== null && value.trim().length > 0) {
      out['token'] = value.trim()
      break
    }
  }
  if (out['token'] === undefined) {
    // Some vendors put the credential in the fragment, which never reaches the
    // server; those flows must be handled by the panel's paste path instead.
    return undefined
  }
  for (const key of spec.extraParams ?? []) {
    const value = url.searchParams.get(key)
    if (value !== null && value.trim().length > 0) {
      out[key === 'refresh_token' ? 'refresh' : key] = value.trim()
    }
  }
  return out
}

function respondPage(response: import('node:http').ServerResponse, ok: boolean, message: string): void {
  const tone = ok ? '#2f9e6a' : '#cc4b48'
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
    `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Magpie Connect</title></head>
<body style="font:15px/1.6 system-ui,sans-serif;padding:40px;max-width:520px;margin:0 auto">
<h2 style="color:${tone};margin:0 0 8px">${ok ? '登录完成' : '没有拿到凭证'}</h2>
<p>${message}</p></body></html>`,
  )
}

function closeServer(id: string): void {
  const server = servers.get(id)
  if (server !== undefined) {
    server.close()
    servers.delete(id)
  }
}

export function pollBrowserLogin(id: string): LoginSession | undefined {
  const session = sessions.get(id)
  if (session === undefined) return undefined
  if (session.state === 'done' || session.state === 'error' || session.state === 'cancelled') {
    closeServer(id)
  }
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    session.state = 'error'
    session.error = '登录超时（10 分钟），请重试'
    closeServer(id)
  }
  return session
}

export function cancelBrowserLogin(id: string): void {
  const session = sessions.get(id)
  if (session !== undefined) {
    session.state = 'cancelled'
  }
  closeServer(id)
}

function cancelSessionsOf(vendor: VendorId): void {
  for (const [id, session] of sessions) {
    if (session.vendor === vendor && session.state === 'waiting') {
      session.state = 'cancelled'
      closeServer(id)
    }
  }
}

/** Drop every loopback listener (called when the plugin's fiber unwinds). */
export function closeAllLogins(): void {
  for (const id of [...servers.keys()]) closeServer(id)
  for (const session of sessions.values()) {
    if (session.state === 'waiting') session.state = 'cancelled'
  }
}