import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { exec } from "node:child_process";
// src/types.ts
const DEFAULT_SETTINGS = {
	autoCheckin: true,
	checkinMinute: 600,
	pollMs: 3e5,
	sidebarCard: true,
	checkinOff: [],
	hidden: []
};
const POLL_MIN_MS = 6e4;
/** Base path of the plugin's own HTTP surface, shared by both halves. */
const ROUTE_BASE = "/plugins/dsh-magpie-connect";
// src/host/paths.ts
/**
* Where the plugin keeps its files.
*
* One directory, never loose files: `DSH_MAGPIE_CONNECT_DATA_DIR` when set,
* else `<DSH_HOME>/magpie-connect`, else `<user config>/dsh-magpie-connect`.
* The directory holds the account book (credentials), the settings file, the
* quota/check-in cache and the rolling check-in log.
*/
const DATA_DIR_ENV = "DSH_MAGPIE_CONNECT_DATA_DIR";
let cachedDir;
/** The plugin's data directory, created on first call. */
function dataDir() {
	if (cachedDir !== void 0) return cachedDir;
	const override = process.env[DATA_DIR_ENV]?.trim();
	const dshHome = process.env["DSH_HOME"]?.trim();
	const base = override && override.length > 0 ? resolve(override) : dshHome && dshHome.length > 0 ? join(resolve(dshHome), "magpie-connect") : join(homedir(), ".config", "dsh-magpie-connect");
	mkdirSync(base, { recursive: true });
	cachedDir = base;
	return base;
}
/** One file path inside the data directory. */
function dataFile(name) {
	return join(dataDir(), name);
}
/** Credentials - kept apart from everything else so it can be locked down. */
function accountsPath() {
	return dataFile("accounts.json");
}
function settingsPath() {
	return dataFile("settings.json");
}
function cachePath() {
	return dataFile("cache.json");
}
function logPath() {
	return dataFile("checkin-log.json");
}
/** Read a JSON file, returning `fallback` for anything unreadable. */
function readJson(path, fallback) {
	try {
		const text = readFileSync(path, "utf8");
		return JSON.parse(text);
	} catch {
		return fallback;
	}
}
/**
* Write a JSON file atomically: a sibling temp file renamed over the target, so
* a crash mid-write can never leave a half-parsed credential book behind.
*/
function writeJsonAtomic(path, value, mode = 384) {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
		encoding: "utf8",
		mode
	});
	try {
		chmodSync(temp, mode);
	} catch {}
	renameSync(temp, path);
}
// src/host/store.ts
/**
* The plugin's durable state: the credential book, the settings file, the
* quota/check-in cache and the rolling check-in log.
*
* Credentials live in their own file with 0600 and are never returned by any
* route - the status document only ever carries the masked account label.
*/
/** Bound on the rolling log so the file cannot grow without limit. */
const LOG_LIMIT = 400;
/** Deterministic short hash of a secret plus its vendor. */
function accountIdOf(vendor, secret) {
	const seed = vendor + "\0" + canonicalSecret(secret);
	return `${vendor}:${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}
function canonicalSecret(secret) {
	return Object.keys(secret).sort().map((key) => `${key}=${secret[key] ?? ""}`).join("");
}
function listAccounts() {
	const file = readJson(accountsPath(), {
		schema: 1,
		accounts: []
	});
	return Array.isArray(file.accounts) ? file.accounts.filter(isRecord) : [];
}
function isRecord(value) {
	const record = value;
	return !!record && typeof record.id === "string" && typeof record.vendor === "string" && typeof record.secret === "object";
}
function saveAccounts(accounts) {
	writeJsonAtomic(accountsPath(), {
		schema: 1,
		accounts
	}, 384);
}
/**
* Save (or replace) one account. A secret that hashes to an existing id updates
* that entry in place, keeping the label the user first gave it unless a new
* one is passed.
*/
function saveAccount(input) {
	const secret = {};
	for (const [key, value] of Object.entries(input.secret)) {
		const text = typeof value === "string" ? value.trim() : "";
		if (text.length > 0) secret[key] = text;
	}
	const id = accountIdOf(input.vendor, secret);
	const accounts = listAccounts();
	const index = accounts.findIndex((entry) => entry.id === id);
	const label = input.label?.trim();
	const record = {
		id,
		vendor: input.vendor,
		label: label && label.length > 0 ? label : index >= 0 ? accounts[index].label : defaultLabel(input.vendor, accounts),
		account: input.account?.trim() || accounts[index]?.account || "",
		plan: input.plan?.trim() || accounts[index]?.plan || "",
		createdAt: index >= 0 ? accounts[index].createdAt : (/* @__PURE__ */ new Date()).toISOString(),
		secret
	};
	if (index >= 0) accounts[index] = record;
	else accounts.push(record);
	saveAccounts(accounts);
	clearCache(id);
	return record;
}
function defaultLabel(vendor, accounts) {
	const siblings = accounts.filter((entry) => entry.vendor === vendor).length;
	return siblings === 0 ? "主账号" : `账号 ${siblings + 1}`;
}
function removeAccount(id) {
	const accounts = listAccounts();
	const next = accounts.filter((entry) => entry.id !== id);
	if (next.length === accounts.length) return false;
	saveAccounts(next);
	clearCache(id);
	return true;
}
/** Drop every credential of one vendor. */
function removeVendor(vendor) {
	const accounts = listAccounts();
	const kept = accounts.filter((entry) => entry.vendor !== vendor);
	const removed = accounts.length - kept.length;
	if (removed > 0) saveAccounts(kept);
	for (const entry of accounts) if (entry.vendor === vendor) clearCache(entry.id);
	return removed;
}
function findAccount(id) {
	return listAccounts().find((entry) => entry.id === id);
}
function loadSettings() {
	return normalizeSettings(readJson(settingsPath(), {}));
}
function normalizeSettings(input) {
	const base = { ...DEFAULT_SETTINGS };
	if (!input || typeof input !== "object") return base;
	if (typeof input.autoCheckin === "boolean") base.autoCheckin = input.autoCheckin;
	if (typeof input.sidebarCard === "boolean") base.sidebarCard = input.sidebarCard;
	if (typeof input.checkinMinute === "number" && Number.isInteger(input.checkinMinute)) base.checkinMinute = Math.min(1439, Math.max(0, input.checkinMinute));
	if (typeof input.pollMs === "number" && Number.isFinite(input.pollMs)) base.pollMs = Math.max(POLL_MIN_MS, Math.round(input.pollMs));
	base.checkinOff = Array.isArray(input.checkinOff) ? input.checkinOff.filter((v) => typeof v === "string") : [];
	base.hidden = Array.isArray(input.hidden) ? input.hidden.filter((v) => typeof v === "string") : [];
	return base;
}
function saveSettings(settings) {
	const normalized = normalizeSettings(settings);
	writeJsonAtomic(settingsPath(), normalized, 384);
	return normalized;
}
/** Merge a partial patch into the stored settings. */
function patchSettings(patch) {
	return saveSettings({
		...loadSettings(),
		...patch
	});
}
function readCache() {
	const file = readJson(cachePath(), {
		schema: 1,
		entries: {}
	});
	return file && typeof file.entries === "object" && file.entries !== null ? file : {
		schema: 1,
		entries: {}
	};
}
function writeCache(file) {
	writeJsonAtomic(cachePath(), file, 384);
}
function readEntry(id) {
	return readCache().entries[id];
}
function patchEntry(id, patch) {
	const file = readCache();
	const previous = file.entries[id];
	file.entries[id] = {
		...previous ?? { at: (/* @__PURE__ */ new Date()).toISOString() },
		...patch
	};
	writeCache(file);
}
function clearCache(id) {
	const file = readCache();
	if (!(id in file.entries)) return;
	delete file.entries[id];
	writeCache(file);
}
function appendLog(entry) {
	const file = readJson(logPath(), {
		schema: 1,
		entries: []
	});
	const entries = [entry, ...Array.isArray(file.entries) ? file.entries : []].slice(0, LOG_LIMIT);
	writeJsonAtomic(logPath(), {
		schema: 1,
		entries
	}, 384);
}
function readLog(limit = 100) {
	const file = readJson(logPath(), {
		schema: 1,
		entries: []
	});
	return (Array.isArray(file.entries) ? file.entries : []).slice(0, Math.max(1, limit));
}
function clearLog() {
	writeJsonAtomic(logPath(), {
		schema: 1,
		entries: []
	}, 384);
}
/** Project one account + its cache into the status line the browser reads. */
function statusOf(record, settings, now = (/* @__PURE__ */ new Date()).toISOString()) {
	const entry = readEntry(record.id);
	const checkinOn = !settings.checkinOff.includes(record.id);
	return {
		id: record.id,
		vendor: record.vendor,
		label: record.label,
		account: record.account ?? "",
		plan: entry?.quota?.plan ?? record.plan ?? null,
		signedIn: true,
		quota: entry?.quota ?? null,
		error: entry?.error ?? null,
		ms: entry?.ms,
		checkinOn,
		checkin: entry?.checkin ?? null
	};
}
function headersToRecord(headers) {
	const out = {};
	headers.forEach((value, key) => {
		out[key.toLowerCase()] = value;
	});
	return out;
}
/** Perform one request and return everything it produced. */
async function httpRequest(url, options = {}) {
	const started = Date.now();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15e3);
	try {
		const response = await fetch(url, {
			method: options.method ?? "GET",
			headers: options.headers,
			body: options.body,
			redirect: options.redirect === false ? "manual" : "follow",
			signal: controller.signal
		});
		const text = await response.text();
		return {
			status: response.status,
			ok: response.ok,
			headers: headersToRecord(response.headers),
			text,
			json: tryParse(text),
			ms: Date.now() - started
		};
	} finally {
		clearTimeout(timeout);
	}
}
function tryParse(text) {
	const trimmed = text.trim();
	if (trimmed.length === 0) return void 0;
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return void 0;
	try {
		return JSON.parse(trimmed);
	} catch {
		return;
	}
}
/** Small helper: safely walk a JSON value. */
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function asArray(value) {
	return Array.isArray(value) ? value : [];
}
function str(value) {
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}
function num(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}
/** First non-empty string of the candidates, else ''. */
function firstStr(...values) {
	for (const value of values) {
		const text = str(value).trim();
		if (text.length > 0) return text;
	}
	return "";
}
/** First finite number of the candidates, else null. */
function firstNum(...values) {
	for (const value of values) {
		const parsed = num(value);
		if (parsed !== null) return parsed;
	}
	return null;
}
/** Mask an account identifier for display: keep a short head and tail. */
function maskAccount(value) {
	const text = value.trim();
	if (text.length === 0) return "(未知账号)";
	if (text.includes("@")) {
		const [head, domain] = text.split("@");
		return `${head.slice(0, 2)}${"*".repeat(Math.max(1, Math.min(6, head.length - 2)))}@${domain}`;
	}
	if (text.length <= 4) return text[0] + "*".repeat(Math.max(0, text.length - 1));
	return `${text.slice(0, 2)}${"*".repeat(Math.max(2, Math.min(8, text.length - 4)))}${text.slice(-2)}`;
}
// src/providers/base.ts
/** A refused read: carries the console's error vocabulary. */
var AdapterFailure = class extends Error {
	error;
	constructor(error) {
		super(error.message);
		this.name = "AdapterFailure";
		this.error = error;
	}
};
/** Build one allowance window from amounts, deriving the missing side. */
function windowOf(input) {
	const total = input.total ?? null;
	const used = input.used ?? null;
	let remaining = input.remaining ?? null;
	if (remaining === null && total !== null && used !== null) remaining = Math.max(0, total - used);
	const derivedUsed = used ?? (total !== null && remaining !== null ? Math.max(0, total - remaining) : null);
	const percentLeft = input.percentLeft ?? (total !== null && total > 0 && remaining !== null ? Math.round(remaining / total * 1e3) / 10 : null);
	const out = {
		name: input.name,
		unit: input.unit,
		total,
		used: derivedUsed,
		remaining,
		percentLeft
	};
	if (input.resetsAt) out.resetsAt = input.resetsAt;
	if (input.expiresAt) out.expiresAt = input.expiresAt;
	if (input.unlimited) out.unlimited = true;
	if (input.note) out.note = input.note;
	return out;
}
/** Epoch seconds (or ms, or an ISO string) to ISO; null when unreadable. */
function isoTimestamp(value) {
	if (typeof value === "string") {
		const text = value.trim();
		if (text.length === 0) return null;
		const at = Date.parse(text);
		if (Number.isFinite(at)) return new Date(at).toISOString();
		const numeric = Number(text);
		return Number.isFinite(numeric) ? fromEpoch(numeric) : null;
	}
	if (typeof value === "number" && Number.isFinite(value)) return fromEpoch(value);
	return null;
}
function fromEpoch(value) {
	if (value <= 0) return null;
	const ms = value < 1e11 ? value * 1e3 : value;
	const at = new Date(ms);
	return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}
/** ISO for "now", the value every `fetchedAt`/`at` uses. */
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
/** A check-in status line with the given outcome. */
function checkinStatus(input) {
	const out = {
		outcome: input.outcome,
		message: input.message,
		at: nowIso()
	};
	if (input.amount) out.amount = input.amount;
	if (typeof input.streak === "number") out.streak = input.streak;
	if (input.nextAt) out.nextAt = input.nextAt;
	return out;
}
/** Perform a request and return the raw result without failing on status. */
async function requestRaw(url, options = {}) {
	return httpRequest(url, options);
}
// src/providers/qoder.ts
const HOSTS = {
	"qoder-cn": "https://openapi.qoder.com.cn",
	"qoder-global": "https://openapi.qoder.sh"
};
const SITES$1 = {
	"qoder-cn": "qoder.com.cn",
	"qoder-global": "qoder.com"
};
function headers$3(account, site) {
	return {
		"content-type": "application/json",
		accept: "application/json",
		authorization: `Bearer ${account.secret["token"] ?? ""}`,
		"user-agent": `Qoder/1.1.77 (${site})`,
		"x-requested-with": "XMLHttpRequest"
	};
}
function campaignsOf(payload) {
	const root = asRecord(payload);
	const list = asArray(root["campaigns"] ?? root["data"] ?? root["items"] ?? payload);
	const out = [];
	for (const item of list) {
		const record = asRecord(item);
		const id = firstStr(record["campaignId"], record["id"], record["campaign_id"]);
		if (id.length === 0) continue;
		out.push({
			id,
			actionType: firstStr(record["actionType"], record["action_type"]),
			claimStatus: firstStr(record["claimStatus"], record["claim_status"], record["status"]),
			startAt: num(record["startAt"] ?? record["start_at"]),
			endAt: num(record["endAt"] ?? record["end_at"]),
			benefit: asRecord(record["benefit"] ?? record["reward"]),
			raw: record
		});
	}
	return out;
}
function within(campaign) {
	const now = Date.now() / 1e3;
	const start = campaign.startAt;
	const end = campaign.endAt;
	if (start !== null && start > 0 && now < start) return false;
	if (end !== null && end > 0 && now > end) return false;
	return true;
}
function benefitText(campaign) {
	const credits = firstNum(campaign.benefit["credits"], campaign.benefit["amount"], campaign.benefit["value"], campaign.benefit["creditAmount"]);
	if (credits !== null) return `${credits} Credits`;
	const name = firstStr(campaign.benefit["name"], campaign.benefit["title"], campaign.benefit["description"]);
	return name.length > 0 ? name : null;
}
async function fetchCampaigns(account, vendor) {
	const host = HOSTS[vendor];
	const site = SITES$1[vendor] ?? "";
	if (host === void 0) throw new AdapterFailure({
		code: "unsupported",
		message: `未知的 Qoder 站点：${vendor}`
	});
	const result = await requestRaw(`${host}/sash/api/v1/me/campaigns`, {
		method: "GET",
		headers: headers$3(account, site)
	});
	if (!result.ok) throw new AdapterFailure({
		code: result.status === 401 || result.status === 403 ? "unauthorized" : "unknown",
		message: `Qoder campaigns 读取失败：HTTP ${result.status} ${result.text.slice(0, 200)}`
	});
	if (result.json === void 0) throw new AdapterFailure({
		code: "parse_failed",
		message: `Qoder campaigns 响应不是 JSON：${result.text.slice(0, 160)}`
	});
	return campaignsOf(result.json);
}
/** Pull an allowance window out of a response, when the vendor sent one. */
function quotaWindowsOf(payload) {
	const root = asRecord(payload);
	const candidates = [
		root["userQuota"],
		root["orgResourcePackage"],
		root["addOnQuota"],
		root["quota"]
	];
	const windows = [];
	for (const candidate of candidates) {
		const record = asRecord(candidate);
		if (Object.keys(record).length === 0) continue;
		const total = firstNum(record["total"], record["totalQuota"], record["limit"]);
		const used = firstNum(record["used"], record["usedQuota"]);
		const remaining = firstNum(record["remaining"], record["remain"], record["available"]);
		if (total === null && used === null && remaining === null) continue;
		windows.push(windowOf({
			name: firstStr(record["name"], record["packageName"]) || "Quota",
			unit: "credits",
			total,
			used,
			remaining,
			expiresAt: isoTimestamp(record["expiresAt"] ?? record["expireAt"])
		}));
	}
	return windows;
}
function createAdapter$1(vendor) {
	return {
		id: vendor,
		async readQuota(account) {
			const windows = quotaWindowsOf({ campaigns: (await fetchCampaigns(account, vendor)).map((campaign) => campaign.raw) });
			if (windows.length === 0) throw new AdapterFailure({
				code: "unsupported",
				message: "Qoder 的额度查询接口没有公开契约，本插件只读取到活动信息，不猜额度。签到与活动奖励仍可正常使用；额度请在 Qoder 客户端或 magpie 查看。"
			});
			return {
				account: account.account ?? "",
				plan: null,
				windows,
				balance: null,
				fetchedAt: nowIso()
			};
		},
		async readCheckin(account) {
			const benefit = (await fetchCampaigns(account, vendor)).filter((campaign) => campaign.actionType === "CLAIM_BENEFIT");
			if (benefit.length === 0) return checkinStatus({
				outcome: "ineligible",
				message: "Qoder 当前没有可领取的签到活动"
			});
			const open = benefit.filter(within);
			const claimable = open.filter((campaign) => {
				const status = campaign.claimStatus.toLowerCase();
				return status === "" || status.includes("claimable") || status === "unclaimed" || status === "pending";
			});
			const claimed = open.filter((campaign) => campaign.claimStatus.toLowerCase().includes("claimed"));
			if (claimable.length > 0) {
				const next = claimable[0];
				return checkinStatus({
					outcome: "eligible",
					message: "今日签到可领取",
					amount: benefitText(next),
					nextAt: isoTimestamp(next.endAt)
				});
			}
			if (claimed.length > 0) {
				const done = claimed[0];
				return checkinStatus({
					outcome: "already",
					message: "今日签到已领取",
					amount: benefitText(done)
				});
			}
			return checkinStatus({
				outcome: "no_window",
				message: "Qoder 的签到活动当前不在领取窗口内"
			});
		},
		async claimCheckin(account) {
			const host = HOSTS[vendor];
			const site = SITES$1[vendor] ?? "";
			const target = (await fetchCampaigns(account, vendor)).filter((campaign) => campaign.actionType === "CLAIM_BENEFIT" && within(campaign)).find((campaign) => {
				const status = campaign.claimStatus.toLowerCase();
				return status === "" || status.includes("claimable") || status === "unclaimed" || status === "pending";
			});
			if (target === void 0) return checkinStatus({
				outcome: "already",
				message: "Qoder 今日没有可领取的签到"
			});
			const result = await requestRaw(`${host}/sash/api/v1/me/campaigns/${encodeURIComponent(target.id)}/claim`, {
				method: "POST",
				headers: headers$3(account, site),
				body: "{}"
			});
			if (!result.ok) return checkinStatus({
				outcome: "failed",
				message: `Qoder 签到失败：HTTP ${result.status} ${result.text.slice(0, 200)}`
			});
			return checkinStatus({
				outcome: "claimed",
				message: "签到成功",
				amount: benefitText(target)
			});
		}
	};
}
const qoderCnAdapter = createAdapter$1("qoder-cn");
const qoderGlobalAdapter = createAdapter$1("qoder-global");
// src/providers/workbuddy.ts
const SITES = {
	workbuddy: {
		endpoint: "https://copilot.tencent.com",
		appName: "workbuddy",
		appVersion: "5.9.3",
		domain: "tencent.com"
	},
	"workbuddy-ai": {
		endpoint: "https://www.workbuddy.ai",
		appName: "workbuddy-ai",
		appVersion: "5.9.3",
		domain: "workbuddy.ai"
	}
};
function headers$2(account, site) {
	const token = account.secret["token"] ?? "";
	const uid = account.secret["uid"] ?? "";
	return {
		"content-type": "application/json",
		accept: "application/json",
		authorization: `Bearer ${token}`,
		"x-user-id": uid,
		"x-domain": site.domain,
		"x-product": "SaaS",
		"x-ide-type": "WorkBuddy",
		"x-ide-name": "WorkBuddy",
		"x-ide-version": site.appVersion,
		"x-agent-intent": "craft",
		"x-agent-purpose": "conversation",
		"x-requested-with": "XMLHttpRequest",
		"user-agent": `WorkBuddy/${site.appVersion}`
	};
}
function siteOf(vendor) {
	const site = SITES[vendor];
	if (site === void 0) throw new AdapterFailure({
		code: "unsupported",
		message: `未知的 WorkBuddy 站点：${vendor}`
	});
	return site;
}
/** Read the account's resource summary (the vendor's own allowance page). */
async function fetchSummary(account, vendor) {
	const site = siteOf(vendor);
	const result = await requestRaw(`${site.endpoint}/billing/meter/get-user-resource-summary`, {
		method: "POST",
		headers: headers$2(account, site),
		body: "{}"
	});
	if (!result.ok) throw new AdapterFailure({
		code: result.status === 401 || result.status === 403 ? "unauthorized" : "unknown",
		message: `WorkBuddy 资源汇总读取失败：HTTP ${result.status} ${result.text.slice(0, 200)}`
	});
	const root = asRecord(result.json);
	const data = asRecord(root["data"] ?? root["result"] ?? root);
	return Object.keys(data).length > 0 ? data : root;
}
/** Collect credit windows from whichever block the summary carries. */
function windowsOf(summary) {
	const windows = [];
	const blocks = [
		summary["credits"],
		summary["resourceSummary"],
		summary["resources"],
		summary["meters"],
		summary["list"]
	];
	for (const block of blocks) for (const item of asArray(block)) {
		const record = asRecord(item);
		const total = firstNum(record["total"], record["limit"], record["totalAmount"], record["quota"]);
		const used = firstNum(record["used"], record["usedAmount"], record["consumed"]);
		const remaining = firstNum(record["remaining"], record["remain"], record["balance"], record["left"]);
		if (total === null && used === null && remaining === null) continue;
		windows.push(windowOf({
			name: firstStr(record["name"], record["resourceName"], record["type"]) || "Credits",
			unit: "credits",
			total,
			used,
			remaining,
			resetsAt: isoTimestamp(record["resetAt"] ?? record["reset_at"] ?? record["cycleEnd"]),
			expiresAt: isoTimestamp(record["expireAt"] ?? record["expiresAt"])
		}));
	}
	if (windows.length === 0) {
		const total = firstNum(summary["totalCredits"], summary["creditTotal"], summary["creditsTotal"]);
		const used = firstNum(summary["usedCredits"], summary["creditUsed"]);
		const remaining = firstNum(summary["remainingCredits"], summary["creditRemaining"], summary["creditsRemaining"]);
		if (total !== null || used !== null || remaining !== null) windows.push(windowOf({
			name: "Credits",
			unit: "credits",
			total,
			used,
			remaining
		}));
	}
	return windows;
}
/** The answer both check-in methods give: the vendor's own plugin owns it. */
function ownPluginCheckin() {
	return checkinStatus({
		outcome: "skipped",
		message: "WorkBuddy 的签到事件由 magpie 侧的 @magpie-community/opencode-workbuddy-auth 插件执行；本插件不复制它未公开的签到端点，请在 magpie 的 WorkBuddy 卡片上签到，或让该插件自动执行。"
	});
}
function createAdapter(vendor) {
	return {
		id: vendor,
		async readQuota(account) {
			const summary = await fetchSummary(account, vendor);
			const windows = windowsOf(summary);
			if (windows.length === 0) throw new AdapterFailure({
				code: "parse_failed",
				message: `WorkBuddy 资源汇总里没有认出额度字段：${JSON.stringify(summary).slice(0, 300)}`
			});
			const plan = firstStr(summary["plan"], summary["planName"], summary["productName"]);
			return {
				account: account.account ?? "",
				plan: plan.length > 0 ? plan : null,
				windows,
				balance: null,
				fetchedAt: nowIso()
			};
		},
		async readCheckin() {
			return ownPluginCheckin();
		},
		async claimCheckin() {
			return ownPluginCheckin();
		}
	};
}
const workbuddyAdapter = createAdapter("workbuddy");
const workbuddyAiAdapter = createAdapter("workbuddy-ai");
// src/providers/trae.ts
const HOST = "https://api.trae.cn";
const STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
const CLAIM_PATH$1 = "/trae/api/v2/ug/checkin_credits/claim";
const USAGE_PATH = "/trae/api/v2/pay/ide_user_ent_usage";
const APP_VERSION = "0.1.69";
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Trae/${APP_VERSION} Chrome/128.0.0.0 Safari/537.36`;
function headers$1(account) {
	const token = account.secret["token"] ?? "";
	const deviceId = account.secret["deviceId"]?.trim();
	return {
		"content-type": "application/json",
		authorization: `Cloud-IDE-JWT ${token}`,
		"user-agent": UA,
		"x-device-id": deviceId && deviceId.length > 0 ? deviceId : fallbackDeviceId(account.id),
		"x-device-brand": "Trae",
		"x-device-type": "Windows",
		"x-os-version": "10.0.22631",
		"x-app-version": APP_VERSION
	};
}
/** A stable 15-digit device id derived from the account, as the relays send. */
function fallbackDeviceId(seed) {
	let hash = 0;
	for (let index = 0; index < seed.length; index++) hash = (hash * 31 + seed.charCodeAt(index)) % 0x38d7ea4c68000;
	return String(hash).padStart(15, "0").slice(0, 15);
}
/** Unwrap Trae's `{code, message, data}` envelope, or explain a refusal. */
function unwrap(payload, what) {
	const root = asRecord(payload);
	const code = firstStr(root["code"], root["status"], root["errCode"]);
	const message = firstStr(root["message"], root["msg"], root["message_"]);
	if (code.length > 0 && code !== "0" && code !== "200" && code.toLowerCase() !== "ok") throw new AdapterFailure({
		code: /9074|9095/.test(code) ? "unsupported" : "unknown",
		message: `Trae 拒绝${what}：${message || code}（code ${code}）`
	});
	return asRecord(root["data"] ?? root["result"] ?? root);
}
function boolOf(record, keys) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "boolean") return value;
		if (typeof value === "number") return value !== 0;
		if (typeof value === "string") {
			const text = value.toLowerCase();
			if (text === "true" || text === "1" || text === "yes") return true;
			if (text === "false" || text === "0" || text === "no") return false;
		}
	}
	return null;
}
const CLAIMABLE_KEYS = [
	"claimable",
	"can_checkin",
	"canCheckin",
	"canClaim",
	"can_claim",
	"available"
];
const DONE_KEYS = [
	"checked_in",
	"checkedIn",
	"has_checkin",
	"hasCheckin",
	"signed",
	"finished",
	"claimed",
	"is_checked"
];
async function readStatus(account) {
	const result = await requestRaw(`${HOST}${STATUS_PATH}`, {
		method: "GET",
		headers: headers$1(account)
	});
	if (!result.ok) throw new AdapterFailure({
		code: result.status === 401 || result.status === 403 ? "unauthorized" : "unknown",
		message: `Trae 签到状态读取失败：HTTP ${result.status} ${result.text.slice(0, 160)}`
	});
	return unwrap(result.json, "签到状态查询");
}
async function readUsage(account) {
	const result = await requestRaw(`${HOST}${USAGE_PATH}`, {
		method: "POST",
		headers: headers$1(account),
		body: JSON.stringify({
			require_usage: true,
			req_source: 0
		})
	});
	if (!result.ok) throw new AdapterFailure({
		code: result.status === 401 || result.status === 403 ? "unauthorized" : "unknown",
		message: `Trae 用量读取失败：HTTP ${result.status} ${result.text.slice(0, 160)}`
	});
	return unwrap(result.json, "用量查询");
}
/** Pull a credits block out of whatever shape the usage page returned. */
function creditsOf(usage) {
	const direct = asRecord(usage["credits"] ?? usage["credit"] ?? usage["ent_usage"] ?? usage["usage"]);
	if (Object.keys(direct).length > 0) return direct;
	const nested = asArray(usage["list"])[0];
	return asRecord(nested);
}
const traeCnAdapter = {
	id: "trae-cn",
	async readQuota(account) {
		const usage = await readUsage(account);
		const credits = creditsOf(usage);
		const unlimited = boolOf(credits, ["unlimited", "is_unlimited"]) === true;
		const total = firstNum(credits["limit"], credits["total"], credits["total_credits"], credits["package_limit"]);
		const used = firstNum(credits["used"], credits["used_credits"], credits["consumed"]);
		const remaining = firstNum(credits["remain"], credits["remaining"], credits["available"], credits["left"]);
		const windows = [];
		if (unlimited) windows.push(windowOf({
			name: "额度",
			unit: "credits",
			total: null,
			used,
			remaining: null,
			unlimited: true
		}));
		else if (total !== null || remaining !== null) windows.push(windowOf({
			name: "Credits",
			unit: "credits",
			total,
			used,
			remaining,
			resetsAt: isoTimestamp(credits["reset_at"] ?? credits["resetAt"] ?? credits["expire_at"]),
			expiresAt: isoTimestamp(credits["expire_at"] ?? credits["expires_at"] ?? credits["end_at"])
		}));
		const plan = firstStr(usage["plan"], usage["plan_name"], credits["plan"], credits["plan_name"]);
		const account_ = firstStr(usage["user"], usage["uid"], credits["user"]);
		if (windows.length === 0) throw new AdapterFailure({
			code: "parse_failed",
			message: `Trae 用量响应里没有认出额度字段：${JSON.stringify(usage).slice(0, 300)}`
		});
		return {
			account: account_ || account.account || "",
			plan: plan || (boolOf(usage, ["is_credits_billing"]) === true ? "Credits" : "Free"),
			windows,
			balance: null,
			fetchedAt: nowIso()
		};
	},
	async readCheckin(account) {
		const status = await readStatus(account);
		const claimable = boolOf(status, CLAIMABLE_KEYS);
		const done = boolOf(status, DONE_KEYS);
		const streak = firstNum(status["streak"], status["days"], status["continuous_days"], status["checked_days"]);
		const amount = firstNum(status["credits"], status["reward"], status["reward_credits"], status["amount"]);
		const amountText = amount !== null ? `${amount} Credits` : null;
		if (claimable === true) return checkinStatus({
			outcome: "eligible",
			message: "今日签到可领取",
			amount: amountText,
			streak
		});
		if (claimable === false) return checkinStatus({
			outcome: "already",
			message: done === true ? "今日已签到" : "上游报告当前不可领取（通常为今日已签或未到窗口）",
			amount: amountText,
			streak
		});
		if (done === true) return checkinStatus({
			outcome: "already",
			message: "今日已签到",
			amount: amountText,
			streak
		});
		return checkinStatus({
			outcome: "no_window",
			message: `Trae 未报告可领取状态：${JSON.stringify(status).slice(0, 240)}`,
			streak
		});
	},
	async claimCheckin(account) {
		const result = await requestRaw(`${HOST}${CLAIM_PATH$1}`, {
			method: "POST",
			headers: headers$1(account),
			body: "{}"
		});
		if (!result.ok) {
			const said = result.text.slice(0, 200);
			return checkinStatus({
				outcome: "failed",
				message: /9074/.test(said) ? `Trae 拒绝本次签到（9074 当前参与用户太多）；每日签到这个账号今日不再重试。${said}` : `Trae 签到失败：HTTP ${result.status} ${said}`
			});
		}
		const root = asRecord(result.json);
		const code = firstStr(root["code"], root["status"], root["errCode"]);
		const message = firstStr(root["message"], root["msg"]);
		if (!(code.length === 0 || code === "0" || code === "200" || code.toLowerCase() === "ok")) return checkinStatus({
			outcome: "failed",
			message: `Trae 签到被拒：${message || code}（code ${code}）`
		});
		const data = asRecord(root["data"] ?? root["result"] ?? root);
		const amount = firstNum(data["credits"], data["reward"], data["amount"]);
		const streak = firstNum(data["streak"], data["days"], data["continuous_days"]);
		return checkinStatus({
			outcome: "claimed",
			message: "签到成功",
			amount: amount !== null ? `${amount} Credits` : null,
			streak
		});
	}
};
// src/providers/zcode.ts
const ROOTS = {
	zai: "https://api.z.ai",
	bigmodel: "https://bigmodel.cn"
};
function rootOf(account) {
	const site = (account.secret["site"] ?? "zai").trim().toLowerCase();
	return ROOTS[site] ?? ROOTS["zai"];
}
function headers(account) {
	return {
		"content-type": "application/json",
		accept: "application/json",
		authorization: `Bearer ${account.secret["token"] ?? ""}`,
		"set-language": "zh"
	};
}
function subscriptionsOf(payload) {
	const root = asRecord(payload);
	const list = asArray(root["data"] ?? root["subscriptions"] ?? payload);
	const out = [];
	for (const item of list) {
		const record = asRecord(item);
		const status = firstStr(record["status"]);
		if (status.length === 0) continue;
		out.push({
			productName: firstStr(record["productName"], record["product_name"], record["plan_name"]),
			status,
			startsAt: isoTimestamp(record["starts_at"] ?? record["startsAt"]),
			endsAt: isoTimestamp(record["ends_at"] ?? record["endsAt"]),
			raw: record
		});
	}
	return out;
}
async function fetchSubscriptions(account) {
	const result = await requestRaw(`${rootOf(account)}/api/biz/subscription/list`, {
		method: "GET",
		headers: headers(account)
	});
	if (!result.ok) throw new AdapterFailure({
		code: result.status === 401 || result.status === 403 ? "unauthorized" : "unknown",
		message: `ZCode 套餐读取失败：HTTP ${result.status} ${result.text.slice(0, 200)}`
	});
	if (result.json === void 0) throw new AdapterFailure({
		code: "parse_failed",
		message: `ZCode 套餐响应不是 JSON：${result.text.slice(0, 160)}`
	});
	return subscriptionsOf(result.json);
}
const zcodeAdapter = {
	id: "zcode",
	async readQuota(account) {
		const subscriptions = await fetchSubscriptions(account);
		const live = subscriptions.find((entry) => entry.status.toUpperCase() === "VALID") ?? subscriptions[0];
		if (live === void 0) throw new AdapterFailure({
			code: "unsupported",
			message: "ZCode 账号下没有读到任何套餐"
		});
		const windows = [];
		for (const item of asArray(live.raw["balances"] ?? live.raw["balance"] ?? live.raw["quotas"])) {
			const record = asRecord(item);
			const total = firstNum(record["total"], record["limit"], record["amount"]);
			const used = firstNum(record["used"], record["consumed"]);
			const remaining = firstNum(record["remaining"], record["balance"], record["left"]);
			if (total === null && used === null && remaining === null) continue;
			windows.push(windowOf({
				name: firstStr(record["name"], record["type"]) || live.productName || "GLM Plan",
				unit: "credits",
				total,
				used,
				remaining,
				expiresAt: isoTimestamp(record["expires_at"] ?? record["expireAt"])
			}));
		}
		if (windows.length === 0) windows.push(windowOf({
			name: live.productName || "GLM Coding Plan",
			unit: "credits",
			total: null,
			used: null,
			remaining: null,
			expiresAt: live.endsAt,
			note: "ZCode 未在该接口返回额度数，只报告套餐有效期"
		}));
		return {
			account: account.account ?? "",
			plan: live.productName || null,
			windows,
			balance: null,
			fetchedAt: nowIso()
		};
	},
	async readCheckin() {
		return giftPlanCheckin();
	},
	async claimCheckin() {
		return giftPlanCheckin();
	}
};
/** ZCode's gift-plan claim is magpie's 30-minute recheck, not this plugin's. */
function giftPlanCheckin() {
	return checkinStatus({
		outcome: "skipped",
		message: "ZCode 的赠礼/签到计划由 magpie 侧每 30 分钟复查并领取，本插件不重复执行；如遇验证码或需要本机 App 确认，请到 magpie 的 ZCode 卡片处理。"
	});
}
// src/providers/codearts.ts
/**
* CodeArts (华为云码道代码智能体) - Huawei Cloud's coding agent.
*
* Requests are signed with temporary AK/SK/security-token credentials using
* Huawei's SDK-HMAC-SHA256 scheme; the host and the daily-benefit endpoints are
* the ones magpie's own CodeArts plugin uses (`packages/codearts/index.mjs`):
*
*   daily benefits  GET  https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/delivery?channel=IDE
*   claim           POST https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/claim
*   confirm         POST https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/confirm
*
* The activity this plugin calls the daily check-in is the `USER_LOGIN` item of
* the activity list (「限时福利 → 每日领取」); an item already in CLAIMED /
* CONFIRMED / CONSUMED is today's benefit, received.
*
* The credit-batch page path is not published either, so the allowance card
* reports what the activity list says and refuses to invent a total.
*/
const SNAP_HOST = "https://snap-access.cn-north-4.myhuaweicloud.com";
const DELIVERY_PATH = "/v1/ops/delivery?channel=IDE";
const CLAIM_PATH = "/v1/ops/claim";
const CONFIRM_PATH = "/v1/ops/confirm";
const DAILY_TYPE = "USER_LOGIN";
const CLAIMED_STATUSES = [
	"CLAIMED",
	"CONFIRMED",
	"CONSUMED"
];
/** Hong Kong / Beijing style signing timestamp. */
function sdkDate(now = /* @__PURE__ */ new Date()) {
	return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function sha256Hex(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
function hmacHex(key, value) {
	return createHmac("sha256", key).update(value, "utf8").digest("hex");
}
function encode(value) {
	return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
}
/**
* Build the headers Huawei's SDK-HMAC-SHA256 expects. The canonical request uses
* `host` as the only signed header, which is what the plain SDK signer emits.
*/
function signedHeaders(account, method, urlStr, body) {
	const ak = account.secret["ak"] ?? "";
	const sk = account.secret["sk"] ?? "";
	const securityToken = account.secret["token"] ?? "";
	if (ak.length === 0 || sk.length === 0) throw new AdapterFailure({
		code: "no_credential",
		message: "CodeArts 需要 Access Key 与 Secret Key"
	});
	const url = new URL(urlStr);
	const canonicalUri = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
	const canonicalQuery = [...url.searchParams.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
	const canonicalHeaders = `host:${url.host}\n`;
	const signed = "host";
	const canonicalRequest = [
		method.toUpperCase(),
		canonicalUri,
		canonicalQuery,
		canonicalHeaders,
		signed,
		sha256Hex(body)
	].join("\n");
	const stamp = sdkDate();
	const signature = hmacHex(sk, [
		"SDK-HMAC-SHA256",
		stamp,
		sha256Hex(canonicalRequest)
	].join("\n"));
	const headers = {
		"content-type": "application/json",
		accept: "application/json",
		host: url.host,
		"x-sdk-date": stamp,
		authorization: `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signed}, Signature=${signature}`,
		"agent-type": "PromptCenter",
		"x-language": "zh-cn"
	};
	if (securityToken.length > 0) headers["x-security-token"] = securityToken;
	return headers;
}
async function fetchActivities(account) {
	const url = `${SNAP_HOST}${DELIVERY_PATH}`;
	const result = await requestRaw(url, {
		method: "GET",
		headers: signedHeaders(account, "GET", url, "")
	});
	if (!result.ok) throw new AdapterFailure({
		code: result.status === 401 || result.status === 403 ? "unauthorized" : "unknown",
		message: `CodeArts 活动列表读取失败：HTTP ${result.status} ${result.text.slice(0, 200)}`
	});
	const root = asRecord(result.json);
	const data = asRecord(root["data"] ?? root);
	const items = [];
	for (const entry of asArray(data["items"] ?? data["list"])) {
		const record = asRecord(entry);
		items.push({
			id: firstStr(record["id"], record["deliveryId"], record["activityId"]),
			type: firstStr(record["type"], record["activityType"]),
			status: firstStr(record["status"]).toUpperCase(),
			claimable: record["claimable"] === true,
			raw: record
		});
	}
	return {
		items,
		raw: result.json
	};
}
function post(account, path, body) {
	const url = `${SNAP_HOST}${path}`;
	const text = JSON.stringify(body);
	return requestRaw(url, {
		method: "POST",
		headers: signedHeaders(account, "POST", url, text),
		body: text
	});
}
// src/providers/index.ts
const TABLE = {
	"qoder-cn": qoderCnAdapter,
	"qoder-global": qoderGlobalAdapter,
	workbuddy: workbuddyAdapter,
	"workbuddy-ai": workbuddyAiAdapter,
	"trae-cn": traeCnAdapter,
	zcode: zcodeAdapter,
	codearts: {
		id: "codearts",
		async readQuota() {
			throw new AdapterFailure({
				code: "unsupported",
				message: "CodeArts 的积分批次接口（package/credit/page）路径未公开，本插件不猜数额。签到状态与每日领取可用，额度请在华为云 CodeArts 控制台查看。"
			});
		},
		async readCheckin(account) {
			const { items } = await fetchActivities(account);
			const daily = items.find((item) => item.type === DAILY_TYPE);
			if (daily === void 0) return checkinStatus({
				outcome: "ineligible",
				message: "CodeArts 活动列表里没有每日领取项（USER_LOGIN）"
			});
			if (daily.claimable) return checkinStatus({
				outcome: "eligible",
				message: "CodeArts 今日奖励可领取"
			});
			if (CLAIMED_STATUSES.includes(daily.status)) return checkinStatus({
				outcome: "already",
				message: "CodeArts 今日奖励已领取",
				amount: daily.status
			});
			return checkinStatus({
				outcome: "no_window",
				message: `CodeArts 未报告可领取：status=${daily.status || "(空)"} claimable=${String(daily.claimable)}`
			});
		},
		async claimCheckin(account) {
			const { items } = await fetchActivities(account);
			const daily = items.find((item) => item.type === DAILY_TYPE);
			if (daily === void 0) return checkinStatus({
				outcome: "ineligible",
				message: "CodeArts 无每日领取项"
			});
			if (CLAIMED_STATUSES.includes(daily.status) && !daily.claimable) return checkinStatus({
				outcome: "already",
				message: "CodeArts 今日奖励已领取"
			});
			const claim = await post(account, CLAIM_PATH, {
				deliveryId: daily.id,
				activityId: daily.id,
				type: DAILY_TYPE,
				channel: "IDE"
			});
			if (!claim.ok) return checkinStatus({
				outcome: "failed",
				message: `CodeArts 领取失败：HTTP ${claim.status} ${claim.text.slice(0, 200)}`
			});
			const claimRoot = asRecord(claim.json);
			const claimData = asRecord(claimRoot["data"] ?? claimRoot);
			const claimId = firstStr(claimData["claimId"], claimData["id"], claimData["deliveryId"]);
			if (claimId.length > 0) await post(account, CONFIRM_PATH, {
				claimId,
				id: claimId,
				channel: "IDE"
			}).catch(() => void 0);
			return checkinStatus({
				outcome: "claimed",
				message: "CodeArts 签到成功"
			});
		}
	}
};
/** The adapter for a vendor, or undefined for an id with no implementation. */
function adapterFor(vendor) {
	return TABLE[vendor];
}
// src/host/engine.ts
/** The Asia/Shanghai calendar day a timestamp falls in (`YYYY-MM-DD`). */
function shanghaiDay(at = /* @__PURE__ */ new Date()) {
	const date = typeof at === "number" ? new Date(at) : at;
	try {
		return new Intl.DateTimeFormat("en-CA", {
			timeZone: "Asia/Shanghai",
			year: "numeric",
			month: "2-digit",
			day: "2-digit"
		}).format(date);
	} catch {
		return date.toISOString().slice(0, 10);
	}
}
/** Convert an Asia/Shanghai wall clock on a given day to a UTC epoch. */
function shanghaiWallClockToUtc(day, minute) {
	const [year, month, date] = day.split("-").map(Number);
	if (!year || !month || !date) return 0;
	return Date.UTC(year, month - 1, date, 0, minute, 0, 0) - 288e5;
}
/** The next instant the automatic sweep should run, as an ISO timestamp. */
function nextCheckinAt(minute, now = Date.now()) {
	const todayAt = shanghaiWallClockToUtc(shanghaiDay(now), minute);
	return new Date(todayAt > now ? todayAt : todayAt + 864e5).toISOString();
}
/** Run at most `limit` promises at a time, preserving input order. */
async function mapLimited(items, limit, worker) {
	const out = new Array(items.length);
	let cursor = 0;
	const size = Math.min(Math.max(1, limit), Math.max(1, items.length));
	const lanes = new Array(size).fill(null).map(async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			out[index] = await worker(items[index]);
		}
	});
	await Promise.all(lanes);
	return out;
}
function failureOf(error) {
	if (error instanceof AdapterFailure) return error.error;
	return {
		code: "unknown",
		message: (error instanceof Error ? error.message : String(error)).slice(0, 240)
	};
}
/** Read one account's allowances and cache the outcome. */
async function refreshAccount(record, options) {
	const settings = loadSettings();
	const adapter = adapterFor(record.vendor);
	if (adapter === void 0) {
		const error = {
			code: "unsupported",
			message: `没有 ${record.vendor} 的适配器`
		};
		patchEntry(record.id, {
			error,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return statusOf(record, settings);
	}
	const started = Date.now();
	try {
		const quota = await adapter.readQuota(record);
		patchEntry(record.id, {
			quota,
			error: void 0,
			ms: Date.now() - started,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
	} catch (error) {
		const failure = failureOf(error);
		patchEntry(record.id, {
			quota: void 0,
			error: failure,
			ms: Date.now() - started,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		options.logger.warn(`dsh-magpie-connect: ${record.vendor} ${record.label} 额度读取失败 - ${failure.message}`);
	}
	return statusOf(record, settings);
}
/** Read every stored account's allowances. */
async function refreshAll(options) {
	return mapLimited(listAccounts(), 4, (record) => refreshAccount(record, options));
}
/** Whether a check-in for this account already concluded today. */
function concludedToday(record) {
	const checkin = readEntry(record.id)?.checkin;
	if (!checkin) return false;
	if (checkin.outcome !== "claimed" && checkin.outcome !== "already") return false;
	return shanghaiDay(new Date(checkin.at)) === shanghaiDay();
}
function logAttempt(record, status) {
	appendLog({
		at: status.at,
		vendor: record.vendor,
		accountId: record.id,
		account: maskAccount(record.account || record.label),
		outcome: status.outcome,
		message: status.message
	});
}
/**
* Ask one account whether today's check-in is available, and claim it when it
* is. `manual` is a press from the card: it re-asks the vendor even after an
* earlier conclusion so the user sees a fresh answer.
*/
async function checkinAccount(record, options, manual = false) {
	if (!manual && concludedToday(record)) {
		const previous = readEntry(record.id)?.checkin;
		if (previous) return previous;
	}
	const adapter = adapterFor(record.vendor);
	let status;
	if (adapter === void 0) status = {
		outcome: "skipped",
		message: "该供应商没有适配器",
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
	else try {
		const probe = await adapter.readCheckin(record);
		status = probe.outcome === "eligible" ? await adapter.claimCheckin(record) : probe;
	} catch (error) {
		const failure = failureOf(error);
		status = {
			outcome: "failed",
			message: failure.message,
			at: (/* @__PURE__ */ new Date()).toISOString()
		};
		options.logger.warn(`dsh-magpie-connect: ${record.vendor} ${record.label} 签到失败 - ${failure.message}`);
	}
	patchEntry(record.id, {
		checkin: status,
		at: (/* @__PURE__ */ new Date()).toISOString()
	});
	logAttempt(record, status);
	return status;
}
/** Every account that still has its check-in switch on. */
function checkinCandidates(settings) {
	return listAccounts().filter((record) => !settings.checkinOff.includes(record.id));
}
/** Sweep every account with its check-in switch on. */
async function checkinAll(options) {
	return mapLimited(checkinCandidates(loadSettings()), 2, (record) => checkinAccount(record, options, false));
}
/** Compute the headline totals from the accounts as they now stand. */
function totalsOf(accounts) {
	let creditsLeft = null;
	let creditsTotal = null;
	let updatedAt = null;
	for (const account of accounts) {
		for (const window of account.quota?.windows ?? []) {
			if (window.unit !== "credits") continue;
			if (typeof window.remaining === "number") creditsLeft = (creditsLeft ?? 0) + window.remaining;
			if (typeof window.total === "number") creditsTotal = (creditsTotal ?? 0) + window.total;
		}
		const fetched = account.quota?.fetchedAt;
		if (fetched && (updatedAt === null || fetched > updatedAt)) updatedAt = fetched;
	}
	return {
		vendors: new Set(accounts.map((account) => account.vendor)).size,
		accounts: accounts.length,
		signedIn: accounts.filter((account) => account.signedIn).length,
		readOk: accounts.filter((account) => !!account.quota).length,
		readFailed: accounts.filter((account) => account.error).length,
		checkinClaimable: accounts.filter((account) => account.checkin?.outcome === "eligible").length,
		checkinClaimed: accounts.filter((account) => account.checkin?.outcome === "claimed" || account.checkin?.outcome === "already").length,
		checkinFailed: accounts.filter((account) => account.checkin?.outcome === "failed").length,
		creditsLeft,
		creditsTotal,
		updatedAt
	};
}
/** Assemble the status document the browser half polls. */
function buildStatus(options, scheduler) {
	const settings = loadSettings();
	const accounts = listAccounts().map((record) => statusOf(record, settings));
	const problems = [];
	for (const account of accounts) if (account.error) problems.push(`${account.label}（${account.vendor}）：${account.error.message}`);
	let log = [];
	try {
		log = readLog(60);
	} catch {
		log = [];
	}
	return {
		schema: 1,
		version: options.version,
		configured: accounts.length > 0,
		accounts,
		totals: totalsOf(accounts),
		log,
		problems,
		at: (/* @__PURE__ */ new Date()).toISOString(),
		scheduler
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
// src/host/browser-login.ts
/**
* Browser sign-in, the way magpie does it.
*
* Each login is a short-lived session:
*   1. a loopback HTTP server binds 127.0.0.1 on a random port;
*   2. the system browser is opened at the vendor's authorize page, with
*      `redirect_uri` pointing back at that port;
*   3. the vendor redirects to `/callback`, which extracts the credential from
*      the query string the vendor promises (Cloud-IDE-JWT for Trae, `code` for
*      an OAuth flow, and so on);
*   4. the browser gets a small "you can close this" page and the session
*      becomes `done`, which the panel's poll picks up.
*
* Sessions are in memory only: a restart drops them, and nothing is written to
* disk until the caller saves the credential through the normal account book.
*/
const SESSION_TTL_MS = 6e5;
const sessions = /* @__PURE__ */ new Map();
const servers = /* @__PURE__ */ new Map();
/** Per-vendor browser sign-in descriptors. */
const LOGIN_SPECS = {
	"trae-cn": {
		tokenParams: [
			"Cloud-IDE-JWT",
			"cloud-ide-jwt",
			"access_token",
			"token",
			"jwt"
		],
		extraParams: ["refresh_token", "device_id"],
		authorizeUrl: "https://www.trae.cn/authorization?redirect_uri={redirect}&response_type=token",
		manualLoginUrl: "https://www.trae.cn/"
	},
	codearts: {
		tokenParams: ["code"],
		authorizeUrl: "https://codearts.huaweicloud.com/portal/authorize?redirect_uri={redirect}&response_type=code&client_id=codearts-agent&theme=2",
		manualLoginUrl: "https://codearts.huaweicloud.com/"
	},
	workbuddy: {
		tokenParams: ["access_token", "token"],
		authorizeUrl: null,
		manualLoginUrl: "https://copilot.tencent.com/"
	},
	"workbuddy-ai": {
		tokenParams: ["access_token", "token"],
		authorizeUrl: null,
		manualLoginUrl: "https://www.workbuddy.ai/"
	},
	"qoder-cn": {
		tokenParams: ["access_token", "token"],
		authorizeUrl: null,
		manualLoginUrl: "https://qoder.com.cn/account"
	},
	"qoder-global": {
		tokenParams: ["access_token", "token"],
		authorizeUrl: null,
		manualLoginUrl: "https://qoder.com/account"
	},
	zcode: {
		tokenParams: [
			"access_token",
			"token",
			"api_key"
		],
		authorizeUrl: null,
		manualLoginUrl: "https://zcode.z.ai/"
	}
};
/** Open a URL in the operating system's default browser. */
function openBrowser(url) {
	const platform = process.platform;
	const command = platform === "win32" ? `cmd /c start "" "${url.replace(/"/g, "")}"` : platform === "darwin" ? `open "${url.replace(/"/g, "")}"` : `xdg-open "${url.replace(/"/g, "")}"`;
	exec(command, (error) => {
		if (error) {}
	});
}
/** Start (or restart) one vendor's browser sign-in. */
function startBrowserLogin(vendor) {
	cancelSessionsOf(vendor);
	const spec = LOGIN_SPECS[vendor];
	const meta = vendorMeta(vendor);
	const id = randomBytes(8).toString("hex");
	if (spec === void 0) {
		const session = {
			id,
			vendor,
			state: "error",
			createdAt: Date.now(),
			url: "",
			error: `没有 ${vendor} 的浏览器登录配置`
		};
		sessions.set(id, session);
		return session;
	}
	if (spec.authorizeUrl === null) {
		openBrowser(spec.manualLoginUrl);
		const session = {
			id,
			vendor,
			state: "waiting",
			createdAt: Date.now(),
			url: spec.manualLoginUrl,
			error: `${meta?.name ?? vendor} 没有开放第三方登录回调，已为你打开官方页面；登录后在页面里取到令牌，粘贴回卡片即可。`
		};
		sessions.set(id, session);
		return session;
	}
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== "/callback") {
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
			return;
		}
		const secret = extractSecret(url, spec);
		const session = sessions.get(id);
		if (secret === void 0) {
			if (session !== void 0) {
				session.state = "error";
				session.error = "回调里没有找到凭证字段：" + [...url.searchParams.keys()].join(", ");
			}
			respondPage(response, false, "没有收到凭证，回到 DSH 看看卡片上的说明。");
			return;
		}
		if (session !== void 0) {
			session.state = "done";
			session.secret = secret;
			delete session.error;
		}
		respondPage(response, true, `已完成 ${meta?.name ?? vendor} 的登录，可以关闭这个页面，回到 DSH。`);
	});
	server.on("error", (error) => {
		const session = sessions.get(id);
		if (session !== void 0) {
			session.state = "error";
			session.error = `本地回调端口启动失败：${error.message}`;
		}
	});
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		const redirect = `http://127.0.0.1:${port}/callback`;
		const authorizeUrl = (spec.authorizeUrl ?? "").replace("{redirect}", encodeURIComponent(redirect));
		const session = {
			id,
			vendor,
			state: "waiting",
			createdAt: Date.now(),
			url: authorizeUrl,
			port
		};
		sessions.set(id, session);
		openBrowser(authorizeUrl);
	});
	servers.set(id, server);
	const placeholder = {
		id,
		vendor,
		state: "waiting",
		createdAt: Date.now(),
		url: ""
	};
	sessions.set(id, sessions.get(id) ?? placeholder);
	return sessions.get(id);
}
function extractSecret(url, spec) {
	const out = {};
	for (const key of spec.tokenParams) {
		const value = url.searchParams.get(key);
		if (value !== null && value.trim().length > 0) {
			out["token"] = value.trim();
			break;
		}
	}
	if (out["token"] === void 0) return;
	for (const key of spec.extraParams ?? []) {
		const value = url.searchParams.get(key);
		if (value !== null && value.trim().length > 0) out[key === "refresh_token" ? "refresh" : key] = value.trim();
	}
	return out;
}
function respondPage(response, ok, message) {
	const tone = ok ? "#2f9e6a" : "#cc4b48";
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Magpie Connect</title></head>
<body style="font:15px/1.6 system-ui,sans-serif;padding:40px;max-width:520px;margin:0 auto">
<h2 style="color:${tone};margin:0 0 8px">${ok ? "登录完成" : "没有拿到凭证"}</h2>
<p>${message}</p></body></html>`);
}
function closeServer(id) {
	const server = servers.get(id);
	if (server !== void 0) {
		server.close();
		servers.delete(id);
	}
}
function pollBrowserLogin(id) {
	const session = sessions.get(id);
	if (session === void 0) return void 0;
	if (session.state === "done" || session.state === "error" || session.state === "cancelled") closeServer(id);
	if (Date.now() - session.createdAt > SESSION_TTL_MS) {
		session.state = "error";
		session.error = "登录超时（10 分钟），请重试";
		closeServer(id);
	}
	return session;
}
function cancelBrowserLogin(id) {
	const session = sessions.get(id);
	if (session !== void 0) session.state = "cancelled";
	closeServer(id);
}
function cancelSessionsOf(vendor) {
	for (const [id, session] of sessions) if (session.vendor === vendor && session.state === "waiting") {
		session.state = "cancelled";
		closeServer(id);
	}
}
/** Drop every loopback listener (called when the plugin's fiber unwinds). */
function closeAllLogins() {
	for (const id of [...servers.keys()]) closeServer(id);
	for (const session of sessions.values()) if (session.state === "waiting") session.state = "cancelled";
}
// src/host/routes.ts
const MAX_BODY_BYTES = 32768;
function sendJson(response, status, payload) {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8"
	});
	response.end(JSON.stringify(payload));
}
function isLoopbackHost(host) {
	const value = host.split(":")[0] ?? "";
	return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]" || value === "0.0.0.0";
}
/**
* Refuse a mutating request that did not come from this page. `Origin`, when
* present, must match `Host`; a browser always sends it on a POST.
*/
function sameOrigin(request) {
	const origin = request.headers.origin;
	if (typeof origin !== "string" || origin.length === 0) {
		const host = request.headers.host;
		return typeof host === "string" && isLoopbackHost(host);
	}
	try {
		const parsed = new URL(origin);
		const host = request.headers.host;
		return typeof host === "string" && parsed.host === host;
	} catch {
		return false;
	}
}
async function readBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new Error("请求体过大");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text.length === 0) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("请求体不是 JSON");
	}
}
function asObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function asString(value) {
	return typeof value === "string" ? value : "";
}
function isVendor(value) {
	return vendorMeta(value) !== void 0;
}
function mountRoutes(deps) {
	const { options } = deps;
	/** GET status */
	async function status(request, response) {
		const host = request.headers.host;
		if (typeof host !== "string" || !isLoopbackHost(host)) {
			if (host === void 0) {
				sendJson(response, 403, { error: "missing_host" });
				return;
			}
		}
		sendJson(response, 200, buildStatus(options, deps.scheduler()));
	}
	/** GET settings */
	async function getSettings(_request, response) {
		const settings = loadSettings();
		sendJson(response, 200, {
			value: settings,
			user: settings,
			base: settings
		});
	}
	/** POST settings */
	async function postSettings(request, response) {
		if (!sameOrigin(request)) {
			sendJson(response, 403, { error: "cross_origin" });
			return;
		}
		let body;
		try {
			body = asObject(await readBody(request));
		} catch (error) {
			sendJson(response, 400, { error: error.message });
			return;
		}
		const current = loadSettings();
		const patch = {};
		if (typeof body["autoCheckin"] === "boolean") patch.autoCheckin = body["autoCheckin"];
		if (typeof body["sidebarCard"] === "boolean") patch.sidebarCard = body["sidebarCard"];
		if (typeof body["checkinMinute"] === "number" && Number.isInteger(body["checkinMinute"])) patch.checkinMinute = Math.min(1439, Math.max(0, body["checkinMinute"]));
		if (typeof body["pollMs"] === "number" && Number.isFinite(body["pollMs"])) patch.pollMs = Math.max(POLL_MIN_MS, Math.round(body["pollMs"]));
		const accountId = asString(body["accountId"]);
		const accountPatch = asString(body["accountPatch"]);
		if (accountId.length > 0 && (accountPatch === "checkin-off" || accountPatch === "checkin-on")) {
			const off = new Set(current.checkinOff);
			if (accountPatch === "checkin-off") off.add(accountId);
			else off.delete(accountId);
			patch.checkinOff = [...off];
		}
		if (accountId.length > 0 && (accountPatch === "hide" || accountPatch === "show")) {
			const hidden = new Set(current.hidden);
			if (accountPatch === "hide") hidden.add(accountId);
			else hidden.delete(accountId);
			patch.hidden = [...hidden];
		}
		const saved = Object.keys(patch).length > 0 ? patchSettings(patch) : saveSettings(current);
		if (patch.autoCheckin !== void 0 || patch.checkinMinute !== void 0) deps.reschedule();
		sendJson(response, 200, {
			value: saved,
			user: saved,
			base: saved
		});
	}
	/** POST auth */
	async function postAuth(request, response) {
		if (!sameOrigin(request)) {
			sendJson(response, 403, { error: "cross_origin" });
			return;
		}
		let body;
		try {
			body = asObject(await readBody(request));
		} catch (error) {
			sendJson(response, 400, { error: error.message });
			return;
		}
		const action = asString(body["action"]);
		const id = asString(body["id"]);
		const vendorRaw = asString(body["vendor"]);
		if (action === "remove") {
			if (id.length === 0) {
				sendJson(response, 400, { error: "missing_id" });
				return;
			}
			const removed = removeAccount(id);
			sendJson(response, removed ? 200 : 404, { ok: removed });
			return;
		}
		if (action === "removeVendor") {
			if (!isVendor(vendorRaw)) {
				sendJson(response, 400, { error: "unknown_vendor" });
				return;
			}
			sendJson(response, 200, {
				ok: true,
				removed: removeVendor(vendorRaw)
			});
			return;
		}
		if (action !== "save") {
			sendJson(response, 400, { error: "unknown_action" });
			return;
		}
		if (!isVendor(vendorRaw)) {
			sendJson(response, 400, { error: "unknown_vendor" });
			return;
		}
		const meta = vendorMeta(vendorRaw);
		const secretRaw = asObject(body["secret"]);
		const secret = {};
		for (const field of meta.credential.fields) {
			const value = asString(secretRaw[field.key]).trim();
			if (field.required && value.length === 0) {
				sendJson(response, 400, {
					error: "missing_field",
					field: field.key
				});
				return;
			}
			if (value.length > 0) secret[field.key] = value;
		}
		if (Object.keys(secret).length === 0) {
			sendJson(response, 400, { error: "empty_secret" });
			return;
		}
		const record = saveAccount({
			vendor: vendorRaw,
			label: asString(body["label"]),
			account: asString(body["account"]),
			secret
		});
		const status = await refreshAccount(record, options);
		sendJson(response, 200, {
			ok: true,
			id: record.id,
			status
		});
	}
	/** POST refresh */
	async function postRefresh(request, response) {
		if (!sameOrigin(request)) {
			sendJson(response, 403, { error: "cross_origin" });
			return;
		}
		let body = {};
		try {
			body = asObject(await readBody(request));
		} catch (error) {
			sendJson(response, 400, { error: error.message });
			return;
		}
		const id = asString(body["id"]);
		if (id.length === 0) {
			sendJson(response, 200, {
				ok: true,
				accounts: await refreshAll(options)
			});
			return;
		}
		const record = findAccount(id);
		if (record === void 0) {
			sendJson(response, 404, { error: "unknown_account" });
			return;
		}
		sendJson(response, 200, {
			ok: true,
			status: await refreshAccount(record, options)
		});
	}
	/** POST checkin */
	async function postCheckin(request, response) {
		if (!sameOrigin(request)) {
			sendJson(response, 403, { error: "cross_origin" });
			return;
		}
		let body = {};
		try {
			body = asObject(await readBody(request));
		} catch (error) {
			sendJson(response, 400, { error: error.message });
			return;
		}
		const id = asString(body["id"]);
		const manual = body["manual"] !== false;
		if (id.length === 0) {
			sendJson(response, 200, {
				ok: true,
				results: await checkinAll(options)
			});
			return;
		}
		const record = findAccount(id);
		if (record === void 0) {
			sendJson(response, 404, { error: "unknown_account" });
			return;
		}
		sendJson(response, 200, {
			ok: true,
			status: await checkinAccount(record, options, manual)
		});
	}
	/** POST log/clear */
	async function postLogClear(request, response) {
		if (!sameOrigin(request)) {
			sendJson(response, 403, { error: "cross_origin" });
			return;
		}
		clearLog();
		sendJson(response, 200, { ok: true });
	}
	/** GET accounts - the account book without any secret. */
	async function getAccounts(_request, response) {
		sendJson(response, 200, { accounts: listAccounts().map((record) => ({
			id: record.id,
			vendor: record.vendor,
			label: record.label,
			account: record.account ?? "",
			plan: record.plan ?? "",
			createdAt: record.createdAt
		})) });
	}
	/**
	* POST browser/start - open the vendor's sign-in page in the system browser
	* with a loopback redirect. The credential comes back to this process, never
	* through the page.
	*/
	async function postBrowserStart(request, response) {
		if (!sameOrigin(request)) {
			sendJson(response, 403, { error: "cross_origin" });
			return;
		}
		let body;
		try {
			body = asObject(await readBody(request));
		} catch (error) {
			sendJson(response, 400, { error: error.message });
			return;
		}
		const vendorRaw = asString(body["vendor"]);
		if (!isVendor(vendorRaw)) {
			sendJson(response, 400, { error: "unknown_vendor" });
			return;
		}
		const session = startBrowserLogin(vendorRaw);
		sendJson(response, 200, {
			session: session.id,
			state: session.state,
			url: session.url,
			note: session.error ?? null
		});
	}
	/**
	* GET browser/status - poll one sign-in. When the callback has delivered a
	* credential it is saved here, so the secret never travels to the browser.
	*/
	async function getBrowserStatus(request, response) {
		const session = pollBrowserLogin(new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`).searchParams.get("session") ?? "");
		if (session === void 0) {
			sendJson(response, 404, { error: "unknown_session" });
			return;
		}
		if (session.state === "done" && session.secret !== void 0) {
			const record = saveAccount({
				vendor: session.vendor,
				secret: session.secret
			});
			const status = await refreshAccount(record, options);
			session.secret = void 0;
			session.state = "done";
			sendJson(response, 200, {
				state: "saved",
				id: record.id,
				status
			});
			return;
		}
		sendJson(response, 200, {
			state: session.state,
			note: session.error ?? null
		});
	}
	/** POST browser/cancel - drop one pending sign-in and its listener. */
	async function postBrowserCancel(request, response) {
		if (!sameOrigin(request)) {
			sendJson(response, 403, { error: "cross_origin" });
			return;
		}
		let body;
		try {
			body = asObject(await readBody(request));
		} catch (error) {
			sendJson(response, 400, { error: error.message });
			return;
		}
		cancelBrowserLogin(asString(body["session"]));
		sendJson(response, 200, { ok: true });
	}
	return [
		{
			kind: "exact",
			path: `${ROUTE_BASE}/status`,
			handler: status
		},
		{
			kind: "exact",
			path: `${ROUTE_BASE}/settings`,
			handler: (request, response) => request.method === "POST" ? postSettings(request, response) : getSettings(request, response)
		},
		{
			kind: "exact",
			path: `${ROUTE_BASE}/auth`,
			handler: postAuth
		},
		{
			kind: "exact",
			path: `${ROUTE_BASE}/refresh`,
			handler: postRefresh
		},
		{
			kind: "exact",
			path: `${ROUTE_BASE}/checkin`,
			handler: postCheckin
		},
		{
			kind: "exact",
			path: `${ROUTE_BASE}/log/clear`,
			handler: postLogClear
		},
		{
			kind: "exact",
			path: `${ROUTE_BASE}/accounts`,
			handler: getAccounts
		},
		{
			kind: "exact",
			path: `${ROUTE_BASE}/auth/browser/start`,
			handler: postBrowserStart
		},
		{
			kind: "exact",
			path: `${ROUTE_BASE}/auth/browser/status`,
			handler: getBrowserStatus
		},
		{
			kind: "exact",
			path: `${ROUTE_BASE}/auth/browser/cancel`,
			handler: postBrowserCancel
		}
	];
}
// src/index.ts
const name = "magpie-connect";
/** The services this plugin needs before it can mount its routes. */
const inject = ["webServer"];
/** Bumped with every release; the panel shows it in its footer. */
const VERSION = "0.1.0";
/** Delay before the first read, so a cold boot is not charged with it. */
const FIRST_READ_DELAY_MS = 4e3;
/** How often the ticker checks whether the check-in minute has arrived. */
const TICK_MS = 3e4;
function apply(ctx) {
	const logger = ctx.logger;
	const options = {
		version: VERSION,
		logger: {
			warn: (...args) => logger.warn(...args),
			info: (...args) => logger.info(...args)
		}
	};
	const state = {
		enabled: loadSettings().autoCheckin,
		nextAt: null,
		lastAt: null
	};
	/** Re-arm the timer from the stored settings; called after every change. */
	function reschedule() {
		const settings = loadSettings();
		state.enabled = settings.autoCheckin;
		state.nextAt = settings.autoCheckin ? nextCheckinAt(settings.checkinMinute) : null;
	}
	reschedule();
	let timer;
	let running = false;
	/** One tick: sweep when the minute has arrived and today has not been swept. */
	async function tick() {
		if (running) return;
		const settings = loadSettings();
		if (!settings.autoCheckin) {
			if (state.nextAt !== null) state.nextAt = null;
			return;
		}
		const now = Date.now();
		const target = shanghaiWallClockToUtc(shanghaiDay(now), settings.checkinMinute);
		const lastDay = state.lastAt === null ? null : shanghaiDay(new Date(state.lastAt));
		if (now < target) {
			state.nextAt = new Date(target).toISOString();
			return;
		}
		if (lastDay === shanghaiDay(now)) {
			state.nextAt = new Date(target + 864e5).toISOString();
			return;
		}
		if (listAccounts().length === 0) {
			state.nextAt = new Date(target + 864e5).toISOString();
			return;
		}
		running = true;
		try {
			logger.info(`dsh-magpie-connect: 开始每日签到（北京时间 ${formatMinute(settings.checkinMinute)}）`);
			await checkinAll(options);
			state.lastAt = (/* @__PURE__ */ new Date()).toISOString();
			logger.info("dsh-magpie-connect: 每日签到完成");
		} catch (error) {
			logger.warn(`dsh-magpie-connect: 每日签到异常 - ${error.message}`);
		} finally {
			running = false;
			state.nextAt = new Date(target + 864e5).toISOString();
		}
	}
	function formatMinute(minute) {
		const hours = Math.floor(minute / 60);
		const minutes = minute % 60;
		return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
	}
	ctx.effect(() => () => closeAllLogins(), "dsh-magpie-connect: browser logins");
	ctx.effect(() => {
		timer = setInterval(() => {
			tick();
		}, TICK_MS);
		const firstRead = setTimeout(() => {
			refreshAll(options).catch(() => void 0);
			tick();
		}, FIRST_READ_DELAY_MS);
		return () => {
			clearInterval(timer);
			clearTimeout(firstRead);
		};
	}, "dsh-magpie-connect: scheduler");
	ctx.inject(["webServer"], (scoped) => {
		const server = scoped.webServer;
		if (server === void 0 || typeof server.register !== "function") {
			logger.warn("dsh-magpie-connect: 宿主没有提供 webServer，面板将无法读取状态");
			return;
		}
		const routes = mountRoutes({
			options,
			scheduler: () => ({ ...state }),
			reschedule
		});
		for (const route of routes) ctx.effect(() => server.register(route), `dsh-magpie-connect: ${route.path}`);
		logger.info(`dsh-magpie-connect: 已挂载 ${routes.length} 条路由于 ${ROUTE_BASE}`);
	});
}
export { VERSION, apply, buildStatus, inject, name };
