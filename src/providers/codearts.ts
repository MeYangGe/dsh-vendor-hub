/**
 * CodeArts (华为云码道代码智能体) - Huawei Cloud's coding agent.
 *
 * Requests are signed with temporary AK/SK/security-token credentials using
 * Huawei's SDK-HMAC-SHA256 scheme; the host and the daily-benefit endpoints are
 * the ones magpie's own CodeArts plugin uses (`packages/codearts/index.mjs`):
 *
 *   daily benefits  GET  https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/delivery?channel=IDE
 *   claim           POST https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/claim
 *   confirm         POST https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/confirm
 *
 * The activity this plugin calls the daily check-in is the `USER_LOGIN` item of
 * the activity list (「限时福利 → 每日领取」); an item already in CLAIMED /
 * CONFIRMED / CONSUMED is today's benefit, received.
 *
 * The credit-batch page path is not published either, so the allowance card
 * reports what the activity list says and refuses to invent a total.
 */

import { createHash, createHmac } from 'node:crypto'
import type { AccountQuota, CheckinStatus, QuotaWindow } from '../types.ts'
import type { AccountRecord } from '../host/store.ts'
import { AdapterFailure, checkinStatus, nowIso, requestRaw, type VendorAdapter } from './base.ts'
import { asArray, asRecord, firstStr, str } from '../host/http.ts'

const SNAP_HOST = 'https://snap-access.cn-north-4.myhuaweicloud.com'
const DELIVERY_PATH = '/v1/ops/delivery?channel=IDE'
const CLAIM_PATH = '/v1/ops/claim'
const CONFIRM_PATH = '/v1/ops/confirm'
const DAILY_TYPE = 'USER_LOGIN'
const CLAIMED_STATUSES = ['CLAIMED', 'CONFIRMED', 'CONSUMED']

/** Hong Kong / Beijing style signing timestamp. */
function sdkDate(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hmacHex(key: string, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex')
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())
}

/**
 * Build the headers Huawei's SDK-HMAC-SHA256 expects. The canonical request uses
 * `host` as the only signed header, which is what the plain SDK signer emits.
 */
function signedHeaders(account: AccountRecord, method: string, urlStr: string, body: string): Record<string, string> {
  const ak = account.secret['ak'] ?? ''
  const sk = account.secret['sk'] ?? ''
  const securityToken = account.secret['token'] ?? ''
  if (ak.length === 0 || sk.length === 0) {
    throw new AdapterFailure({ code: 'no_credential', message: 'CodeArts 需要 Access Key 与 Secret Key' })
  }
  const url = new URL(urlStr)
  const canonicalUri = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  const params = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const canonicalQuery = params.map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&')
  const canonicalHeaders = `host:${url.host}\n`
  const signed = 'host'
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signed,
    sha256Hex(body),
  ].join('\n')
  const stamp = sdkDate()
  const stringToSign = ['SDK-HMAC-SHA256', stamp, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmacHex(sk, stringToSign)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    host: url.host,
    'x-sdk-date': stamp,
    authorization: `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signed}, Signature=${signature}`,
    'agent-type': 'PromptCenter',
    'x-language': 'zh-cn',
  }
  if (securityToken.length > 0) headers['x-security-token'] = securityToken
  return headers
}

interface ActivityItem {
  id: string
  type: string
  status: string
  claimable: boolean
  raw: Record<string, unknown>
}

async function fetchActivities(account: AccountRecord): Promise<{ items: ActivityItem[]; raw: unknown }> {
  const url = `${SNAP_HOST}${DELIVERY_PATH}`
  const result = await requestRaw(url, { method: 'GET', headers: signedHeaders(account, 'GET', url, '') })
  if (!result.ok) {
    throw new AdapterFailure({
      code: result.status === 401 || result.status === 403 ? 'unauthorized' : 'unknown',
      message: `CodeArts 活动列表读取失败：HTTP ${result.status} ${result.text.slice(0, 200)}`,
    })
  }
  const root = asRecord(result.json)
  const data = asRecord(root['data'] ?? root)
  const items: ActivityItem[] = []
  for (const entry of asArray(data['items'] ?? data['list'])) {
    const record = asRecord(entry)
    items.push({
      id: firstStr(record['id'], record['deliveryId'], record['activityId']),
      type: firstStr(record['type'], record['activityType']),
      status: firstStr(record['status']).toUpperCase(),
      claimable: record['claimable'] === true,
      raw: record,
    })
  }
  return { items, raw: result.json }
}

function post(account: AccountRecord, path: string, body: Record<string, unknown>) {
  const url = `${SNAP_HOST}${path}`
  const text = JSON.stringify(body)
  return requestRaw(url, { method: 'POST', headers: signedHeaders(account, 'POST', url, text), body: text })
}

export const codeartsAdapter: VendorAdapter = {
  id: 'codearts',

  async readQuota(): Promise<AccountQuota> {
    throw new AdapterFailure({
      code: 'unsupported',
      message:
        'CodeArts 的积分批次接口（package/credit/page）路径未公开，本插件不猜数额。' +
        '签到状态与每日领取可用，额度请在华为云 CodeArts 控制台查看。',
    })
  },

  async readCheckin(account: AccountRecord): Promise<CheckinStatus> {
    const { items } = await fetchActivities(account)
    const daily = items.find((item) => item.type === DAILY_TYPE)
    if (daily === undefined) {
      return checkinStatus({ outcome: 'ineligible', message: 'CodeArts 活动列表里没有每日领取项（USER_LOGIN）' })
    }
    if (daily.claimable) return checkinStatus({ outcome: 'eligible', message: 'CodeArts 今日奖励可领取' })
    if (CLAIMED_STATUSES.includes(daily.status)) {
      return checkinStatus({ outcome: 'already', message: 'CodeArts 今日奖励已领取', amount: daily.status })
    }
    return checkinStatus({
      outcome: 'no_window',
      message: `CodeArts 未报告可领取：status=${daily.status || '(空)'} claimable=${String(daily.claimable)}`,
    })
  },

  async claimCheckin(account: AccountRecord): Promise<CheckinStatus> {
    const { items } = await fetchActivities(account)
    const daily = items.find((item) => item.type === DAILY_TYPE)
    if (daily === undefined) return checkinStatus({ outcome: 'ineligible', message: 'CodeArts 无每日领取项' })
    if (CLAIMED_STATUSES.includes(daily.status) && !daily.claimable) {
      return checkinStatus({ outcome: 'already', message: 'CodeArts 今日奖励已领取' })
    }
    const claim = await post(account, CLAIM_PATH, {
      deliveryId: daily.id,
      activityId: daily.id,
      type: DAILY_TYPE,
      channel: 'IDE',
    })
    if (!claim.ok) {
      return checkinStatus({
        outcome: 'failed',
        message: `CodeArts 领取失败：HTTP ${claim.status} ${claim.text.slice(0, 200)}`,
      })
    }
    const claimRoot = asRecord(claim.json)
    const claimData = asRecord(claimRoot['data'] ?? claimRoot)
    const claimId = firstStr(claimData['claimId'], claimData['id'], claimData['deliveryId'])
    if (claimId.length > 0) {
      // The IDE confirms the claim as a second step; ignore its failure but keep
      // the claim itself, which already succeeded.
      await post(account, CONFIRM_PATH, { claimId, id: claimId, channel: 'IDE' }).catch(() => undefined)
    }
    return checkinStatus({ outcome: 'claimed', message: 'CodeArts 签到成功' })
  },
}

/** Exposed for diagnostics: which key the account signs with. */
export function codeartsAccessKeyOf(account: AccountRecord): string {
  return str(account.secret['ak'])
}