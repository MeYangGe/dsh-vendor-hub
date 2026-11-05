/**
 * The vendor catalogue: everything the console can say about a vendor with no
 * network access. Shared by both halves, so the panel, the settings card and
 * the host's adapters agree on ids, names and credential shapes.
 */

import type { VendorId, VendorMeta } from './types.ts'

const PAT_FIELD = { key: 'token', labelKey: 'field.token', required: true, secret: true } as const

export const VENDORS: readonly VendorMeta[] = [
  {
    id: 'qoder-cn',
    name: 'Qoder 国内版',
    nameEn: 'Qoder (China)',
    site: 'qoder.com.cn',
    glyph: 'Q',
    credential: {
      kind: 'pat',
      hintKey: 'hint.qoder-cn',
      fields: [{ ...PAT_FIELD, placeholder: '粘贴 qoder.com.cn 生成的 PAT' }],
    },
    checkin: true,
    unit: 'credits',
    planHintKey: 'plan.qoder',
  },
  {
    id: 'qoder-global',
    name: 'Qoder 国际版',
    nameEn: 'Qoder Global',
    site: 'qoder.com',
    glyph: 'Q',
    credential: {
      kind: 'pat',
      hintKey: 'hint.qoder-global',
      fields: [{ ...PAT_FIELD, placeholder: 'Paste the PAT generated on qoder.com' }],
    },
    checkin: true,
    unit: 'credits',
    planHintKey: 'plan.qoder',
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy 国内版',
    nameEn: 'WorkBuddy (China)',
    site: 'copilot.tencent.com',
    glyph: 'W',
    credential: {
      kind: 'token',
      hintKey: 'hint.workbuddy',
      fields: [
        { key: 'token', labelKey: 'field.token', required: true, secret: true, placeholder: 'accessToken（桌面端登录态）' },
        { key: 'uid', labelKey: 'field.uid', required: false, placeholder: '账号 uid（可选，用于归属）' },
      ],
    },
    checkin: true,
    unit: 'credits',
    planHintKey: 'plan.workbuddy',
  },
  {
    id: 'workbuddy-ai',
    name: 'WorkBuddy 国际版',
    nameEn: 'WorkBuddy AI',
    site: 'www.workbuddy.ai',
    glyph: 'W',
    credential: {
      kind: 'token',
      hintKey: 'hint.workbuddy-ai',
      fields: [
        { key: 'token', labelKey: 'field.token', required: true, secret: true, placeholder: 'access token' },
        { key: 'uid', labelKey: 'field.uid', required: false, placeholder: 'account uid (optional)' },
      ],
    },
    checkin: false,
    unit: 'credits',
    planHintKey: 'plan.workbuddy-ai',
  },
  {
    id: 'trae-cn',
    name: 'Trae 国内版',
    nameEn: 'Trae CN',
    site: 'trae.cn',
    glyph: 'T',
    credential: {
      kind: 'token',
      hintKey: 'hint.trae-cn',
      fields: [
        { key: 'token', labelKey: 'field.token', required: true, secret: true, placeholder: 'Cloud-IDE-JWT' },
        { key: 'deviceId', labelKey: 'field.deviceId', required: false, placeholder: '设备 id（可选）' },
      ],
    },
    checkin: true,
    unit: 'credits',
    planHintKey: 'plan.trae',
  },
  {
    id: 'zcode',
    name: 'ZCode（GLM 编码套餐）',
    nameEn: 'ZCode (GLM Coding Plan)',
    site: 'zcode.z.ai',
    glyph: 'Z',
    credential: {
      kind: 'pat',
      hintKey: 'hint.zcode',
      fields: [
        { key: 'token', labelKey: 'field.token', required: true, secret: true, placeholder: 'API Key（zcode-api-key 的 secret）' },
        { key: 'site', labelKey: 'field.site', required: false, placeholder: 'zai 或 bigmodel（默认 zai）' },
      ],
    },
    checkin: true,
    unit: 'credits',
    planHintKey: 'plan.zcode',
  },
  {
    id: 'codearts',
    name: 'CodeArts（华为云码道）',
    nameEn: 'CodeArts (Huawei Cloud)',
    site: 'codearts.huaweicloud.com',
    glyph: 'C',
    credential: {
      kind: 'keys',
      hintKey: 'hint.codearts',
      fields: [
        { key: 'ak', labelKey: 'field.ak', required: true, secret: true, placeholder: 'Access Key' },
        { key: 'sk', labelKey: 'field.sk', required: true, secret: true, placeholder: 'Secret Key' },
        { key: 'token', labelKey: 'field.securityToken', required: false, secret: true, placeholder: 'security-token（临时凭证才需要）' },
        { key: 'projectId', labelKey: 'field.projectId', required: false, placeholder: '项目 id（可选）' },
      ],
    },
    checkin: true,
    unit: 'credits',
    planHintKey: 'plan.codearts',
  },
]

/** Lookup by id; undefined for an id the catalogue dropped. */
export function vendorMeta(id: VendorId): VendorMeta | undefined {
  return VENDORS.find((vendor) => vendor.id === id)
}

/** Vendors that pay a daily check-in, in catalogue order. */
export function checkinVendors(): readonly VendorMeta[] {
  return VENDORS.filter((vendor) => vendor.checkin)
}