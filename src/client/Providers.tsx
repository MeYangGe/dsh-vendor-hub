/**
 * Providers: the credential book.
 *
 * One card per vendor, listing what is already saved for it and the exact fields
 * its credential needs. A saved secret is never echoed back: the card only ever
 * shows the label, the masked account and the local id's tail.
 */

import { useState } from 'react'
import type { VendorMeta } from '../types.ts'
import type { AccountStatus } from '../types.ts'
import { VENDORS } from '../vendors.ts'
import { Glyph, Pill } from './parts.tsx'

export interface ProvidersProps {
  accounts: AccountStatus[]
  busy: boolean
  onSave: (input: { vendor: string; label: string; account: string; secret: Record<string, string> }) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onRemoveVendor: (vendor: string) => Promise<void>
}

export function Providers(props: ProvidersProps) {
  const [openVendor, setOpenVendor] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null)

  const savedByVendor = new Map<string, AccountStatus[]>()
  for (const account of props.accounts) {
    const list = savedByVendor.get(account.vendor) ?? []
    list.push(account)
    savedByVendor.set(account.vendor, list)
  }

  return (
    <div className="mmp-panel">
      <div className="mmp-head">
        <h2 className="mmp-title">供应商</h2>
        <span className="mmp-sub">{VENDORS.length} 家 · 已保存 {props.accounts.length} 个账号</span>
      </div>
      {message ? (
        <div className={message.bad ? 'mmp-error' : 'mmp-ok'} style={{ padding: '4px 0' }}>
          {message.text}
        </div>
      ) : null}

      {VENDORS.map((vendor) => {
        const saved = savedByVendor.get(vendor.id) ?? []
        // A vendor with nothing saved opens by default: the page should read as
        // seven forms ready to fill, not seven closed rows.
        const open = openVendor === vendor.id || (openVendor === null && saved.length === 0)
        return (
          <div className="mmp-block" key={vendor.id}>
            <div className="mmp-block-head" style={{ cursor: 'pointer' }} onClick={() => setOpenVendor(open ? null : vendor.id)}>
              <Glyph text={vendor.glyph} />
              <span style={{ color: 'var(--mmp-fg)', fontWeight: 600 }}>{vendor.name}</span>
              <Pill tone="neutral">{vendor.site}</Pill>
              {vendor.checkin ? <Pill tone="accent">支持签到</Pill> : null}
              <span className="mmp-grow" />
              <span className="mmp-sub">{saved.length > 0 ? `${saved.length} 个账号` : '未添加'}</span>
            </div>
            <div className="mmp-block-body">
              {saved.map((account) => (
                <div className="mmp-row" key={account.id}>
                  <div className="mmp-who">
                    <div className="mmp-name">
                      {account.label}
                      {account.plan ? <Pill tone="neutral">{account.plan}</Pill> : null}
                      {account.error ? <Pill tone="bad">{account.error.code}</Pill> : null}
                    </div>
                    <div className="mmp-meta">
                      <span>{account.account || '未标注账号'}</span>
                      <span>id …{account.id.slice(-6)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="mmp-btn"
                    data-variant="danger"
                    disabled={props.busy}
                    onClick={async () => {
                      try {
                        await props.onRemove(account.id)
                        setMessage({ text: `已删除 ${account.label}`, bad: false })
                      } catch (error) {
                        setMessage({ text: (error as Error).message, bad: true })
                      }
                    }}
                  >
                    删除
                  </button>
                </div>
              ))}
              {open ? (
                <CredentialForm
                  vendor={vendor}
                  busy={props.busy}
                  onSave={async (input) => {
                    try {
                      await props.onSave(input)
                      setMessage({ text: `${vendor.name} 的凭证已保存，并已读取一次额度`, bad: false })
                    } catch (error) {
                      setMessage({ text: (error as Error).message, bad: true })
                      throw error
                    }
                  }}
                  onRemoveVendor={async () => {
                    try {
                      await props.onRemoveVendor(vendor.id)
                      setMessage({ text: `已清除 ${vendor.name} 的全部凭证`, bad: false })
                    } catch (error) {
                      setMessage({ text: (error as Error).message, bad: true })
                    }
                  }}
                />
              ) : (
                <div className="mmp-empty">点击标题展开，粘贴凭证</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CredentialForm(props: {
  vendor: VendorMeta
  busy: boolean
  onSave: (input: { vendor: string; label: string; account: string; secret: Record<string, string> }) => Promise<void>
  onRemoveVendor: () => Promise<void>
}) {
  const [label, setLabel] = useState('')
  const [account, setAccount] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const fields = props.vendor.credential.fields

  return (
    <div className="mmp-form">
      <div className="mmp-hint">{hintOf(props.vendor)}</div>
      <div className="mmp-field">
        <label>备注名（可选，只存在本机）</label>
        <input value={label} placeholder="例如：主账号 / 备用" onChange={(event) => setLabel(event.target.value)} />
      </div>
      <div className="mmp-field">
        <label>账号标识（可选，便于区分）</label>
        <input value={account} placeholder="邮箱或 uid" onChange={(event) => setAccount(event.target.value)} />
      </div>
      {fields.map((field) => (
        <div className="mmp-field" key={field.key}>
          <label>
            {labelOf(field.labelKey)}
            {field.required ? ' *' : ''}
          </label>
          <input
            type={field.secret === false ? 'text' : 'password'}
            value={values[field.key] ?? ''}
            placeholder={field.placeholder ?? ''}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
          />
        </div>
      ))}
      <div className="mmp-actions">
        <button
          type="button"
          className="mmp-btn"
          data-variant="primary"
          disabled={props.busy || saving}
          onClick={async () => {
            setSaving(true)
            try {
              await props.onSave({ vendor: props.vendor.id, label, account, secret: values })
              setValues({})
            } catch {
              // The parent surfaces the refusal.
            } finally {
              setSaving(false)
            }
          }}
        >
          {saving ? '保存并校验中…' : '保存并校验'}
        </button>
        <button type="button" className="mmp-btn" data-variant="danger" disabled={props.busy} onClick={props.onRemoveVendor}>
          清除该供应商全部凭证
        </button>
      </div>
    </div>
  )
}

const LABELS: Record<string, string> = {
  'field.token': 'Token / 密钥',
  'field.uid': '账号 uid',
  'field.site': '站点（zai / bigmodel）',
  'field.ak': 'Access Key',
  'field.sk': 'Secret Key',
  'field.securityToken': 'Security Token',
  'field.projectId': '项目 id',
  'field.deviceId': '设备 id',
}

const HINTS: Record<string, string> = {
  'hint.qoder-cn': '在 qoder.com.cn 的账号设置里生成 Personal Access Token，粘贴到这里。保存时会立刻校验并读一次额度。',
  'hint.qoder-global': '在 qoder.com 的账号设置里生成 Personal Access Token（国际版令牌对国内版无效）。',
  'hint.workbuddy': '从 WorkBuddy 桌面端登录态里取 accessToken（%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth）。',
  'hint.workbuddy-ai': '从 WorkBuddy AI 桌面端取 access token；国际版不带每日签到事件。',
  'hint.trae-cn': '从 Trae CN 客户端登录态取 Cloud-IDE-JWT（不含前缀），设备 id 可留空。',
  'hint.zcode': '粘贴 zcode-api-key 的 secret；Z.ai 账号选 zai，智谱账号选 bigmodel。',
  'hint.codearts': '华为云临时 AK/SK（+security-token）。CodeArts 请求要按 SDK-HMAC-SHA256 签名，本插件会替你签。',
}

function labelOf(key: string): string {
  return LABELS[key] ?? 'Token'
}

function hintOf(vendor: VendorMeta): string {
  return HINTS[vendor.credential.hintKey] ?? '按该供应商的要求填写凭证。'
}