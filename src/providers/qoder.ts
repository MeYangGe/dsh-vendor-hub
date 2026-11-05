/**
 * Qoder (China: qoder.com.cn, International: qoder.com) - one adapter built per
 * site, differing only in the openapi host.
 *
 * The check-in endpoint is the one magpie's own Qoder check-in uses
 * (`internal/provider/qoder_checkin.go`):
 *
 *   campaigns  GET  {openapi}/sash/api/v1/me/campaigns
 *   claim      POST {openapi}/sash/api/v1/me/campaigns/{campaignId}/claim
 *
 * A campaign with `actionType === "CLAIM_BENEFIT"` is the day's credits; the
 * server decides which of an account's campaigns can be claimed.
 *
 * Qoder's allowance figures come from its subscriber/quota API, which no
 * published contract covers and which this bundle therefore does not guess at:
 * when the campaigns answer carries no quota block the card says so plainly
 * instead of inventing a number.
 */

import type { AccountQuota, CheckinStatus, QuotaWindow } from '../types.ts'
import type { AccountRecord } from '../host/store.ts'
import type { VendorId } from '../types.ts'
import { AdapterFailure, checkinStatus, isoTimestamp, nowIso, requestRaw, windowOf, type VendorAdapter } from './base.ts'
import { asArray, asRecord, firstNum, firstStr, num } from '../host/http.ts'

const HOSTS: Record<string, string> = {
  'qoder-cn': 'https://openapi.qoder.com.cn',
  'qoder-global': 'https://openapi.qoder.sh',
}

const SITES: Record<string, string> = {
  'qoder-cn': 'qoder.com.cn',
  'qoder-global': 'qoder.com',
}

