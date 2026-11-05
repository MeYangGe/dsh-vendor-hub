/**
 * Wrap the built browser bundle into the harness's module container.
 *
 * The harness loads a plugin's browser half by evaluating
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... return exports } })
 *
 * so the built CommonJS body is placed inside that factory, with `module` and
 * `exports` supplied by the wrapper. `react` and friends stay external and are
 * resolved through the loader's own `require`.
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const lib = join(root, 'lib')
const source = join(lib, 'client.raw.cjs')
const target = join(lib, 'client.js')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

if (!existsSync(source)) {
  console.error(`postbuild: 缺少构建产物 ${source}，先跑 tsdown`)
  process.exit(1)
}

const body = readFileSync(source, 'utf8')
const wrapped = `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
${body}
return module.exports;
}
});
`

writeFileSync(target, wrapped, 'utf8')
rmSync(source, { force: true })

// The host bundle must also be reachable at the path package.json advertises.
const hostBundle = join(lib, 'index.js')
if (!existsSync(hostBundle)) {
  console.error('postbuild: 缺少 lib/index.js')
  process.exit(1)
}

console.log(`postbuild: lib/client.js ${wrapped.length} 字节 · lib/index.js 就绪`)