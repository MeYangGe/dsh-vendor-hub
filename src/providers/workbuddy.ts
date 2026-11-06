/**
 * WorkBuddy - Tencent's CodeBuddy desktop agent, two builds:
 * `workbuddy` (copilot.tencent.com) and `workbuddy-ai` (www.workbuddy.ai).
 *
 * Header set and endpoint are the ones WorkBuddy's own desktop app sends and
 * magpie's `internal/provider/workbuddy_checkin.go` / `plugin_workbuddy.go`
 * probe:
 *
 *   resource summary  POST {endpoint}/billing/meter/get-user-resource-summary
 *
 * The daily 签到 event is driven by WorkBuddy's own plugin inside magpie
 * (`@magpie-community/opencode-workbuddy-auth`), whose paths this bundle does
 * not duplicate: the check-in card therefore reports that the vendor's own
 * plugin owns it instead of sending an unverified request.
 */

import type { AccountQuota, CheckinStatus, QuotaWindow } from '../types.ts'
import type { AccountRecord } from '../host/store.ts'
import type { VendorId } from '../types.ts'
import { AdapterFailure, checkinStatus, isoTimestamp, nowIso, requestRaw, windowOf, type VendorAdapter } from './base.ts'
import { asArray, asRecord, firstNum, firstStr } from '../host/http.ts'

interface Site {
  endpoint: string
  appName: string
  appVersion: string
  domain: string
}

const SITES: Record<string, Site> = {
  workbuddy: { endpoint: 'https://copilot.tencent.com', appName: 'workbuddy', appVersion: '5.9.3', domain: 'tencent.com' },
  'workbuddy-ai': { endpoint: 'https://www.workbuddy.ai', appName: 'workbuddy-ai', appVersion: '5.9.3', domain: 'workbuddy.ai' },
}

function headers(account: AccountRecord, site: Site): Record<string, string> {
  const token = account.secret['token'] ?? ''
  const uid = account.secret['uid'] ?? ''
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'x-user-id': uid,
    'x-domain': site.domain,
    'x-product': 'SaaS',
    'x-ide-type': 'WorkBuddy',
    'x-ide-name': 'WorkBuddy',
    'x-ide-version': site.appVersion,
    'x-agent-intent': 'craft',
    'x-agent-purpose': 'conversation',
    'x-requested-with': 'XMLHttpRequest',
    'user-agent': `WorkBuddy/${site.appVersion}`,
  }
}

function siteOf(vendor: VendorId): Site {
  const site = SITES[vendor]
  if (site === undefined) throw new AdapterFailure({ code: 'unsupported', message: `未知的 WorkBuddy 站点：${vendor}` })
  return site
}

/** POST one billing/meter endpoint; the envelope is `{code,msg,data}`. */
async function postMeter(
  account: AccountRecord,
  vendor: VendorId,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const site = siteOf(vendor)
  const result = await requestRaw(`${site.endpoint}${path}`, {
    method: 'POST',
    headers: headers(account, site),
    body: JSON.stringify(body),
  })
  if (!result.ok) {
    throw new AdapterFailure({
      code: result.status === 401 || result.status === 403 ? 'unauthorized' : 'unknown',
      message: `WorkBuddy ${path} 读取失败：HTTP ${result.status} ${result.text.slice(0, 200)}`,
    })
  }
  const root = asRecord(result.json)
  const data = asRecord(root['data'] ?? root['result'] ?? root)
  return Object.keys(data).length > 0 ? data : root
}

