import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { parseScheduleSelectedV1 } from '@ds-plugins/dsh-scheduling-contracts'
import type { ScheduleSelectedV1 } from '@ds-plugins/dsh-scheduling-contracts'
import type { HandoffV1, VerificationEvidenceV1, WorkerSpecV1 } from './types.js'

/** Durable record of the resolved run configuration. */
export interface RunStartedV1 {
  readonly schemaVersion: 1
  readonly mode: 'direct' | 'single-worker'
  readonly provider: string
  readonly model: string
}

/** Durable record that binds a completed child session to its validated handoff. */
export interface WorkerFinishedV1 {
  readonly schemaVersion: 1
  readonly childSessionId: SessionId
  readonly handoff: HandoffV1
}

/** Stable reason and counters for one deterministic admission rejection. */
export interface BudgetRejectedV1 {
  readonly schemaVersion: 1
  readonly reason: string
  readonly limit: number
  readonly observed: number
}

/** Input for recording one resolved run configuration. */
export interface RunStartedInput {
  readonly mode: RunStartedV1['mode']
  readonly provider: string
  readonly model: string
}

/** Input for recording one deterministic admission rejection. */
export interface BudgetRejectedInput {
  readonly reason: string
  readonly limit: number
  readonly observed: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Required replay record of the selected run mode and resolved model route. */
    'dsh-plugin/run-started': RunStartedV1
    /** Required replay record of the bounded worker request. */
    'dsh-plugin/worker-requested': WorkerSpecV1
    /** Required replay record of the child-session result visible to its parent. */
    'dsh-plugin/worker-finished': WorkerFinishedV1
    /** Required replay record of a deterministic resource-admission rejection. */
    'dsh-plugin/budget-rejected': BudgetRejectedV1
    /** Required replay record of one targeted verification result. */
    'dsh-plugin/verification-finished': VerificationEvidenceV1
    /** Durable record of the selected bounded scheduler route. */
    'dsh-plugin/schedule-selected': ScheduleSelectedV1
  }
}

function snapshotVerification(evidence: VerificationEvidenceV1): VerificationEvidenceV1 {
  return {
    schemaVersion: 1,
    commandName: evidence.commandName,
    args: [...evidence.args],
    exitCode: evidence.exitCode,
    status: evidence.status,
    stdout: evidence.stdout,
    stderr: evidence.stderr,
    truncated: evidence.truncated,
    durationMs: evidence.durationMs,
  }
}

function snapshotHandoff(handoff: HandoffV1): HandoffV1 {
  return {
    schemaVersion: 1,
    status: handoff.status,
    summary: handoff.summary,
    changedFiles: [...handoff.changedFiles],
    decisions: [...handoff.decisions],
    verification: handoff.verification.map(snapshotVerification),
    blockers: [...handoff.blockers],
  }
}

function snapshotWorkerSpec(worker: WorkerSpecV1): WorkerSpecV1 {
  return {
    schemaVersion: 1,
    task: worker.task,
    provider: worker.provider,
    model: worker.model,
    ...(worker.reasoningEffort === undefined ? {} : { reasoningEffort: worker.reasoningEffort }),
    maxTokens: worker.maxTokens,
    allowedTools: [...worker.allowedTools],
    expectedOutput: 'handoff-v1',
  }
}

/**
 * Append the resolved run mode and model route.
 * @param session - Session that owns the durable record.
 * @param input - Resolved run configuration identifiers.
 * @returns The appended event sequence number.
 */
export function appendRunStarted(session: Session, input: RunStartedInput): number {
  return session.append('dsh-plugin/run-started', {
    schemaVersion: 1,
    mode: input.mode,
    provider: input.provider,
    model: input.model,
  }).seq
}

/**
 * Append a bounded child-session request.
 * @param session - Session that owns the durable record.
 * @param worker - Validated worker request.
 * @returns The appended event sequence number.
 */
export function appendWorkerRequested(session: Session, worker: WorkerSpecV1): number {
  return session.append('dsh-plugin/worker-requested', snapshotWorkerSpec(worker)).seq
}

/**
 * Append the validated handoff from a finished child session.
 * @param session - Parent session that owns the durable record.
 * @param childSessionId - Durable identifier of the finished child session.
 * @param handoff - Validated bounded child result.
 * @returns The appended event sequence number.
 */
export function appendWorkerFinished(session: Session, childSessionId: SessionId, handoff: HandoffV1): number {
  return session.append('dsh-plugin/worker-finished', {
    schemaVersion: 1,
    childSessionId,
    handoff: snapshotHandoff(handoff),
  }).seq
}

/**
 * Append one deterministic admission rejection.
 * @param session - Session that owns the durable record.
 * @param rejection - Stable rejection reason and counters.
 * @returns The appended event sequence number.
 */
export function appendBudgetRejected(session: Session, rejection: BudgetRejectedInput): number {
  return session.append('dsh-plugin/budget-rejected', {
    schemaVersion: 1,
    reason: rejection.reason,
    limit: rejection.limit,
    observed: rejection.observed,
  }).seq
}

/**
 * Append one targeted verification result.
 * @param session - Session that owns the durable record.
 * @param evidence - Bounded verification result.
 * @returns The appended event sequence number.
 */
export function appendVerificationFinished(session: Session, evidence: VerificationEvidenceV1): number {
  return session.append('dsh-plugin/verification-finished', snapshotVerification(evidence)).seq
}

/** Append a validated, detached scheduler selection provenance record. */
export function appendScheduleSelected(session: Session, selected: ScheduleSelectedV1): number {
  return session.append('dsh-plugin/schedule-selected', parseScheduleSelectedV1(selected)).seq
}
