/**
 * Browser half of `dsh-vendor-hub`.
 *
 * Registers three surfaces and nothing else:
 *   - `sidebar.footer.action`  the allowance card (when the host serves it)
 *   - `main` / `sidebar.panellist`  the three-tab console
 *   - `settings.plugins.tab`  the same console inside the Plugins surface
 *
 * Every surface is optional: a host that does not declare a slot simply never
 * calls its registration, and the remaining surfaces still work.
 */

import { useEffect } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import './slots.ts'
import { ConnectPanel } from './Panel.tsx'
import { QuotaCard } from './QuotaCard.tsx'
import { acquire, useConnectStore } from './store.ts'
import { ensureStyles, removeStyles } from './styles.ts'

/** Stable plugin name, matching the Host half. */
export const name = 'vendor-hub'

/** Services the browser half needs before it can register. */
export const inject = ['slots']

/** Key of this bundle's center-column panel. */
export const PANEL_ID = 'vendor-hub'

/** The card surface: subscribes on its own so it can render without the panel. */
function SidebarCard(props: { wide: boolean; onOpen: () => void }) {
  const { status, settings } = useConnectStore()
  useEffect(() => {
    ensureStyles()
    return acquire()
  }, [])
  if (status === null) return null
  if (settings !== null && settings.value.sidebarCard === false) return null
  return <QuotaCard status={status} wide={props.wide} onOpen={props.onOpen} />
}

export function apply(ctx: ClientContext): void {
  ensureStyles()
  ctx.effect(() => () => removeStyles(), 'dsh-vendor-hub: styles')

  /** The layout service, once the host offers it. */
  let openPanel: () => void = () => undefined
  ctx.inject(['layout'], (scoped: any) => {
    const layout = scoped.layout as { selectPanel?: (id: string) => void } | undefined
    if (layout !== undefined && typeof layout.selectPanel === 'function') {
      openPanel = () => layout.selectPanel?.(PANEL_ID)
    }
  })

  // The center-column panel itself. `main` is declared by the layout entry's own
  // `register({ name: 'root', children: { main } })`, and entries activate
  // concurrently — registering eagerly races that declaration and throws
  // `slot "main" is not declared`, which fails this bundle and aborts web boot.
  // `inject` runs the registration only once the declaration is committed.
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_ID } as never,
      () => <ConnectPanel />,
    ),
  )

  // The sidebar footer card: opened by a press, hidden when the user turns it off.
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: PANEL_ID, order: 30, label: () => 'Vendor Hub' } as never,
      (owner: { wide?: boolean } = {}) => <SidebarCard wide={owner.wide !== false} onOpen={openPanel} />,
    ),
  )

  // A panel entry beside the host's own sidebar entries.
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => 'Vendor Hub' } as never,
      () => null,
    ),
  )

  // The same console inside the Plugins surface.
  ctx.slots.inject('settings.plugins.tab', () =>
    ctx.slots.register(
      { name: 'settings.plugins.tab', id: PANEL_ID, order: 65, label: () => 'Vendor Hub' } as never,
      () => <ConnectPanel />,
    ),
  )
}