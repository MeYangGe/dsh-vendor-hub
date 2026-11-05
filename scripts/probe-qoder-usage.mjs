/**
 * One-off evidence probe: does Qoder's usage page answer the token we already
 * have on disk? Prints only the shape - never the credential.
 */

import { readFileSync } from 'node:fs'

const dataDir = 'D:/Program Files/DeepSeek Harness Data/dsh-home/magpie-connect'
const book = JSON.parse(readFileSync(dataDir + '/accounts.json', 'utf8'))

const accounts = Array.isArray(book) ? book : (book.accounts ?? [])
const target = accounts.find((entry) => String(entry.vendor).includes('qoder'))
if (!target) {
  console.log('no qoder account on disk')
  process.exit(0)
}

const secret = target.secret ?? {}
console.log('secret keys:', Object.keys(secret).join(', ') || '(none)')

const hosts = { 'qoder-cn': 'https://openapi.qoder.com.cn', 'qoder-global': 'https://openapi.qoder.sh' }
const host = hosts[target.vendor]
const device = String(secret.deviceToken ?? secret.token ?? '')
console.log('vendor:', target.vendor, '· token length:', device.length)

const headers = {
  accept: 'application/json',
  authorization: 'Bearer ' + device,
  'cosy-clienttype': '10',
  'user-agent': 'Qoder',
}

for (const path of ['/sash/api/v2/me/usage', '/sash/api/v1/me/campaigns']) {
  try {
    const response = await fetch(host + path, { headers, signal: AbortSignal.timeout(20000) })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    console.log(`\n${path} -> HTTP ${response.status}`)
    if (body && typeof body === 'object') {
      console.log('  top keys:', Object.keys(body).slice(0, 12).join(', '))
      const usage = body.qoderUsage ?? body.qoder_usage
      if (usage && typeof usage === 'object') {
        console.log('  qoderUsage keys:', Object.keys(usage).join(', '))
        for (const [key, value] of Object.entries(usage)) {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            console.log(`    ${key}:`, Object.keys(value).join(', '))
          }
        }
      }
      if (body.displayMode) console.log('  displayMode:', body.displayMode)
    } else {
      console.log('  body:', text.slice(0, 160))
    }
  } catch (error) {
    console.log(`${path} -> ERR ${error.message}`)
  }
}