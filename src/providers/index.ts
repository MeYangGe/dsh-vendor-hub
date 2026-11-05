/** Adapter registry: one implementation per vendor id. */

import type { VendorId } from '../types.ts'
import type { VendorAdapter } from './base.ts'
import { qoderCnAdapter, qoderGlobalAdapter } from './qoder.ts'
import { workbuddyAdapter, workbuddyAiAdapter } from './workbuddy.ts'
import { traeCnAdapter } from './trae.ts'
import { zcodeAdapter } from './zcode.ts'
import { codeartsAdapter } from './codearts.ts'

const TABLE: Record<VendorId, VendorAdapter> = {
  'qoder-cn': qoderCnAdapter,
  'qoder-global': qoderGlobalAdapter,
  workbuddy: workbuddyAdapter,
  'workbuddy-ai': workbuddyAiAdapter,
  'trae-cn': traeCnAdapter,
  zcode: zcodeAdapter,
  codearts: codeartsAdapter,
}

/** The adapter for a vendor, or undefined for an id with no implementation. */
export function adapterFor(vendor: VendorId): VendorAdapter | undefined {
  return TABLE[vendor]
}

export { AdapterFailure } from './base.ts'
export type { VendorAdapter } from './base.ts'