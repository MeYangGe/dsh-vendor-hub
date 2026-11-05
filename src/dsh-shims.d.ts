/**
 * Local, deliberately loose declarations for the Harness packages this bundle
 * rides. They let the bundle typecheck and build without pinning the DSH
 * dependency graph; at runtime every one of them is provided by the host's
 * module table (tsdown marks them external).
 */

declare module '@deepseek-ai/cordis' {
  export interface Disposer {
    (): void
  }
  export interface Context {
    readonly logger: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void; debug?(...a: unknown[]): void }
    effect(fn: () => void | (() => void), label?: string): void
    inject(deps: string[], fn: (scoped: any) => void): void
    provide(name: string, value: unknown): void
    on(event: string, fn: (...a: any[]) => void): () => void
    readonly config: Record<string, unknown>
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface PropsRuntime {
    slots: any
    locale: any
    theme: any
    [key: string]: any
  }
  export interface PropsRenderSlots {
    [key: string]: any
  }
  export interface SlotMap {}
}

declare module '@deepseek-ai/dsh-client-ui-settings/client' {
  export interface ConfigFormSnapshot<T = Record<string, unknown>> {
    readonly value: T
    readonly revision: number
    [key: string]: any
  }
  export interface ConfigForm<T = Record<string, unknown>> {
    mutate(patch: Partial<T>, revision: number): Promise<void>
    [key: string]: any
  }
  export interface ConfigPageForm {
    readonly state: ConfigFormSnapshot<Record<string, unknown>>
    readonly mutate: ConfigForm<Record<string, unknown>>['mutate']
  }
}

declare module '@deepseek-ai/dsh-client-ui-settings-plugins/client' {
  export interface PluginConfigViewProps {
    readonly view: 'summary' | 'page'
    readonly form?: { readonly state: any; readonly mutate: any } | undefined
  }
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  export interface LocaleService {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar/client' {}
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export const Menu: any
  export const Tooltip: any
  export const Toast: any
  export const DisclosureRow: any
}
declare module '@deepseek-ai/dsh-host-webserver' {
  export interface WebServerService {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void | Promise<void>
    }): () => void
  }
}
