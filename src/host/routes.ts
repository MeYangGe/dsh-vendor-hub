/**
 * The Host half's HTTP surface, mounted on the harness webServer:
 *
 *   GET  {BASE}/status     the status document the sidebar card polls
 *   GET  {BASE}/settings   the effective settings plus the user layer
 *   POST {BASE}/settings   one settings patch
 *   POST {BASE}/auth       save / remove one credential set
 *   POST {BASE}/refresh    re-read one account, or all of them
 *   POST {BASE}/checkin    claim one account, or sweep every account
 *   POST {BASE}/log/clear  empty the rolling check-in log
 *
 * Writes are same-origin only: a page that is not the harness cannot call
 * them, and a credential is never echoed back in any response.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AccountStatus, CheckinStatus, ConnectSettings, ConnectStatus, VendorId } from '../types.ts'
import { POLL_MIN_MS, ROUTE_BASE } from '../types.ts'
import { checkinAll, checkinAccount, refreshAccount, refreshAll, buildStatus, type EngineOptions } from './engine.ts'
import {
  clearLog,
  findAccount,
  listAccounts,
  loadSettings,
  patchSettings,
  removeAccount,
  removeVendor,
  saveAccount,
  saveSettings,
} from './store.ts'
import { vendorMeta } from '../vendors.ts'

export { ROUTE_BASE }

const MAX_BODY_BYTES = 32 * 1024

export interface RouteDeps {
  options: EngineOptions
  /** Reads the live scheduler state the status document reports. */
  scheduler: () => ConnectStatus['scheduler']
  /** Re-arms the check-in timer after a settings change. */
  reschedule: () => void
}

// ------------------------------------------------------------------ helpers

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function isLoopbackHost(host: string): boolean {
  const value = host.split(':')[0] ?? ''
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]' || value === '0.0.0.0'
}

