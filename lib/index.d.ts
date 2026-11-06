import { Context } from "@deepseek-ai/cordis";
/**
 * Contract shared by the Host and browser halves of `dsh-vendor-hub`.
 *
 * Node-free on purpose: the browser bundle imports this file directly, so it
 * may hold shapes, string literals and pure helpers only.
 */
/** One upstream plan vendor this console aggregates. */
type VendorId = 'qoder-cn' | 'qoder-global' | 'workbuddy' | 'workbuddy-ai' | 'trae-cn' | 'zcode' | 'codearts';
type QuotaUnit = 'credits' | 'tokens' | 'usd' | 'requests' | 'points' | 'percent';
/** One allowance window of one account. */
interface QuotaWindow {
  /** Window name as the vendor calls it, e.g. `5 小时`, `每周`, `Credits`. */
  name: string;
  /** Unit this window counts in. */
  unit: QuotaUnit;
  /** Total allowance; `null` when the vendor reports a share only. */
  total: number | null;
  /** Consumed amount; `null` when unknown. */
  used: number | null;
  /** Remaining amount, derived when the vendor reports `used` only. */
  remaining: number | null;
  /** Percentage left, 0..100, when the vendor reports a share. */
  percentLeft?: number | null;
  /** ISO timestamp the window resets at. */
  resetsAt?: string | null;
  /** ISO timestamp the package lapses at. */
  expiresAt?: string | null;
  /** Vendor says this window is not capped. */
  unlimited?: boolean;
  /** Free-form note shown under the bar (plan tier, seat, etc). */
  note?: string;
}
/** A read of one account's allowances. */
interface AccountQuota {
  /** Vendor account identifier, already masked for display by the host. */
  account: string;
  plan?: string | null;
  windows: QuotaWindow[];
  /** Wallet-style balance, when the vendor bills a purse rather than credits. */
  balance?: {
    amount: number;
    unit: string;
    label?: string;
  } | null;
  /** Last successful read. */
  fetchedAt: string;
}
type QuotaErrorCode = 'no_credential' | 'unauthorized' | 'unreachable' | 'unsupported' | 'rate_limited' | 'parse_failed' | 'unknown';
interface QuotaError {
  code: QuotaErrorCode;
  message: string;
}
type CheckinOutcome = 'eligible' | 'claimed' | 'already' | 'ineligible' | 'no_window' | 'failed' | 'skipped';
interface CheckinStatus {
  outcome: CheckinOutcome;
  /** Human sentence saying what happened (already localized by the host). */
  message: string;
  /** Amount granted by this claim, when the vendor says. */
  amount?: string | null;
  /** Consecutive days, when the vendor says. */
  streak?: number | null;
  at: string;
  /** Next time the automatic check-in will look again, ISO. */
  nextAt?: string | null;
}
/** One account's current line in the console. */
interface AccountStatus {
  /** Stable local id `${vendor}:${hash}`. */
  id: string;
  vendor: VendorId;
  /** User-visible label the host stored at save time. */
  label: string;
  account: string;
  plan?: string | null;
  signedIn: boolean;
  quota?: AccountQuota | null;
  error?: QuotaError | null;
  /** Milliseconds the last read took. */
  ms?: number;
  /** Whether the daily check-in switch is on for this account. */
  checkinOn: boolean;
  checkin?: CheckinStatus | null;
}
interface CheckinLogEntry {
  at: string;
  vendor: VendorId;
  accountId: string;
  account: string;
  outcome: CheckinOutcome;
  message: string;
}
/** Aggregated headline the sidebar card and Overview tiles both read. */
interface OverviewTotals {
  vendors: number;
  accounts: number;
  signedIn: number;
  /** Accounts whose quota read succeeded. */
  readOk: number;
  /** Accounts that failed. */
  readFailed: number;
  /** Accounts whose vendor offers a check-in today and it is still claimable. */
  checkinClaimable: number;
  /** Accounts already claimed today. */
  checkinClaimed: number;
  /** Accounts whose last check-in attempt failed. */
  checkinFailed: number;
  /** Sum of remaining credits across every credits-unit window. */
  creditsLeft: number | null;
  /** Total credits the accounts were granted. */
  creditsTotal: number | null;
  /** When any account was last read successfully, ISO. */
  updatedAt: string | null;
}
/** The whole status document the browser half polls. */
interface ConnectStatus {
  schema: 1;
  /** Plugin version, shown in the panel footer. */
  version: string;
  /** Whether the plugin's settings file exists yet. */
  configured: boolean;
  accounts: AccountStatus[];
  totals: OverviewTotals;
  /** Rolling check-in log, newest first, bounded by the host. */
  log: CheckinLogEntry[];
  /** Per-account failures the panel shows on the status bar. */
  problems: string[];
  /** ISO timestamp this document was produced. */
  at: string;
  /** Background scheduler state. */
  scheduler: {
    enabled: boolean;
    nextAt: string | null;
    lastAt: string | null;
  };
}
interface EngineOptions {
  version: string;
  logger: {
    warn(...args: unknown[]): void;
    info(...args: unknown[]): void;
  };
}
/** Assemble the status document the browser half polls. */
declare function buildStatus(options: EngineOptions, scheduler: ConnectStatus['scheduler']): ConnectStatus;
declare const name = "vendor-hub";
/** The services this plugin needs before it can mount its routes. */
declare const inject: readonly ["webServer"];
/** Bumped with every release; the panel shows it in its footer. */
declare const VERSION = "0.1.0";
declare function apply(ctx: Context): void;
export { type ConnectStatus, VERSION, apply, buildStatus, inject, name };