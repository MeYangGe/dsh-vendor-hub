/**
 * ZCode (zcode.z.ai) - Z.ai's / BigModel's GLM Coding Plan.
 *
 * The subscription read is the one magpie's own ZCode plugin makes
 * (`packages/zcode/index.mjs`, `plan()`):
 *
 *   subscriptions  GET {root}/api/biz/subscription/list   (Authorization: Bearer <key>)
 *
 * where `<root>` is https://api.z.ai for a Z.ai account and https://bigmodel.cn
 * for a BigModel one. A subscription with `status === "VALID"` is the live plan
 * and its `productName` names the tier.
 *
 * ZCode's gift-plan check-in runs inside magpie on a 30-minute recheck; this
 * bundle does not repeat that sweep and says so on the card.
 */

import type { AccountQuota, CheckinStatus, QuotaWindow } from '../types.ts'
import type { AccountRecord } from '../host/store.ts'
import { AdapterFailure, checkinStatus, isoTimestamp, nowIso, requestRaw, windowOf, type VendorAdapter } from './base.ts'
import { asArray, asRecord, firstNum, firstStr } from '../host/http.ts'

const ROOTS: Record<string, string> = {
  zai: 'https://api.z.ai',
  bigmodel: 'https://bigmodel.cn',
}

function rootOf(account: AccountRecord): string {
  const site = (account.secret['site'] ?? 'zai').trim().toLowerCase()
  return ROOTS[site] ?? ROOTS['zai']!
}

function headers(account: AccountRecord): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${account.secret['token'] ?? ''}`,
    'set-language': 'zh',
  }
}

interface Subscription {
  productName: string
  status: string
  startsAt: string | null
  endsAt: string | null
  raw: Record<string, unknown>
}

function subscriptionsOf(payload: unknown): Subscription[] {
  const root = asRecord(payload)
  const list = asArray(root['data'] ?? root['subscriptions'] ?? payload)
  const out: Subscription[] = []
  for (const item of list) {
    const record = asRecord(item)
    const status = firstStr(record['status'])
    if (status.length === 0) continue
    out.push({
      productName: firstStr(record['productName'], record['product_name'], record['plan_name']),
      status,
      startsAt: isoTimestamp(record['starts_at'] ?? record['startsAt']),
      endsAt: isoTimestamp(record['ends_at'] ?? record['endsAt']),
      raw: record,
    })
  }
  return out
}

async function fetchSubscriptions(account: AccountRecord): Promise<Subscription[]> {
  const result = await requestRaw(`${rootOf(account)}/api/biz/subscription/list`, {
    method: 'GET',
    headers: headers(account),
  })
  if (!result.ok) {
    throw new AdapterFailure({
      code: result.status === 401 || result.status === 403 ? 'unauthorized' : 'unknown',
      message: `ZCode 套餐读取失败：HTTP ${result.status} ${result.text.slice(0, 200)}`,
    })
  }
  if (result.json === undefined) {
    throw new AdapterFailure({ code: 'parse_failed', message: `ZCode 套餐响应不是 JSON：${result.text.slice(0, 160)}` })
  }
  return subscriptionsOf(result.json)
}

export const zcodeAdapter: VendorAdapter = {
  id: 'zcode',

  async readQuota(account: AccountRecord): Promise<AccountQuota> {
    const subscriptions = await fetchSubscriptions(account)
    const live = subscriptions.find((entry) => entry.status.toUpperCase() === 'VALID') ?? subscriptions[0]
    if (live === undefined) {
      throw new AdapterFailure({ code: 'unsupported', message: 'ZCode 账号下没有读到任何套餐' })
    }
    const windows: QuotaWindow[] = []
    // A plan's own credit buckets ride along on some answers; when they do not,
    // the window still tells the user what the plan covers and when it lapses.
    for (const item of asArray(live.raw['balances'] ?? live.raw['balance'] ?? live.raw['quotas'])) {
      const record = asRecord(item)
      const total = firstNum(record['total'], record['limit'], record['amount'])
      const used = firstNum(record['used'], record['consumed'])
      const remaining = firstNum(record['remaining'], record['balance'], record['left'])
      if (total === null && used === null && remaining === null) continue
      windows.push(
        windowOf({
          name: firstStr(record['name'], record['type']) || live.productName || 'GLM Plan',
          unit: 'credits',
          total,
          used,
          remaining,
          expiresAt: isoTimestamp(record['expires_at'] ?? record['expireAt']),
        }),
      )
    }
    if (windows.length === 0) {
      windows.push(
        windowOf({
          name: live.productName || 'GLM Coding Plan',
          unit: 'credits',
          total: null,
          used: null,
          remaining: null,
          expiresAt: live.endsAt,
          note: 'ZCode 未在该接口返回额度数，只报告套餐有效期',
        }),
      )
    }
    return {
      account: account.account ?? '',
      plan: live.productName || null,
      windows,
      balance: null,
      fetchedAt: nowIso(),
    }
  },

  async readCheckin(): Promise<CheckinStatus> {
    return giftPlanCheckin()
  },

  async claimCheckin(): Promise<CheckinStatus> {
    return giftPlanCheckin()
  },
}

/** ZCode's gift-plan claim is magpie's 30-minute recheck, not this plugin's. */
function giftPlanCheckin(): CheckinStatus {
  return checkinStatus({
    outcome: 'skipped',
    message:
      'ZCode 的赠礼/签到计划由 magpie 侧每 30 分钟复查并领取，本插件不重复执行；' +
      '如遇验证码或需要本机 App 确认，请到 magpie 的 ZCode 卡片处理。',
  })
}