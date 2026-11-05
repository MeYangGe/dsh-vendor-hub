/**
 * Trae CN (trae.cn) - ByteDance's AI IDE.
 *
 * Endpoints and headers are the ones magpie's own Trae plugin sends
 * (`@magpie-community/opencode-trae-auth`, mirrored in magpie's
 * `internal/provider/trae_checkin.go`):
 *
 *   check-in status  GET  https://api.trae.cn/trae/api/v2/ug/checkin_credits/status
 *   check-in claim   POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim
 *   credits usage    POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage
 *
 * Requests carry `Authorization: Cloud-IDE-JWT <token>` plus the IDE's device
 * headers; `Cloud-IDE-JWT` is the prefix Trae's own client uses (a bearer
 * scheme there is refused).
 *
 * Field names inside those answers are not part of any published contract, so
 * every read tries the spellings Trae's IDE and the community relays have been
 * seen to use and reports the vendor's own words when none matches.
 */

import type { AccountQuota, CheckinStatus, QuotaWindow } from '../types.ts'
import type { AccountRecord } from '../host/store.ts'
import { AdapterFailure, checkinStatus, isoTimestamp, nowIso, requestRaw, windowOf, type VendorAdapter } from './base.ts'
import { asArray, asRecord, firstNum, firstStr, str } from '../host/http.ts'

const HOST = 'https://api.trae.cn'
const STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status'
const CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim'
const USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage'

