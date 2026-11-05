/**
 * Contract shared by the Host and browser halves of `dsh-magpie-connect`.
 *
 * Node-free on purpose: the browser bundle imports this file directly, so it
 * may hold shapes, string literals and pure helpers only.
 */

/** One upstream plan vendor this console aggregates. */
export type VendorId =
  | 'qoder-cn'
  | 'qoder-global'
  | 'workbuddy'
  | 'workbuddy-ai'
  | 'trae-cn'
  | 'zcode'
  | 'codearts'

/** How a vendor's credential is obtained and what the card must collect. */
export interface CredentialField {
  /** Field key inside the account's secret record. */
  key: string
  /** Localized label key resolved by the browser half. */
  labelKey: string
  /** Whether the card refuses to save while it is empty. */
  required: boolean
  /** Rendered as a password input and never echoed back. */
  secret?: boolean
  placeholder?: string
}

export interface CredentialSpec {
  /** `pat` = one pasted token, `keys` = AK/SK pair, `cookie` = raw cookie, `token` = session JWT. */
  kind: 'pat' | 'keys' | 'cookie' | 'token'
  /** Where the user gets it - a site host plus the menu path, localized. */
  hintKey: string
  fields: CredentialField[]
}

export type QuotaUnit = 'credits' | 'tokens' | 'usd' | 'requests' | 'points' | 'percent'

/** Everything the console needs to know about a vendor without any network. */
export interface VendorMeta {
  id: VendorId
  /** Chinese display name. */
  name: string
  /** English display name. */
  nameEn: string
  /** The vendor's own site host, shown on the card. */
  site: string
  /** Single glyph used when no logo asset ships. */
  glyph: string
  credential: CredentialSpec
  /** Whether the vendor pays a daily check-in. */
  checkin: boolean
  /** Unit its allowance windows are counted in. */
  unit: QuotaUnit
  /** One line saying what the plan is, localized key. */
  planHintKey: string
}

/** One allowance window of one account. */
export interface QuotaWindow {
  /** Window name as the vendor calls it, e.g. `5 小时`, `每周`, `Credits`. */
  name: string
  /** Unit this window counts in. */
  unit: QuotaUnit
  /** Total allowance; `null` when the vendor reports a share only. */
  total: number | null
  /** Consumed amount; `null` when unknown. */
  used: number | null
  /** Remaining amount, derived when the vendor reports `used` only. */
  remaining: number | null
  /** Percentage left, 0..100, when the vendor reports a share. */
  percentLeft?: number | null
  /** ISO timestamp the window resets at. */
  resetsAt?: string | null
  /** ISO timestamp the package lapses at. */
  expiresAt?: string | null
  /** Vendor says this window is not capped. */
  unlimited?: boolean
  /** Free-form note shown under the bar (plan tier, seat, etc). */
  note?: string
}

/** A read of one account's allowances. */
export interface AccountQuota {
  /** Vendor account identifier, already masked for display by the host. */
  account: string
  plan?: string | null
  windows: QuotaWindow[]
  /** Wallet-style balance, when the vendor bills a purse rather than credits. */
  balance?: { amount: number; unit: string; label?: string } | null
  /** Last successful read. */
  fetchedAt: string
}

export type QuotaErrorCode =
  | 'no_credential'
  | 'unauthorized'
  | 'unreachable'
  | 'unsupported'
  | 'rate_limited'
  | 'parse_failed'
  | 'unknown'

export interface QuotaError {
  code: QuotaErrorCode
  message: string
}

export type CheckinOutcome =
  | 'eligible'
  | 'claimed'
  | 'already'
  | 'ineligible'
  | 'no_window'
  | 'failed'
  | 'skipped'

export interface CheckinStatus {
  outcome: CheckinOutcome
  /** Human sentence saying what happened (already localized by the host). */
  message: string
  /** Amount granted by this claim, when the vendor says. */
  amount?: string | null
  /** Consecutive days, when the vendor says. */
  streak?: number | null
  at: string
  /** Next time the automatic check-in will look again, ISO. */
  nextAt?: string | null
}

/** One account's current line in the console. */
export interface AccountStatus {
  /** Stable local id `${vendor}:${hash}`. */
  id: string
  vendor: VendorId
  /** User-visible label the host stored at save time. */
  label: string
  account: string
  plan?: string | null
  signedIn: boolean
  quota?: AccountQuota | null
  error?: QuotaError | null
  /** Milliseconds the last read took. */
  ms?: number
  /** Whether the daily check-in switch is on for this account. */
  checkinOn: boolean
  checkin?: CheckinStatus | null
}

export interface CheckinLogEntry {
  at: string
  vendor: VendorId
  accountId: string
  account: string
  outcome: CheckinOutcome
  message: string
}

