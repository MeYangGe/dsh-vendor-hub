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
      const windows = windowsOf(summary)
      if (windows.length === 0) {
        throw new AdapterFailure({
          code: 'parse_failed',
          message: `WorkBuddy 资源汇总里没有认出额度字段：${JSON.stringify(summary).slice(0, 300)}`,
        })
      }
      const plan = firstStr(summary['plan'], summary['planName'], summary['productName'])
      return {
        account: account.account ?? '',
        plan: plan.length > 0 ? plan : null,
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