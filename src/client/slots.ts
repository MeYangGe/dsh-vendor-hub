/**
 * SlotMap additions this bundle registers into, declared locally so the browser
 * bundle typechecks without depending on each owning package. Structurally
 * identical to upstream's declarations.
 */

import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

/** Sidebar footer action owner share: only the column display state. */
export interface SidebarFooterActionOwnerProps {
  /** Whether the sidebar renders wide content (false = the 56px rail). */
  wide: boolean
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** The layout's center-column panel registry. */
    main: { kind: 'keyed'; scope: 'root' }
    /** Sidebar foot action list, rendered above the Settings seat. */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
    /** The sidebar's panel entry list. */
    'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: Record<string, unknown> }
    /** A tab in the Plugins settings surface. */
    'settings.plugins.tab': { kind: 'list'; scope: 'root'; owner: Record<string, unknown> }
    /** A bundle's own configuration block. */
    'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewProps }
  }
}