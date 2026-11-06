/**
 * Print what WorkBuddy's package endpoints actually answer for this account, so
 * a "no quota" result can be told apart from a wrong request.
 */

import { readFileSync } from 'node:fs'

const dataDir = 'D:/Program Files/DeepSeek Harness Data/dsh-home/magpie-connect'
const book = JSON.parse(readFileSync(dataDir + '/accounts.json', 'utf8'))
const accounts = Array.isArray(book) ? book : (book.accounts ?? [])
const target = accounts.find((entry) => String(entry.vendor) === 'workbuddy')
const secret = target?.secret ?? {}
const token = String(secret.token ?? '')
const uid = String(secret.uid ?? '')
const domain = String(secret.domain ?? 'www.workbuddy.cn')

const CODE = (index, salt) => `TCACA_code_${index}_${salt}`
const PAID_CODES = [
  CODE('002', 'AkiJS3ZHF5'), CODE('005', 'maRGyrHhw1'), CODE('003', 'FAnt7lcmRT'),
  CODE('023', '4xbGhMrE6q'), CODE('026', 'BaESVICNoi'), CODE('027', '0FCGVA6vSa'),
  CODE('043', '6oIkxT7Z0S'), CODE('009', '0XmEQc2xOf'), CODE('038', 'OhvqZtiPKr'),
  CODE('036', 'lupO5WgNdG'),
]
const FREE_CODES = [
  CODE('001', 'PqouKr6QWV'), CODE('008', 'cfWoLwvjU4'), CODE('035', 'ArVxJcGDsm'),
  CODE('006', 'DbXS0lrypC'), CODE('039', 'KRcQj7wUat'), CODE('040', 'mi9rCYg46x'),
  CODE('007', 'nzdH5h4Nl0'), CODE('028', 'NtpWi0jzXs'), CODE('037', 'WxOD3MpI2o'),
  CODE('029', '6wCGEWquYy'), CODE('030', 'BjSt89qTvr'),
]

const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
console.log('beijing day:', day, '· token length:', token.length, '· uid:', uid ? uid.slice(0, 8) + '…' : '(none)')

const headers = {
  accept: 'application/json',
  'content-type': 'application/json',
  authorization: 'Bearer ' + token,
  'x-user-id': uid,
  'x-domain': domain,
  'x-product': 'SaaS',
  'x-ide-type': 'WorkBuddy',
  'x-ide-name': 'WorkBuddy',
  'x-ide-version': '5.9.3',
  'x-agent-intent': 'craft',
  'x-agent-purpose': 'conversation',
  'x-requested-with': 'XMLHttpRequest',
  'user-agent': 'WorkBuddy/5.9.3',
}

const calls = [
  ['/billing/meter/get-user-resource-summary', {}],
  ['/billing/meter/get-user-resource-paid-packages', { PageNumber: 1, PageSize: 200, Status: [0, 3], PackageCodes: PAID_CODES, NeedRenewInfo: true }],
  ['/billing/meter/get-user-resource-free-packages', { PageNumber: 1, PageSize: 200, Status: [0, 3], PackageCodes: FREE_CODES, SlicePeriodStartTime: `${day} 00:00:00`, SlicePeriodEndTime: `${day} 23:59:59` }],
]

for (const [path, body] of calls) {
  try {
    const response = await fetch('https://copilot.tencent.com' + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
    const text = await response.text()
    console.log(`\n${path} -> ${response.status} (${text.length} bytes)`)
    if (text.includes('Accounts')) {
      const parsed = JSON.parse(text)
      const rows = parsed?.data?.Accounts ?? parsed?.Accounts ?? []
      console.log('  Accounts:', rows.length)
      if (rows.length > 0) {
        console.log('  first row keys:', Object.keys(rows[0]).join(', '))
        console.log('  first row:', JSON.stringify(rows[0]).slice(0, 500))
      }
    } else {
      console.log('  ', text.slice(0, 400))
    }
  } catch (error) {
    console.log(`\n${path} -> ERR ${error.message}`)
  }
}