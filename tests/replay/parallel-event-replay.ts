import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { parseParallelAggregateV1 } from '@ds-plugins/dsh-scheduling-contracts'
import { parseScheduleSelectedV1 } from '@ds-plugins/dsh-scheduling-contracts'
import {
  parseParallelStartedV1,
  parseWorkerFinishedV1,
  parseWorkerRequestedV1,
  type ParallelStartedV1,
} from '@ds-plugins/dsh-orchestrator'
import type { ParallelAggregateV1 } from '@ds-plugins/dsh-scheduling-contracts'

export interface ParallelReplayResultV1 {
  readonly complete: boolean
  readonly committed?: ParallelAggregateV1
  readonly levelAggregates: readonly ParallelAggregateV1[]
}

export class ParallelReplayCorruptionError extends Error {
  readonly code = 'PARALLEL_REPLAY_CORRUPTION' as const
  constructor(message: string) {
    super(message)
    this.name = 'ParallelReplayCorruptionError'
  }
}

type Triple = { fanoutId: string; nodeId: string; requestId: string }
type Run = {
  manifest: ParallelStartedV1
  selected: Set<string>
  requested: Set<string>
  finished: Set<string>
  workerRefs: Map<string, string>
  levels: ParallelAggregateV1[]
  committed?: ParallelAggregateV1
}

const workerBackedReasons = new Set(['completed', 'cancelled-after-start', 'blocked-result', 'failed-result', 'handoff-payload-too-large', 'violation'])
const requestedWithoutFinishReasons = new Set(['start-failed', 'cancelled-before-start'])
const noWorkerReasons = new Set(['dependency-not-run', 'zero-worker-constraint', 'no-route', 'tool-unauthorized', 'admission-rejected', 'level-verification-stopped'])

function corrupt(message: string): never { throw new ParallelReplayCorruptionError(message) }
function triple(value: unknown): Triple | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  if (typeof item.fanoutId !== 'string' || typeof item.nodeId !== 'string' || typeof item.requestId !== 'string') return undefined
  return { fanoutId: item.fanoutId, nodeId: item.nodeId, requestId: item.requestId }
}
function hasCorrelationKeys(value: unknown): boolean {
  return !!value && typeof value === 'object' && ['fanoutId', 'nodeId', 'requestId'].some(key => Object.prototype.hasOwnProperty.call(value, key))
}
function key(value: Triple): string { return `${value.fanoutId}\u0000${value.nodeId}\u0000${value.requestId}` }
function sameTriple(a: Triple, b: Triple): boolean { return a.fanoutId === b.fanoutId && a.nodeId === b.nodeId && a.requestId === b.requestId }
function runFor(runs: Map<string, Run>, value: Triple): Run {
  const match = /^(.*):(?:aggregate|level:\d+)$/u.exec(value.fanoutId)
  const run = match ? runs.get(match[1]) : undefined
  if (!run) corrupt(`parallel event ${value.requestId} has no manifest`)
  return run
}

