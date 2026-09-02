import { describe, expect, it } from 'vitest'
import { replayDirectFixture, replayScheduledDirectFixture, replayVerificationVariants } from './direct.fixture.ts'
import { replaySingleWorkerFixture } from './single-worker.fixture.ts'

describe('DSH v0.1 keyless replay fixtures', () => {
  it('records the scheduled Direct selection before the actual request header and route', async () => {
    const replay = await replayScheduledDirectFixture()

    expect(replay.events.map(event => event.type)).toEqual([
      'dsh-plugin/schedule-selected',
      'request/header',
      'dsh-plugin/run-started',
    ])
    expect(replay.actualRoute).toEqual({ provider: 'actual-disabled', model: 'actual-model-disabled' })
    expect(replay.events[2]).toMatchObject({
      data: { mode: 'direct', provider: 'actual-disabled', model: 'actual-model-disabled' },
    })
  })

  it('records the Direct passing verification outcome as canonical event evidence', async () => {
    const replay = await replayDirectFixture()

    expect(replay).toEqual({
      evidence: {
        commandName: 'typecheck',
        args: [],
        exitCode: 0,
        status: 'passed',
        stdout: 'k passed',
        stderr: '',
        truncated: true,
      },
      events: [{
        type: 'dsh-plugin/verification-finished',
        data: expect.objectContaining({ commandName: 'typecheck', exitCode: 0, status: 'passed' }),
      }],
    })
  })

  it('normalizes non-passing verification variants without a provider or platform-specific path', async () => {
    const replay = await replayVerificationVariants()
    const expected = {
      failed: { exitCode: 1, status: 'failed', stdout: '', stderr: 'k failed', truncated: true },
      'timed-out': { exitCode: null, status: 'timed-out', stdout: '', stderr: '', truncated: false },
      'spawn-error': { exitCode: null, status: 'spawn-error', stdout: '', stderr: '', truncated: false },
      truncated: { exitCode: 0, status: 'passed', stdout: '23456789', stderr: '', truncated: true },
    }

    for (const [name, outcome] of Object.entries(replay)) {
      expect(outcome.evidence).toMatchObject({ commandName: 'typecheck', args: [], ...expected[name as keyof typeof expected] })
      expect(outcome.events).toEqual([{
        type: 'dsh-plugin/verification-finished',
        data: expect.objectContaining({ commandName: 'typecheck', ...expected[name as keyof typeof expected] }),
      }])
    }
  })

  it('continues from a bounded Handoff, rejects a second child, and never leaks malformed raw output', async () => {
    const replay = await replaySingleWorkerFixture()

    expect(replay.first).toEqual({
      schemaVersion: 1,
      status: 'completed',
      summary: 'Applied the focused change.',
      changedFiles: ['packages/dsh-orchestrator/src/worker.ts'],
      decisions: ['Returned only HandoffV1.'],
      verification: [],
      blockers: [],
    })
    expect(replay.deferred).toEqual([{
      status: 'completed',
      summary: 'Applied the focused change.',
      changedFiles: ['packages/dsh-orchestrator/src/worker.ts'],
      decisions: ['Returned only HandoffV1.'],
      verification: [],
      blockers: [],
    }])
    expect(replay.startsBeforeInvalidOutput).toBe(1)
    expect(replay.secondError).toContain('WORKER_LIMIT')
    expect(replay.events.map(event => event.type)).toEqual([
      'dsh-plugin/schedule-selected',
      'dsh-plugin/worker-requested',
      'dsh-plugin/worker-finished',
      'dsh-plugin/budget-rejected',
    ])
    expect(replay.events[3]).toMatchObject({ data: { reason: 'WORKER_LIMIT', limit: 1, observed: 2 } })
    expect(replay.invalid).toMatchObject({ status: 'failed', changedFiles: [], verification: [] })
    expect(JSON.stringify(replay)).not.toContain('SECRET_CHILD_OUTPUT')
    expect(replay.invalidEvents.map(event => event.type)).toEqual([
      'dsh-plugin/worker-requested',
      'dsh-plugin/worker-finished',
    ])
  })
})