const APP_VERSION = '0.1.69'
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Trae/${APP_VERSION} Chrome/128.0.0.0 Safari/537.36`

function headers(account: AccountRecord): Record<string, string> {
  const token = account.secret['token'] ?? ''
  const deviceId = account.secret['deviceId']?.trim()
  return {
    'content-type': 'application/json',
    authorization: `Cloud-IDE-JWT ${token}`,
    'user-agent': UA,
    // The plugin's own made-up device is fine for reads; Trae's 9074 refusal on
    // a claim is a vendor-side device check, reported rather than worked around.
    'x-device-id': deviceId && deviceId.length > 0 ? deviceId : fallbackDeviceId(account.id),
    'x-device-brand': 'Trae',
    'x-device-type': 'Windows',
    'x-os-version': '10.0.22631',
    'x-app-version': APP_VERSION,
  }
}

/** A stable 15-digit device id derived from the account, as the relays send. */
function fallbackDeviceId(seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 1_000_000_000_000_000
  }
  return String(hash).padStart(15, '0').slice(0, 15)
}

/** Unwrap Trae's `{code, message, data}` envelope, or explain a refusal. */
function unwrap(payload: unknown, what: string): Record<string, unknown> {
  const root = asRecord(payload)
  const code = firstStr(root['code'], root['status'], root['errCode'])
  const message = firstStr(root['message'], root['msg'], root['message_'])
  if (code.length > 0 && code !== '0' && code !== '200' && code.toLowerCase() !== 'ok') {
    throw new AdapterFailure({
      code: /9074|9095/.test(code) ? 'unsupported' : 'unknown',
      message: `Trae 拒绝${what}：${message || code}（code ${code}）`,
    })
  }
  const data = root['data'] ?? root['result'] ?? root
  return asRecord(data)
}

function boolOf(record: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') {
      const text = value.toLowerCase()
      if (text === 'true' || text === '1' || text === 'yes') return true
      if (text === 'false' || text === '0' || text === 'no') return false
    }
  }
  return null
}

const CLAIMABLE_KEYS = ['claimable', 'can_checkin', 'canCheckin', 'canClaim', 'can_claim', 'available']
const DONE_KEYS = ['checked_in', 'checkedIn', 'has_checkin', 'hasCheckin', 'signed', 'finished', 'claimed', 'is_checked']

async function readStatus(account: AccountRecord): Promise<Record<string, unknown>> {
  const result = await requestRaw(`${HOST}${STATUS_PATH}`, { method: 'GET', headers: headers(account) })
  if (!result.ok) {
    throw new AdapterFailure({
      code: result.status === 401 || result.status === 403 ? 'unauthorized' : 'unknown',
      message: `Trae 签到状态读取失败：HTTP ${result.status} ${result.text.slice(0, 160)}`,
    })
  }
  return unwrap(result.json, '签到状态查询')
}

async function readUsage(account: AccountRecord): Promise<Record<string, unknown>> {
  const result = await requestRaw(`${HOST}${USAGE_PATH}`, {
    method: 'POST',
    headers: headers(account),
    body: JSON.stringify({ require_usage: true, req_source: 0 }),
  })
  if (!result.ok) {
    throw new AdapterFailure({
      code: result.status === 401 || result.status === 403 ? 'unauthorized' : 'unknown',
      message: `Trae 用量读取失败：HTTP ${result.status} ${result.text.slice(0, 160)}`,
    })
  }
  return unwrap(result.json, '用量查询')
}

/** Pull a credits block out of whatever shape the usage page returned. */
function creditsOf(usage: Record<string, unknown>): Record<string, unknown> {
  const direct = asRecord(usage['credits'] ?? usage['credit'] ?? usage['ent_usage'] ?? usage['usage'])
  if (Object.keys(direct).length > 0) return direct
  const nested = asArray(usage['list'])[0]
  return asRecord(nested)
}

export const traeCnAdapter: VendorAdapter = {
  id: 'trae-cn',

  async readQuota(account: AccountRecord): Promise<AccountQuota> {
    const started = Date.now()
    const usage = await readUsage(account)
    const credits = creditsOf(usage)
    const unlimited = boolOf(credits, ['unlimited', 'is_unlimited']) === true
    const total = firstNum(credits['limit'], credits['total'], credits['total_credits'], credits['package_limit'])
    const used = firstNum(credits['used'], credits['used_credits'], credits['consumed'])
    const remaining = firstNum(credits['remain'], credits['remaining'], credits['available'], credits['left'])

    const windows: QuotaWindow[] = []
    if (unlimited) {
      windows.push(windowOf({ name: '额度', unit: 'credits', total: null, used, remaining: null, unlimited: true }))
    } else if (total !== null || remaining !== null) {
      windows.push(
        windowOf({
          name: 'Credits',
          unit: 'credits',
          total,
          used,
          remaining,
          resetsAt: isoTimestamp(credits['reset_at'] ?? credits['resetAt'] ?? credits['expire_at']),
          expiresAt: isoTimestamp(credits['expire_at'] ?? credits['expires_at'] ?? credits['end_at']),
        }),
      )
    }
    const plan = firstStr(usage['plan'], usage['plan_name'], credits['plan'], credits['plan_name'])
    const account_ = firstStr(usage['user'], usage['uid'], credits['user'])
    if (windows.length === 0) {
      throw new AdapterFailure({
        code: 'parse_failed',
        message: `Trae 用量响应里没有认出额度字段：${JSON.stringify(usage).slice(0, 300)}`,
      })
    }
    return {
      account: account_ || account.account || '',
      plan: plan || (boolOf(usage, ['is_credits_billing']) === true ? 'Credits' : 'Free'),
      windows,
      balance: null,
      fetchedAt: nowIso(),
    }
  },

  async readCheckin(account: AccountRecord): Promise<CheckinStatus> {
    const status = await readStatus(account)
    const claimable = boolOf(status, CLAIMABLE_KEYS)
    const done = boolOf(status, DONE_KEYS)
    const streak = firstNum(status['streak'], status['days'], status['continuous_days'], status['checked_days'])
    const amount = firstNum(status['credits'], status['reward'], status['reward_credits'], status['amount'])
    const amountText = amount !== null ? `${amount} Credits` : null
    // A vendor that answers the claimable question answers it either way: `false`
    // means today is not open for this account (usually already claimed), which
    // is a conclusion, not a missing field.
    if (claimable === true) {
      return checkinStatus({ outcome: 'eligible', message: '今日签到可领取', amount: amountText, streak })
    }
    if (claimable === false) {
      return checkinStatus({
        outcome: 'already',
        message: done === true ? '今日已签到' : '上游报告当前不可领取（通常为今日已签或未到窗口）',
        amount: amountText,
        streak,
      })
    }
    if (done === true) {
      return checkinStatus({ outcome: 'already', message: '今日已签到', amount: amountText, streak })
    }
    return checkinStatus({
      outcome: 'no_window',
      message: `Trae 未报告可领取状态：${JSON.stringify(status).slice(0, 240)}`,
      streak,
    })
  },

  async claimCheckin(account: AccountRecord): Promise<CheckinStatus> {
    const result = await requestRaw(`${HOST}${CLAIM_PATH}`, {
      method: 'POST',
      headers: headers(account),
      body: '{}',
    })
    if (!result.ok) {
      const said = result.text.slice(0, 200)
      const refused = /9074/.test(said)
      return checkinStatus({
        outcome: 'failed',
        message: refused
          ? `Trae 拒绝本次签到（9074 当前参与用户太多）；每日签到这个账号今日不再重试。${said}`
          : `Trae 签到失败：HTTP ${result.status} ${said}`,
      })
    }
    const root = asRecord(result.json)
    const code = firstStr(root['code'], root['status'], root['errCode'])
    const message = firstStr(root['message'], root['msg'])
    const ok = code.length === 0 || code === '0' || code === '200' || code.toLowerCase() === 'ok'
    if (!ok) {
      return checkinStatus({ outcome: 'failed', message: `Trae 签到被拒：${message || code}（code ${code}）` })
    }
    const data = asRecord(root['data'] ?? root['result'] ?? root)
    const amount = firstNum(data['credits'], data['reward'], data['amount'])
    const streak = firstNum(data['streak'], data['days'], data['continuous_days'])
    return checkinStatus({
      outcome: 'claimed',
      message: '签到成功',
      amount: amount !== null ? `${amount} Credits` : null,
      streak,
    })
  },
}

/** Exposed so the host can tell "no credential" from "vendor refused". */
export function traeTokenOf(account: AccountRecord): string {
  return str(account.secret['token'])
}