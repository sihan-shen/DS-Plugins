import { afterEach, describe, expect, it } from 'vitest'
import { codeIntelligenceReplayFixture } from './code-intelligence.fixture.ts'

const fixtures: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose()))
})

function execution() { return { signal: new AbortController().signal } }

describe('code intelligence keyless replay', () => {
  it('replays deterministic bounded fallback map and symbol query results', async () => {
    const fixture = await codeIntelligenceReplayFixture()
    fixtures.push(fixture)
    const firstMap = await fixture.repoMap.execute({ snapshotId: fixture.store.snapshot.snapshotId, limit: 10 }, execution())
    const secondMap = await fixture.repoMap.execute({ snapshotId: fixture.store.snapshot.snapshotId, limit: 10 }, execution())
    const query = await fixture.symbolQuery.execute({ snapshotId: fixture.store.snapshot.snapshotId, query: 'replayTarget', limit: 10 }, execution())
    expect(JSON.stringify(firstMap)).toBe(JSON.stringify(secondMap))
    expect(JSON.stringify(query)).not.toContain('export function')
    expect(JSON.stringify(firstMap)).not.toContain(fixture.root)
  })

  it('rejects stale snapshots and tampered cursors before model-visible output', async () => {
    const fixture = await codeIntelligenceReplayFixture()
    fixtures.push(fixture)
    const page = await fixture.repoMap.execute({ snapshotId: fixture.store.snapshot.snapshotId, limit: 1 }, execution()) as { nextCursor?: string }
    expect(page.nextCursor).toBeDefined()
    await expect(fixture.repoMap.execute({ snapshotId: 'sha256:' + '0'.repeat(64), limit: 1 }, execution())).rejects.toThrow(/snapshot/i)
    const cursor = page.nextCursor!
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`
    await expect(fixture.repoMap.execute({ snapshotId: fixture.store.snapshot.snapshotId, limit: 1, cursor: tampered }, execution())).rejects.toThrow(/cursor|digest|invalid/i)
  })
})
