/**
 * Where the plugin keeps its files.
 *
 * One directory, never loose files: `DSH_VENDOR_HUB_DATA_DIR` when set,
 * else `<DSH_HOME>/vendor-hub`, else `<user config>/dsh-vendor-hub`.
 * The directory holds the account book (credentials), the settings file, the
 * quota/check-in cache and the rolling check-in log.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const DATA_DIR_ENV = 'DSH_VENDOR_HUB_DATA_DIR'

let cachedDir: string | undefined

/** The plugin's data directory, created on first call. */
export function dataDir(): string {
  if (cachedDir !== undefined) return cachedDir
  const override = process.env[DATA_DIR_ENV]?.trim()
  const dshHome = process.env['DSH_HOME']?.trim()
  const base =
    override && override.length > 0
      ? resolve(override)
      : dshHome && dshHome.length > 0
        ? join(resolve(dshHome), 'vendor-hub')
        : join(homedir(), '.config', 'dsh-vendor-hub')
  mkdirSync(base, { recursive: true })
  cachedDir = base
  return base
}

/** One file path inside the data directory. */
export function dataFile(name: string): string {
  return join(dataDir(), name)
}

/** Credentials - kept apart from everything else so it can be locked down. */
export function accountsPath(): string {
  return dataFile('accounts.json')
}

export function settingsPath(): string {
  return dataFile('settings.json')
}

export function cachePath(): string {
  return dataFile('cache.json')
}

export function logPath(): string {
  return dataFile('checkin-log.json')
}

/** Read a JSON file, returning `fallback` for anything unreadable. */
export function readJson<T>(path: string, fallback: T): T {
  try {
    const text = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    return parsed as T
  } catch {
    return fallback
  }
}

/**
 * Write a JSON file atomically: a sibling temp file renamed over the target, so
 * a crash mid-write can never leave a half-parsed credential book behind.
 */
export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode })
  try {
    chmodSync(temp, mode)
  } catch {
    // Windows ignores POSIX modes; the rename below is what matters there.
  }
  renameSync(temp, path)
}