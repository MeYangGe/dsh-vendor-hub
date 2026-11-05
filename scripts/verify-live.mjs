/**
 * Post-restart live check.
 *
 * Run this after the DSH desktop app has restarted with the plugin installed.
 * It asks the running harness for the plugin's status route and prints enough to
 * tell "loaded and serving" from "not loaded" without opening the GUI.
 *
 *   node scripts/verify-live.mjs
 *   node scripts/verify-live.mjs --port 55444
 */

const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const port = portIndex >= 0 && args[portIndex + 1] ? args[portIndex + 1] : '55444'
const base = `http://127.0.0.1:${port}`
const route = '/plugins/dsh-magpie-connect/status'

async function main() {
  let response
  try {
    response = await fetch(`${base}${route}`)
  } catch (error) {
    console.log(`✗ 连不上 ${base}：${error.message}`)
    console.log('  桌面端没有在跑，或者端口不是这个（用 --port 指定）。')
    process.exitCode = 2
    return
  }

  if (response.status === 404) {
    console.log(`✗ ${base}${route} → 404：路由没有挂上，插件未被加载。`)
    console.log('  检查：profiles/desktop/package.json 的 dependencies + dsh.profile.bundles 是否含 dsh-magpie-connect，')
    console.log('        以及 node_modules/dsh-magpie-connect 是否已链接（pnpm install 是否成功）。')
    console.log('  改完需要重启桌面端。')
    process.exitCode = 1
    return
  }

  if (!response.ok) {
    console.log(`✗ ${base}${route} → HTTP ${response.status}`)
    console.log((await response.text()).slice(0, 400))
    process.exitCode = 1
    return
  }

  const doc = await response.json()
  console.log(`✓ 插件已加载并serving（HTTP 200）`)
  console.log(`  schema       ${doc.schema}`)
  console.log(`  version      ${doc.version}`)
  console.log(`  已保存账号   ${doc.accounts.length}`)
  console.log(`  供应商数     ${doc.totals.vendors}`)
  console.log(`  读数成功     ${doc.totals.readOk}`)
  console.log(`  剩余 Credits ${doc.totals.creditsLeft === null ? '—' : doc.totals.creditsLeft}`)
  console.log(`  今日可签到   ${doc.totals.checkinClaimable}`)
  console.log(`  自动签到     ${doc.scheduler.enabled ? '开' : '关'} · 下次 ${doc.scheduler.nextAt ?? '待定'}`)
  if (doc.problems.length > 0) {
    console.log('  待处理：')
    for (const line of doc.problems) console.log(`    - ${line}`)
  }
  console.log('')
  console.log('  侧栏底部应出现 Magpie 额度卡；点它打开三页控制台（概览 / 供应商 / 签到中心）。')
}

await main()