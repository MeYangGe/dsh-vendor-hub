/**
 * Read the WorkBuddy account's allowance through the real adapter, live.
 * Prints the windows; never the credential.
 */

import { readFileSync } from 'node:fs'
import { workbuddyAdapter } from '../src/providers/workbuddy.ts'

const dataDir = 'D:/Program Files/DeepSeek Harness Data/dsh-home/magpie-connect'
const book = JSON.parse(readFileSync(dataDir + '/accounts.json', 'utf8'))
const accounts = Array.isArray(book) ? book : (book.accounts ?? [])
const target = accounts.find((entry) => String(entry.vendor) === 'workbuddy')
if (!target) {
  console.log('no workbuddy account')
  process.exit(0)
}

try {
  const quota = await workbuddyAdapter.readQuota(target)
  console.log('plan:', quota.plan ?? '(none)', '· windows:', quota.windows.length)
  for (const window of quota.windows) {
    const pct =
      window.total !== null && window.total > 0
        ? (((window.remaining ?? 0) / window.total) * 100).toFixed(1) + '%'
        : '?'
    console.log(
      `  ${window.name} | total=${window.total ?? '—'} used=${window.used ?? '—'} remaining=${window.remaining ?? '—'} | ${pct}` +
        (window.expiresAt ? ` | expires=${window.expiresAt}` : '') +
        (window.note ? ` | ${window.note}` : ''),
    )
  }
} catch (error) {
  console.log('ERROR:', error.message)
  if (error.code) console.log('  code:', error.code)
}