// The packages' codes, exactly as WorkBuddy's own client lists them; the API
// refuses a package detail request without them (10001 "PackageCodes required").
const CODE = (index: string, salt: string): string => `TCACA_code_${index}_${salt}`
const DAILY_CODE = CODE('001', 'PqouKr6QWV')
const PAID_CODES = [
  CODE('002', 'AkiJS3ZHF5'),
  CODE('005', 'maRGyrHhw1'),
  CODE('003', 'FAnt7lcmRT'),
  CODE('023', '4xbGhMrE6q'),
  CODE('026', 'BaESVICNoi'),
  CODE('027', '0FCGVA6vSa'),
  CODE('043', '6oIkxT7Z0S'),
  CODE('009', '0XmEQc2xOf'),
  CODE('038', 'OhvqZtiPKr'),
  CODE('036', 'lupO5WgNdG'),
]
const FREE_CODES = [
  DAILY_CODE,
  CODE('008', 'cfWoLwvjU4'),
  CODE('035', 'ArVxJcGDsm'),
  CODE('006', 'DbXS0lrypC'),
  CODE('039', 'KRcQj7wUat'),
  CODE('040', 'mi9rCYg46x'),
  CODE('007', 'nzdH5h4Nl0'),
  CODE('028', 'NtpWi0jzXs'),
  CODE('037', 'WxOD3MpI2o'),
  CODE('029', '6wCGEWquYy'),
  CODE('030', 'BjSt89qTvr'),
]
/** A slice package (CapacityType 4) is refreshed every day; the day is UTC+8. */
const SLICE = '4'

/** WorkBuddy's own clock: the free packages are sliced by the Beijing day. */
function beijingDay(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
}

function amountOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Every package holding credits, paid and free. A free account has no `Packages`
 * in its summary at all - its numbers only appear here, through the daily slice
 * package (`TCACA_code_001_*`), which the vendor refreshes at Beijing midnight.
 */
async function fetchPackages(
  account: AccountRecord,
  vendor: VendorId,
): Promise<Record<string, unknown>[]> {
  const day = beijingDay()
  const lists: Array<{ path: string; extra: Record<string, unknown> }> = [
    {
      path: '/billing/meter/get-user-resource-paid-packages',
      extra: { PackageCodes: PAID_CODES, NeedRenewInfo: true },
    },
    {
      path: '/billing/meter/get-user-resource-free-packages',
      extra: {
        PackageCodes: FREE_CODES,
        SlicePeriodStartTime: `${day} 00:00:00`,
        SlicePeriodEndTime: `${day} 23:59:59`,
      },
    },
  ]
  const out: Record<string, unknown>[] = []
  for (const list of lists) {
    try {
      const data = await postMeter(account, vendor, list.path, {
        PageNumber: 1,
        PageSize: 200,
        Status: [0, 3],
        ...list.extra,
      })
      for (const row of asArray(data['Accounts'])) out.push(asRecord(row))
    } catch {
      // One list failing must not lose the other.
    }
  }
  return out
}

/** A package's window: its cycle capacity, or its day's slice when it is one. */
function windowOfPackage(pkg: Record<string, unknown>): QuotaWindow | null {
  const capacityType = firstStr(pkg['CapacityType'])
  const slice = capacityType === SLICE ? asRecord(asArray(pkg['SlicePeriodUsageDetails'])[0]) : {}
  const total =
    amountOf(slice['SlicePeriodCapacitySizePrecise']) ?? amountOf(pkg['CycleTotalCapacity'])
  const remaining =
    amountOf(slice['SlicePeriodCapacityRemainPrecise']) ?? amountOf(pkg['CycleRemainCapacity'])
  const used = amountOf(pkg['CycleUsedCapacity'])
  if (total === null && remaining === null && used === null) return null
  const name = firstStr(pkg['PackageName'], pkg['CommodityName'], pkg['PackageCode']) || 'Credits'
  const expiresAt = isoTimestamp(pkg['DeductionEndTime'] ?? pkg['ExpireTime'] ?? pkg['CycleEndTime'])
  return windowOf({
    name,
    unit: 'credits',
    total,
    used: used ?? (total !== null && remaining !== null ? total - remaining : null),
    remaining,
    ...(expiresAt !== null ? { expiresAt } : {}),
    ...(capacityType === SLICE ? { note: '按天重置（北京时间 0 点）' } : {}),
  })
}

