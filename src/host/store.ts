/**
 * The plugin's durable state: the credential book, the settings file, the
 * quota/check-in cache and the rolling check-in log.
 *
 * Credentials live in their own file with 0600 and are never returned by any
 * route - the status document only ever carries the masked account label.
 */

import { createHash } from 'node:crypto'
import type {
  AccountQuota,
  AccountStatus,
  CheckinLogEntry,
  CheckinStatus,
  ConnectSettings,
  QuotaError,
  VendorId,
} from '../types.ts'
import { DEFAULT_SETTINGS, POLL_MIN_MS } from '../types.ts'
import { accountsPath, cachePath, logPath, readJson, settingsPath, writeJsonAtomic } from './paths.ts'

export type SecretRecord = Record<string, string>

/** One saved credential set. */
export interface AccountRecord {
  /** `${vendor}:${hash}` - stable for a given secret. */
  id: string
  vendor: VendorId
  /** What the user called it. */
  label: string
  /** Vendor-side account identifier, masked at read time. */
  account?: string
  plan?: string
  createdAt: string
  secret: SecretRecord
}

interface AccountsFile {
  schema: 1
  accounts: AccountRecord[]
}

interface CacheEntry {
  quota?: AccountQuota
  error?: QuotaError
  checkin?: CheckinStatus
  ms?: number
  at: string
}

interface CacheFile {
  schema: 1
  entries: Record<string, CacheEntry>
}

interface LogFile {
  schema: 1
  entries: CheckinLogEntry[]
}

/** Bound on the rolling log so the file cannot grow without limit. */
const LOG_LIMIT = 400

/** Deterministic short hash of a secret plus its vendor. */
export function accountIdOf(vendor: VendorId, secret: SecretRecord): string {
  const seed = vendor + '\u0000' + canonicalSecret(secret)
  return `${vendor}:${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`
}

function canonicalSecret(secret: SecretRecord): string {
  return Object.keys(secret)
    .sort()
    .map((key) => `${key}=${secret[key] ?? ''}`)
    .join('\u0001')
}

export function listAccounts(): AccountRecord[] {
  const file = readJson<AccountsFile>(accountsPath(), { schema: 1, accounts: [] })
  return Array.isArray(file.accounts) ? file.accounts.filter(isRecord) : []
}

function isRecord(value: unknown): value is AccountRecord {
  const record = value as AccountRecord | null
  return !!record && typeof record.id === 'string' && typeof record.vendor === 'string' && typeof record.secret === 'object'
}

function saveAccounts(accounts: AccountRecord[]): void {
  writeJsonAtomic(accountsPath(), { schema: 1, accounts } satisfies AccountsFile, 0o600)
}

/** Whether a credential book exists at all (drives the empty state). */
export function hasAccountsFile(): boolean {
  return listAccounts().length > 0
}

/**
 * Save (or replace) one account. A secret that hashes to an existing id updates
 * that entry in place, keeping the label the user first gave it unless a new
 * one is passed.
 */
export function saveAccount(input: {
  vendor: VendorId
  label?: string
  account?: string
  plan?: string
  secret: SecretRecord
}): AccountRecord {
  const secret: SecretRecord = {}
  for (const [key, value] of Object.entries(input.secret)) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text.length > 0) secret[key] = text
  }
  const id = accountIdOf(input.vendor, secret)
  const accounts = listAccounts()
  const index = accounts.findIndex((entry) => entry.id === id)
  const label = input.label?.trim()
  const record: AccountRecord = {
    id,
    vendor: input.vendor,
    label: label && label.length > 0 ? label : index >= 0 ? accounts[index]!.label : defaultLabel(input.vendor, accounts),
    account: input.account?.trim() || accounts[index]?.account || '',
    plan: input.plan?.trim() || accounts[index]?.plan || '',
    createdAt: index >= 0 ? accounts[index]!.createdAt : new Date().toISOString(),
    secret,
  }
  if (index >= 0) accounts[index] = record
  else accounts.push(record)
  saveAccounts(accounts)
  clearCache(id)
  return record
}

function defaultLabel(vendor: VendorId, accounts: AccountRecord[]): string {
  const siblings = accounts.filter((entry) => entry.vendor === vendor).length
  return siblings === 0 ? '主账号' : `账号 ${siblings + 1}`
}

export function removeAccount(id: string): boolean {
  const accounts = listAccounts()
  const next = accounts.filter((entry) => entry.id !== id)
  if (next.length === accounts.length) return false
  saveAccounts(next)
  clearCache(id)
  return true
}

/** Drop every credential of one vendor. */
export function removeVendor(vendor: VendorId): number {
  const accounts = listAccounts()
  const kept = accounts.filter((entry) => entry.vendor !== vendor)
  const removed = accounts.length - kept.length
  if (removed > 0) saveAccounts(kept)
  for (const entry of accounts) if (entry.vendor === vendor) clearCache(entry.id)
  return removed
}

