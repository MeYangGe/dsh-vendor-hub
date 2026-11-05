/**
 * The engine: turns stored accounts into the status document the browser half
 * reads, and performs the two actions that change the outside world (a quota
 * read and a check-in claim).
 *
 * Rules that keep it honest:
 *  - a read that fails records the failure and drops the stale figures, so the
 *    panel never shows an old number as if it were fresh;
 *  - a check-in for an account concludes at most once per Asia/Shanghai day
 *    unless the user presses the button again;
 *  - every attempt, refusals included, lands in the rolling log.
 */

import type {
  AccountStatus,
  CheckinLogEntry,
  CheckinStatus,
  ConnectSettings,
  ConnectStatus,
  OverviewTotals,
  QuotaError,
} from '../types.ts'
import {
  allEntries,
  appendLog,
  listAccounts,
  loadSettings,
  patchEntry,
  readEntry,
  readLog,
  statusOf,
  type AccountRecord,
} from './store.ts'
import { AdapterFailure, adapterFor } from '../providers/index.ts'
import { maskAccount } from './http.ts'

export interface EngineOptions {
  version: string
  logger: { warn(...args: unknown[]): void; info(...args: unknown[]): void }
}

/** The Asia/Shanghai calendar day a timestamp falls in (`YYYY-MM-DD`). */
export function shanghaiDay(at: Date | number = new Date()): string {
  const date = typeof at === 'number' ? new Date(at) : at
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

/** Convert an Asia/Shanghai wall clock on a given day to a UTC epoch. */
export function shanghaiWallClockToUtc(day: string, minute: number): number {
  const [year, month, date] = day.split('-').map(Number)
  if (!year || !month || !date) return 0
  // Asia/Shanghai has no DST: it is UTC+8 all year.
  return Date.UTC(year, month - 1, date, 0, minute, 0, 0) - 8 * 3_600_000
}

/** The next instant the automatic sweep should run, as an ISO timestamp. */
export function nextCheckinAt(minute: number, now = Date.now()): string {
  const today = shanghaiDay(now)
  const todayAt = shanghaiWallClockToUtc(today, minute)
  return new Date(todayAt > now ? todayAt : todayAt + 86_400_000).toISOString()
}

/** Run at most `limit` promises at a time, preserving input order. */
async function mapLimited<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const size = Math.min(Math.max(1, limit), Math.max(1, items.length))
  const lanes = new Array(size).fill(null).map(async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      out[index] = await worker(items[index] as T)
    }
  })
  await Promise.all(lanes)
  return out
}

function failureOf(error: unknown): QuotaError {
  if (error instanceof AdapterFailure) return error.error
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'unknown', message: message.slice(0, 240) }
}

/** Read one account's allowances and cache the outcome. */
export async function refreshAccount(record: AccountRecord, options: EngineOptions): Promise<AccountStatus> {
  const settings = loadSettings()
  const adapter = adapterFor(record.vendor)
  if (adapter === undefined) {
    const error: QuotaError = { code: 'unsupported', message: `没有 ${record.vendor} 的适配器` }
    patchEntry(record.id, { error, at: new Date().toISOString() })
    return statusOf(record, settings)
  }
  const started = Date.now()
  try {
    const quota = await adapter.readQuota(record)
    patchEntry(record.id, { quota, error: undefined, ms: Date.now() - started, at: new Date().toISOString() })
  } catch (error) {
    const failure = failureOf(error)
    patchEntry(record.id, { quota: undefined, error: failure, ms: Date.now() - started, at: new Date().toISOString() })
    options.logger.warn(`dsh-magpie-connect: ${record.vendor} ${record.label} 额度读取失败 - ${failure.message}`)
  }
  return statusOf(record, settings)
}

/** Read every stored account's allowances. */
export async function refreshAll(options: EngineOptions): Promise<AccountStatus[]> {
  return mapLimited(listAccounts(), 4, (record) => refreshAccount(record, options))
}

/** Whether a check-in for this account already concluded today. */
function concludedToday(record: AccountRecord): boolean {
  const checkin = readEntry(record.id)?.checkin
  if (!checkin) return false
  if (checkin.outcome !== 'claimed' && checkin.outcome !== 'already') return false
  return shanghaiDay(new Date(checkin.at)) === shanghaiDay()
}

