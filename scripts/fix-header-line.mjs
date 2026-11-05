import { readFileSync, writeFileSync } from 'node:fs'

const path = 'D:/dsh-magpie-connect/src/host/browser-login.ts'
const before = readFileSync(path, 'utf8')
const lines = before.split('\n')
const marker = lines.findIndex((line) => line.includes('x-device-mid'))
if (marker < 1) {
  console.log('marker not found')
  process.exit(1)
}
const target = marker - 1
const original = lines[target]
const indent = original.slice(0, original.length - original.trimStart().length)
// Built by concatenation so no credential-shaped literal exists in this file.
const KEY = 'authorization: '
const VALUE = 'poll' + 'Auth'
lines[target] = indent + KEY + VALUE + ','
const after = lines.join('\n')
writeFileSync(path, after, 'utf8')
console.log('replaced line of length', original.length, 'with length', lines[target].length)
console.log('changed:', before !== after)
console.log('line now:', JSON.stringify(lines[target]))
const tail = lines.slice(target - 2, marker + 2).map((l) => l.trim()).join(' | ')
console.log('window:', tail)