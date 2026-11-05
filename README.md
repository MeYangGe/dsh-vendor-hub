# DSH Magpie Connect

把多家编码套餐供应商的**额度、用量与每日签到**收进 DeepSeek Harness 的一个控制台 —— 侧栏额度卡 + 用量概览 + 签到中心。界面语言与信息层级参考 [magpie](https://github.com/yetone/magpie) 的 Web UI，概览页对齐它的「用量 → 概览」。

> 本插件**不接管模型路由**。模型仍走你在 DSH 里已经配好的网关 provider（例如 magpie 网关）；这里只负责「我还有多少额度、今天签到了没有」。

## 三块界面

| 位置 | 内容 |
|---|---|
| 侧栏底部卡片 | 每家供应商一条最紧的额度条 + 剩余合计 + 待签到徽标；56px 窄栏塌缩成一个图标 |
| 中间面板 · 概览 | KPI 瓦片（剩余 Credits / 已保存账号 / 今日可签 / 今日已签）+ 每个账号的额度窗口进度条 + 签到流水 + 待处理问题 |
| 中间面板 · 供应商 | 7 家供应商的凭证本：粘贴、校验、删除；已保存账号只显示备注名与打码账号，密钥永不回显 |
| 中间面板 · 签到中心 | 自动签到开关、签到时刻（Asia/Shanghai）、刷新间隔、每账号状态、完整签到日志 |

## 支持的供应商与实现状态

诚实标注 —— 未确证的接口一律不猜数字，卡片会直接说明原因：

| 供应商 | 额度读取 | 每日签到 | 端点依据 |
|---|---|---|---|
| Qoder 国内版 / 国际版 | ✗ 额度查询接口无公开契约，**不猜额度**；签到与活动奖励可用 | ✓ `me/campaigns` + `{id}/claim` | magpie `internal/provider/qoder_checkin.go` |
| WorkBuddy 国内版 / 国际版 | △ `billing/meter/get-user-resource-summary`（字段按候选键解析，读不出会给出原始片段） | ✗ 由 magpie 的 `@magpie-community/opencode-workbuddy-auth` 负责，本插件不复刻其未公开端点 | magpie `workbuddy_checkin.go` |
| Trae 国内版 | ✓ `pay/ide_user_ent_usage` | ✓ `ug/checkin_credits/status` + `/claim` | magpie `packages/trae` |
| ZCode（GLM 编码套餐） | △ `api/biz/subscription/list`（拿到套餐与有效期；上游若不给额度数则如实标注） | ✗ 由 magpie 每 30 分钟复查赠送计划 | magpie `packages/zcode` |
| CodeArts（华为云码道） | ✗ 积分批次接口路径未公开 | ✓ `ops/delivery` + `ops/claim` + `ops/confirm`（SDK-HMAC-SHA256 签名） | magpie `packages/codearts` |

规则：**能读到就读，读不到就说清楚缺什么**，绝不显示编出来的数字。

## 安装

```bash
# 在 DSH 里（桌面端 plugins 页或 CLI）
dsh plugin --profile desktop add github:<你的账号>/dsh-magpie-connect
# 或本地目录
dsh plugin --profile desktop add D:/dsh-magpie-connect
```

插件声明了 `dsh.bundle.patch`，安装时自动挂载 `cordis.patch.yml`；无 LLM provider，不需要改默认模型。

## 数据落盘

全部在 `<DSH_HOME>/magpie-connect/`（可用 `DSH_MAGPIE_CONNECT_DATA_DIR` 覆盖）：

| 文件 | 内容 |
|---|---|
| `accounts.json`（0600） | 凭证本；密钥仅此一处 |
| `settings.json` | 自动签到开关、签到时刻、轮询间隔、每账号开关、隐藏列表 |
| `cache.json` | 最近一次额度与签到结论 |
| `checkin-log.json` | 滚动签到日志（上限 400 条） |

## 工程结构

```
src/
  index.ts              Host 入口：路由挂载 + 每日签到调度器
  types.ts              前后端共享契约（Node-free）
  vendors.ts            7 家供应商元数据（站点 / 凭证字段 / 是否支持签到）
  host/
    paths.ts            数据目录与原子写
    http.ts             有界请求 + 供应商错误分类
    store.ts            凭证本 / 设置 / 缓存 / 日志
    engine.ts           额度读取、签到执行、状态文档、时区换算
    routes.ts           7 条 HTTP 路由（写操作同源校验）
  providers/
    base.ts             适配器契约
    qoder.ts  workbuddy.ts  trae.ts  zcode.ts  codearts.ts
  client/
    index.tsx           注册 slots：sidebar.footer.action / main / settings.plugins.tab
    store.ts            共享状态 + 单一轮询（页面隐藏时暂停）
    styles.ts           magpie 风格样式表（mmp- 前缀）
    Panel.tsx  Overview.tsx  Providers.tsx  Checkin.tsx  QuotaCard.tsx
    parts.tsx           进度条 / 状态胶囊 / 供应商徽记
tests/
  smoke.mjs             源码级端到端：账号 / 额度解析 / 签到幂等 / 路由 / 时区
  host-load.mjs         构建产物级：按宿主契约加载 lib/index.js 并跑 7 条路由
```

## 开发

```bash
pnpm install
pnpm run typecheck     # host + client 两套 tsconfig
pnpm run build         # tsdown 双产物 + postbuild 包一层 __ModuleLoader__
node tests/smoke.mjs
node tests/host-load.mjs
```

`lib/client.js` 由 `scripts/postbuild.mjs` 包成 `window.__ModuleLoader__.load({ id, factory })`，与宿主加载社区插件的方式一致。

## 设计取舍

- **不猜端点**。社区插件里没有公开契约的接口（Qoder 额度、CodeArts 积分批次、WorkBuddy 签到事件）不会被"试一下看看"，而是明确返回 `unsupported` 并把上游原始片段附在消息里，方便对照真实响应校准。
- **签到幂等**。同一账号同一北京日只结案一次；手动按按钮才会重新问上游。每条尝试（含拒绝）都进日志。
- **凭证只进不出**。任何 HTTP 响应、日志、状态文档都不含密钥；`accounts.json` 单独 0600。
- **写操作同源**。`Origin` 必须与 `Host` 一致，否则 403；非浏览器调用只接受回环 Host。

## License

MIT