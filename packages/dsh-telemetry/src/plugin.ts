import type { Context, Plugin } from '@deepseek-ai/cordis'
import { Config, parseTelemetryConfig, type TelemetryConfig } from './config.js'
import { createCollector, type TelemetryCollector, type TelemetryService } from './collector.js'
import { openTelemetryStore, type TelemetryStore } from './store.js'

interface SourceSession { id: string; header: { parentSession?: string } }
interface EventContext {
  provide(name: string, value: TelemetryService): () => unknown
  on(name: 'session/event', callback: (session: SourceSession, event: { seq: number; type: string; data: unknown }) => void): () => unknown
  on(name: 'session/disposed', callback: (session: SourceSession) => void): () => unknown
}
export const name = 'dsh-telemetry'
export const provide = ['telemetry'] as const
export const inject = ['sessions'] as const

export const apply: Plugin.Function<TelemetryConfig> = async (ctx: Context, rawConfig: TelemetryConfig) => {
  const config = parseTelemetryConfig(rawConfig)
  if (!config.enabled) return
  const events = ctx as unknown as EventContext
  let active = true
  let collector: TelemetryCollector | undefined
  let store: TelemetryStore | undefined
  let initialization: Promise<void>
  let disposal: Promise<void> | undefined
  const listeners: (() => unknown)[] = []
  let removeService: (() => unknown) | undefined
  const detach = () => {
    active = false
    for (const remove of listeners.splice(0)) { try { void Promise.resolve(remove()).catch(() => {}) } catch { /* passive cleanup */ } }
    try { if (removeService) void Promise.resolve(removeService()).catch(() => {}) } catch { /* passive cleanup */ }
    removeService = undefined
  }
  const close = async () => {
    try { if (collector) await collector.dispose(); else await store?.dispose() } catch { /* counters expose failure; never raw diagnostics */ }
  }
  const stop = () => {
    detach()
    return disposal ??= (async () => { await initialization; await close() })()
  }
  // Register synchronous cancellation before asynchronous filesystem startup.
  // Late startup checks this flag and closes its store before binding anything.
  ctx.effect(() => stop, 'dsh-telemetry: service generation')
  initialization = (async () => {
    try {
      store = await openTelemetryStore(config.storageRoot!)
      if (!active) { await close(); return }
      collector = createCollector(store)
      const runtime = collector
      listeners.push(events.on('session/event', (session, event) => {
        if (!active) return
        let id: string | undefined
        try {
          id = session.id
          runtime.observe({ id, parentId: session.header.parentSession }, { seq: event.seq, type: event.type, data: event.data })
        } catch { runtime.reject(id) }
      }))
      listeners.push(events.on('session/disposed', session => {
        if (!active) return
        let id: string | undefined
        try { id = session.id; if (session.header.parentSession === undefined) runtime.closeRoot(id) }
        catch { runtime.reject(id) }
      }))
      removeService = events.provide('telemetry', { flush: () => runtime.flush(), stats: () => runtime.stats(), dispose: stop })
    } catch {
      detach()
      await close()
    }
  })()
  await initialization
}
apply.Config = Config
apply.inject = inject
apply.provide = [...provide]