/**
 * Refuse a mutating request that did not come from this page. `Origin`, when
 * present, must match `Host`; a browser always sends it on a POST.
 */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) {
    // A non-browser caller (curl, the CLI) has no Origin: allow loopback only.
    const host = request.headers.host
    return typeof host === 'string' && isLoopbackHost(host)
  }
  try {
    const parsed = new URL(origin)
    const host = request.headers.host
    return typeof host === 'string' && parsed.host === host
  } catch {
    return false
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('请求体不是 JSON')
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isVendor(value: string): value is VendorId {
  return vendorMeta(value as VendorId) !== undefined
}

// ------------------------------------------------------------------- routes

export function mountRoutes(deps: RouteDeps): Array<{
  kind: 'exact'
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
}> {
  const { options } = deps

  /** GET status */
  async function status(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host
    if (typeof host !== 'string' || !isLoopbackHost(host)) {
      // Reached through a configured authority: still fine, the harness gate
      // already admitted it. Only a literal rebinding attempt has no Host.
      if (host === undefined) {
        sendJson(response, 403, { error: 'missing_host' })
        return
      }
    }
    sendJson(response, 200, buildStatus(options, deps.scheduler()))
  }

  /** GET settings */
  async function getSettings(_request: IncomingMessage, response: ServerResponse): Promise<void> {
    const settings = loadSettings()
    sendJson(response, 200, { value: settings, user: settings, base: settings })
  }

  /** POST settings */
  async function postSettings(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: 'cross_origin' })
      return
    }
    let body: Record<string, unknown>
    try {
      body = asObject(await readBody(request))
    } catch (error) {
      sendJson(response, 400, { error: (error as Error).message })
      return
    }
    const current = loadSettings()
    const patch: Partial<ConnectSettings> = {}
    if (typeof body['autoCheckin'] === 'boolean') patch.autoCheckin = body['autoCheckin']
    if (typeof body['sidebarCard'] === 'boolean') patch.sidebarCard = body['sidebarCard']
    if (typeof body['checkinMinute'] === 'number' && Number.isInteger(body['checkinMinute'])) {
      patch.checkinMinute = Math.min(1439, Math.max(0, body['checkinMinute']))
    }
    if (typeof body['pollMs'] === 'number' && Number.isFinite(body['pollMs'])) {
      patch.pollMs = Math.max(POLL_MIN_MS, Math.round(body['pollMs']))
    }
    // Account-level switches arrive as one-account patches.
    const accountId = asString(body['accountId'])
    const accountPatch = asString(body['accountPatch'])
    if (accountId.length > 0 && (accountPatch === 'checkin-off' || accountPatch === 'checkin-on')) {
      const off = new Set(current.checkinOff)
      if (accountPatch === 'checkin-off') off.add(accountId)
      else off.delete(accountId)
      patch.checkinOff = [...off]
    }
    if (accountId.length > 0 && (accountPatch === 'hide' || accountPatch === 'show')) {
      const hidden = new Set(current.hidden)
      if (accountPatch === 'hide') hidden.add(accountId)
      else hidden.delete(accountId)
      patch.hidden = [...hidden]
    }
    const saved = Object.keys(patch).length > 0 ? patchSettings(patch) : saveSettings(current)
    if (patch.autoCheckin !== undefined || patch.checkinMinute !== undefined) deps.reschedule()
    sendJson(response, 200, { value: saved, user: saved, base: saved })
  }

  /** POST auth */
  async function postAuth(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: 'cross_origin' })
      return
    }
    let body: Record<string, unknown>
    try {
      body = asObject(await readBody(request))
    } catch (error) {
      sendJson(response, 400, { error: (error as Error).message })
      return
    }
    const action = asString(body['action'])
    const id = asString(body['id'])
    const vendorRaw = asString(body['vendor'])

    if (action === 'remove') {
      if (id.length === 0) {
        sendJson(response, 400, { error: 'missing_id' })
        return
      }
      const removed = removeAccount(id)
      sendJson(response, removed ? 200 : 404, { ok: removed })
      return
    }

    if (action === 'removeVendor') {
      if (!isVendor(vendorRaw)) {
        sendJson(response, 400, { error: 'unknown_vendor' })
        return
      }
      const removed = removeVendor(vendorRaw)
      sendJson(response, 200, { ok: true, removed })
      return
    }

    if (action !== 'save') {
      sendJson(response, 400, { error: 'unknown_action' })
      return
    }
    if (!isVendor(vendorRaw)) {
      sendJson(response, 400, { error: 'unknown_vendor' })
      return
    }
    const meta = vendorMeta(vendorRaw)!
    const secretRaw = asObject(body['secret'])
    const secret: Record<string, string> = {}
    for (const field of meta.credential.fields) {
      const value = asString(secretRaw[field.key]).trim()
      if (field.required && value.length === 0) {
        sendJson(response, 400, { error: 'missing_field', field: field.key })
        return
      }
      if (value.length > 0) secret[field.key] = value
    }
    if (Object.keys(secret).length === 0) {
      sendJson(response, 400, { error: 'empty_secret' })
      return
    }
    const record = saveAccount({
      vendor: vendorRaw,
      label: asString(body['label']),
      account: asString(body['account']),
      secret,
    })
    // Read once right away so the card has figures instead of a spinner.
    const status = await refreshAccount(record, options)
    sendJson(response, 200, { ok: true, id: record.id, status })
    return
  }

  /** POST refresh */
  async function postRefresh(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: 'cross_origin' })
      return
    }
    let body: Record<string, unknown> = {}
    try {
      body = asObject(await readBody(request))
    } catch (error) {
      sendJson(response, 400, { error: (error as Error).message })
      return
    }
    const id = asString(body['id'])
    if (id.length === 0) {
      const accounts = await refreshAll(options)
      sendJson(response, 200, { ok: true, accounts })
      return
    }
    const record = findAccount(id)
    if (record === undefined) {
      sendJson(response, 404, { error: 'unknown_account' })
      return
    }
    const status: AccountStatus = await refreshAccount(record, options)
    sendJson(response, 200, { ok: true, status })
    return
  }

  /** POST checkin */
  async function postCheckin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: 'cross_origin' })
      return
    }
    let body: Record<string, unknown> = {}
    try {
      body = asObject(await readBody(request))
    } catch (error) {
      sendJson(response, 400, { error: (error as Error).message })
      return
    }
    const id = asString(body['id'])
    const manual = body['manual'] !== false
    if (id.length === 0) {
      const results = await checkinAll(options)
      sendJson(response, 200, { ok: true, results })
      return
    }
    const record = findAccount(id)
    if (record === undefined) {
      sendJson(response, 404, { error: 'unknown_account' })
      return
    }
    const status: CheckinStatus = await checkinAccount(record, options, manual)
    sendJson(response, 200, { ok: true, status })
    return
  }

  /** POST log/clear */
  async function postLogClear(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: 'cross_origin' })
      return
    }
    clearLog()
    sendJson(response, 200, { ok: true })
    return
  }

  /** GET accounts - the account book without any secret. */
  async function getAccounts(_request: IncomingMessage, response: ServerResponse): Promise<void> {
    const accounts = listAccounts().map((record) => ({
      id: record.id,
      vendor: record.vendor,
      label: record.label,
      account: record.account ?? '',
      plan: record.plan ?? '',
      createdAt: record.createdAt,
    }))
    sendJson(response, 200, { accounts })
  }

  return [
    { kind: 'exact', path: `${ROUTE_BASE}/status`, handler: status },
    { kind: 'exact', path: `${ROUTE_BASE}/settings`, handler: (request, response) =>
      request.method === 'POST' ? postSettings(request, response) : getSettings(request, response) },
    { kind: 'exact', path: `${ROUTE_BASE}/auth`, handler: postAuth },
    { kind: 'exact', path: `${ROUTE_BASE}/refresh`, handler: postRefresh },
    { kind: 'exact', path: `${ROUTE_BASE}/checkin`, handler: postCheckin },
    { kind: 'exact', path: `${ROUTE_BASE}/log/clear`, handler: postLogClear },
    { kind: 'exact', path: `${ROUTE_BASE}/accounts`, handler: getAccounts },
  ]
}