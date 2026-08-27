import { describe, expect, it } from 'vitest'
import { replayDirectFixture, replayVerificationVariants } from './direct.fixture.ts'
import { replaySingleWorkerFixture } from './single-worker.fixture.ts'

describe('DSH v0.1 keyless replay fixtures', () => {
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
    await expect(replayVerificationVariants()).resolves.toEqual({
      failed: { commandName: 'typecheck', args: [], exitCode: 1, status: 'failed', stdout: '', stderr: 'k failed', truncated: true },
      'timed-out': { commandName: 'typecheck', args: [], exitCode: null, status: 'timed-out', stdout: '', stderr: '', truncated: false },
      'spawn-error': { commandName: 'typecheck', args: [], exitCode: null, status: 'spawn-error', stdout: '', stderr: '', truncated: false },
      truncated: { commandName: 'typecheck', args: [], exitCode: 0, status: 'passed', stdout: '23456789', stderr: '', truncated: true },
    })
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
      'dsh-plugin/worker-requested',
      'dsh-plugin/worker-finished',
      'dsh-plugin/budget-rejected',
    ])
    expect(replay.events[2]).toMatchObject({ data: { reason: 'WORKER_LIMIT', limit: 1, observed: 2 } })
    expect(replay.invalid).toMatchObject({ status: 'failed', changedFiles: [], verification: [] })
    expect(JSON.stringify(replay)).not.toContain('SECRET_CHILD_OUTPUT')
    expect(replay.invalidEvents.map(event => event.type)).toEqual([
      'dsh-plugin/worker-requested',
      'dsh-plugin/worker-finished',
    ])
  })
})
