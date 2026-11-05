/**
 * The Overview: magpie's Usage > Overview, for subscriptions instead of calls.
 *
 * KPI tiles lead with the number that matters (how much is left, how many
 * accounts still need a check-in), then one row per account with a share bar
 * and its allowance windows, then the accounts the user hid and the failures.
 */

import { useState } from 'react'
import type { AccountStatus, ConnectStatus } from '../types.ts'
import { CHECKIN_OUTCOME_LABEL, claimableAccounts, formatAmount, percentLeftOf, worstPercent } from '../types.ts'
import { vendorMeta } from '../vendors.ts'
import { Bar, Glyph, MiniBar, Pill, toneOf } from './parts.tsx'

export interface OverviewProps {
  status: ConnectStatus
  /** Ids the user hid from the Overview. */
  hidden: string[]
  busy: boolean
  onRefreshAll: () => void
  onCheckinAll: () => void
  onRefreshOne: (id: string) => void
  onCheckinOne: (id: string) => void
  onToggleHidden: (id: string, hidden: boolean) => void
  onToggleCheckin: (id: string, on: boolean) => void
}

export function Overview(props: OverviewProps) {
  const { status } = props
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const claimable = claimableAccounts(status)
  const hiddenSet = new Set(props.hidden)
  const totals = status.totals
  const visible = status.accounts.filter((account) => !hiddenSet.has(account.id))
  const hiddenAccounts = status.accounts.filter((account) => hiddenSet.has(account.id))

  return (
    <div className="mmp-panel">
      <div className="mmp-head">
        <h2 className="mmp-title">用量概览</h2>
        <span className="mmp-sub">{status.accounts.length} 个账号 · {totals.vendors} 家供应商</span>
        <span className="mmp-grow" />
        <button type="button" className="mmp-btn" disabled={props.busy} onClick={props.onRefreshAll}>
          {props.busy ? '刷新中…' : '全部刷新'}
        </button>
        <button type="button" className="mmp-btn" data-variant="primary" disabled={props.busy} onClick={props.onCheckinAll}>
          全部签到
        </button>
      </div>

      <div className="mmp-tiles">
        <div className="mmp-tile">
          <b>{totals.creditsLeft === null ? '—' : formatAmount(totals.creditsLeft)}</b>
          <span>剩余 Credits</span>
          <small>{totals.creditsTotal === null ? '上游未给总额' : `共 ${formatAmount(totals.creditsTotal)}`}</small>
        </div>
        <div className="mmp-tile">
          <b>{totals.signedIn}</b>
          <span>已保存账号</span>
          <small>{totals.readOk} 个读数成功 · {totals.readFailed} 个失败</small>
        </div>
        <div className="mmp-tile">
          <b>{totals.checkinClaimable}</b>
          <span>今日可签到</span>
          <small>{claimable.length > 0 ? claimable.map((account) => account.label).join('、') : '没有待领取的'}</small>
        </div>
        <div className="mmp-tile">
          <b>{totals.checkinClaimed}</b>
          <span>今日已签</span>
          <small>{totals.checkinFailed > 0 ? `${totals.checkinFailed} 个失败` : '无失败'}</small>
        </div>
      </div>

      <div className="mmp-block">
        <div className="mmp-block-head">
          <span>账号额度</span>
          <span className="mmp-grow" />
          <span className="mmp-sub">{status.totals.updatedAt ? `更新于 ${stamp(status.totals.updatedAt)}` : '尚未读取'}</span>
        </div>
        <div className="mmp-block-body">
          {visible.length === 0 ? (
            <div className="mmp-empty">
              还没有账号。去「供应商」页粘贴第一份凭证 —— 保存时会立刻读一次额度。
            </div>
          ) : (
            visible.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                open={opened[account.id] === true}
                onToggleOpen={() => setOpened((prev) => ({ ...prev, [account.id]: prev[account.id] !== true }))}
                onRefresh={() => props.onRefreshOne(account.id)}
                onCheckin={() => props.onCheckinOne(account.id)}
                onToggleCheckin={(on) => props.onToggleCheckin(account.id, on)}
                onHide={() => props.onToggleHidden(account.id, true)}
                busy={props.busy}
              />
            ))
          )}
        </div>
      </div>

      {hiddenAccounts.length > 0 ? (
        <div className="mmp-block">
          <div className="mmp-block-head">
            <span>已从概览隐藏（{hiddenAccounts.length}）</span>
            <span className="mmp-grow" />
            <span className="mmp-sub">仍然照常读取与签到</span>
          </div>
          <div className="mmp-block-body">
            {hiddenAccounts.map((account) => (
              <div className="mmp-row" key={account.id}>
                <Glyph text={vendorMeta(account.vendor)?.glyph ?? '?'} />
                <div className="mmp-who">
                  <div className="mmp-name">{account.label}</div>
                  <div className="mmp-meta">{vendorMeta(account.vendor)?.name ?? account.vendor}</div>
                </div>
                <button type="button" className="mmp-btn" onClick={() => props.onToggleHidden(account.id, false)}>
                  取消隐藏
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {status.log.length > 0 ? (
        <div className="mmp-block">
          <div className="mmp-block-head">
            <span>签到记录</span>
            <span className="mmp-grow" />
            <span className="mmp-sub">最近 {Math.min(status.log.length, 12)} 条</span>
          </div>
          <div className="mmp-log">
            {status.log.slice(0, 12).map((entry, index) => (
              <div key={`${entry.at}-${index}`}>
                <time>{stamp(entry.at, true)}</time>
                <span>{entry.account}</span>
                <span>{CHECKIN_OUTCOME_LABEL[entry.outcome] ?? entry.outcome}</span>
                <span className="mmp-sub">{entry.message}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {status.problems.length > 0 ? (
        <div className="mmp-block">
          <div className="mmp-block-head">
            <span>需要处理</span>
          </div>
          <div className="mmp-block-body">
            {status.problems.map((problem, index) => (
              <div key={index} className="mmp-error">
                {problem}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function AccountRow(props: {
  account: AccountStatus
  open: boolean
  busy: boolean
  onToggleOpen: () => void
  onRefresh: () => void
  onCheckin: () => void
  onToggleCheckin: (on: boolean) => void
  onHide: () => void
}) {
  const { account } = props
  const meta = vendorMeta(account.vendor)
  const worst = worstPercent(account)
  const tone = toneOf(worst)
  const checkin = account.checkin
  const checkinTone =
    checkin?.outcome === 'claimed' || checkin?.outcome === 'already'
      ? 'good'
      : checkin?.outcome === 'eligible'
        ? 'accent'
        : checkin?.outcome === 'failed'
          ? 'bad'
          : 'neutral'
  return (
    <>
      <div className="mmp-row" style={{ cursor: 'pointer' }} onClick={props.onToggleOpen}>
        <Glyph text={meta?.glyph ?? '?'} />
        <div className="mmp-who">
          <div className="mmp-name">
            {account.label}
            <Pill tone="neutral">{meta?.name ?? account.vendor}</Pill>
            {account.plan ? <Pill tone="neutral">{account.plan}</Pill> : null}
            {checkin ? <Pill tone={checkinTone}>{CHECKIN_OUTCOME_LABEL[checkin.outcome] ?? checkin.outcome}</Pill> : null}
            {account.error ? <Pill tone="bad">{account.error.code}</Pill> : null}
          </div>
          <div className="mmp-meta">
            <span>{account.account || '未标注账号'}</span>
            {account.quota?.windows.length ? (
              <span>
                {account.quota.windows.length} 个额度窗口 · 最紧 {worst === null ? '未知' : `${Math.round(worst)}% 剩余`}
              </span>
            ) : (
              <span>{account.error ? '额度不可读' : '尚未读取'}</span>
            )}
            {checkin?.amount ? <span>{checkin.amount}</span> : null}
          </div>
        </div>
        <MiniBar percent={worst} />
        <div className="mmp-num">
          <b style={{ color: tone === 'bad' ? 'var(--mmp-bad)' : tone === 'warn' ? 'var(--mmp-warn)' : undefined }}>
            {worst === null ? '—' : `${Math.round(worst)}%`}
          </b>
          <small>剩余</small>
        </div>
      </div>
      {props.open ? (
        <div className="mmp-bar-group" style={{ padding: '0 14px 12px' }}>
          {account.quota?.windows.length ? (
            <div className="mmp-bars" style={{ padding: 0 }}>
              {account.quota.windows.map((window, index) => (
                <Bar key={`${window.name}-${index}`} window={window} />
              ))}
            </div>
          ) : (
            <div className="mmp-bar-note">
              {account.error ? account.error.message : '这个账号还没有成功读取过额度。'}
            </div>
          )}
          <div className="mmp-actions" style={{ marginTop: 10 }}>
            <button type="button" className="mmp-btn" disabled={props.busy} onClick={props.onRefresh}>
              读取额度
            </button>
            <button
              type="button"
              className="mmp-btn"
              data-variant="primary"
              disabled={props.busy || !account.checkinOn}
              onClick={props.onCheckin}
            >
              立即签到
            </button>
            <label className="mmp-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={account.checkinOn}
                onChange={(event) => props.onToggleCheckin(event.target.checked)}
              />
              <span className="mmp-hint">自动签到</span>
            </label>
            {account.ms ? <span className="mmp-hint">上次读数 {account.ms} ms</span> : null}
            <span className="mmp-grow" />
            <button type="button" className="mmp-btn" onClick={props.onHide}>
              从概览隐藏
            </button>
          </div>
        </div>
      ) : null}
    </>
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

export { percentLeftOf }