function logAttempt(record: AccountRecord, status: CheckinStatus): void {
  const entry: CheckinLogEntry = {
    at: status.at,
    vendor: record.vendor,
    accountId: record.id,
    account: maskAccount(record.account || record.label),
    outcome: status.outcome,
    message: status.message,
  }
  appendLog(entry)
}

/**
 * Ask one account whether today's check-in is available, and claim it when it
 * is. `manual` is a press from the card: it re-asks the vendor even after an
 * earlier conclusion so the user sees a fresh answer.
 */
export async function checkinAccount(
  record: AccountRecord,
  options: EngineOptions,
  manual = false,
): Promise<CheckinStatus> {
  if (!manual && concludedToday(record)) {
    const previous = readEntry(record.id)?.checkin
    if (previous) return previous
  }
  const adapter = adapterFor(record.vendor)
  let status: CheckinStatus
  if (adapter === undefined) {
    status = { outcome: 'skipped', message: '该供应商没有适配器', at: new Date().toISOString() }
  } else {
    try {
      const probe = await adapter.readCheckin(record)
      status = probe.outcome === 'eligible' ? await adapter.claimCheckin(record) : probe
    } catch (error) {
      const failure = failureOf(error)
      status = { outcome: 'failed', message: failure.message, at: new Date().toISOString() }
      options.logger.warn(`dsh-magpie-connect: ${record.vendor} ${record.label} 签到失败 - ${failure.message}`)
    }
  }
  patchEntry(record.id, { checkin: status, at: new Date().toISOString() })
  logAttempt(record, status)
  return status
}

/** Every account that still has its check-in switch on. */
export function checkinCandidates(settings: ConnectSettings): AccountRecord[] {
  return listAccounts().filter((record) => !settings.checkinOff.includes(record.id))
}

/** Sweep every account with its check-in switch on. */
export async function checkinAll(options: EngineOptions): Promise<CheckinStatus[]> {
  const settings = loadSettings()
  return mapLimited(checkinCandidates(settings), 2, (record) => checkinAccount(record, options, false))
}

/** Compute the headline totals from the accounts as they now stand. */
export function totalsOf(accounts: AccountStatus[]): OverviewTotals {
  let creditsLeft: number | null = null
  let creditsTotal: number | null = null
  let updatedAt: string | null = null
  for (const account of accounts) {
    for (const window of account.quota?.windows ?? []) {
      if (window.unit !== 'credits') continue
      if (typeof window.remaining === 'number') creditsLeft = (creditsLeft ?? 0) + window.remaining
      if (typeof window.total === 'number') creditsTotal = (creditsTotal ?? 0) + window.total
    }
    const fetched = account.quota?.fetchedAt
    if (fetched && (updatedAt === null || fetched > updatedAt)) updatedAt = fetched
  }
  return {
    vendors: new Set(accounts.map((account) => account.vendor)).size,
    accounts: accounts.length,
    signedIn: accounts.filter((account) => account.signedIn).length,
    readOk: accounts.filter((account) => !!account.quota).length,
    readFailed: accounts.filter((account) => account.error).length,
    checkinClaimable: accounts.filter((account) => account.checkin?.outcome === 'eligible').length,
    checkinClaimed: accounts.filter(
      (account) => account.checkin?.outcome === 'claimed' || account.checkin?.outcome === 'already',
    ).length,
    checkinFailed: accounts.filter((account) => account.checkin?.outcome === 'failed').length,
    creditsLeft,
    creditsTotal,
    updatedAt,
  }
}

/** Assemble the status document the browser half polls. */
export function buildStatus(options: EngineOptions, scheduler: ConnectStatus['scheduler']): ConnectStatus {
  const settings = loadSettings()
  const accounts = listAccounts().map((record) => statusOf(record, settings))
  const problems: string[] = []
  for (const account of accounts) {
    if (account.error) problems.push(`${account.label}（${account.vendor}）：${account.error.message}`)
  }
  if (accounts.length === 0) problems.push('还没有保存任何供应商账号：去「供应商」页粘贴第一份凭证。')
  let log: CheckinLogEntry[] = []
  try {
    log = readLog(60)
  } catch {
    log = []
  }
  return {
    schema: 1,
    version: options.version,
    configured: accounts.length > 0,
    accounts,
    totals: totalsOf(accounts),
    log,
    problems,
    at: new Date().toISOString(),
    scheduler,
  }
}

/** Every cached entry, for diagnostics. */
export function cacheSnapshot(): ReturnType<typeof allEntries> {
  return allEntries()
}