export function validateParallelEventReplay(events: readonly SessionEvent[]): readonly ParallelReplayResultV1[] {
  const runs = new Map<string, Run>()
  for (const event of events) {
    const data = event.data as unknown
    if (event.type === 'dsh-plugin/parallel-started') {
      let manifest: ParallelStartedV1
      try { manifest = parseParallelStartedV1(data) } catch (error) { corrupt(`invalid parallel manifest: ${String(error)}`) }
      if (runs.has(manifest.dagId)) corrupt(`duplicate manifest ${manifest.dagId}`)
      runs.set(manifest.dagId, { manifest, selected: new Set(), requested: new Set(), finished: new Set(), workerRefs: new Map(), levels: [] })
      continue
    }
    if (event.type === 'dsh-plugin/schedule-selected') {
      if (hasCorrelationKeys(data) && !triple(data)) corrupt('correlation triple is incomplete')
      const t = triple(data)
      if (!t) continue
      const run = runFor(runs, t)
      if (run.committed) corrupt(`parallel event after commit: ${t.requestId}`)
      let schedule: ReturnType<typeof parseScheduleSelectedV1>
      try { schedule = parseScheduleSelectedV1(data) } catch (error) { corrupt(`invalid schedule: ${String(error)}`) }
      if (schedule.target === 'root') corrupt('correlated schedule cannot target root')
      const planned = run.manifest.requests.find(item => sameTriple(item, t))
      if (!planned) corrupt(`schedule does not match manifest: ${t.requestId}`)
      const k = key(t)
      if (run.selected.has(k)) corrupt(`duplicate schedule: ${t.requestId}`)
      run.selected.add(k)
      continue
    }
    if (event.type === 'dsh-plugin/worker-requested') {
      if (hasCorrelationKeys(data) && !triple(data)) corrupt('correlation triple is incomplete')
      const t = triple(data)
      if (!t) continue
      const run = runFor(runs, t)
      if (run.committed) corrupt(`parallel event after commit: ${t.requestId}`)
      try { parseWorkerRequestedV1(data, 'parallel') } catch (error) { corrupt(`invalid parallel request: ${String(error)}`) }
      const k = key(t)
      if (!run.selected.has(k)) corrupt(`request without schedule: ${t.requestId}`)
      if (run.requested.has(k)) corrupt(`duplicate request: ${t.requestId}`)
      run.requested.add(k)
      continue
    }
    if (event.type === 'dsh-plugin/worker-finished') {
      if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'workerRef') && !triple(data)) corrupt('parallel worker-finished requires a complete correlation triple')
      if (hasCorrelationKeys(data) && !triple(data)) corrupt('correlation triple is incomplete')
      const t = triple(data)
      if (!t) continue
      const run = runFor(runs, t)
      if (run.committed) corrupt(`parallel event after commit: ${t.requestId}`)
      let finished: ReturnType<typeof parseWorkerFinishedV1>
      try { finished = parseWorkerFinishedV1(data, 'parallel') } catch (error) { corrupt(`invalid parallel finish: ${String(error)}`) }
      const k = key(t)
      if (!run.requested.has(k)) corrupt(`finish without request: ${t.requestId}`)
      if (run.finished.has(k)) corrupt(`duplicate finish: ${t.requestId}`)
      run.finished.add(k)
      run.workerRefs.set(k, finished.workerRef)
      continue
    }
    if (event.type === 'dsh-plugin/parallel-finished') {
      let aggregate: ParallelAggregateV1
      try { aggregate = parseParallelAggregateV1(data) } catch (error) { corrupt(`invalid aggregate: ${String(error)}`) }
      const run = runs.get(aggregate.dagId)
      if (!run) corrupt(`aggregate has no manifest: ${aggregate.dagId}`)
      if (run.committed) corrupt(`duplicate cumulative commit: ${aggregate.dagId}`)
      const expectedFanout = aggregate.scope === 'dag' ? `${aggregate.dagId}:aggregate` : `${aggregate.dagId}:level:${aggregate.levelIndex}`
      if (aggregate.fanoutId !== expectedFanout) corrupt(`aggregate fanout is inconsistent: ${aggregate.fanoutId}`)
      for (const result of aggregate.nodeResults) {
        const planned = run.manifest.requests.find(item => item.nodeId === result.nodeId && item.requestId === result.requestId)
        if (!planned || planned.fanoutId !== aggregate.fanoutId && aggregate.scope === 'level') corrupt(`aggregate node is inconsistent: ${result.nodeId}`)
      }
      if (aggregate.scope === 'level') {
        const prior = run.levels.at(-1)
        if (prior !== undefined && aggregate.levelIndex! <= prior.levelIndex!) corrupt(`level aggregate is not strictly increasing: ${aggregate.levelIndex}`)
        const members = new Set(run.manifest.requests.filter(item => item.fanoutId === aggregate.fanoutId).map(key))
        const results = new Set(aggregate.nodeResults.map(result => key({ fanoutId: aggregate.fanoutId, nodeId: result.nodeId, requestId: result.requestId })))
        if (members.size !== results.size || [...members].some(item => !results.has(item))) corrupt(`level aggregate membership is incomplete: ${aggregate.levelIndex}`)
        if (aggregate.verificationOutcome === 'not-run-no-accepted-nodes' || aggregate.nodeResults.every(result => noWorkerReasons.has(result.reason))) corrupt(`level aggregate has no executable nodes: ${aggregate.levelIndex}`)
        for (const result of aggregate.nodeResults) validateTerminalCorrespondence(run, result, aggregate.fanoutId)
        run.levels.push(aggregate)
      } else {
        const identity = (item: { nodeId: string; requestId: string }) => `${item.nodeId}\u0000${item.requestId}`
        const all = new Set(run.manifest.requests.map(identity))
        const got = new Set(aggregate.nodeResults.map(identity))
        if (got.size !== all.size || [...all].some(item => !got.has(item))) corrupt('final aggregate does not cover manifest')
        for (const result of aggregate.nodeResults) {
          const planned = run.manifest.requests.find(item => item.nodeId === result.nodeId && item.requestId === result.requestId)
          if (!planned) corrupt(`aggregate node is inconsistent: ${result.nodeId}`)
          const eventKey = key(planned)
          validateTerminalCorrespondence(run, result)
        }
        reconcileLevels(run, aggregate)
        run.committed = aggregate
      }
    }
  }
  return [...runs.values()].map(run => ({ complete: run.committed !== undefined, ...(run.committed ? { committed: run.committed } : {}), levelAggregates: run.levels }))
}

