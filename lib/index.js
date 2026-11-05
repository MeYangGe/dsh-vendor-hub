import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
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
/**
* Qoder's own usage page, as magpie reads it (`internal/provider/qoder_usage.go`,
* and `opencode-qoder-auth`'s `fetchUsage`):
*
*   GET {openapi}/sash/api/v2/me/usage
*   Authorization: Bearer <device token>   ← the device token, NOT the job token
*   Cosy-ClientType: 10
*   User-Agent: Qoder
*
* The answer is `{displayMode, qoderUsage}`: an enterprise account reports only
* its mode, a personal one lists the pools of credits it may spend.
*/
async function fetchUsage(account, vendor) {
	const host = HOSTS[vendor];
	if (host === void 0) return null;
	const device = firstStr(account.secret["deviceToken"], account.secret["token"]);
	if (device.length === 0) return null;
	const result = await requestRaw(`${host}/sash/api/v2/me/usage`, {
		method: "GET",
		headers: {
			accept: "application/json",
			authorization: `Bearer ${device}`,
			"cosy-clienttype": "10",
			"user-agent": "Qoder"
		}
	});
	if (!result.ok || result.json === void 0) return null;
	return parseUsage(result.json, account);
}
/** The pools Qoder spends one after another before an account stops. */
const SPENT_IN_TURN = /* @__PURE__ */ new Set([
	"Credits",
	"Add-on credits",
	"Shared credits"
]);
function creditWindow(candidate, fallbackName) {
	const record = asRecord(candidate);
	if (Object.keys(record).length === 0) return null;
	const total = firstNum(record["total"], record["cap"], record["totalQuota"], record["total_quota"]);
	const used = firstNum(record["used"], record["usedQuota"], record["used_quota"]);
	const remaining = firstNum(record["remaining"], record["remain"], record["available"], record["remainingQuota"]);
	if (total === null && used === null && remaining === null) return null;
	const name = firstStr(record["name"], record["packageName"], record["title"]);
	return windowOf({
		name: name.length > 0 ? name : fallbackName,
		unit: "credits",
		total,
		used,
		remaining,
		expiresAt: isoTimestamp(record["expiresAt"] ?? record["expires_at"] ?? record["expireAt"])
	});
}
function parseUsage(payload, account) {
	const env = asRecord(payload);
	const mode = firstStr(env["displayMode"], env["display_mode"]);
	if (mode === "enterprise") return {
		account: account.account ?? "",
		plan: "Enterprise",
		windows: [],
		balance: null,
		fetchedAt: nowIso()
	};
	if (mode !== "qoder") return null;
	const usage = asRecord(env["qoderUsage"] ?? env["qoder_usage"]);
	if (Object.keys(usage).length === 0) return null;
	const windows = [];
	const push = (candidate, name) => {
		const window = creditWindow(candidate, name);
		if (window !== null) windows.push(window);
	};
	push(usage["userQuota"] ?? usage["user_quota"], "Credits");
	push(usage["addOnQuota"] ?? usage["add_on_quota"], "Add-on credits");
	push(usage["orgResourcePackage"] ?? usage["org_resource_package"], "Shared credits");
	asArray(usage["dedicatedResourcePackages"] ?? usage["dedicated_resource_packages"]).forEach((item, index) => {
		push(item, `Dedicated ${index + 1}`);
	});
	if (windows.length === 0) return null;
	const plan = firstStr(usage["userType"], usage["user_type"]);
	const shared = windows.filter((window) => SPENT_IN_TURN.has(window.name)).length > 1;
	return {
		account: account.account ?? "",
		plan: plan.length > 0 ? plan : null,
		windows: shared ? windows.map((window) => ({
			...window,
			note: "多个额度池按顺序消耗"
		})) : windows,
		balance: null,
		fetchedAt: nowIso()
	};
}
function createAdapter$1(vendor) {
	return {
		id: vendor,
		async readQuota(account) {
			const usage = await fetchUsage(account, vendor);
			if (usage !== null) return usage;
			const windows = quotaWindowsOf({ campaigns: (await fetchCampaigns(account, vendor)).map((campaign) => campaign.raw) });
			if (windows.length === 0) throw new AdapterFailure({
				code: "unsupported",
				message: (firstStr(account.secret["deviceToken"], account.secret["token"]).length === 0 ? "这个 Qoder 账号没有保存 device token，读不到用量页；" : "Qoder 的用量页 /sash/api/v2/me/usage 没有返回额度块（可能账号无计划或凭据已被换掉）；") + "请用「浏览器登录」重新接入，或到 Qoder 客户端查看额度。"
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
* Browser sign-in, modelled on magpie's own plugin contract.
*
* magpie's plugins declare `auth.methods[].authorize()`, which returns
* `{ url, instructions, method: 'auto' | 'code', callback }`. With `auto` the
* host opens `url` and the plugin's own `callback` settles the credential -
* either by catching a loopback redirect or by polling the vendor. This module
* is that host side, and the two implemented flows are ported from the plugins
* actually installed on the magpie server
* (`.../plugins/node_modules/@magpie-community/opencode-*-auth/index.mjs`):
*
*   trae-cn   loopback `/authorize`; the page sends `userJwt` + `refreshToken`
*             as query parameters (NOT `Cloud-IDE-JWT`, NOT `/callback`);
*             authorize URL `https://www.trae.cn/authorization?…`
*   qoder-*   PKCE device flow: `{web}/device/selectAccounts?…`, then poll
*             `{openapi}/api/v1/deviceToken/poll`, then `/api/v1/me/jobToken`
*
* Every credential is collected inside this process. Nothing is written to disk
* here: the caller stores it through the account book once the session is done.
*/
const SIGN_IN_TIMEOUT_MS = 3e5;
const SESSION_TTL_MS = 6e5;
const sessions = /* @__PURE__ */ new Map();
const closers = /* @__PURE__ */ new Map();
/** Open a URL in the operating system's default browser. */
function openBrowser(url) {
	if (process.env["DSH_MAGPIE_CONNECT_NO_BROWSER"] === "1") return;
	const quoted = url.replace(/"/g, "%22");
	const command = process.platform === "win32" ? `cmd /c start "" "${quoted}"` : process.platform === "darwin" ? `open "${quoted}"` : `xdg-open "${quoted}"`;
	exec(command, () => {});
}
function base64url(buffer) {
	return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function page(ok, title, detail) {
	return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Magpie Connect</title></head>
<body style="font:15px/1.6 system-ui,sans-serif;padding:40px;max-width:560px;margin:0 auto">
<h2 style="color:${ok ? "#2f9e6a" : "#cc4b48"};margin:0 0 8px">${title}</h2><p>${detail}</p></body></html>`;
}
/**
* Trae CN, ported from `opencode-trae-auth/index.mjs` `browserSignIn()`.
* The callback URL must be resolved before the authorize page can be built, so
* this flow is async: it listens first, then hands back the URL.
*/
async function traeCnFlow() {
	const device = {
		machineId: randomUUID(),
		deviceId: randomBytes(8).toString("hex")
	};
	const trace = randomUUID();
	let over = false;
	let settle = () => void 0;
	let fail = () => void 0;
	const done = new Promise((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	const finish = (fn) => {
		if (over) return;
		over = true;
		fn();
	};
	const server = createServer((request, response) => {
		const cors = {
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET, OPTIONS",
			"access-control-allow-headers": "Content-Type"
		};
		if (request.method === "OPTIONS") {
			response.writeHead(204, cors).end();
			return;
		}
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const html = (body) => {
			response.writeHead(200, {
				...cors,
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store"
			});
			response.end(body);
		};
		if (url.pathname !== "/authorize") {
			response.writeHead(404, cors).end();
			return;
		}
		if (over) {
			html(page(false, "这次登录已结束", "请在 DSH 里重新发起。"));
			return;
		}
		const query = url.searchParams;
		const error = query.get("error");
		if (error !== null) {
			const reason = query.get("error_description") ?? error;
			finish(() => fail(/* @__PURE__ */ new Error(`Trae CN 拒绝登录：${reason}`)));
			html(page(false, "登录没有完成", reason));
			return;
		}
		const jwt = query.get("userJwt") ?? query.get("jwt") ?? "";
		const refresh = query.get("refreshToken") ?? "";
		if (jwt.length === 0) {
			html(page(false, "没有收到凭证", "Trae CN 没有回传 userJwt，请回到 DSH 重新发起登录。"));
			return;
		}
		finish(() => settle({
			token: jwt,
			...refresh.length > 0 ? { refresh } : {},
			deviceId: device.deviceId
		}));
		html(page(true, "登录完成", "Trae CN 账号已接入，可以关闭这个页面。"));
	});
	const timer = setTimeout(() => finish(() => fail(/* @__PURE__ */ new Error("登录超时（5 分钟），请重试"))), SIGN_IN_TIMEOUT_MS);
	done.then(() => clearTimeout(timer)).catch(() => clearTimeout(timer));
	const port = await new Promise((resolve, reject) => {
		server.once("error", (error) => reject(/* @__PURE__ */ new Error(`本地回调端口启动失败：${error.message}`)));
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve(typeof address === "object" && address !== null ? address.port : 0);
		});
	});
	return {
		mode: "loopback",
		url: `https://www.trae.cn/authorization?${new URLSearchParams({
			login_version: "1",
			auth_from: "solo",
			login_channel: "native_ide",
			plugin_version: "2.3.24254",
			auth_type: "local",
			client_id: "ono9krqynydwx5",
			redirect: "0",
			login_trace_id: trace,
			auth_callback_url: `http://127.0.0.1:${port}/authorize`,
			machine_id: device.machineId,
			device_id: device.deviceId,
			x_device_id: device.deviceId,
			x_machine_id: device.machineId,
			x_device_brand: "ASUS TUF Gaming A15 FA507RM_FA507RM",
			x_device_type: "windows",
			x_os_version: "Windows 10 Pro",
			x_env: "",
			x_app_version: "3.3.65",
			x_app_type: "stable",
			hide_saas_login: "false"
		}).toString()}`,
		instructions: "在浏览器里登录 trae.cn 并允许授权；登录会自行回到本机完成，无需复制任何东西。",
		wait: () => done,
		close: () => {
			clearTimeout(timer);
			server.close();
			finish(() => fail(/* @__PURE__ */ new Error("已取消")));
		}
	};
}
/**
* Qoder, ported from `opencode-qoder-auth/index.mjs` `deviceSignIn()`:
* PKCE device authorization, then `deviceToken/poll`, then a job token.
*/
function qoderFlow(vendor) {
	const site = vendor === "qoder-cn" ? {
		name: "Qoder CN",
		clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
		web: "https://qoder.cn",
		openapi: "https://openapi.qoder.com.cn"
	} : {
		name: "Qoder",
		clientId: "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa",
		web: "https://qoder.com",
		openapi: "https://openapi.qoder.sh"
	};
	const verifier = base64url(randomBytes(64));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	const nonce = randomUUID();
	const machineId = randomUUID();
	let cancelled = false;
	const query = new URLSearchParams({
		challenge,
		challenge_method: "S256",
		nonce,
		machine_id: machineId,
		client_id: site.clientId
	});
	async function poll() {
		const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
		let deviceToken = "";
		while (!cancelled) {
			if (Date.now() > deadline) throw new Error("登录超时（5 分钟），请重试");
			try {
				const pollQuery = new URLSearchParams({
					nonce,
					verifier,
					challenge_method: "S256"
				});
				const result = await httpRequest(`${site.openapi}/api/v1/deviceToken/poll?${pollQuery.toString()}`, {
					method: "GET",
					headers: { accept: "application/json" },
					timeoutMs: 2e4
				});
				const body = result.json;
				const token = typeof body?.["token"] === "string" ? body["token"].trim() : "";
				if (result.status === 200 && token.length > 0) {
					deviceToken = token;
					break;
				}
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 2e3));
		}
		if (deviceToken.length === 0) throw new Error("已取消");
		try {
			const exchange = await httpRequest(`${site.openapi}/api/v1/me/jobToken`, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					authorization: `Bearer ${deviceToken}`
				},
				body: JSON.stringify({ clientId: site.clientId }),
				timeoutMs: 2e4
			});
			const body = exchange.json;
			const jobToken = typeof body?.["token"] === "string" ? body["token"].trim() : "";
			if (exchange.status === 200 && jobToken.length > 0) return {
				token: jobToken,
				deviceToken
			};
		} catch {}
		return {
			token: deviceToken,
			deviceToken
		};
	}
	return {
		mode: "device-poll",
		url: `${site.web}/device/selectAccounts?${query.toString()}`,
		instructions: `在浏览器里登录 ${site.name} 并授权这台设备；授权后会自动回传，无需复制。`,
		wait: poll,
		close: () => {
			cancelled = true;
		}
	};
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
* WorkBuddy, ported from `opencode-workbuddy-auth/index.mjs` `browserSignIn()`.
*
* The vendor issues the sign-in itself: ask for a `state`, open the `authUrl` it
* returns, then poll `auth/token?state=` until the browser finishes. Magpie reads
* the same flow the desktop app uses, and code 11217 simply means "not yet".
*/
async function workbuddyFlow(vendor) {
	const site = vendor === "workbuddy" ? {
		name: "WorkBuddy",
		endpoint: "https://copilot.tencent.com",
		platform: "workbuddy"
	} : {
		name: "WorkBuddy AI",
		endpoint: "https://www.workbuddy.ai",
		platform: "workbuddy-ai"
	};
	const appVersion = "5.9.3";
	const quiet = {
		"x-no-authorization": "true",
		"x-no-user-id": "true",
		"x-no-enterprise-id": "true",
		"x-no-department-info": "true"
	};
	async function call(method, path, headers = {}, body = void 0) {
		const result = await httpRequest(site.endpoint + path, {
			method,
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				"user-agent": `WorkBuddy/${appVersion}`,
				...headers
			},
			...body === void 0 ? {} : { body: JSON.stringify(body) },
			timeoutMs: 3e4
		});
		const envelope = result.json ?? {};
		const code = Number.parseInt(String(envelope["code"] ?? "0"), 10) || 0;
		const data = envelope["data"] ?? null;
		if (result.status < 200 || result.status >= 300 || code !== 0) {
			const raw = envelope["msg"] ?? envelope["message"] ?? `HTTP ${result.status}`;
			const error = /* @__PURE__ */ new Error(`${site.name}: ${String(raw)}${code === 0 ? "" : `（code ${code}）`}`);
			error.vendorCode = code;
			throw error;
		}
		return data;
	}
	/** Poll until the vendor answers, tolerating the "still waiting" code. */
	async function until(path, headers, keepCode, deadline) {
		for (;;) {
			if (Date.now() > deadline) throw new Error(`${site.name} 登录超时（5 分钟），请重试`);
			try {
				const data = await call("GET", path, headers);
				if (data !== null && Object.keys(data).length > 0) return data;
			} catch (error) {
				if (error.vendorCode !== keepCode) throw error;
			}
			await sleep(1e3);
		}
	}
	const state = await call("POST", `/v2/plugin/auth/state?platform=${encodeURIComponent(site.platform)}`, quiet, {});
	const stateToken = typeof state?.["state"] === "string" ? state["state"] : "";
	const authUrl = typeof state?.["authUrl"] === "string" ? state["authUrl"] : "";
	if (stateToken.length === 0 || authUrl.length === 0) throw new Error(`${site.name} 没有给出登录页`);
	const url = new URL(authUrl);
	if (url.protocol !== "https:") throw new Error(`${site.name} 的登录页不是 https`);
	url.searchParams.set("version", appVersion);
	url.searchParams.set("loginSessionId", randomBytes(8).toString("hex"));
	const encoded = encodeURIComponent(stateToken);
	return {
		mode: "device-poll",
		url: url.toString(),
		instructions: `在浏览器里登录 ${site.name}；登录完成后会自动回传，无需复制。`,
		async wait() {
			const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
			const token = await until(`/v2/plugin/auth/token?state=${encoded}`, {}, 11217, deadline);
			const wire = token["accessToken"] ?? token["access_token"] ?? token["access"];
			const access = typeof wire === "string" ? wire.trim() : "";
			if (access.length === 0) throw new Error(`${site.name} 没有回传 access token（响应字段：${Object.keys(token).join(", ") || "空"}）`);
			const domain = typeof token["domain"] === "string" && token["domain"].length > 0 ? token["domain"] : "";
			let uid = "";
			try {
				const account = await until(`/v2/plugin/login/account?state=${encoded}`, {
					authorization: `Bearer ${access}`,
					...domain.length > 0 ? { "x-domain": domain } : {},
					"x-no-user-id": "true",
					"x-no-enterprise-id": "true"
				}, 12151, deadline);
				uid = typeof account["uid"] === "string" ? account["uid"] : "";
			} catch {}
			const refresh = typeof token["refresh"] === "string" ? token["refresh"] : "";
			return {
				token: access,
				...refresh.length > 0 ? { refresh } : {},
				...domain.length > 0 ? { domain } : {},
				...uid.length > 0 ? { uid } : {}
			};
		},
		close: () => void 0
	};
}
/**
* ZCode / BigModel, ported from `opencode-zcode-auth/index.mjs`.
*
* `oauth/cli/init` opens a flow, the browser signs in on Z.ai or BigModel, and
* `oauth/cli/poll/{flow_id}` reports `pending` until it is `ready` with the
* account's access token.
*/
async function zcodeFlow() {
	const zcode = "https://zcode.z.ai";
	const appVersion = "3.17.2";
	const pollAuth = "Bearer " + randomBytes(32).toString("hex");
	const device = randomUUID();
	let cancelled = false;
	async function call(method, path, body = void 0) {
		const result = await httpRequest(zcode + path, {
			method,
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				"user-agent": `ZCode/${appVersion}`,
				authorization: pollAuth,
				"x-device-mid": device
			},
			...body === void 0 ? {} : { body: JSON.stringify(body) },
			timeoutMs: 3e4
		});
		const envelope = result.json ?? {};
		const code = envelope["code"] === null || envelope["code"] === void 0 ? "" : String(envelope["code"]);
		if (result.status < 200 || result.status >= 300 || code !== "" && code !== "0" && code !== "200") {
			const raw = envelope["msg"] ?? `HTTP ${result.status}`;
			throw new Error(`ZCode: ${String(raw)}${code === "" ? "" : `（code ${code}）`}`);
		}
		return envelope["data"] ?? null;
	}
	const flow = await call("POST", "/api/v1/oauth/cli/init", { provider: "zai" });
	const authorizeUrl = typeof flow?.["authorize_url"] === "string" ? flow["authorize_url"] : "";
	const flowId = typeof flow?.["flow_id"] === "string" ? flow["flow_id"] : "";
	if (flowId.length === 0) throw new Error("ZCode 没有给出登录流程");
	let page;
	try {
		page = new URL(authorizeUrl);
	} catch {
		throw new Error("ZCode 给出的登录页不是合法 URL");
	}
	if (page.protocol !== "https:") throw new Error("ZCode 的登录页不是 https");
	const back = `${zcode}/app/oauth/login?` + new URLSearchParams({
		redirect: "zcode://oauth/callback",
		app_version: appVersion
	}).toString();
	page.searchParams.set("redirect_uri", back);
	const intervalMs = Math.max(Number(flow?.["poll_interval_sec"]) || 0, 1) * 1e3;
	const expiresAt = Number(flow?.["expires_at"]) > 0 ? Number(flow?.["expires_at"]) * 1e3 : Date.now() + SIGN_IN_TIMEOUT_MS;
	return {
		mode: "device-poll",
		url: page.toString(),
		instructions: "在浏览器里登录 Z.ai；登录完成后会自动回传，无需复制。",
		async wait() {
			for (;;) {
				await sleep(intervalMs);
				if (cancelled) throw new Error("已取消");
				if (Date.now() > expiresAt) throw new Error("ZCode 登录超时，请重试");
				let got = null;
				try {
					got = await call("GET", `/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (/HTTP 4\d\d/.test(message)) throw error;
					continue;
				}
				const status = typeof got?.["status"] === "string" ? got["status"] : "";
				if (status === "pending" || status === "") continue;
				if (status === "failed") throw new Error("ZCode 侧的登录被拒绝");
				const zai = got?.["zai"];
				const access = typeof zai?.["access_token"] === "string" ? zai["access_token"] : typeof zai?.["accessToken"] === "string" ? zai["accessToken"] : "";
				if (status !== "ready" || access.length === 0) throw new Error(`ZCode 返回了意外的状态：${status}`);
				const jwt = typeof got?.["token"] === "string" ? got["token"] : "";
				return {
					token: access,
					...jwt.length > 0 ? { jwt } : {}
				};
			}
		},
		close: () => {
			cancelled = true;
		}
	};
}
/** Vendors whose sign-in the official client owns: open the page, paste by hand. */
function manualFlow(vendor, pageUrl, why) {
	const meta = vendorMeta(vendor);
	return {
		mode: "manual",
		url: pageUrl,
		instructions: why,
		wait: () => Promise.reject(/* @__PURE__ */ new Error(`${meta?.name ?? vendor}：${why} 已在浏览器打开官方页面，取到令牌后粘贴回卡片即可。`)),
		close: () => void 0
	};
}
/** Where each vendor's browser sign-in goes, and how honest that is. */
async function startLoginFlow(vendor) {
	switch (vendor) {
		case "trae-cn": return traeCnFlow();
		case "qoder-cn": return qoderFlow("qoder-cn");
		case "qoder-global": return qoderFlow("qoder-global");
		case "workbuddy": return workbuddyFlow("workbuddy");
		case "workbuddy-ai": return workbuddyFlow("workbuddy-ai");
		case "zcode": return zcodeFlow();
		case "codearts": return manualFlow(vendor, "https://codearts.huaweicloud.com/", "CodeArts 是 PKCE + DPoP 的华为云 OAuth（STS 换临时 AK/SK），本插件尚未移植");
		default: return manualFlow(vendor, "https://example.com", "没有该供应商的登录配置");
	}
}
/** Start one vendor's sign-in: create the session, open the browser, begin waiting. */
async function startBrowserLogin(vendor) {
	cancelSessionsOf(vendor);
	const id = randomBytes(8).toString("hex");
	const flow = await startLoginFlow(vendor);
	const session = {
		id,
		vendor,
		state: "waiting",
		createdAt: Date.now(),
		mode: flow.mode,
		url: flow.url,
		instructions: flow.instructions
	};
	sessions.set(id, session);
	closers.set(id, () => flow.close());
	openBrowser(flow.url);
	flow.wait().then((secret) => {
		if (session.state !== "waiting") return;
		session.secret = secret;
		session.state = "done";
	}).catch((error) => {
		if (session.state !== "waiting") return;
		session.state = "error";
		session.error = error instanceof Error ? error.message : String(error);
		flow.close();
	});
	return session;
}
function pollBrowserLogin(id) {
	const session = sessions.get(id);
	if (session === void 0) return void 0;
	if (session.state !== "waiting") closeSession(id);
	if (Date.now() - session.createdAt > SESSION_TTL_MS && session.state === "waiting") {
		session.state = "error";
		session.error = "登录超时，请重试";
		closeSession(id);
	}
	return session;
}
function cancelBrowserLogin(id) {
	const session = sessions.get(id);
	if (session !== void 0 && session.state === "waiting") session.state = "cancelled";
	closeSession(id);
}
function closeSession(id) {
	const close = closers.get(id);
	if (close !== void 0) {
		close();
		closers.delete(id);
	}
}
function cancelSessionsOf(vendor) {
	for (const [id, session] of sessions) if (session.vendor === vendor && session.state === "waiting") {
		session.state = "cancelled";
		closeSession(id);
	}
}
/** Drop every listener (called when the plugin's fiber unwinds). */
function closeAllLogins() {
	for (const id of [...closers.keys()]) closeSession(id);
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
		const session = await startBrowserLogin(vendorRaw);
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
