/**
 * Read one Qoder account's allowance through the real adapter, against the live
 * vendor, using the credential already on disk. Prints the windows, never the
 * credential.
 */

import { readFileSync } from 'node:fs'
import { qoderCnAdapter } from '../src/providers/qoder.ts'

const dataDir = 'D:/Program Files/DeepSeek Harness Data/dsh-home/magpie-connect'
const book = JSON.parse(readFileSync(dataDir + '/accounts.json', 'utf8'))
const accounts = Array.isArray(book) ? book : (book.accounts ?? [])
const target = accounts.find((entry) => String(entry.vendor) === 'qoder-cn')
if (!target) {
  console.log('no qoder-cn account')
  process.exit(0)
}

const quota = await qoderCnAdapter.readQuota(target)
console.log('plan:', quota.plan ?? '(none)')
console.log('fetchedAt:', quota.fetchedAt)
for (const window of quota.windows) {
  const pct = window.total !== null && window.total > 0 ? (((window.remaining ?? 0) / window.total) * 100).toFixed(1) : '?'
  console.log(
    `  ${window.name.padEnd(18)} total=${window.total ?? '—'} used=${window.used ?? '—'} remaining=${window.remaining ?? '—'} unit=${window.unit} left=${pct}%${window.expiresAt ? ' expires=' + window.expiresAt : ''}${window.note ? ' · ' + window.note : ''}`,
  )
}