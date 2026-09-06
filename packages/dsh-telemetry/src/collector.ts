import { randomUUID } from 'node:crypto'
import { pseudonym } from './identity.js'
import { projectEvent } from './project.js'
import { addTelemetryCount, type TelemetryStore } from './store.js'
import type { TelemetryRecordV1 } from './contracts.js'

export interface TelemetryService {
  flush(): Promise<void>
  stats(): { trackedRuns: number; dropped: number; writeErrors: number }
  dispose(): Promise<void>
}
export interface TelemetryCollector extends TelemetryService {
  observe(session: { id: string; parentId?: string }, event: { seq: number; type: string; data: unknown }): void
  closeRoot(id: string): void
  /** Sanitized loss path for malformed listener metadata. */
  reject(id?: string): void
}
interface Run {
  rootRef: string
  runRef: string
  count: number
  lost: number
  started: boolean
  seen: Set<string>
  sessions: Set<string>
}
const recognized = new Set(['run-started', 'schedule-selected', 'worker-requested', 'worker-finished', 'budget-rejected', 'verification-finished', 'parallel-started', 'parallel-finished'].map(kind => `dsh-plugin/${kind}`))
const MAX_ROOTS = 64
const MAX_EVENTS = 2048
const MAX_RETIRED = 2048
const failed = () => new Error('telemetry collector write failed')

