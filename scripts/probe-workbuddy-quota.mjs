/**
 * Probe WorkBuddy's billing surface with the signed-in credential on disk, to
 * see whether any endpoint reports an allowance for a free account.
 */

import { readFileSync } from 'node:fs'

const dataDir = 'D:/Program Files/DeepSeek Harness Data/dsh-home/magpie-connect'
const book = JSON.parse(readFileSync(dataDir + '/accounts.json', 'utf8'))
const accounts = Array.isArray(book) ? book : (book.accounts ?? [])
const target = accounts.find((entry) => String(entry.vendor) === 'workbuddy')
if (!target) {
  console.log('no workbuddy account')
  process.exit(0)
}

const secret = target.secret ?? {}
const token = String(secret.token ?? '')
const domain = String(secret.domain ?? '')
console.log('token length:', token.length, '· domain:', domain || '(none)')

const sites = [
  { name: 'CN', endpoint: 'https://copilot.tencent.com' },
  { name: 'AI', endpoint: 'https://www.workbuddy.ai' },
]

const base = {
  accept: 'application/json',
  'content-type': 'application/json',
  'user-agent': 'WorkBuddy/5.9.3',
  authorization: 'Bearer ' + token,
  ...(domain ? { 'x-domain': domain } : {}),
}

const paths = [
  '/billing/meter/get-user-resource-summary',
  '/billing/meter/get-user-resource-summary?platform=workbuddy',
  '/v2/plugin/usage',
  '/billing/meter/get-user-resource-usage',
  '/v2/plugin/login/account',
]

for (const site of sites) {
  for (const path of paths) {
    try {
      const response = await fetch(site.endpoint + path, { headers: base, signal: AbortSignal.timeout(15000) })
      const text = await response.text()
      const short = text.length > 240 ? text.slice(0, 240) + '…' : text
      console.log(`\n[${site.name}] ${path} -> ${response.status}`)
      console.log('  ', short)
    } catch (error) {
      console.log(`\n[${site.name}] ${path} -> ERR ${error.message}`)
    }
  }
}