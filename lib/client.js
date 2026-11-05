window.__ModuleLoader__.load({ id: "dsh-magpie-connect", factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
/** Base path of the plugin's own HTTP surface, shared by both halves. */
const ROUTE_BASE = "/plugins/dsh-magpie-connect";
/** Human label per check-in outcome, used by the log and the cards. */
const CHECKIN_OUTCOME_LABEL = {
	eligible: "可领取",
	claimed: "已领取",
	already: "今日已签",
	ineligible: "不满足条件",
	no_window: "未到签到时间",
	failed: "失败",
	skipped: "已跳过"
};
function trimNumber(value) {
	return (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1)).replace(/\.0$/, "");
}
/** Format a credit/token count the way the Overview tiles read it. */
function formatAmount(value) {
	if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
	const n = Math.abs(value);
	if (n >= 1e6) return trimNumber(value / 1e6) + "M";
	if (n >= 1e4) return trimNumber(value / 1e3) + "K";
	if (n >= 1e3) return Math.round(value).toLocaleString("zh-CN");
	if (n < 1 && n > 0) return trimNumber(value);
	return String(Math.round(value));
}
function clampPercent(value) {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}
/** Percentage left as an integer 0..100, or null when the window is opaque. */
function percentLeftOf(window) {
	if (window.unlimited) return 100;
	if (typeof window.percentLeft === "number" && Number.isFinite(window.percentLeft)) return clampPercent(window.percentLeft);
	if (window.total && window.total > 0 && window.remaining !== null) return clampPercent(window.remaining / window.total * 100);
	return null;
}
/** Worst-case (smallest) remaining share across an account's windows. */
function worstPercent(account) {
	const windows = account.quota?.windows ?? [];
	let worst = null;
	for (const window of windows) {
		const percent = percentLeftOf(window);
		if (percent === null) continue;
		if (worst === null || percent < worst) worst = percent;
	}
	return worst;
}
/** Accounts still claimable today, which the card surfaces as a badge. */
function claimableAccounts(status) {
	return status.accounts.filter((account) => account.checkinOn && account.checkin?.outcome === "eligible");
}
/** Days left until an ISO timestamp, rounded up; null when unbounded. */
function daysUntil(iso, now = Date.now()) {
	if (!iso) return null;
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return null;
	const days = Math.ceil((at - now) / 864e5);
	return Number.isFinite(days) ? days : null;
}
// src/client/store.ts
/**
* One shared store for every surface (sidebar card, panel, settings tab).
*
* A single ticker polls the Host's status route - paused while the document is
* hidden - and every surface subscribes through `useSyncExternalStore`. Writes
* go straight to the Host's routes and then refresh the store, so a card never
* renders a figure the Host did not just produce.
*/
let status = null;
let settings = null;
let readFailure = null;
let revision = 0;
let inflight = null;
let timer;
let subscribers = 0;
const listeners = /* @__PURE__ */ new Set();
function bump() {
	revision += 1;
	for (const listener of listeners) listener();
}
function subscribe(listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
function getRevision() {
	return revision;
}
async function getJson(path) {
	const response = await fetch(`${ROUTE_BASE}${path}`, { credentials: "same-origin" });
	if (!response.ok) {
		const body = await response.json().catch(() => void 0);
		const error = typeof body === "object" && body !== null && "error" in body ? String(body["error"]) : `HTTP ${response.status}`;
		throw new Error(error);
	}
	return await response.json();
}
async function postJson(path, body) {
	const response = await fetch(`${ROUTE_BASE}${path}`, {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	});
	const payload = await response.json().catch(() => void 0);
	if (!response.ok) {
		const error = typeof payload === "object" && payload !== null && "error" in payload ? String(payload["error"]) : `HTTP ${response.status}`;
		throw new Error(error);
	}
	return payload;
}
/** Read the status document; concurrent callers share one request. */
function loadStatus() {
	if (inflight !== null) return inflight;
	inflight = (async () => {
		try {
			status = await getJson("/status");
			readFailure = null;
		} catch (error) {
			readFailure = error.message;
		} finally {
			inflight = null;
			bump();
		}
	})();
	return inflight;
}
/** Read the settings document. */
async function loadSettings() {
	try {
		settings = await getJson("/settings");
		readFailure = null;
	} catch (error) {
		readFailure = error.message;
		return;
	} finally {
		bump();
	}
	retick();
}
/** Patch one settings field; resolves to the saved document. */
async function saveSettings(patch) {
	settings = await postJson("/settings", patch);
	bump();
	retick();
	await loadStatus();
}
/** Save a credential set; the Host validates by reading the account once. */
async function saveCredential(input) {
	await postJson("/auth", {
		action: "save",
		...input
	});
	await loadStatus();
}
async function removeCredential(id) {
	await postJson("/auth", {
		action: "remove",
		id
	});
	await loadStatus();
}
async function removeVendorCredentials(vendor) {
	await postJson("/auth", {
		action: "removeVendor",
		vendor
	});
	await loadStatus();
}
async function refreshOne(id) {
	await postJson("/refresh", id === void 0 ? {} : { id });
	await loadStatus();
}
async function checkinOne(id) {
	await postJson("/checkin", id === void 0 ? {} : {
		id,
		manual: true
	});
	await loadStatus();
}
async function clearLog() {
	await postJson("/log/clear", {});
	await loadStatus();
}
function intervalOf() {
	const configured = settings?.value.pollMs;
	return typeof configured === "number" && configured >= 6e4 ? configured : 3e5;
}
function stop() {
	if (timer !== void 0) {
		clearInterval(timer);
		timer = void 0;
	}
}
function start() {
	stop();
	timer = setInterval(() => {
		if (typeof document !== "undefined" && document.hidden) return;
		loadStatus();
	}, intervalOf());
}
/** Restart the ticker after the poll interval changed. */
function retick() {
	if (subscribers === 0) return;
	start();
}
/** Acquire the store for one surface; the ticker stops with the last one. */
function acquire() {
	subscribers += 1;
	if (subscribers === 1) {
		if (status === null) loadStatus();
		if (settings === null) loadSettings();
		start();
	}
	return () => {
		subscribers = Math.max(0, subscribers - 1);
		if (subscribers === 0) stop();
	};
}
/** Subscribe a component to the shared store. */
function useConnectStore() {
	const rev = (0, react.useSyncExternalStore)(subscribe, getRevision, getRevision);
	return {
		status,
		settings,
		revision: rev,
		failure: readFailure
	};
}
// src/vendors.ts
const PAT_FIELD = {
	key: "token",
	labelKey: "field.token",
	required: true,
	secret: true
};
const VENDORS = [
	{
		id: "qoder-cn",
		name: "Qoder 国内版",
		nameEn: "Qoder (China)",
		site: "qoder.com.cn",
		glyph: "Q",
		credential: {
			kind: "pat",
			hintKey: "hint.qoder-cn",
			fields: [{
				...PAT_FIELD,
				placeholder: "粘贴 qoder.com.cn 生成的 PAT"
			}]
		},
		checkin: true,
		unit: "credits",
		planHintKey: "plan.qoder"
	},
	{
		id: "qoder-global",
		name: "Qoder 国际版",
		nameEn: "Qoder Global",
		site: "qoder.com",
		glyph: "Q",
		credential: {
			kind: "pat",
			hintKey: "hint.qoder-global",
			fields: [{
				...PAT_FIELD,
				placeholder: "Paste the PAT generated on qoder.com"
			}]
		},
		checkin: true,
		unit: "credits",
		planHintKey: "plan.qoder"
	},
	{
		id: "workbuddy",
		name: "WorkBuddy 国内版",
		nameEn: "WorkBuddy (China)",
		site: "copilot.tencent.com",
		glyph: "W",
		credential: {
			kind: "token",
			hintKey: "hint.workbuddy",
			fields: [{
				key: "token",
				labelKey: "field.token",
				required: true,
				secret: true,
				placeholder: "accessToken（桌面端登录态）"
			}, {
				key: "uid",
				labelKey: "field.uid",
				required: false,
				placeholder: "账号 uid（可选，用于归属）"
			}]
		},
		checkin: true,
		unit: "credits",
		planHintKey: "plan.workbuddy"
	},
	{
		id: "workbuddy-ai",
		name: "WorkBuddy 国际版",
		nameEn: "WorkBuddy AI",
		site: "www.workbuddy.ai",
		glyph: "W",
		credential: {
			kind: "token",
			hintKey: "hint.workbuddy-ai",
			fields: [{
				key: "token",
				labelKey: "field.token",
				required: true,
				secret: true,
				placeholder: "access token"
			}, {
				key: "uid",
				labelKey: "field.uid",
				required: false,
				placeholder: "account uid (optional)"
			}]
		},
		checkin: false,
		unit: "credits",
		planHintKey: "plan.workbuddy-ai"
	},
	{
		id: "trae-cn",
		name: "Trae 国内版",
		nameEn: "Trae CN",
		site: "trae.cn",
		glyph: "T",
		credential: {
			kind: "token",
			hintKey: "hint.trae-cn",
			fields: [{
				key: "token",
				labelKey: "field.token",
				required: true,
				secret: true,
				placeholder: "Cloud-IDE-JWT"
			}, {
				key: "deviceId",
				labelKey: "field.deviceId",
				required: false,
				placeholder: "设备 id（可选）"
			}]
		},
		checkin: true,
		unit: "credits",
		planHintKey: "plan.trae"
	},
	{
		id: "zcode",
		name: "ZCode（GLM 编码套餐）",
		nameEn: "ZCode (GLM Coding Plan)",
		site: "zcode.z.ai",
		glyph: "Z",
		credential: {
			kind: "pat",
			hintKey: "hint.zcode",
			fields: [{
				key: "token",
				labelKey: "field.token",
				required: true,
				secret: true,
				placeholder: "API Key（zcode-api-key 的 secret）"
			}, {
				key: "site",
				labelKey: "field.site",
				required: false,
				placeholder: "zai 或 bigmodel（默认 zai）"
			}]
		},
		checkin: true,
		unit: "credits",
		planHintKey: "plan.zcode"
	},
	{
		id: "codearts",
		name: "CodeArts（华为云码道）",
		nameEn: "CodeArts (Huawei Cloud)",
		site: "codearts.huaweicloud.com",
		glyph: "C",
		credential: {
			kind: "keys",
			hintKey: "hint.codearts",
			fields: [
				{
					key: "ak",
					labelKey: "field.ak",
					required: true,
					secret: true,
					placeholder: "Access Key"
				},
				{
					key: "sk",
					labelKey: "field.sk",
					required: true,
					secret: true,
					placeholder: "Secret Key"
				},
				{
					key: "token",
					labelKey: "field.securityToken",
					required: false,
					secret: true,
					placeholder: "security-token（临时凭证才需要）"
				},
				{
					key: "projectId",
					labelKey: "field.projectId",
					required: false,
					placeholder: "项目 id（可选）"
				}
			]
		},
		checkin: true,
		unit: "credits",
		planHintKey: "plan.codearts"
	}
];
/** Lookup by id; undefined for an id the catalogue dropped. */
function vendorMeta(id) {
	return VENDORS.find((vendor) => vendor.id === id);
}
// src/client/parts.tsx
/** Colour band for a remaining share: roomy, getting low, nearly gone. */
function toneOf(percent) {
	if (percent === null) return "neutral";
	if (percent >= 50) return "good";
	if (percent >= 20) return "warn";
	return "bad";
}
function Pill({ tone = "neutral", children, title }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		className: "mmp-pill",
		"data-tone": tone,
		title,
		children
	});
}
function Glyph({ text }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		className: "mmp-glyph",
		children: text
	});
}
/** One allowance window: name/amount line, then a bar that drains. */
function Bar({ window, showReset = true }) {
	const percent = percentLeftOf(window);
	const tone = toneOf(percent);
	const left = window.unlimited ? "不限量" : formatAmount(window.remaining);
	const total = window.total === null ? "" : ` / ${formatAmount(window.total)}`;
	const reset = showReset ? resetText(window) : "";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "mmp-bar",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-bar-top",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: window.name }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mmp-grow" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
						left,
						total,
						percent === null ? "" : ` · ${Math.round(percent)}%`
					] })
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "mmp-bar-track",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "mmp-bar-fill",
					"data-tone": tone,
					style: { width: `${percent === null ? 0 : Math.max(2, Math.min(100, percent))}%` }
				})
			}),
			reset.length > 0 || window.note ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "mmp-bar-note",
				children: [reset, window.note].filter(Boolean).join(" · ")
			}) : null
		]
	});
}
function resetText(window) {
	const days = daysUntil(window.expiresAt);
	if (days !== null) return days <= 0 ? "已到期" : `${days} 天后到期`;
	if (window.resetsAt) {
		const at = new Date(window.resetsAt);
		if (Number.isFinite(at.getTime())) return `重置于 ${at.toLocaleString("zh-CN", {
			month: "numeric",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit"
		})}`;
	}
	return "";
}
/** A thin share bar with no label, for the sidebar card. */
function MiniBar({ percent }) {
	const tone = toneOf(percent);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		className: "mmp-share",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {
			"data-tone": tone,
			style: { width: `${percent === null ? 0 : Math.max(2, Math.min(100, percent))}%` }
		})
	});
}
// src/client/Overview.tsx
/**
* The Overview: magpie's Usage > Overview, for subscriptions instead of calls.
*
* KPI tiles lead with the number that matters (how much is left, how many
* accounts still need a check-in), then one row per account with a share bar
* and its allowance windows, then the accounts the user hid and the failures.
*/
function Overview(props) {
	const { status } = props;
	const [opened, setOpened] = (0, react.useState)({});
	const claimable = claimableAccounts(status);
	const hiddenSet = new Set(props.hidden);
	const totals = status.totals;
	const visible = status.accounts.filter((account) => !hiddenSet.has(account.id));
	const hiddenAccounts = status.accounts.filter((account) => hiddenSet.has(account.id));
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "mmp-panel",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-head",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: "mmp-title",
						children: "用量概览"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "mmp-sub",
						children: [
							status.accounts.length,
							" 个账号 · ",
							totals.vendors,
							" 家供应商"
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mmp-grow" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "mmp-btn",
						disabled: props.busy,
						onClick: props.onRefreshAll,
						children: props.busy ? "刷新中…" : "全部刷新"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "mmp-btn",
						"data-variant": "primary",
						disabled: props.busy,
						onClick: props.onCheckinAll,
						children: "全部签到"
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-tiles",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mmp-tile",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: totals.creditsLeft === null ? "—" : formatAmount(totals.creditsLeft) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "剩余 Credits" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: totals.creditsTotal === null ? "上游未给总额" : `共 ${formatAmount(totals.creditsTotal)}` })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mmp-tile",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: totals.signedIn }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "已保存账号" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
								totals.readOk,
								" 个读数成功 · ",
								totals.readFailed,
								" 个失败"
							] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mmp-tile",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: totals.checkinClaimable }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "今日可签到" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: claimable.length > 0 ? claimable.map((account) => account.label).join("、") : "没有待领取的" })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mmp-tile",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: totals.checkinClaimed }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "今日已签" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: totals.checkinFailed > 0 ? `${totals.checkinFailed} 个失败` : "无失败" })
						]
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-block",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "mmp-block-head",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "账号额度" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mmp-grow" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "mmp-sub",
							children: status.totals.updatedAt ? `更新于 ${stamp$1(status.totals.updatedAt)}` : "尚未读取"
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "mmp-block-body",
					children: visible.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "mmp-empty",
						children: "还没有账号。去「供应商」页粘贴第一份凭证 —— 保存时会立刻读一次额度。"
					}) : visible.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountRow, {
						account,
						open: opened[account.id] === true,
						onToggleOpen: () => setOpened((prev) => ({
							...prev,
							[account.id]: prev[account.id] !== true
						})),
						onRefresh: () => props.onRefreshOne(account.id),
						onCheckin: () => props.onCheckinOne(account.id),
						onToggleCheckin: (on) => props.onToggleCheckin(account.id, on),
						onHide: () => props.onToggleHidden(account.id, true),
						busy: props.busy
					}, account.id))
				})]
			}),
			hiddenAccounts.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-block",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "mmp-block-head",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							"已从概览隐藏（",
							hiddenAccounts.length,
							"）"
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mmp-grow" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "mmp-sub",
							children: "仍然照常读取与签到"
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "mmp-block-body",
					children: hiddenAccounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mmp-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Glyph, { text: vendorMeta(account.vendor)?.glyph ?? "?" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "mmp-who",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "mmp-name",
									children: account.label
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "mmp-meta",
									children: vendorMeta(account.vendor)?.name ?? account.vendor
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "mmp-btn",
								onClick: () => props.onToggleHidden(account.id, false),
								children: "取消隐藏"
							})
						]
					}, account.id))
				})]
			}) : null,
			status.log.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-block",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "mmp-block-head",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "签到记录" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mmp-grow" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "mmp-sub",
							children: [
								"最近 ",
								Math.min(status.log.length, 12),
								" 条"
							]
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "mmp-log",
					children: status.log.slice(0, 12).map((entry, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("time", { children: stamp$1(entry.at, true) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: entry.account }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: CHECKIN_OUTCOME_LABEL[entry.outcome] ?? entry.outcome }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "mmp-sub",
							children: entry.message
						})
					] }, `${entry.at}-${index}`))
				})]
			}) : null,
			status.problems.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-block",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "mmp-block-head",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "需要处理" })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "mmp-block-body",
					children: status.problems.map((problem, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "mmp-error",
						children: problem
					}, index))
				})]
			}) : null
		]
	});
}
function AccountRow(props) {
	const { account } = props;
	const meta = vendorMeta(account.vendor);
	const worst = worstPercent(account);
	const tone = toneOf(worst);
	const checkin = account.checkin;
	const checkinTone = checkin?.outcome === "claimed" || checkin?.outcome === "already" ? "good" : checkin?.outcome === "eligible" ? "accent" : checkin?.outcome === "failed" ? "bad" : "neutral";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "mmp-row",
		style: { cursor: "pointer" },
		onClick: props.onToggleOpen,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Glyph, { text: meta?.glyph ?? "?" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-who",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "mmp-name",
					children: [
						account.label,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
							tone: "neutral",
							children: meta?.name ?? account.vendor
						}),
						account.plan ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
							tone: "neutral",
							children: account.plan
						}) : null,
						checkin ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
							tone: checkinTone,
							children: CHECKIN_OUTCOME_LABEL[checkin.outcome] ?? checkin.outcome
						}) : null,
						account.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
							tone: "bad",
							children: account.error.code
						}) : null
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "mmp-meta",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: account.account || "未标注账号" }),
						account.quota?.windows.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							account.quota.windows.length,
							" 个额度窗口 · 最紧 ",
							worst === null ? "未知" : `${Math.round(worst)}% 剩余`
						] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: account.error ? "额度不可读" : "尚未读取" }),
						checkin?.amount ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: checkin.amount }) : null
					]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MiniBar, { percent: worst }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-num",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", {
					style: { color: tone === "bad" ? "var(--mmp-bad)" : tone === "warn" ? "var(--mmp-warn)" : void 0 },
					children: worst === null ? "—" : `${Math.round(worst)}%`
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: "剩余" })]
			})
		]
	}), props.open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "mmp-bar-group",
		style: { padding: "0 14px 12px" },
		children: [account.quota?.windows.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "mmp-bars",
			style: { padding: 0 },
			children: account.quota.windows.map((window, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Bar, { window }, `${window.name}-${index}`))
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "mmp-bar-note",
			children: account.error ? account.error.message : "这个账号还没有成功读取过额度。"
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "mmp-actions",
			style: { marginTop: 10 },
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "mmp-btn",
					disabled: props.busy,
					onClick: props.onRefresh,
					children: "读取额度"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "mmp-btn",
					"data-variant": "primary",
					disabled: props.busy || !account.checkinOn,
					onClick: props.onCheckin,
					children: "立即签到"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
					className: "mmp-field",
					style: {
						flexDirection: "row",
						alignItems: "center",
						gap: 6
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "checkbox",
						checked: account.checkinOn,
						onChange: (event) => props.onToggleCheckin(event.target.checked)
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "mmp-hint",
						children: "自动签到"
					})]
				}),
				account.ms ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "mmp-hint",
					children: [
						"上次读数 ",
						account.ms,
						" ms"
					]
				}) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mmp-grow" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "mmp-btn",
					onClick: props.onHide,
					children: "从概览隐藏"
				})
			]
		})]
	}) : null] });
}
function stamp$1(iso, withSeconds = false) {
	const at = new Date(iso);
	if (!Number.isFinite(at.getTime())) return iso;
	return at.toLocaleString("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		...withSeconds ? { second: "2-digit" } : {}
	});
}
// src/client/Providers.tsx
/**
* Providers: the credential book.
*
* One card per vendor, listing what is already saved for it and the exact fields
* its credential needs. A saved secret is never echoed back: the card only ever
* shows the label, the masked account and the local id's tail.
*/
function Providers(props) {
	const [openVendor, setOpenVendor] = (0, react.useState)(null);
	const [message, setMessage] = (0, react.useState)(null);
	const savedByVendor = /* @__PURE__ */ new Map();
	for (const account of props.accounts) {
		const list = savedByVendor.get(account.vendor) ?? [];
		list.push(account);
		savedByVendor.set(account.vendor, list);
	}
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "mmp-panel",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-head",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
					className: "mmp-title",
					children: "供应商"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "mmp-sub",
					children: [
						VENDORS.length,
						" 家 · 已保存 ",
						props.accounts.length,
						" 个账号"
					]
				})]
			}),
			message ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: message.bad ? "mmp-error" : "mmp-ok",
				style: { padding: "4px 0" },
				children: message.text
			}) : null,
			VENDORS.map((vendor) => {
				const saved = savedByVendor.get(vendor.id) ?? [];
				const open = openVendor === vendor.id;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "mmp-block",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mmp-block-head",
						style: { cursor: "pointer" },
						onClick: () => setOpenVendor(open ? null : vendor.id),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Glyph, { text: vendor.glyph }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									color: "var(--mmp-fg)",
									fontWeight: 600
								},
								children: vendor.name
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
								tone: "neutral",
								children: vendor.site
							}),
							vendor.checkin ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
								tone: "accent",
								children: "支持签到"
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mmp-grow" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "mmp-sub",
								children: saved.length > 0 ? `${saved.length} 个账号` : "未添加"
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "mmp-block-body",
						children: [saved.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "mmp-row",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "mmp-who",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "mmp-name",
									children: [
										account.label,
										account.plan ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
											tone: "neutral",
											children: account.plan
										}) : null,
										account.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
											tone: "bad",
											children: account.error.code
										}) : null
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "mmp-meta",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: account.account || "未标注账号" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["id …", account.id.slice(-6)] })]
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "mmp-btn",
								"data-variant": "danger",
								disabled: props.busy,
								onClick: async () => {
									try {
										await props.onRemove(account.id);
										setMessage({
											text: `已删除 ${account.label}`,
											bad: false
										});
									} catch (error) {
										setMessage({
											text: error.message,
											bad: true
										});
									}
								},
								children: "删除"
							})]
						}, account.id)), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CredentialForm, {
							vendor,
							busy: props.busy,
							onSave: async (input) => {
								try {
									await props.onSave(input);
									setMessage({
										text: `${vendor.name} 的凭证已保存，并已读取一次额度`,
										bad: false
									});
								} catch (error) {
									setMessage({
										text: error.message,
										bad: true
									});
									throw error;
								}
							},
							onRemoveVendor: async () => {
								try {
									await props.onRemoveVendor(vendor.id);
									setMessage({
										text: `已清除 ${vendor.name} 的全部凭证`,
										bad: false
									});
								} catch (error) {
									setMessage({
										text: error.message,
										bad: true
									});
								}
							}
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "mmp-empty",
							children: "点击标题展开，粘贴凭证"
						})]
					})]
				}, vendor.id);
			})
		]
	});
}
function CredentialForm(props) {
	const [label, setLabel] = (0, react.useState)("");
	const [account, setAccount] = (0, react.useState)("");
	const [values, setValues] = (0, react.useState)({});
	const [saving, setSaving] = (0, react.useState)(false);
	const fields = props.vendor.credential.fields;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "mmp-form",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "mmp-hint",
				children: hintOf(props.vendor)
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-field",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "备注名（可选，只存在本机）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					value: label,
					placeholder: "例如：主账号 / 备用",
					onChange: (event) => setLabel(event.target.value)
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-field",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "账号标识（可选，便于区分）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					value: account,
					placeholder: "邮箱或 uid",
					onChange: (event) => setAccount(event.target.value)
				})]
			}),
			fields.map((field) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-field",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [labelOf(field.labelKey), field.required ? " *" : ""] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					type: field.secret === false ? "text" : "password",
					value: values[field.key] ?? "",
					placeholder: field.placeholder ?? "",
					autoComplete: "off",
					spellCheck: false,
					onChange: (event) => setValues((prev) => ({
						...prev,
						[field.key]: event.target.value
					}))
				})]
			}, field.key)),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-actions",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "mmp-btn",
					"data-variant": "primary",
					disabled: props.busy || saving,
					onClick: async () => {
						setSaving(true);
						try {
							await props.onSave({
								vendor: props.vendor.id,
								label,
								account,
								secret: values
							});
							setValues({});
						} catch {} finally {
							setSaving(false);
						}
					},
					children: saving ? "保存并校验中…" : "保存并校验"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "mmp-btn",
					"data-variant": "danger",
					disabled: props.busy,
					onClick: props.onRemoveVendor,
					children: "清除该供应商全部凭证"
				})]
			})
		]
	});
}
const LABELS = {
	"field.token": "Token / 密钥",
	"field.uid": "账号 uid",
	"field.site": "站点（zai / bigmodel）",
	"field.ak": "Access Key",
	"field.sk": "Secret Key",
	"field.securityToken": "Security Token",
	"field.projectId": "项目 id",
	"field.deviceId": "设备 id"
};
const HINTS = {
	"hint.qoder-cn": "在 qoder.com.cn 的账号设置里生成 Personal Access Token，粘贴到这里。保存时会立刻校验并读一次额度。",
	"hint.qoder-global": "在 qoder.com 的账号设置里生成 Personal Access Token（国际版令牌对国内版无效）。",
	"hint.workbuddy": "从 WorkBuddy 桌面端登录态里取 accessToken（%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth）。",
	"hint.workbuddy-ai": "从 WorkBuddy AI 桌面端取 access token；国际版不带每日签到事件。",
	"hint.trae-cn": "从 Trae CN 客户端登录态取 Cloud-IDE-JWT（不含前缀），设备 id 可留空。",
	"hint.zcode": "粘贴 zcode-api-key 的 secret；Z.ai 账号选 zai，智谱账号选 bigmodel。",
	"hint.codearts": "华为云临时 AK/SK（+security-token）。CodeArts 请求要按 SDK-HMAC-SHA256 签名，本插件会替你签。"
};
function labelOf(key) {
	return LABELS[key] ?? "Token";
}
function hintOf(vendor) {
	return HINTS[vendor.credential.hintKey] ?? "按该供应商的要求填写凭证。";
}
// src/client/Checkin.tsx
/**
* The check-in centre: the daily sweep's switch and time, each account's state,
* and the rolling log.
*
* The time is entered as the Asia/Shanghai wall clock the schedule uses; the
* Host stores it as minutes past local midnight, which is what its timer reads.
*/
function Checkin(props) {
	const { status, settings } = props;
	const [message, setMessage] = (0, react.useState)(null);
	const hour = Math.floor(settings.checkinMinute / 60);
	const minute = settings.checkinMinute % 60;
	const timeValue = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "mmp-panel",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-head",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: "mmp-title",
						children: "签到中心"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "mmp-sub",
						children: status.scheduler.enabled ? `每日自动签到已启用 · 下次 ${status.scheduler.nextAt ? stamp(status.scheduler.nextAt) : "待定"}` : "每日自动签到已关闭"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mmp-grow" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "mmp-btn",
						"data-variant": "primary",
						disabled: props.busy,
						onClick: props.onCheckinAll,
						children: props.busy ? "执行中…" : "立即全部签到"
					})
				]
			}),
			message ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: message.bad ? "mmp-error" : "mmp-ok",
				style: { padding: "4px 0" },
				children: message.text
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-block",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "mmp-block-head",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "自动签到" })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "mmp-form",
					style: {
						flexDirection: "row",
						alignItems: "flex-end",
						gap: 16,
						flexWrap: "wrap"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "mmp-field",
							style: {
								flexDirection: "row",
								alignItems: "center",
								gap: 6
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: settings.autoCheckin,
								onChange: async (event) => {
									try {
										await props.onSave({ autoCheckin: event.target.checked });
										setMessage({
											text: event.target.checked ? "已启用每日自动签到" : "已关闭每日自动签到",
											bad: false
										});
									} catch (error) {
										setMessage({
											text: error.message,
											bad: true
										});
									}
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "mmp-hint",
								children: "每天按下面的时刻自动签到（时区固定 Asia/Shanghai）"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "mmp-field",
							style: { maxWidth: 140 },
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "签到时刻" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "time",
								value: timeValue,
								onChange: async (event) => {
									const [h, m] = event.target.value.split(":").map(Number);
									if (!Number.isFinite(h) || !Number.isFinite(m)) return;
									try {
										await props.onSave({ checkinMinute: h * 60 + m });
										setMessage({
											text: `签到时刻已改为 ${event.target.value}`,
											bad: false
										});
									} catch (error) {
										setMessage({
											text: error.message,
											bad: true
										});
									}
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "mmp-field",
							style: { maxWidth: 180 },
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "额度刷新间隔（分钟）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "number",
								min: 1,
								step: 1,
								value: Math.round(settings.pollMs / 6e4),
								onChange: async (event) => {
									const minutes = Number(event.target.value);
									if (!Number.isFinite(minutes) || minutes < 1) return;
									try {
										await props.onSave({ pollMs: Math.round(minutes) * 6e4 });
									} catch (error) {
										setMessage({
											text: error.message,
											bad: true
										});
									}
								}
							})]
						}),
						status.scheduler.lastAt ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "mmp-hint",
							children: ["上次自动执行：", stamp(status.scheduler.lastAt)]
						}) : null
					]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-block",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "mmp-block-head",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "各账号签到状态" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mmp-grow" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "mmp-sub",
							children: ["今日北京时间 ", beijingDay()]
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "mmp-block-body",
					children: status.accounts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "mmp-empty",
						children: "还没有账号，先去「供应商」页添加。"
					}) : status.accounts.map((account) => {
						const meta = vendorMeta(account.vendor);
						const checkin = account.checkin;
						const tone = checkin?.outcome === "claimed" || checkin?.outcome === "already" ? "good" : checkin?.outcome === "eligible" ? "accent" : checkin?.outcome === "failed" ? "bad" : "neutral";
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "mmp-row",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Glyph, { text: meta?.glyph ?? "?" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "mmp-who",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "mmp-name",
										children: [
											account.label,
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
												tone: "neutral",
												children: meta?.name ?? account.vendor
											}),
											meta?.checkin === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
												tone: "neutral",
												children: "无签到"
											}) : null,
											checkin ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
												tone,
												children: CHECKIN_OUTCOME_LABEL[checkin.outcome] ?? checkin.outcome
											}) : null,
											account.checkinOn ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Pill, {
												tone: "neutral",
												children: "已关自动"
											})
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "mmp-meta",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: checkin ? checkin.message : "尚未签到" }),
											checkin?.amount ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["奖励 ", checkin.amount] }) : null,
											typeof checkin?.streak === "number" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
												"连续 ",
												checkin.streak,
												" 天"
											] }) : null
										]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "mmp-actions",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "mmp-btn",
										disabled: props.busy || !account.checkinOn,
										onClick: () => props.onCheckinOne(account.id),
										children: "签到"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "mmp-field",
										style: {
											flexDirection: "row",
											alignItems: "center",
											gap: 5
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: account.checkinOn,
											onChange: (event) => props.onToggleCheckin(account.id, event.target.checked)
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "mmp-hint",
											children: "自动"
										})]
									})]
								})
							]
						}, account.id);
					})
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-block",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "mmp-block-head",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "签到日志" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mmp-grow" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "mmp-btn",
							disabled: props.busy,
							onClick: props.onClearLog,
							children: "清空"
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "mmp-log",
					children: status.log.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "mmp-empty",
						children: "还没有记录"
					}) : status.log.map((entry, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("time", { children: stamp(entry.at, true) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: entry.account }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: CHECKIN_OUTCOME_LABEL[entry.outcome] ?? entry.outcome }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "mmp-sub",
							children: entry.message
						})
					] }, `${entry.at}-${index}`))
				})]
			})
		]
	});
}
function stamp(iso, withSeconds = false) {
	const at = new Date(iso);
	if (!Number.isFinite(at.getTime())) return iso;
	return at.toLocaleString("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		...withSeconds ? { second: "2-digit" } : {}
	});
}
function beijingDay() {
	try {
		return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(/* @__PURE__ */ new Date());
	} catch {
		return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
	}
}
// src/client/styles.ts
/**
* The console's stylesheet.
*
* Visual language follows magpie's own web UI: a neutral canvas, soft cards with
* a hairline border, KPI tiles that lead with the number, thin allowance bars
* that change colour as they drain, pill status tags and segmented controls.
*
* Classes are `mmp-` prefixed because other plugins inject global CSS into the
* same document. Every colour resolves through a harness theme alias with a
* literal fallback, so the panel stays readable on any theme.
*/
const CSS_ID = "dsh-magpie-connect/Panel.css";
const PANEL_CSS = `
.mmp-root{
  --mmp-fg:var(--dsw-alias-label-primary,#16181d);
  --mmp-fg-dim:var(--dsw-alias-label-secondary,#5c626e);
  --mmp-fg-faint:var(--dsw-alias-label-tertiary,#8a909c);
  --mmp-bg:var(--dsw-alias-bg-layer-1,#ffffff);
  --mmp-bg-soft:var(--dsw-alias-bg-layer-2,#f5f6f8);
  --mmp-bg-sunk:var(--dsw-alias-bg-layer-3,#eceef2);
  --mmp-line:var(--dsw-alias-border-subtle,#e3e6ec);
  --mmp-accent:var(--dsw-alias-brand-primary,#34698c);
  --mmp-accent-soft:color-mix(in oklab,var(--mmp-accent) 12%,transparent);
  --mmp-good:#2f9e6a;
  --mmp-warn:#c98a15;
  --mmp-bad:#cc4b48;
  --mmp-radius:14px;
  color:var(--mmp-fg);
  font-size:13px;
  line-height:1.5;
  font-variant-numeric:tabular-nums;
}

/* ---------------------------------------------------------------- shell */
/* The panel is a column that owns the full height, with a fixed header and a
   scrolling body. the panel class itself must never claim height: a content pane
   that sets height:100% inside a flex column pushes everything below it out of
   sight - that was the "blank supplier page" defect. */
.mmp-shell{display:flex;flex-direction:column;height:100%;min-height:0}
.mmp-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:14px 20px 10px;border-bottom:1px solid var(--mmp-line);flex:0 0 auto}
.mmp-scroll{flex:1 1 auto;min-height:0;overflow:auto}
.mmp-panel{display:flex;flex-direction:column;gap:14px;padding:16px 20px 28px}
.mmp-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.mmp-title{font-size:16px;font-weight:600;letter-spacing:-0.01em;margin:0}
.mmp-sub{color:var(--mmp-fg-dim);font-size:12px}
.mmp-grow{flex:1 1 auto}
.mmp-segs{display:inline-flex;background:var(--mmp-bg-sunk);border-radius:999px;padding:3px;gap:2px}
.mmp-seg{border:0;background:transparent;color:var(--mmp-fg-dim);font:inherit;font-size:12px;
  padding:5px 12px;border-radius:999px;cursor:pointer;white-space:nowrap}
.mmp-seg[data-on="1"]{background:var(--mmp-bg);color:var(--mmp-fg);font-weight:600;box-shadow:0 1px 2px rgba(16,20,28,.10)}
.mmp-seg:hover:not([data-on="1"]){color:var(--mmp-fg)}

.mmp-btn{border:1px solid var(--mmp-line);background:var(--mmp-bg);color:var(--mmp-fg);
  font:inherit;font-size:12px;padding:5px 12px;border-radius:9px;cursor:pointer}
.mmp-btn:hover{border-color:var(--mmp-accent);color:var(--mmp-accent)}
.mmp-btn[data-variant="primary"]{background:var(--mmp-accent);border-color:transparent;color:#fff}
.mmp-btn[data-variant="primary"]:hover{filter:brightness(1.08);color:#fff}
.mmp-btn[data-variant="danger"]:hover{border-color:var(--mmp-bad);color:var(--mmp-bad)}
.mmp-btn:disabled{opacity:.5;cursor:not-allowed}

/* ------------------------------------------------------------- kpi tiles */
.mmp-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px}
.mmp-tile{background:var(--mmp-bg);border:1px solid var(--mmp-line);border-radius:var(--mmp-radius);
  padding:12px 14px;display:flex;flex-direction:column;gap:2px}
.mmp-tile b{font-size:22px;font-weight:600;letter-spacing:-0.02em;line-height:1.15}
.mmp-tile span{font-size:11.5px;color:var(--mmp-fg-dim)}
.mmp-tile small{font-size:11px;color:var(--mmp-fg-faint)}

/* --------------------------------------------------------------- blocks */
.mmp-block{background:var(--mmp-bg);border:1px solid var(--mmp-line);border-radius:var(--mmp-radius);overflow:hidden}
.mmp-block-head{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--mmp-line);
  font-size:12px;color:var(--mmp-fg-dim);font-weight:600}
.mmp-block-body{padding:6px 0}

/* ------------------------------------------------------------------ rows */
.mmp-row{display:flex;align-items:center;gap:11px;padding:10px 14px}
.mmp-row + .mmp-row{border-top:1px solid var(--mmp-line)}
.mmp-row:hover{background:var(--mmp-bg-soft)}
.mmp-glyph{width:30px;height:30px;flex:0 0 30px;border-radius:9px;display:grid;place-items:center;
  background:var(--mmp-accent-soft);color:var(--mmp-accent);font-weight:700;font-size:13px}
.mmp-who{flex:1 1 auto;min-width:0}
.mmp-name{font-weight:600;font-size:12.5px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.mmp-meta{font-size:11.5px;color:var(--mmp-fg-dim);display:flex;gap:6px;flex-wrap:wrap}
.mmp-share{width:88px;height:4px;border-radius:999px;background:var(--mmp-bg-sunk);overflow:hidden;flex:0 0 88px}
.mmp-share i{display:block;height:100%;border-radius:999px;background:var(--mmp-accent)}
.mmp-num{text-align:right;font-size:12px;min-width:74px}
.mmp-num b{font-weight:600}
.mmp-num small{display:block;color:var(--mmp-fg-faint);font-size:10.5px}

/* --------------------------------------------------------------- pills */
.mmp-pill{font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--mmp-bg-sunk);
  color:var(--mmp-fg-dim);font-weight:600;white-space:nowrap}
.mmp-pill[data-tone="good"]{background:color-mix(in oklab,var(--mmp-good) 15%,transparent);color:var(--mmp-good)}
.mmp-pill[data-tone="warn"]{background:color-mix(in oklab,var(--mmp-warn) 16%,transparent);color:var(--mmp-warn)}
.mmp-pill[data-tone="bad"]{background:color-mix(in oklab,var(--mmp-bad) 14%,transparent);color:var(--mmp-bad)}
.mmp-pill[data-tone="accent"]{background:var(--mmp-accent-soft);color:var(--mmp-accent)}

/* --------------------------------------------------------------- bars */
.mmp-bars{display:flex;flex-direction:column;gap:7px;padding:2px 14px 12px}
.mmp-bar{display:flex;flex-direction:column;gap:3px}
.mmp-bar-top{display:flex;font-size:11.5px;color:var(--mmp-fg-dim);gap:8px}
.mmp-bar-track{height:5px;border-radius:999px;background:var(--mmp-bg-sunk);overflow:hidden}
.mmp-bar-fill{height:100%;border-radius:999px;background:var(--mmp-accent);transition:width .25s ease}
.mmp-bar-fill[data-tone="warn"]{background:var(--mmp-warn)}
.mmp-bar-fill[data-tone="bad"]{background:var(--mmp-bad)}
.mmp-bar-note{font-size:10.5px;color:var(--mmp-fg-faint)}

/* -------------------------------------------------------------- sidebar */
.mmp-foot{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:6px;
  padding:8px 10px;border-radius:11px;border:1px solid var(--mmp-line);background:var(--mmp-bg);
  cursor:pointer;text-align:left;font:inherit;color:inherit}
.mmp-foot:hover{border-color:var(--mmp-accent)}
.mmp-foot-head{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--mmp-fg-dim)}
.mmp-foot-head b{color:var(--mmp-fg);font-weight:600}
.mmp-foot-grid{display:flex;flex-direction:column;gap:5px}
.mmp-foot-item{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--mmp-fg-dim)}
.mmp-foot-item .mmp-share{width:auto;flex:1 1 auto;height:3px}
.mmp-foot-rail{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;
  border:1px solid var(--mmp-line);background:var(--mmp-bg);cursor:pointer;font-weight:700;font-size:12px;
  color:var(--mmp-accent);position:relative}
.mmp-dot{position:absolute;top:-3px;right:-3px;width:9px;height:9px;border-radius:999px;background:var(--mmp-warn);
  border:2px solid var(--mmp-bg)}

/* ---------------------------------------------------------------- forms */
.mmp-form{display:flex;flex-direction:column;gap:9px;padding:12px 14px 14px}
.mmp-field{display:flex;flex-direction:column;gap:3px}
.mmp-field label{font-size:11.5px;color:var(--mmp-fg-dim)}
.mmp-field input{font:inherit;font-size:12.5px;padding:7px 10px;border-radius:9px;
  border:1px solid var(--mmp-line);background:var(--mmp-bg-soft);color:var(--mmp-fg);min-width:0}
.mmp-field input:focus{outline:none;border-color:var(--mmp-accent);background:var(--mmp-bg)}
.mmp-hint{font-size:11px;color:var(--mmp-fg-faint);line-height:1.45}
.mmp-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center}

/* -------------------------------------------------------------- empties */
.mmp-empty{color:var(--mmp-fg-dim);font-size:12px;padding:14px;text-align:center}
.mmp-error{color:var(--mmp-bad);font-size:11.5px;padding:8px 14px;background:color-mix(in oklab,var(--mmp-bad) 7%,transparent)}
.mmp-ok{color:var(--mmp-good);font-size:11.5px}
.mmp-log{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;
  color:var(--mmp-fg-dim);display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto;padding:8px 14px}
.mmp-log div{display:flex;gap:8px}
.mmp-log time{color:var(--mmp-fg-faint);flex:0 0 auto}
.mmp-vendor-tabs{display:flex;gap:6px;flex-wrap:wrap;padding:12px 14px 0}
.mmp-vendor-tab{border:1px solid var(--mmp-line);background:var(--mmp-bg);border-radius:999px;
  font:inherit;font-size:11.5px;padding:4px 11px;cursor:pointer;color:var(--mmp-fg-dim)}
.mmp-vendor-tab[data-on="1"]{border-color:var(--mmp-accent);color:var(--mmp-accent);background:var(--mmp-accent-soft)}
.mmp-footbar{font-size:11px;color:var(--mmp-fg-faint);display:flex;gap:10px;flex-wrap:wrap}
`;
let installed = false;
/** Mount the stylesheet once; safe to call from every surface. */
function ensureStyles() {
	if (installed) return;
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="dsh-magpie-connect/Panel.css"]`) !== null) {
		installed = true;
		return;
	}
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-magpie-connect";
	tag.dataset.pluginCss = CSS_ID;
	tag.textContent = PANEL_CSS;
	document.head.appendChild(tag);
	installed = true;
}
/** Remove the stylesheet when the plugin's fiber unwinds. */
function removeStyles() {
	if (typeof document === "undefined") return;
	document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)?.remove();
	installed = false;
}
// src/client/Panel.tsx
/**
* The centre panel: three tabs over one store, and the single place that turns
* a press into a Host request while keeping the whole panel disabled mid-flight.
*
* Layout contract: `.mmp-shell` owns the height, `.mmp-header` is fixed, and
* `.mmp-scroll` is the only scroller. A content pane must never set its own
* height - doing that pushed every page below the fold (the blank-panel defect).
*/
/** Bumped on every client-only fix, so a reload can be told from a cache hit. */
const PANEL_BUILD = "v0.1.1-layout";
const TABS = [
	{
		id: "overview",
		label: "概览"
	},
	{
		id: "providers",
		label: "供应商"
	},
	{
		id: "checkin",
		label: "签到中心"
	}
];
function ConnectPanel() {
	const [tab, setTab] = (0, react.useState)("overview");
	const [busy, setBusy] = (0, react.useState)(false);
	const [notice, setNotice] = (0, react.useState)(null);
	const { status, settings, failure } = useConnectStore();
	(0, react.useEffect)(() => {
		ensureStyles();
		return acquire();
	}, []);
	async function run(work) {
		setBusy(true);
		setNotice(null);
		try {
			await work();
		} catch (error) {
			setNotice(error.message);
		} finally {
			setBusy(false);
		}
	}
	const settingsValue = settings?.value ?? null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "mmp-root mmp-shell",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-header",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: "mmp-title",
						children: "Magpie Connect"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "mmp-sub",
						children: "多供应商额度 · 用量 · 每日签到"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "mmp-pill",
						"data-tone": "neutral",
						children: PANEL_BUILD
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mmp-grow" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "mmp-segs",
						children: TABS.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "mmp-seg",
							"data-on": tab === entry.id ? "1" : "0",
							onClick: () => setTab(entry.id),
							children: entry.label
						}, entry.id))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "mmp-btn",
						disabled: busy,
						onClick: () => void run(async () => void await loadStatus()),
						children: "刷新"
					})
				]
			}),
			failure ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "mmp-error",
				children: ["读取状态失败：", failure]
			}) : null,
			notice ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "mmp-error",
				children: notice
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "mmp-scroll",
				children: status === null || settingsValue === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "mmp-panel",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "mmp-empty",
						children: failure ? "读取失败，点右上角「刷新」重试。" : "正在读取插件状态…"
					})
				}) : tab === "overview" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Overview, {
					status,
					hidden: settingsValue.hidden,
					busy,
					onRefreshAll: () => void run(() => refreshOne()),
					onCheckinAll: () => void run(() => checkinOne()),
					onRefreshOne: (id) => void run(() => refreshOne(id)),
					onCheckinOne: (id) => void run(() => checkinOne(id)),
					onToggleHidden: (id, hidden) => void run(() => saveSettings({
						accountId: id,
						accountPatch: hidden ? "hide" : "show"
					})),
					onToggleCheckin: (id, on) => void run(() => saveSettings({
						accountId: id,
						accountPatch: on ? "checkin-on" : "checkin-off"
					}))
				}) : tab === "providers" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Providers, {
					accounts: status.accounts,
					busy,
					onSave: (input) => run(() => saveCredential(input)),
					onRemove: (id) => run(() => removeCredential(id)),
					onRemoveVendor: (vendor) => run(() => removeVendorCredentials(vendor))
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Checkin, {
					status,
					settings: settingsValue,
					busy,
					onSave: (patch) => run(() => saveSettings(patch)),
					onCheckinAll: () => void run(() => checkinOne()),
					onCheckinOne: (id) => void run(() => checkinOne(id)),
					onToggleCheckin: (id, on) => void run(() => saveSettings({
						accountId: id,
						accountPatch: on ? "checkin-on" : "checkin-off"
					})),
					onClearLog: () => void run(() => clearLog())
				})
			})
		]
	});
}
// src/client/QuotaCard.tsx
function digestOf(status) {
	const byVendor = /* @__PURE__ */ new Map();
	for (const account of status.accounts) {
		const list = byVendor.get(account.vendor) ?? [];
		list.push(account);
		byVendor.set(account.vendor, list);
	}
	const out = [];
	for (const [vendor, accounts] of byVendor) {
		let worst = null;
		let left = null;
		let total = null;
		for (const account of accounts) {
			const percent = worstPercent(account);
			if (percent !== null && (worst === null || percent < worst)) worst = percent;
			for (const window of account.quota?.windows ?? []) {
				if (window.unit !== "credits") continue;
				if (typeof window.remaining === "number") left = (left ?? 0) + window.remaining;
				if (typeof window.total === "number") total = (total ?? 0) + window.total;
			}
		}
		out.push({
			meta: vendorMeta(vendor),
			accounts,
			worst,
			left,
			total,
			claimable: accounts.filter((account) => account.checkinOn && account.checkin?.outcome === "eligible").length,
			failed: accounts.filter((account) => account.error).length
		});
	}
	return out.sort((a, b) => (a.worst ?? 100) - (b.worst ?? 100));
}
function QuotaCard({ status, wide, onOpen }) {
	const digests = digestOf(status);
	const waiting = claimableAccounts(status).length;
	const title = waiting > 0 ? `${waiting} 个账号今天还没签到` : "Magpie Connect — 额度与签到";
	if (!wide) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
		type: "button",
		className: "mmp-root mmp-foot-rail",
		onClick: onOpen,
		title,
		"aria-label": title,
		children: ["M", waiting > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mmp-dot" }) : null]
	});
	const worst = digests.length > 0 ? digests.reduce((acc, item) => {
		if (item.worst === null) return acc;
		return acc === null || item.worst < acc ? item.worst : acc;
	}, null) : null;
	const leftSum = digests.reduce((acc, item) => acc + (typeof item.left === "number" ? item.left : 0), 0);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
		type: "button",
		className: "mmp-root mmp-foot",
		onClick: onOpen,
		title,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "mmp-foot-head",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "Magpie" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mmp-grow" }),
					waiting > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "mmp-pill",
						"data-tone": "warn",
						children: ["签到 ", waiting]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							color: "var(--mmp-fg-faint)",
							fontSize: 10
						},
						children: worst === null ? "—" : `${Math.round(worst)}%`
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "mmp-foot-grid",
				children: [
					digests.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "mmp-foot-item",
						children: "未添加账号"
					}) : null,
					digests.slice(0, 3).map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "mmp-foot-item",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									width: 14,
									textAlign: "center",
									fontWeight: 700,
									color: "var(--mmp-accent)"
								},
								children: item.meta?.glyph ?? "?"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MiniBar, { percent: item.worst }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									minWidth: 42,
									textAlign: "right"
								},
								children: item.left === null ? "—" : formatAmount(item.left)
							}),
							item.failed > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { color: "var(--mmp-bad)" },
								children: "!"
							}) : null
						]
					}, item.meta?.id ?? "unknown")),
					digests.length > 3 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "mmp-foot-item",
						children: [
							"另 ",
							digests.length - 3,
							" 家"
						]
					}) : null
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "mmp-foot-head",
				style: { fontSize: 10 },
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { color: "var(--mmp-fg-faint)" },
						children: digests.length > 0 && leftSum > 0 ? `合计 ${formatAmount(leftSum)} Credits` : "点开查看用量概览"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "mmp-grow" }),
					status.totals.updatedAt ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: shortStamp(status.totals.updatedAt) }) : null
				]
			})
		]
	});
}
function shortStamp(iso) {
	const at = new Date(iso);
	if (!Number.isFinite(at.getTime())) return "";
	return at.toLocaleTimeString("zh-CN", {
		hour: "2-digit",
		minute: "2-digit"
	});
}
// src/client/index.tsx
/**
* Browser half of `dsh-magpie-connect`.
*
* Registers three surfaces and nothing else:
*   - `sidebar.footer.action`  the allowance card (when the host serves it)
*   - `main` / `sidebar.panellist`  the three-tab console
*   - `settings.plugins.tab`  the same console inside the Plugins surface
*
* Every surface is optional: a host that does not declare a slot simply never
* calls its registration, and the remaining surfaces still work.
*/
/** Stable plugin name, matching the Host half. */
const name = "magpie-connect";
/** Services the browser half needs before it can register. */
const inject = ["slots"];
/** Key of this bundle's center-column panel. */
const PANEL_ID = "magpie-connect";
/** The card surface: subscribes on its own so it can render without the panel. */
function SidebarCard(props) {
	const { status, settings } = useConnectStore();
	(0, react.useEffect)(() => {
		ensureStyles();
		return acquire();
	}, []);
	if (status === null) return null;
	if (settings !== null && settings.value.sidebarCard === false) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaCard, {
		status,
		wide: props.wide,
		onOpen: props.onOpen
	});
}
function apply(ctx) {
	ensureStyles();
	ctx.effect(() => () => removeStyles(), "dsh-magpie-connect: styles");
	/** The layout service, once the host offers it. */
	let openPanel = () => void 0;
	ctx.inject(["layout"], (scoped) => {
		const layout = scoped.layout;
		if (layout !== void 0 && typeof layout.selectPanel === "function") openPanel = () => layout.selectPanel?.(PANEL_ID);
	});
	ctx.slots.inject("main", () => ctx.slots.register({
		name: "main",
		key: PANEL_ID
	}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConnectPanel, {})));
	ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
		name: "sidebar.footer.action",
		id: PANEL_ID,
		order: 30,
		label: () => "Magpie Connect"
	}, (owner = {}) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SidebarCard, {
		wide: owner.wide !== false,
		onOpen: openPanel
	})));
	ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
		name: "sidebar.panellist",
		id: PANEL_ID,
		order: 30,
		label: () => "Magpie Connect"
	}, () => null));
	ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
		name: "settings.plugins.tab",
		id: PANEL_ID,
		order: 65,
		label: () => "Magpie Connect"
	}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConnectPanel, {})));
}
exports.PANEL_ID = PANEL_ID;
exports.apply = apply;
exports.inject = inject;
exports.name = name;

return module.exports;
}
});
