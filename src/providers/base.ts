/**
 * The adapter contract every vendor implements, plus the small helpers they
 * share. An adapter is pure I/O: it never touches the store, never decides
 * what to persist, and never reports success it did not observe.
 */

import type { AccountQuota, CheckinStatus, QuotaError, QuotaUnit, QuotaWindow, VendorId } from '../types.ts'
import type { AccountRecord } from '../host/store.ts'
import { classifyFailure, httpRequest, type HttpOptions } from '../host/http.ts'

/** A refused read: carries the console's error vocabulary. */
export class AdapterFailure extends Error {
  readonly error: QuotaError
  constructor(error: QuotaError) {
    super(error.message)
    this.name = 'AdapterFailure'
    this.error = error
  }
}

export interface VendorAdapter {
  readonly id: VendorId
  /** Read this account's allowances. Throws {@link AdapterFailure} on refusal. */
  readQuota(account: AccountRecord): Promise<AccountQuota>
  /** Ask the vendor whether today's check-in is still claimable. */
  readCheckin(account: AccountRecord): Promise<CheckinStatus>
  /** Claim today's check-in. */
  claimCheckin(account: AccountRecord): Promise<CheckinStatus>
}

/** Build one allowance window from amounts, deriving the missing side. */
export function windowOf(input: {
  name: string
  unit: QuotaUnit
  total?: number | null
  used?: number | null
  remaining?: number | null
  percentLeft?: number | null
  resetsAt?: string | null
  expiresAt?: string | null
  unlimited?: boolean
  note?: string
}): QuotaWindow {
  const total = input.total ?? null
  const used = input.used ?? null
  let remaining = input.remaining ?? null
  if (remaining === null && total !== null && used !== null) remaining = Math.max(0, total - used)
  const derivedUsed = used ?? (total !== null && remaining !== null ? Math.max(0, total - remaining) : null)
  const percentLeft =
    input.percentLeft ??
    (total !== null && total > 0 && remaining !== null ? Math.round((remaining / total) * 1000) / 10 : null)
  const out: QuotaWindow = {
    name: input.name,
    unit: input.unit,
    total,
    used: derivedUsed,
    remaining,
    percentLeft,
  }
  if (input.resetsAt) out.resetsAt = input.resetsAt
  if (input.expiresAt) out.expiresAt = input.expiresAt
  if (input.unlimited) out.unlimited = true
  if (input.note) out.note = input.note
  return out
}

/** Epoch seconds (or ms, or an ISO string) to ISO; null when unreadable. */
export function isoTimestamp(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.length === 0) return null
    const at = Date.parse(text)
    if (Number.isFinite(at)) return new Date(at).toISOString()
    const numeric = Number(text)
    return Number.isFinite(numeric) ? fromEpoch(numeric) : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return fromEpoch(value)
  return null
}

function fromEpoch(value: number): string | null {
  if (value <= 0) return null
  // Anything below 1e11 is seconds; above is milliseconds.
  const ms = value < 1e11 ? value * 1000 : value
  const at = new Date(ms)
  return Number.isFinite(at.getTime()) ? at.toISOString() : null
}

/** ISO for "now", the value every `fetchedAt`/`at` uses. */
export function nowIso(): string {
  return new Date().toISOString()
}

/** A check-in status line with the given outcome. */
export function checkinStatus(input: {
  outcome: CheckinStatus['outcome']
  message: string
  amount?: string | null
  streak?: number | null
  nextAt?: string | null
}): CheckinStatus {
  const out: CheckinStatus = { outcome: input.outcome, message: input.message, at: nowIso() }
  if (input.amount) out.amount = input.amount
  if (typeof input.streak === 'number') out.streak = input.streak
  if (input.nextAt) out.nextAt = input.nextAt
  return out
}

/** Perform a vendor request and parse JSON, failing loudly on refusal. */
export async function requestJson(url: string, options: HttpOptions = {}): Promise<unknown> {
  const result = await httpRequest(url, options)
  if (!result.ok) {
    throw new AdapterFailure(classifyFailure(result.status, result.text))
  }
  if (result.json === undefined) {
    throw new AdapterFailure({ code: 'parse_failed', message: `响应不是 JSON：${result.text.slice(0, 160)}` })
  }
  return result.json
}

/** Perform a request and return the raw result without failing on status. */
export async function requestRaw(url: string, options: HttpOptions = {}) {
  return httpRequest(url, options)
}