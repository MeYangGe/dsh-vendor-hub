/** Small presentational pieces shared by every surface. */

import type { ReactNode } from 'react'
import type { QuotaWindow } from '../types.ts'
import { daysUntil, formatAmount, percentLeftOf } from '../types.ts'

export type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'accent'

/** Colour band for a remaining share: roomy, getting low, nearly gone. */
export function toneOf(percent: number | null): Tone {
  if (percent === null) return 'neutral'
  if (percent >= 50) return 'good'
  if (percent >= 20) return 'warn'
  return 'bad'
}

export function Pill({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className="vdh-pill" data-tone={tone} title={title}>
      {children}
    </span>
  )
}

export function Glyph({ text }: { text: string }) {
  return <span className="vdh-glyph">{text}</span>
}

/** One allowance window: name/amount line, then a bar that drains. */
export function Bar({ window, showReset = true }: { window: QuotaWindow; showReset?: boolean }) {
  const percent = percentLeftOf(window)
  const tone = toneOf(percent)
  const left = window.unlimited ? '不限量' : formatAmount(window.remaining)
  const total = window.total === null ? '' : ` / ${formatAmount(window.total)}`
  const reset = showReset ? resetText(window) : ''
  return (
    <div className="vdh-bar">
      <div className="vdh-bar-top">
        <span>{window.name}</span>
        <span className="vdh-grow" />
        <span>
          {left}
          {total}
          {percent === null ? '' : ` · ${Math.round(percent)}%`}
        </span>
      </div>
      <div className="vdh-bar-track">
        <div
          className="vdh-bar-fill"
          data-tone={tone}
          style={{ width: `${percent === null ? 0 : Math.max(2, Math.min(100, percent))}%` }}
        />
      </div>
      {reset.length > 0 || window.note ? <div className="vdh-bar-note">{[reset, window.note].filter(Boolean).join(' · ')}</div> : null}
    </div>
  )
}

function resetText(window: QuotaWindow): string {
  const days = daysUntil(window.expiresAt)
  if (days !== null) return days <= 0 ? '已到期' : `${days} 天后到期`
  if (window.resetsAt) {
    const at = new Date(window.resetsAt)
    if (Number.isFinite(at.getTime())) {
      return `重置于 ${at.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
    }
  }
  return ''
}

/** A thin share bar with no label, for the sidebar card. */
export function MiniBar({ percent }: { percent: number | null }) {
  const tone = toneOf(percent)
  return (
    <span className="vdh-share">
      <i data-tone={tone} style={{ width: `${percent === null ? 0 : Math.max(2, Math.min(100, percent))}%` }} />
    </span>
  )
}