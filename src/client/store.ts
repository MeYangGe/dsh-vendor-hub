/**
 * One shared store for every surface (sidebar card, panel, settings tab).
 *
 * A single ticker polls the Host's status route - paused while the document is
 * hidden - and every surface subscribes through `useSyncExternalStore`. Writes
 * go straight to the Host's routes and then refresh the store, so a card never
 * renders a figure the Host did not just produce.
 */

import { useSyncExternalStore } from 'react'
import type { ConnectSettings, ConnectStatus } from '../types.ts'
import { POLL_MIN_MS, ROUTE_BASE } from '../types.ts'

export interface SettingsBundle {
  value: ConnectSettings
  user: ConnectSettings
  base: ConnectSettings
}

let status: ConnectStatus | null = null
let settings: SettingsBundle | null = null
let readFailure: string | null = null
let revision = 0
let inflight: Promise<void> | null = null
let timer: ReturnType<typeof setInterval> | undefined
let subscribers = 0

const listeners = new Set<() => void>()

function bump(): void {
  revision += 1
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getRevision(): number {
  return revision
}

export function statusSnapshot(): ConnectStatus | null {
  return status
}

export function settingsSnapshot(): SettingsBundle | null {
  return settings
}

export function readFailureOf(): string | null {
  return readFailure
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${ROUTE_BASE}${path}`, { credentials: 'same-origin' })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined)
    const error =
      typeof body === 'object' && body !== null && 'error' in body ? String((body as Record<string, unknown>)['error']) : `HTTP ${response.status}`
    throw new Error(error)
  }
  return (await response.json()) as T
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${ROUTE_BASE}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String((payload as Record<string, unknown>)['error'])
        : `HTTP ${response.status}`
    throw new Error(error)
  }
  return payload as T
}

/** Read the status document; concurrent callers share one request. */
export function loadStatus(): Promise<void> {
  if (inflight !== null) return inflight
  inflight = (async () => {
    try {
      status = await getJson<ConnectStatus>('/status')
      readFailure = null
    } catch (error) {
      readFailure = (error as Error).message
    } finally {
      inflight = null
      bump()
    }
  })()
  return inflight
}

/** Read the settings document. */
export async function loadSettings(): Promise<void> {
  try {
    settings = await getJson<SettingsBundle>('/settings')
    readFailure = null
  } catch (error) {
    readFailure = (error as Error).message
    return
  } finally {
    bump()
  }
  retick()
}

/** Patch one settings field; resolves to the saved document. */
export async function saveSettings(patch: Partial<ConnectSettings> & { accountId?: string; accountPatch?: string }): Promise<void> {
  settings = await postJson<SettingsBundle>('/settings', patch)
  bump()
  retick()
  await loadStatus()
}

/** Save a credential set; the Host validates by reading the account once. */
export async function saveCredential(input: {
  vendor: string
  label?: string
  account?: string
  secret: Record<string, string>
}): Promise<void> {
  await postJson('/auth', { action: 'save', ...input })
  await loadStatus()
}

export async function removeCredential(id: string): Promise<void> {
  await postJson('/auth', { action: 'remove', id })
  await loadStatus()
}

export async function removeVendorCredentials(vendor: string): Promise<void> {
  await postJson('/auth', { action: 'removeVendor', vendor })
  await loadStatus()
}

export async function refreshOne(id?: string): Promise<void> {
  await postJson('/refresh', id === undefined ? {} : { id })
  await loadStatus()
}

export async function checkinOne(id?: string): Promise<void> {
  await postJson('/checkin', id === undefined ? {} : { id, manual: true })
  await loadStatus()
}

export async function clearLog(): Promise<void> {
  await postJson('/log/clear', {})
  await loadStatus()
}

// ----------------------------------------------------------- browser login

export interface BrowserLoginStart {
  session: string
  state: 'waiting' | 'done' | 'error' | 'cancelled'
  url: string
  note: string | null
}

export interface BrowserLoginStatus {
  state: 'waiting' | 'done' | 'saved' | 'error' | 'cancelled'
  note?: string | null
  id?: string
}

/** Open the vendor's sign-in page with a loopback redirect. */
export async function startBrowserLogin(vendor: string): Promise<BrowserLoginStart> {
  return postJson<BrowserLoginStart>('/auth/browser/start', { vendor })
}

/** Poll one sign-in; `saved` means the Host already stored the credential. */
export async function pollBrowserLogin(session: string): Promise<BrowserLoginStatus> {
  const response = await fetch(`${ROUTE_BASE}/auth/browser/status?session=${encodeURIComponent(session)}`, {
    credentials: 'same-origin',
  })
  return (await response.json()) as BrowserLoginStatus
}

export async function cancelBrowserLogin(session: string): Promise<void> {
  await postJson('/auth/browser/cancel', { session })
}

// ------------------------------------------------------------------ ticker

function intervalOf(): number {
  const configured = settings?.value.pollMs
  return typeof configured === 'number' && configured >= POLL_MIN_MS ? configured : 300_000
}

function stop(): void {
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

function start(): void {
  stop()
  timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return
    void loadStatus()
  }, intervalOf())
}

/** Restart the ticker after the poll interval changed. */
export function retick(): void {
  if (subscribers === 0) return
  start()
}

/** Acquire the store for one surface; the ticker stops with the last one. */
export function acquire(): () => void {
  subscribers += 1
  if (subscribers === 1) {
    if (status === null) void loadStatus()
    if (settings === null) void loadSettings()
    start()
  }
  return () => {
    subscribers = Math.max(0, subscribers - 1)
    if (subscribers === 0) stop()
  }
}

/** Subscribe a component to the shared store. */
export function useConnectStore(): { status: ConnectStatus | null; settings: SettingsBundle | null; revision: number; failure: string | null } {
  const rev = useSyncExternalStore(subscribe, getRevision, getRevision)
  return { status, settings, revision: rev, failure: readFailure }
}