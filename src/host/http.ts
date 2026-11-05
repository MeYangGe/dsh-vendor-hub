/**
 * One HTTP seam for every vendor adapter: a bounded request that always
 * resolves with the status/body it got, plus a classifier that turns a vendor's
 * refusal into the console's error vocabulary.
 *
 * Nothing here holds a credential: callers pass their own headers.
 */

import type { QuotaError, QuotaErrorCode } from '../types.ts'

export const DEFAULT_TIMEOUT_MS = 15_000

export interface HttpResult {
  status: number
  ok: boolean
  headers: Record<string, string>
  text: string
  /** Parsed JSON when the body was JSON; `undefined` otherwise. */
  json: unknown
  /** Wall clock the request took. */
  ms: number
}

export interface HttpOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** Follow redirects (default true). */
  redirect?: boolean
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

/** Perform one request and return everything it produced. */
export async function httpRequest(url: string, options: HttpOptions = {}): Promise<HttpResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      redirect: options.redirect === false ? 'manual' : 'follow',
      signal: controller.signal,
    })
    const text = await response.text()
    return {
      status: response.status,
      ok: response.ok,
      headers: headersToRecord(response.headers),
      text,
      json: tryParse(text),
      ms: Date.now() - started,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function tryParse(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

/** Small helper: safely walk a JSON value. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

export function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** First non-empty string of the candidates, else ''. */
export function firstStr(...values: unknown[]): string {
  for (const value of values) {
    const text = str(value).trim()
    if (text.length > 0) return text
  }
  return ''
}

/** First finite number of the candidates, else null. */
export function firstNum(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = num(value)
    if (parsed !== null) return parsed
  }
  return null
}

const AUTH_WORDS = /unauthor|invalid[_ ]?token|token[_ ]?expired|sign ?in|not ?logged|expired|401|凭证|登录/i
const RATE_WORDS = /rate ?limit|too many|429|频繁|稍后再试|慢一点/i

/**
 * Turn a vendor refusal into the console's vocabulary. The message keeps the
 * vendor's own words (bounded) so the card can explain rather than guess.
 */
export function classifyFailure(status: number, text: string, fallback = ''): QuotaError {
  const body = text.trim().slice(0, 300)
  const said = body.length > 0 ? body : fallback
  let code: QuotaErrorCode = 'unknown'
  if (status === 401 || status === 403 || AUTH_WORDS.test(body)) code = 'unauthorized'
  else if (status === 429 || RATE_WORDS.test(body)) code = 'rate_limited'
  else if (status >= 500) code = 'unreachable'
  else if (status === 404) code = 'unsupported'
  else if (status >= 400) code = 'unknown'
  return { code, message: `HTTP ${status}${said ? ` · ${said}` : ''}` }
}

/** Classify a thrown transport error (DNS, timeout, reset). */
export function classifyThrown(error: unknown): QuotaError {
  const name = (error as { name?: string } | null)?.name ?? ''
  const message = (error as { message?: string } | null)?.message ?? String(error)
  if (name === 'AbortError' || name === 'TimeoutError' || /timeout|abort/i.test(message)) {
    return { code: 'unreachable', message: `请求超时：${message}` }
  }
  return { code: 'unreachable', message: `网络不可达：${message}` }
}

/** A `Bearer <token>` authorization header. */
export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

/** Mask an account identifier for display: keep a short head and tail. */
export function maskAccount(value: string): string {
  const text = value.trim()
  if (text.length === 0) return '(未知账号)'
  if (text.includes('@')) {
    const [head, domain] = text.split('@')
    const keep = head.slice(0, 2)
    return `${keep}${'*'.repeat(Math.max(1, Math.min(6, head.length - 2)))}@${domain}`
  }
  if (text.length <= 4) return text[0] + '*'.repeat(Math.max(0, text.length - 1))
  return `${text.slice(0, 2)}${'*'.repeat(Math.max(2, Math.min(8, text.length - 4)))}${text.slice(-2)}`
}

/** ISO timestamp for `Date.now()` shifted by a number of milliseconds. */
export function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}