/** Aggregated headline the sidebar card and Overview tiles both read. */
export interface OverviewTotals {
  vendors: number
  accounts: number
  signedIn: number
  /** Accounts whose quota read succeeded. */
  readOk: number
  /** Accounts that failed. */
  readFailed: number
  /** Accounts whose vendor offers a check-in today and it is still claimable. */
  checkinClaimable: number
  /** Accounts already claimed today. */
  checkinClaimed: number
  /** Accounts whose last check-in attempt failed. */
  checkinFailed: number
  /** Sum of remaining credits across every credits-unit window. */
  creditsLeft: number | null
  /** Total credits the accounts were granted. */
  creditsTotal: number | null
  /** When any account was last read successfully, ISO. */
  updatedAt: string | null
}

/** The whole status document the browser half polls. */
export interface ConnectStatus {
  schema: 1
  /** Plugin version, shown in the panel footer. */
  version: string
  /** Whether the plugin's settings file exists yet. */
  configured: boolean
  accounts: AccountStatus[]
  totals: OverviewTotals
  /** Rolling check-in log, newest first, bounded by the host. */
  log: CheckinLogEntry[]
  /** Per-account failures the panel shows on the status bar. */
  problems: string[]
  /** ISO timestamp this document was produced. */
  at: string
  /** Background scheduler state. */
  scheduler: { enabled: boolean; nextAt: string | null; lastAt: string | null }
}

/** Settings the user can change from the cards (persisted to the plugin file). */
export interface ConnectSettings {
  /** Automatic daily check-in sweep. */
  autoCheckin: boolean
  /** Minutes past Asia/Shanghai midnight the sweep runs at (0..1439). */
  checkinMinute: number
  /** Sidebar card refresh interval, milliseconds. */
  pollMs: number
  /** Whether the sidebar footer card is shown. */
  sidebarCard: boolean
  /** Accounts the user switched the check-in off for (`AccountStatus.id`). */
  checkinOff: string[]
  /** Accounts the user hid from the Overview. */
  hidden: string[]
}

export const DEFAULT_SETTINGS: ConnectSettings = {
  autoCheckin: true,
  checkinMinute: 10 * 60,
  pollMs: 300_000,
  sidebarCard: true,
  checkinOff: [],
  hidden: [],
}

export const POLL_MIN_MS = 60_000
export const POLL_DEFAULT_MS = 300_000

/** Base path of the plugin's own HTTP surface, shared by both halves. */
export const ROUTE_BASE = '/plugins/dsh-magpie-connect'

/** Human label per check-in outcome, used by the log and the cards. */
export const CHECKIN_OUTCOME_LABEL: Record<CheckinOutcome, string> = {
  eligible: '可领取',
  claimed: '已领取',
  already: '今日已签',
  ineligible: '不满足条件',
  no_window: '未到签到时间',
  failed: '失败',
  skipped: '已跳过',
}

function trimNumber(value: number): string {
  const fixed = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1)
  return fixed.replace(/\.0$/, '')
}

/** Format a credit/token count the way the Overview tiles read it. */
export function formatAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const n = Math.abs(value)
  if (n >= 1_000_000) return trimNumber(value / 1_000_000) + 'M'
  if (n >= 10_000) return trimNumber(value / 1_000) + 'K'
  if (n >= 1_000) return Math.round(value).toLocaleString('zh-CN')
  if (n < 1 && n > 0) return trimNumber(value)
  return String(Math.round(value))
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/** Percentage left as an integer 0..100, or null when the window is opaque. */
export function percentLeftOf(window: QuotaWindow): number | null {
  if (window.unlimited) return 100
  if (typeof window.percentLeft === 'number' && Number.isFinite(window.percentLeft)) return clampPercent(window.percentLeft)
  if (window.total && window.total > 0 && window.remaining !== null) return clampPercent((window.remaining / window.total) * 100)
  return null
}

/** Worst-case (smallest) remaining share across an account's windows. */
export function worstPercent(account: AccountStatus): number | null {
  const windows = account.quota?.windows ?? []
  let worst: number | null = null
  for (const window of windows) {
    const percent = percentLeftOf(window)
    if (percent === null) continue
    if (worst === null || percent < worst) worst = percent
  }
  return worst
}

/** Accounts still claimable today, which the card surfaces as a badge. */
export function claimableAccounts(status: ConnectStatus): AccountStatus[] {
  return status.accounts.filter((account) => account.checkinOn && account.checkin?.outcome === 'eligible')
}

/** Days left until an ISO timestamp, rounded up; null when unbounded. */
export function daysUntil(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  const days = Math.ceil((at - now) / 86_400_000)
  return Number.isFinite(days) ? days : null
}