/** Read the account's resource summary (the vendor's own allowance page). */
async function fetchSummary(account: AccountRecord, vendor: VendorId): Promise<Record<string, unknown>> {
  const site = siteOf(vendor)
  const result = await requestRaw(`${site.endpoint}/billing/meter/get-user-resource-summary`, {
    method: 'POST',
    headers: headers(account, site),
    body: '{}',
  })
  if (!result.ok) {
    throw new AdapterFailure({
      code: result.status === 401 || result.status === 403 ? 'unauthorized' : 'unknown',
      message: `WorkBuddy 资源汇总读取失败：HTTP ${result.status} ${result.text.slice(0, 200)}`,
    })
  }
  const root = asRecord(result.json)
  const data = asRecord(root['data'] ?? root['result'] ?? root)
  return Object.keys(data).length > 0 ? data : root
}

/** Collect credit windows from whichever block the summary carries. */
function windowsOf(summary: Record<string, unknown>): QuotaWindow[] {
  const windows: QuotaWindow[] = []
  const blocks: unknown[] = [
    summary['credits'],
    summary['resourceSummary'],
    summary['resources'],
    summary['meters'],
    summary['list'],
  ]
  for (const block of blocks) {
    for (const item of asArray(block)) {
      const record = asRecord(item)
      const total = firstNum(record['total'], record['limit'], record['totalAmount'], record['quota'])
      const used = firstNum(record['used'], record['usedAmount'], record['consumed'])
      const remaining = firstNum(record['remaining'], record['remain'], record['balance'], record['left'])
      if (total === null && used === null && remaining === null) continue
      windows.push(
        windowOf({
          name: firstStr(record['name'], record['resourceName'], record['type']) || 'Credits',
          unit: 'credits',
          total,
          used,
          remaining,
          resetsAt: isoTimestamp(record['resetAt'] ?? record['reset_at'] ?? record['cycleEnd']),
          expiresAt: isoTimestamp(record['expireAt'] ?? record['expiresAt']),
        }),
      )
    }
  }
  if (windows.length === 0) {
    const total = firstNum(summary['totalCredits'], summary['creditTotal'], summary['creditsTotal'])
    const used = firstNum(summary['usedCredits'], summary['creditUsed'])
    const remaining = firstNum(summary['remainingCredits'], summary['creditRemaining'], summary['creditsRemaining'])
    if (total !== null || used !== null || remaining !== null) {
      windows.push(windowOf({ name: 'Credits', unit: 'credits', total, used, remaining }))
    }
  }
  return windows
}

/** The answer both check-in methods give: the vendor's own plugin owns it. */
function ownPluginCheckin(): CheckinStatus {
  return checkinStatus({
    outcome: 'skipped',
    message:
      'WorkBuddy 的签到事件由 magpie 侧的 @magpie-community/opencode-workbuddy-auth 插件执行；' +
      '本插件不复制它未公开的签到端点，请在 magpie 的 WorkBuddy 卡片上签到，或让该插件自动执行。',
  })
}

function createAdapter(vendor: VendorId): VendorAdapter {
  return {
    id: vendor,

    async readQuota(account: AccountRecord): Promise<AccountQuota> {
      const summary = await fetchSummary(account, vendor)
      const windows: QuotaWindow[] = []
      // A free account's numbers live in its packages, not in the summary.
      for (const pkg of await fetchPackages(account, vendor)) {
        const window = windowOfPackage(pkg)
        if (window !== null) windows.push(window)
      }
      if (windows.length === 0) windows.push(...windowsOf(summary))
      const isPaid = summary['IsPaidUser'] === true
      const named = firstStr(summary['SubscriptionPackageName'], summary['plan'], summary['planName'])
      const plan = named.length > 0 ? named : isPaid ? 'Pro' : '免费账号'
      if (windows.length === 0) {
        // Neither the summary nor any package carries a number: the vendor does
        // not publish a free allowance. Say that, rather than fail the read.
        return {
          account: account.account ?? '',
          plan,
          windows: [],
          balance: null,
          fetchedAt: nowIso(),
        }
      }
      return {
        account: account.account ?? '',
        plan,
        windows,
        balance: null,
        fetchedAt: nowIso(),
      }
    },

    async readCheckin(): Promise<CheckinStatus> {
      return ownPluginCheckin()
    },

    async claimCheckin(): Promise<CheckinStatus> {
      return ownPluginCheckin()
    },
  }
}

export const workbuddyAdapter = createAdapter('workbuddy')
export const workbuddyAiAdapter = createAdapter('workbuddy-ai')