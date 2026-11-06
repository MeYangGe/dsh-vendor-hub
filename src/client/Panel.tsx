/**
 * The centre panel: three tabs over one store, and the single place that turns
 * a press into a Host request while keeping the whole panel disabled mid-flight.
 *
 * Layout contract: `.vdh-shell` owns the height, `.vdh-header` is fixed, and
 * `.vdh-scroll` is the only scroller. A content pane must never set its own
 * height - doing that pushed every page below the fold (the blank-panel defect).
 */

import { useEffect, useState } from 'react'
import {
  acquire,
  checkinOne,
  clearLog,
  loadStatus,
  refreshOne,
  removeCredential,
  removeVendorCredentials,
  saveCredential,
  saveSettings,
  useConnectStore,
} from './store.ts'
import type { ConnectSettings } from '../types.ts'
import { Overview } from './Overview.tsx'
import { Providers } from './Providers.tsx'
import { Checkin } from './Checkin.tsx'
import { ensureStyles } from './styles.ts'

type Tab = 'overview' | 'providers' | 'checkin'

/** Bumped on every client-only fix, so a reload can be told from a cache hit. */
const PANEL_BUILD = 'v0.1.1-layout'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'providers', label: '供应商' },
  { id: 'checkin', label: '签到中心' },
]

export function ConnectPanel() {
  const [tab, setTab] = useState<Tab>('overview')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const { status, settings, failure } = useConnectStore()

  useEffect(() => {
    ensureStyles()
    return acquire()
  }, [])

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      await work()
    } catch (error) {
      setNotice((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const settingsValue: ConnectSettings | null = settings?.value ?? null

  return (
    <div className="vdh-root vdh-shell">
      <div className="vdh-header">
        <h2 className="vdh-title">Vendor Hub</h2>
        <span className="vdh-sub">多供应商额度 · 用量 · 每日签到</span>
        <span className="vdh-pill" data-tone="neutral">
          {PANEL_BUILD}
        </span>
        <span className="vdh-grow" />
        <div className="vdh-segs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="vdh-seg"
              data-on={tab === entry.id ? '1' : '0'}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="vdh-btn"
          disabled={busy}
          onClick={() => void run(async () => void (await loadStatus()))}
        >
          刷新
        </button>
      </div>
      {failure ? <div className="vdh-error">读取状态失败：{failure}</div> : null}
      {notice ? <div className="vdh-error">{notice}</div> : null}

      <div className="vdh-scroll">
        {status === null || settingsValue === null ? (
          <div className="vdh-panel">
            <div className="vdh-empty">
              {failure ? '读取失败，点右上角「刷新」重试。' : '正在读取插件状态…'}
            </div>
          </div>
        ) : tab === 'overview' ? (
          <Overview
            status={status}
            hidden={settingsValue.hidden}
            busy={busy}
            onRefreshAll={() => void run(() => refreshOne())}
            onCheckinAll={() => void run(() => checkinOne())}
            onRefreshOne={(id) => void run(() => refreshOne(id))}
            onCheckinOne={(id) => void run(() => checkinOne(id))}
            onToggleHidden={(id, hidden) =>
              void run(() => saveSettings({ accountId: id, accountPatch: hidden ? 'hide' : 'show' }))
            }
            onToggleCheckin={(id, on) =>
              void run(() => saveSettings({ accountId: id, accountPatch: on ? 'checkin-on' : 'checkin-off' }))
            }
          />
        ) : tab === 'providers' ? (
          <Providers
            accounts={status.accounts}
            busy={busy}
            onSave={(input) => run(() => saveCredential(input))}
            onRemove={(id) => run(() => removeCredential(id))}
            onRemoveVendor={(vendor) => run(() => removeVendorCredentials(vendor))}
          />
        ) : (
          <Checkin
            status={status}
            settings={settingsValue}
            busy={busy}
            onSave={(patch) => run(() => saveSettings(patch))}
            onCheckinAll={() => void run(() => checkinOne())}
            onCheckinOne={(id) => void run(() => checkinOne(id))}
            onToggleCheckin={(id, on) =>
              void run(() => saveSettings({ accountId: id, accountPatch: on ? 'checkin-on' : 'checkin-off' }))
            }
            onClearLog={() => void run(() => clearLog())}
          />
        )}
      </div>
    </div>
  )
}