export function createCollector(store: TelemetryStore): TelemetryCollector {
  const salt = store.salt
  const identify = (domain: string, value: string) => pseudonym(salt, domain, value)
  const sessionRef = (id: string) => {
    if (typeof id !== 'string' || !id.length) throw new TypeError('Invalid telemetry session')
    return identify('session', id)
  }
  const domainRef = identify('domain', 'dsh-telemetry-v1')
  const roots = new Map<string, Run>()
  const sessions = new Map<string, { run: Run; parentRef?: string }>()
  // Bounded retirement preserves unsafe root and descendant provenance.
  // At capacity, novel roots and children fail closed until replacement.
  const retired = new Set<string>()
  let admissionsClosed = false
  let stopped = false
  let dropped = 0
  let rejectedByStore = 0
  let writeError = false
  let dirty = false
  let pending: Promise<void> | undefined
  let disposal: Promise<void> | undefined
  const loss = (run?: Run) => {
    dropped = addTelemetryCount(dropped)
    if (run) run.lost = addTelemetryCount(run.lost)
  }
  const retire = (ref: string) => {
    if (retired.size < MAX_RETIRED) retired.add(ref)
    if (retired.size >= MAX_RETIRED) admissionsClosed = true
  }
  const flush = (): Promise<void> => {
    if (pending) return pending
    if (writeError) return Promise.reject(failed())
    pending = Promise.resolve().then(async () => {
      try {
        do { dirty = false; await store.flush() } while (dirty)
      } catch { writeError = true; throw failed() }
      finally { pending = undefined }
    })
    return pending
  }
  const enqueue = (record: TelemetryRecordV1, run: Run) => {
    try {
      if (store.enqueue(record)) {
        dirty = true
        // Store enqueue is deliberately synchronous; one caught drain owns I/O.
        void flush().catch(() => {})
        return true
      }
      rejectedByStore = addTelemetryCount(rejectedByStore)
    } catch { writeError = true }
    loss(run)
    return false
  }
  const seal = (run: Run, complete: boolean) => {
    roots.delete(run.rootRef)
    for (const ref of run.sessions) { sessions.delete(ref); retire(ref) }
    retire(run.rootRef)
    enqueue({ schemaVersion: 1, kind: 'run-seal', domainRef, runRef: run.runRef,
      observationCount: run.count, lostCount: run.lost, complete: complete && run.started && run.lost === 0 && !writeError }, run)
  }
  return {
    observe(session, event) {
      let run: Run | undefined
      let ref: string | undefined
      let projected: ReturnType<typeof projectEvent> | undefined
      const reject = () => {
        if (ref !== undefined && !sessions.has(ref)) retire(ref)
        loss(run)
      }
      try {
        if (!recognized.has(event.type)) return
        if (stopped) { loss(); return }
        ref = sessionRef(session.id)
        const known = sessions.get(ref)
        run = known?.run
        const parentRef = session.parentId === undefined ? undefined : sessionRef(session.parentId)
        if (known && known.parentRef !== parentRef) {
          const other = parentRef === undefined ? undefined : sessions.get(parentRef)?.run
          if (other && other !== run) other.lost = addTelemetryCount(other.lost)
          loss(run); return
        }
        if (!run && parentRef !== undefined) run = sessions.get(parentRef)?.run
        if (!run) {
          if (parentRef !== undefined) { retire(ref); retire(parentRef); loss(); return }
          const startsRun = event.type === 'dsh-plugin/run-started'
          const schedulesRoot = event.type === 'dsh-plugin/schedule-selected'
          if ((!startsRun && !schedulesRoot) || roots.size >= MAX_ROOTS || admissionsClosed || retired.has(ref)) {
            retire(ref); loss(); return
          }
          const candidate: Run = { rootRef: ref, runRef: identify('run', JSON.stringify([ref, randomUUID()])), count: 0, lost: 0, started: false, seen: new Set(), sessions: new Set([ref]) }
          if (schedulesRoot) {
            if (!Number.isSafeInteger(event.seq) || event.seq < 0) { reject(); return }
            projected = projectEvent(event, { schemaVersion: 1, domainRef, runRef: candidate.runRef,
              sessionRef: ref, seq: 1, observedAtMs: Date.now() }, identify)
            if (projected?.kind !== 'schedule-selected' || projected.facts.scope !== 'root') { reject(); return }
          }
          run = candidate
          roots.set(ref, run)
          sessions.set(ref, { run })
        }
        if (retired.has(ref) || (!known && parentRef !== undefined && admissionsClosed)) { loss(run); return }
        if (!Number.isSafeInteger(event.seq) || event.seq < 0) { reject(); return }
        const key = `${ref}:${event.seq}`
        if (run.seen.has(key)) return
        if (run.seen.size >= MAX_EVENTS) { reject(); return }
        run.seen.add(key)
        if (!known && parentRef !== undefined) {
          sessions.set(ref, { run, parentRef })
          run.sessions.add(ref)
        }
        if (event.type === 'dsh-plugin/run-started' && parentRef !== undefined) { loss(run); return }
        projected ??= projectEvent(event, { schemaVersion: 1, domainRef, runRef: run.runRef,
          sessionRef: ref, seq: run.count + 1, observedAtMs: Date.now() }, identify)
        if (projected && enqueue(projected, run)) {
          run.count++
          if (projected.kind === 'run-started') run.started = true
        }
      } catch { reject() }
    },
    reject(id) {
      let run: Run | undefined
      try {
        if (id !== undefined) {
          const ref = sessionRef(id)
          run = sessions.get(ref)?.run
          if (!run) retire(ref)
        }
      } catch { /* no raw diagnostics */ }
      loss(run)
    },
    closeRoot(id) {
      try {
        const ref = sessionRef(id)
        const run = roots.get(ref)
        if (run) seal(run, true)
        else if (!sessions.has(ref)) retire(ref)
      } catch { loss() }
    },
    flush() { return disposal ?? flush() },
    stats() {
      const stats = store.stats()
      return { trackedRuns: roots.size, dropped: addTelemetryCount(dropped, Math.max(0, stats.dropped - rejectedByStore)), writeErrors: Math.max(stats.writeErrors, writeError ? 1 : 0) }
    },
    dispose() {
      if (disposal) return disposal
      stopped = true
      for (const run of roots.values()) seal(run, false)
      disposal = (async () => {
        await pending?.catch(() => {})
        try { await store.dispose() } catch { writeError = true; throw failed() }
      })()
      return disposal
    },
  }
}
