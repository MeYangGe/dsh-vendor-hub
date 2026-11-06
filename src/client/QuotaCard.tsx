/**
 * The sidebar footer card.
 *
 * It IS the button (the shell supplies no chrome): one block per vendor showing
 * the tightest window and how much is left, a badge when a check-in is waiting,
 * and the last-read time. In the 56px rail it collapses to a single glyph.
 */

import type { AccountStatus, ConnectStatus, VendorMeta } from '../types.ts'
import { claimableAccounts, formatAmount, percentLeftOf, worstPercent } from '../types.ts'
import { vendorMeta } from '../vendors.ts'
import { MiniBar, toneOf } from './parts.tsx'

export interface QuotaCardProps {
  status: ConnectStatus
  /** Sidebar renders wide content when true; the 56px rail when false. */
  wide: boolean
  onOpen: () => void
}

interface VendorDigest {
  meta: VendorMeta | undefined
  accounts: AccountStatus[]
  /** Tightest remaining share across the vendor's accounts. */
  worst: number | null
  /** Sum of remaining credits, when any window carries a number. */
  left: number | null
  total: number | null
  claimable: number
  failed: number
}

function digestOf(status: ConnectStatus): VendorDigest[] {
  const byVendor = new Map<string, AccountStatus[]>()
  for (const account of status.accounts) {
    const list = byVendor.get(account.vendor) ?? []
    list.push(account)
    byVendor.set(account.vendor, list)
  }
  const out: VendorDigest[] = []
  for (const [vendor, accounts] of byVendor) {
    let worst: number | null = null
    let left: number | null = null
    let total: number | null = null
    for (const account of accounts) {
      const percent = worstPercent(account)
      if (percent !== null && (worst === null || percent < worst)) worst = percent
      for (const window of account.quota?.windows ?? []) {
        if (window.unit !== 'credits') continue
        if (typeof window.remaining === 'number') left = (left ?? 0) + window.remaining
        if (typeof window.total === 'number') total = (total ?? 0) + window.total
      }
    }
    out.push({
      meta: vendorMeta(vendor as never),
      accounts,
      worst,
      left,
      total,
      claimable: accounts.filter((account) => account.checkinOn && account.checkin?.outcome === 'eligible').length,
      failed: accounts.filter((account) => account.error).length,
    })
  }
  return out.sort((a, b) => (a.worst ?? 100) - (b.worst ?? 100))
}

export function QuotaCard({ status, wide, onOpen }: QuotaCardProps) {
  const digests = digestOf(status)
  const waiting = claimableAccounts(status).length
  const title = waiting > 0 ? `${waiting} 个账号今天还没签到` : 'Vendor Hub — 额度与签到'

  if (!wide) {
    return (
      <button type="button" className="vdh-root vdh-foot-rail" onClick={onOpen} title={title} aria-label={title}>
        M
        {waiting > 0 ? <span className="vdh-dot" /> : null}
      </button>
    )
  }

  const worst = digests.length > 0 ? digests.reduce<number | null>((acc, item) => {
    if (item.worst === null) return acc
    return acc === null || item.worst < acc ? item.worst : acc
  }, null) : null
  const leftSum = digests.reduce<number>((acc, item) => acc + (typeof item.left === 'number' ? item.left : 0), 0)

  return (
    <button type="button" className="vdh-root vdh-foot" onClick={onOpen} title={title}>
      <span className="vdh-foot-head">
        <b>Vendor</b>
        <span className="vdh-grow" />
        {waiting > 0 ? <span className="vdh-pill" data-tone="warn">签到 {waiting}</span> : null}
        <span style={{ color: 'var(--vdh-fg-faint)', fontSize: 10 }}>{worst === null ? '—' : `${Math.round(worst)}%`}</span>
      </span>
      <span className="vdh-foot-grid">
        {digests.length === 0 ? <span className="vdh-foot-item">未添加账号</span> : null}
        {digests.slice(0, 3).map((item) => (
          <span className="vdh-foot-item" key={item.meta?.id ?? 'unknown'}>
            <span style={{ width: 14, textAlign: 'center', fontWeight: 700, color: 'var(--vdh-accent)' }}>
              {item.meta?.glyph ?? '?'}
            </span>
            <MiniBar percent={item.worst} />
            <span style={{ minWidth: 42, textAlign: 'right' }}>
              {item.left === null ? '—' : formatAmount(item.left)}
            </span>
            {item.failed > 0 ? <span style={{ color: 'var(--vdh-bad)' }}>!</span> : null}
          </span>
        ))}
        {digests.length > 3 ? <span className="vdh-foot-item">另 {digests.length - 3} 家</span> : null}
      </span>
      <span className="vdh-foot-head" style={{ fontSize: 10 }}>
        <span style={{ color: 'var(--vdh-fg-faint)' }}>
          {digests.length > 0 && leftSum > 0 ? `合计 ${formatAmount(leftSum)} Credits` : '点开查看用量概览'}
        </span>
        <span className="vdh-grow" />
        {status.totals.updatedAt ? <span>{shortStamp(status.totals.updatedAt)}</span> : null}
      </span>
    </button>
  )
}

function shortStamp(iso: string): string {
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return ''
  return at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export { percentLeftOf, toneOf }