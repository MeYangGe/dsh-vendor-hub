/**
 * Preflight for the desktop profile manifest.
 *
 * The Host parses `profiles/desktop/package.json` with a bare `JSON.parse`, so a
 * leading UTF-8 BOM (EF BB BF) kills startup with
 * `SyntaxError: Unexpected token '﻿', "﻿{...` before any plugin loads.
 * Windows PowerShell 5.1 writes exactly that BOM from `Set-Content -Encoding UTF8`
 * / `Out-File -Encoding utf8`, so any script that rewrites the manifest can
 * reintroduce it.
 *
 * This script is idempotent: with no BOM it only validates the JSON.
 *
 *   node scripts/ensure-profile.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Candidate DSH homes, first existing wins: the env var, then the usual installs. */
function resolveHome() {
  const env = process.env['DSH_HOME']?.trim()
  const candidates = [
    ...(env ? [env] : []),
    'D:/Program Files/DeepSeek Harness Data/dsh-home',
    'C:/Program Files/DeepSeek Harness Data/dsh-home',
    join(process.env['ProgramFiles'] ?? 'C:/Program Files', 'DeepSeek Harness Data', 'dsh-home'),
  ]
  return candidates.find((path) => existsSync(join(path, 'profiles', 'desktop'))) ?? candidates[0]
}

const manifest = join(resolveHome(), 'profiles', 'desktop', 'package.json')

if (!existsSync(manifest)) {
  console.log(`ensure-profile: 跳过，未找到 ${manifest}`)
  process.exit(0)
}

const buf = readFileSync(manifest)
const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
const body = hasBom ? buf.subarray(3) : buf

try {
  JSON.parse(body.toString('utf8'))
} catch (error) {
  console.error(`ensure-profile: ${manifest} 不是合法 JSON - ${error.message}`)
  process.exit(1)
}

if (!hasBom) {
  console.log('ensure-profile: package.json 无 BOM，JSON 正常')
  process.exit(0)
}

writeFileSync(manifest, body)
console.log('ensure-profile: 已去掉 package.json 的 UTF-8 BOM')
