/**
 * Host half of `dsh-magpie-connect`.
 *
 * Owns no LLM provider: model routing stays with whichever gateway provider the
 * profile already configured. This bundle supplies the multi-vendor console -
 * the account book, the quota reads, the daily check-in sweep and the HTTP
 * routes its own browser half calls.
 *
 * @module dsh-magpie-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectStatus } from './types.ts'
import { ROUTE_BASE } from './types.ts'
import { mountRoutes } from './host/routes.ts'
import { buildStatus, checkinAll, nextCheckinAt, refreshAll, shanghaiDay, shanghaiWallClockToUtc, type EngineOptions } from './host/engine.ts'
import { listAccounts, loadSettings } from './host/store.ts'
import { closeAllLogins } from './host/browser-login.ts'

export const name = 'magpie-connect'

/** The services this plugin needs before it can mount its routes. */
export const inject = ['webServer'] as const

/** Bumped with every release; the panel shows it in its footer. */
export const VERSION = '0.1.0'

/** Delay before the first read, so a cold boot is not charged with it. */
const FIRST_READ_DELAY_MS = 4_000

/** How often the ticker checks whether the check-in minute has arrived. */
const TICK_MS = 30_000

interface SchedulerState {
  enabled: boolean
  nextAt: string | null
  lastAt: string | null
}

export function apply(ctx: Context): void {
  const logger = ctx.logger
  const options: EngineOptions = {
    version: VERSION,
    logger: {
      warn: (...args: unknown[]) => logger.warn(...args),
      info: (...args: unknown[]) => logger.info(...args),
    },
  }

  const state: SchedulerState = {
    enabled: loadSettings().autoCheckin,
    nextAt: null,
    lastAt: null,
  }

  /** Re-arm the timer from the stored settings; called after every change. */
  function reschedule(): void {
    const settings = loadSettings()
    state.enabled = settings.autoCheckin
    state.nextAt = settings.autoCheckin ? nextCheckinAt(settings.checkinMinute) : null
  }

  reschedule()

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  /** One tick: sweep when the minute has arrived and today has not been swept. */
  async function tick(): Promise<void> {
    if (running) return
    const settings = loadSettings()
    if (!settings.autoCheckin) {
      if (state.nextAt !== null) {
        state.nextAt = null
      }
      return
    }
    const now = Date.now()
    const target = shanghaiWallClockToUtc(shanghaiDay(now), settings.checkinMinute)
    const lastDay = state.lastAt === null ? null : shanghaiDay(new Date(state.lastAt))
    if (now < target) {
      state.nextAt = new Date(target).toISOString()
      return
    }
    if (lastDay === shanghaiDay(now)) {
      // Already swept today; wait for tomorrow's window.
      state.nextAt = new Date(target + 86_400_000).toISOString()
      return
    }
    if (listAccounts().length === 0) {
      state.nextAt = new Date(target + 86_400_000).toISOString()
      return
    }
    running = true
    try {
      logger.info(`dsh-magpie-connect: 开始每日签到（北京时间 ${formatMinute(settings.checkinMinute)}）`)
      await checkinAll(options)
      state.lastAt = new Date().toISOString()
      logger.info('dsh-magpie-connect: 每日签到完成')
    } catch (error) {
      logger.warn(`dsh-magpie-connect: 每日签到异常 - ${(error as Error).message}`)
    } finally {
      running = false
      state.nextAt = new Date(target + 86_400_000).toISOString()
    }
  }

  function formatMinute(minute: number): string {
    const hours = Math.floor(minute / 60)
    const minutes = minute % 60
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  }

  ctx.effect(() => () => closeAllLogins(), 'dsh-magpie-connect: browser logins')

  ctx.effect(() => {
    timer = setInterval(() => {
      void tick()
    }, TICK_MS)
    // A first read shortly after mount fills the card without a manual press.
    const firstRead = setTimeout(() => {
      void refreshAll(options).catch(() => undefined)
      void tick()
    }, FIRST_READ_DELAY_MS)
    return () => {
      clearInterval(timer)
      clearTimeout(firstRead)
    }
  }, 'dsh-magpie-connect: scheduler')

  ctx.inject(['webServer'], (scoped: any) => {
    const server = scoped.webServer as { register(route: unknown): () => void }
    if (server === undefined || typeof server.register !== 'function') {
      logger.warn('dsh-magpie-connect: 宿主没有提供 webServer，面板将无法读取状态')
      return
    }
    const routes = mountRoutes({
      options,
      scheduler: () => ({ ...state }),
      reschedule,
    })
    for (const route of routes) {
      ctx.effect(() => server.register(route) as () => void, `dsh-magpie-connect: ${route.path}`)
    }
    logger.info(`dsh-magpie-connect: 已挂载 ${routes.length} 条路由于 ${ROUTE_BASE}`)
  })
}

/** Re-exported for tests and for the browser half's type imports. */
export { buildStatus }
export type { ConnectStatus }