function validateTerminalCorrespondence(run: Run, result: ParallelAggregateV1['nodeResults'][number], fanoutId?: string): void {
  const planned = run.manifest.requests.find(item => (fanoutId === undefined || item.fanoutId === fanoutId) && item.nodeId === result.nodeId && item.requestId === result.requestId)
  if (!planned) corrupt(`aggregate node is inconsistent: ${result.nodeId}`)
  const eventKey = key(planned)
  const finished = run.finished.has(eventKey)
  const workerRef = run.workerRefs.get(eventKey)
  const selected = run.selected.has(eventKey)
  const requested = run.requested.has(eventKey)
  if (workerBackedReasons.has(result.reason)) {
    const payloadTooLarge = result.reason === 'handoff-payload-too-large'
    if (!selected || !requested || finished !== !payloadTooLarge || (!payloadTooLarge && result.workerRef !== workerRef)) corrupt(`worker terminal correspondence: ${result.nodeId}`)
  } else if (requestedWithoutFinishReasons.has(result.reason)) {
    if (!selected || !requested || finished || result.workerRef !== undefined) corrupt(`worker predecessor cardinality: ${result.nodeId}`)
  } else if (noWorkerReasons.has(result.reason)) {
    if (selected || requested || finished || result.workerRef !== undefined) corrupt(`forbidden worker event: ${result.nodeId}`)
  } else corrupt(`unsupported terminal reason: ${result.nodeId}`)
}

function reconcileLevels(run: Run, final: ParallelAggregateV1): void {
  const latest = new Map<string, ParallelAggregateV1['nodeResults'][number]>()
  const ownership = new Map<string, ParallelAggregateV1['ownershipViolations'][number]>()
  let verification: ParallelAggregateV1['verificationOutcome'] = 'not-run-no-commands'
  for (const level of run.levels) {
    for (const result of level.nodeResults) {
      const id = `${result.nodeId}\u0000${result.requestId}`
      if (latest.has(id)) corrupt(`repeated node result: ${id}`)
      latest.set(id, result)
    }
    for (const item of level.ownershipViolations) ownership.set(item.nodeId, item)
    verification = level.verificationOutcome
  }
  if (run.levels.length !== 0) {
    const finalIds = new Set(final.nodeResults.map(result => `${result.nodeId}\u0000${result.requestId}`))
    if ([...latest.keys()].some(id => !finalIds.has(id))) corrupt('final aggregate does not reconcile levels')
    for (const result of final.nodeResults) {
      const prior = latest.get(`${result.nodeId}\u0000${result.requestId}`)
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(result)) corrupt(`final node result differs from level result: ${result.nodeId}`)
      if (prior === undefined && !noWorkerReasons.has(result.reason)) corrupt(`final-only node is not skipped: ${result.nodeId}`)
    }
    const lastActual = [...run.levels].reverse().find(level => level.verificationOutcome !== 'not-run-no-commands' && level.verificationOutcome !== 'not-run-no-accepted-nodes')
    const foldedVerification = lastActual?.verificationOutcome ?? verification
    if (final.verificationOutcome !== foldedVerification) corrupt('final verification fold is inconsistent')
    const finalEvidence = JSON.stringify(final.verification)
    const lastEvidence = JSON.stringify(lastActual?.verification)
    if (lastActual !== undefined && finalEvidence !== lastEvidence) corrupt('final verification evidence is inconsistent')
    const finalOwnership = new Map(final.ownershipViolations.map(item => [item.nodeId, item]))
    if (finalOwnership.size !== ownership.size || [...ownership].some(([id, item]) => JSON.stringify(finalOwnership.get(id)) !== JSON.stringify(item))) corrupt('ownership summaries do not reconcile')
  }
}
