import { describe, expect, it } from 'vitest'

describe('published orchestrator package entry', () => {
  it('exports every durable event append helper through the package name', async () => {
    const entry = await import('@ds-plugins/dsh-orchestrator')

    expect(entry.appendRunStarted).toEqual(expect.any(Function))
    expect(entry.appendWorkerRequested).toEqual(expect.any(Function))
    expect(entry.appendWorkerFinished).toEqual(expect.any(Function))
    expect(entry.appendBudgetRejected).toEqual(expect.any(Function))
    expect(entry.appendVerificationFinished).toEqual(expect.any(Function))
    expect(entry.appendScheduleSelected).toEqual(expect.any(Function))
    expect(entry.resolveSchedule).toEqual(expect.any(Function))
    expect(entry.validateTaskDagV1).toEqual(expect.any(Function))
    expect(entry.compareDagValidationIssues).toEqual(expect.any(Function))
  })
})
