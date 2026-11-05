/**
 * The check-in centre: the daily sweep's switch and time, each account's state,
 * and the rolling log.
 *
 * The time is entered as the Asia/Shanghai wall clock the schedule uses; the
 * Host stores it as minutes past local midnight, which is what its timer reads.
 */

import { useState } from 'react'
import type { ConnectStatus, ConnectSettings } from '../types.ts'
import { CHECKIN_OUTCOME_LABEL } from '../types.ts'
import { vendorMeta } from '../vendors.ts'
import { Glyph, Pill } from './parts.tsx'

export interface CheckinProps {
  status: ConnectStatus
  settings: ConnectSettings
  busy: boolean
  onSave: (patch: Partial<ConnectSettings>) => Promise<void>
  onCheckinAll: () => void
  onCheckinOne: (id: string) => void
  onToggleCheckin: (id: string, on: boolean) => void
  onClearLog: () => void
}

export function Checkin(props: CheckinProps) {
  const { status, settings } = props
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null)
  const hour = Math.floor(settings.checkinMinute / 60)
  const minute = settings.checkinMinute % 60
  const timeValue = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

  return (
    <div className="mmp-panel">
      <div className="mmp-head">
        <h2 className="mmp-title">签到中心</h2>
        <span className="mmp-sub">
          {status.scheduler.enabled
            ? `每日自动签到已启用 · 下次 ${status.scheduler.nextAt ? stamp(status.scheduler.nextAt) : '待定'}`
            : '每日自动签到已关闭'}
        </span>
        <span className="mmp-grow" />
        <button type="button" className="mmp-btn" data-variant="primary" disabled={props.busy} onClick={props.onCheckinAll}>
          {props.busy ? '执行中…' : '立即全部签到'}
        </button>
      </div>
      {message ? (
        <div className={message.bad ? 'mmp-error' : 'mmp-ok'} style={{ padding: '4px 0' }}>
          {message.text}
        </div>
      ) : null}

      <div className="mmp-block">
        <div className="mmp-block-head">
          <span>自动签到</span>
        </div>
        <div className="mmp-form" style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
          <label className="mmp-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={settings.autoCheckin}
              onChange={async (event) => {
                try {
                  await props.onSave({ autoCheckin: event.target.checked })
                  setMessage({ text: event.target.checked ? '已启用每日自动签到' : '已关闭每日自动签到', bad: false })
                } catch (error) {
                  setMessage({ text: (error as Error).message, bad: true })
                }
              }}
            />
            <span className="mmp-hint">每天按下面的时刻自动签到（时区固定 Asia/Shanghai）</span>
          </label>
          <div className="mmp-field" style={{ maxWidth: 140 }}>
            <label>签到时刻</label>
            <input
              type="time"
              value={timeValue}
              onChange={async (event) => {
                const [h, m] = event.target.value.split(':').map(Number)
                if (!Number.isFinite(h) || !Number.isFinite(m)) return
                try {
                  await props.onSave({ checkinMinute: h * 60 + m })
                  setMessage({ text: `签到时刻已改为 ${event.target.value}`, bad: false })
                } catch (error) {
                  setMessage({ text: (error as Error).message, bad: true })
                }
              }}
            />
          </div>
          <div className="mmp-field" style={{ maxWidth: 180 }}>
            <label>额度刷新间隔（分钟）</label>
            <input
              type="number"
              min={1}
              step={1}
              value={Math.round(settings.pollMs / 60_000)}
              onChange={async (event) => {
                const minutes = Number(event.target.value)
                if (!Number.isFinite(minutes) || minutes < 1) return
                try {
                  await props.onSave({ pollMs: Math.round(minutes) * 60_000 })
                } catch (error) {
                  setMessage({ text: (error as Error).message, bad: true })
                }
              }}
            />
          </div>
          {status.scheduler.lastAt ? <span className="mmp-hint">上次自动执行：{stamp(status.scheduler.lastAt)}</span> : null}
        </div>
      </div>

      <div className="mmp-block">
        <div className="mmp-block-head">
          <span>各账号签到状态</span>
          <span className="mmp-grow" />
          <span className="mmp-sub">今日北京时间 {beijingDay()}</span>
        </div>
        <div className="mmp-block-body">
          {status.accounts.length === 0 ? (
            <div className="mmp-empty">还没有账号，先去「供应商」页添加。</div>
          ) : (
            status.accounts.map((account) => {
              const meta = vendorMeta(account.vendor)
              const checkin = account.checkin
              const tone =
                checkin?.outcome === 'claimed' || checkin?.outcome === 'already'
                  ? 'good'
                  : checkin?.outcome === 'eligible'
                    ? 'accent'
                    : checkin?.outcome === 'failed'
                      ? 'bad'
                      : 'neutral'
              return (
                <div className="mmp-row" key={account.id}>
                  <Glyph text={meta?.glyph ?? '?'} />
                  <div className="mmp-who">
                    <div className="mmp-name">
                      {account.label}
                      <Pill tone="neutral">{meta?.name ?? account.vendor}</Pill>
                      {meta?.checkin === false ? <Pill tone="neutral">无签到</Pill> : null}
                      {checkin ? <Pill tone={tone}>{CHECKIN_OUTCOME_LABEL[checkin.outcome] ?? checkin.outcome}</Pill> : null}
                      {account.checkinOn ? null : <Pill tone="neutral">已关自动</Pill>}
                    </div>
                    <div className="mmp-meta">
                      <span>{checkin ? checkin.message : '尚未签到'}</span>
                      {checkin?.amount ? <span>奖励 {checkin.amount}</span> : null}
                      {typeof checkin?.streak === 'number' ? <span>连续 {checkin.streak} 天</span> : null}
                    </div>
                  </div>
                  <div className="mmp-actions">
                    <button
                      type="button"
                      className="mmp-btn"
                      disabled={props.busy || !account.checkinOn}
                      onClick={() => props.onCheckinOne(account.id)}
                    >
                      签到
                    </button>
                    <label className="mmp-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      <input
                        type="checkbox"
                        checked={account.checkinOn}
                        onChange={(event) => props.onToggleCheckin(account.id, event.target.checked)}
                      />
                      <span className="mmp-hint">自动</span>
                    </label>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      <div className="mmp-block">
        <div className="mmp-block-head">
          <span>签到日志</span>
          <span className="mmp-grow" />
          <button type="button" className="mmp-btn" disabled={props.busy} onClick={props.onClearLog}>
            清空
          </button>
        </div>
        <div className="mmp-log">
          {status.log.length === 0 ? (
            <div className="mmp-empty">还没有记录</div>
          ) : (
            status.log.map((entry, index) => (
              <div key={`${entry.at}-${index}`}>
                <time>{stamp(entry.at, true)}</time>
                <span>{entry.account}</span>
                <span>{CHECKIN_OUTCOME_LABEL[entry.outcome] ?? entry.outcome}</span>
                <span className="mmp-sub">{entry.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function stamp(iso: string, withSeconds = false): string {
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return iso
  return at.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  })
}

function beijingDay(): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}