export function findAccount(id: string): AccountRecord | undefined {
  return listAccounts().find((entry) => entry.id === id)
}

// ---------------------------------------------------------------- settings

export function loadSettings(): ConnectSettings {
  const file = readJson<Partial<ConnectSettings>>(settingsPath(), {})
  return normalizeSettings(file)
}

export function normalizeSettings(input: Partial<ConnectSettings> | undefined | null): ConnectSettings {
  const base = { ...DEFAULT_SETTINGS }
  if (!input || typeof input !== 'object') return base
  if (typeof input.autoCheckin === 'boolean') base.autoCheckin = input.autoCheckin
  if (typeof input.sidebarCard === 'boolean') base.sidebarCard = input.sidebarCard
  if (typeof input.checkinMinute === 'number' && Number.isInteger(input.checkinMinute)) {
    base.checkinMinute = Math.min(1439, Math.max(0, input.checkinMinute))
  }
  if (typeof input.pollMs === 'number' && Number.isFinite(input.pollMs)) {
    base.pollMs = Math.max(POLL_MIN_MS, Math.round(input.pollMs))
  }
  base.checkinOff = Array.isArray(input.checkinOff) ? input.checkinOff.filter((v) => typeof v === 'string') : []
  base.hidden = Array.isArray(input.hidden) ? input.hidden.filter((v) => typeof v === 'string') : []
  return base
}

export function saveSettings(settings: ConnectSettings): ConnectSettings {
  const normalized = normalizeSettings(settings)
  writeJsonAtomic(settingsPath(), normalized, 0o600)
  return normalized
}

/** Merge a partial patch into the stored settings. */
export function patchSettings(patch: Partial<ConnectSettings>): ConnectSettings {
  return saveSettings({ ...loadSettings(), ...patch })
}

// ------------------------------------------------------------------ cache

function readCache(): CacheFile {
  const file = readJson<CacheFile>(cachePath(), { schema: 1, entries: {} })
  return file && typeof file.entries === 'object' && file.entries !== null ? file : { schema: 1, entries: {} }
}

function writeCache(file: CacheFile): void {
  writeJsonAtomic(cachePath(), file, 0o600)
}

export function readEntry(id: string): CacheEntry | undefined {
  return readCache().entries[id]
}

export function patchEntry(id: string, patch: Partial<CacheEntry>): void {
  const file = readCache()
  const previous = file.entries[id]
  file.entries[id] = { ...(previous ?? { at: new Date().toISOString() }), ...patch }
  writeCache(file)
}

export function clearCache(id: string): void {
  const file = readCache()
  if (!(id in file.entries)) return
  delete file.entries[id]
  writeCache(file)
}

/** Every cached entry, keyed by account id. */
export function allEntries(): Record<string, CacheEntry> {
  return readCache().entries
}

// -------------------------------------------------------------------- log

export function appendLog(entry: CheckinLogEntry): void {
  const file = readJson<LogFile>(logPath(), { schema: 1, entries: [] })
  const entries = [entry, ...(Array.isArray(file.entries) ? file.entries : [])].slice(0, LOG_LIMIT)
  writeJsonAtomic(logPath(), { schema: 1, entries } satisfies LogFile, 0o600)
}

export function readLog(limit = 100): CheckinLogEntry[] {
  const file = readJson<LogFile>(logPath(), { schema: 1, entries: [] })
  const entries = Array.isArray(file.entries) ? file.entries : []
  return entries.slice(0, Math.max(1, limit))
}

export function clearLog(): void {
  writeJsonAtomic(logPath(), { schema: 1, entries: [] } satisfies LogFile, 0o600)
}

/** Project one account + its cache into the status line the browser reads. */
export function statusOf(record: AccountRecord, settings: ConnectSettings, now = new Date().toISOString()): AccountStatus {
  const entry = readEntry(record.id)
  const checkinOn = !settings.checkinOff.includes(record.id)
  return {
    id: record.id,
    vendor: record.vendor,
    label: record.label,
    account: record.account ?? '',
    plan: entry?.quota?.plan ?? record.plan ?? null,
    signedIn: true,
    quota: entry?.quota ?? null,
    error: entry?.error ?? null,
    ms: entry?.ms,
    checkinOn,
    checkin: entry?.checkin ?? null,
  }
}

/** Empty status for an account whose cache has never been written. */
export function blankStatus(record: AccountRecord, settings: ConnectSettings): AccountStatus {
  return {
    id: record.id,
    vendor: record.vendor,
    label: record.label,
    account: record.account ?? '',
    plan: record.plan ?? null,
    signedIn: true,
    quota: null,
    error: null,
    checkinOn: !settings.checkinOff.includes(record.id),
    checkin: null,
  }
}