function headers(account: AccountRecord, site: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${account.secret['token'] ?? ''}`,
    'user-agent': `Qoder/1.1.77 (${site})`,
    'x-requested-with': 'XMLHttpRequest',
  }
}

interface Campaign {
  id: string
  actionType: string
  claimStatus: string
  startAt: number | null
  endAt: number | null
  benefit: Record<string, unknown>
  raw: Record<string, unknown>
}

function campaignsOf(payload: unknown): Campaign[] {
  const root = asRecord(payload)
  const list = asArray(root['campaigns'] ?? root['data'] ?? root['items'] ?? payload)
  const out: Campaign[] = []
  for (const item of list) {
    const record = asRecord(item)
    const id = firstStr(record['campaignId'], record['id'], record['campaign_id'])
    if (id.length === 0) continue
    out.push({
      id,
      actionType: firstStr(record['actionType'], record['action_type']),
      claimStatus: firstStr(record['claimStatus'], record['claim_status'], record['status']),
      startAt: num(record['startAt'] ?? record['start_at']),
      endAt: num(record['endAt'] ?? record['end_at']),
      benefit: asRecord(record['benefit'] ?? record['reward']),
      raw: record,
    })
  }
  return out
}

function within(campaign: Campaign): boolean {
  const now = Date.now() / 1000
  const start = campaign.startAt
  const end = campaign.endAt
  if (start !== null && start > 0 && now < start) return false
  if (end !== null && end > 0 && now > end) return false
  return true
}

function benefitText(campaign: Campaign): string | null {
  const credits = firstNum(
    campaign.benefit['credits'],
    campaign.benefit['amount'],
    campaign.benefit['value'],
    campaign.benefit['creditAmount'],
  )
  if (credits !== null) return `${credits} Credits`
  const name = firstStr(campaign.benefit['name'], campaign.benefit['title'], campaign.benefit['description'])
  return name.length > 0 ? name : null
}

async function fetchCampaigns(account: AccountRecord, vendor: VendorId): Promise<Campaign[]> {
  const host = HOSTS[vendor]
  const site = SITES[vendor] ?? ''
  if (host === undefined) throw new AdapterFailure({ code: 'unsupported', message: `未知的 Qoder 站点：${vendor}` })
  const result = await requestRaw(`${host}/sash/api/v1/me/campaigns`, { method: 'GET', headers: headers(account, site) })
  if (!result.ok) {
    throw new AdapterFailure({
      code: result.status === 401 || result.status === 403 ? 'unauthorized' : 'unknown',
      message: `Qoder campaigns 读取失败：HTTP ${result.status} ${result.text.slice(0, 200)}`,
    })
  }
  if (result.json === undefined) {
    throw new AdapterFailure({ code: 'parse_failed', message: `Qoder campaigns 响应不是 JSON：${result.text.slice(0, 160)}` })
  }
  return campaignsOf(result.json)
}

/** Pull an allowance window out of a response, when the vendor sent one. */
function quotaWindowsOf(payload: unknown): QuotaWindow[] {
  const root = asRecord(payload)
  const candidates = [root['userQuota'], root['orgResourcePackage'], root['addOnQuota'], root['quota']]
  const windows: QuotaWindow[] = []
  for (const candidate of candidates) {
    const record = asRecord(candidate)
    if (Object.keys(record).length === 0) continue
    const total = firstNum(record['total'], record['totalQuota'], record['limit'])
    const used = firstNum(record['used'], record['usedQuota'])
    const remaining = firstNum(record['remaining'], record['remain'], record['available'])
    if (total === null && used === null && remaining === null) continue
    windows.push(
      windowOf({
        name: firstStr(record['name'], record['packageName']) || 'Quota',
        unit: 'credits',
        total,
        used,
        remaining,
        expiresAt: isoTimestamp(record['expiresAt'] ?? record['expireAt']),
      }),
    )
  }
  return windows
}

function createAdapter(vendor: VendorId): VendorAdapter {
  return {
    id: vendor,

    async readQuota(account: AccountRecord): Promise<AccountQuota> {
      const campaigns = await fetchCampaigns(account, vendor)
      // The campaigns answer sometimes carries the account's quota alongside;
      // when it does, use it. When it does not, say so rather than guess.
      const rawPayload = { campaigns: campaigns.map((campaign) => campaign.raw) }
      const windows = quotaWindowsOf(rawPayload)
      if (windows.length === 0) {
        throw new AdapterFailure({
          code: 'unsupported',
          message:
            'Qoder 的额度查询接口没有公开契约，本插件只读取到活动信息，不猜额度。' +
            '签到与活动奖励仍可正常使用；额度请在 Qoder 客户端或 magpie 查看。',
        })
      }
      return {
        account: account.account ?? '',
        plan: null,
        windows,
        balance: null,
        fetchedAt: nowIso(),
      }
    },

    async readCheckin(account: AccountRecord): Promise<CheckinStatus> {
      const campaigns = await fetchCampaigns(account, vendor)
      const benefit = campaigns.filter((campaign) => campaign.actionType === 'CLAIM_BENEFIT')
      if (benefit.length === 0) {
        return checkinStatus({ outcome: 'ineligible', message: 'Qoder 当前没有可领取的签到活动' })
      }
      const open = benefit.filter(within)
      const claimable = open.filter((campaign) => {
        const status = campaign.claimStatus.toLowerCase()
        return status === '' || status.includes('claimable') || status === 'unclaimed' || status === 'pending'
      })
      const claimed = open.filter((campaign) => campaign.claimStatus.toLowerCase().includes('claimed'))
      if (claimable.length > 0) {
        const next = claimable[0]!
        return checkinStatus({
          outcome: 'eligible',
          message: '今日签到可领取',
          amount: benefitText(next),
          nextAt: isoTimestamp(next.endAt),
        })
      }
      if (claimed.length > 0) {
        const done = claimed[0]!
        return checkinStatus({
          outcome: 'already',
          message: '今日签到已领取',
          amount: benefitText(done),
        })
      }
      return checkinStatus({ outcome: 'no_window', message: 'Qoder 的签到活动当前不在领取窗口内' })
    },

    async claimCheckin(account: AccountRecord): Promise<CheckinStatus> {
      const host = HOSTS[vendor]
      const site = SITES[vendor] ?? ''
      const campaigns = await fetchCampaigns(account, vendor)
      const target = campaigns
        .filter((campaign) => campaign.actionType === 'CLAIM_BENEFIT' && within(campaign))
        .find((campaign) => {
          const status = campaign.claimStatus.toLowerCase()
          return status === '' || status.includes('claimable') || status === 'unclaimed' || status === 'pending'
        })
      if (target === undefined) {
        return checkinStatus({ outcome: 'already', message: 'Qoder 今日没有可领取的签到' })
      }
      const result = await requestRaw(`${host}/sash/api/v1/me/campaigns/${encodeURIComponent(target.id)}/claim`, {
        method: 'POST',
        headers: headers(account, site),
        body: '{}',
      })
      if (!result.ok) {
        return checkinStatus({
          outcome: 'failed',
          message: `Qoder 签到失败：HTTP ${result.status} ${result.text.slice(0, 200)}`,
        })
      }
      return checkinStatus({
        outcome: 'claimed',
        message: '签到成功',
        amount: benefitText(target),
      })
    },
  }
}

export const qoderCnAdapter = createAdapter('qoder-cn')
export const qoderGlobalAdapter = createAdapter('qoder-global')