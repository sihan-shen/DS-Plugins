import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codeIntelligenceReplayFixture, codeIntelligenceRuntimeReplayFixture } from './code-intelligence.fixture.ts'

const fixtures: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose()))
})

function execution() { return { signal: new AbortController().signal } }

describe('code intelligence keyless replay', () => {
  it('rejects invalid Code Intelligence configuration during Loader startup', async () => {
    await expect(codeIntelligenceRuntimeReplayFixture({ codeConfigOverrides: { maxFiles: 0 } }))
      .rejects.toThrow(/invalid config.*maxFiles|maxFiles.*between/is)
  })

  it('rejects Loader boot clearly when workspaceRegistry is unavailable', async () => {
    await expect(codeIntelligenceRuntimeReplayFixture({ disableWorkspaceRegistry: true }))
      .rejects.toThrow(/workspaceRegistry.*startup timeout/i)
  }, 7_000)

  it('runs the built bundle through pinned Loader, SessionStore, and ToolRuntime', async () => {
    const fixture = await codeIntelligenceRuntimeReplayFixture()
    fixtures.push(fixture)
    expect(fixture.context.get('tools')?.get('code_repo_map')).toBeDefined()
    const result = await fixture.tools.execute({
      callId: 'replay-real-code-map',
      name: 'code_repo_map',
      arguments: { limit: 10 },
      signal: new AbortController().signal,
      agent: { id: fixture.session.id, session: fixture.session },
    })
    if (result.isError) throw new Error(`real Loader replay result: ${JSON.stringify(result)}`)
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ path: 'src/main.ts' })]),
    })
    expect(result.value).not.toEqual({ limit: 10 })

    const legacyResult = await fixture.tools.execute({
      callId: 'replay-legacy-snapshot-id',
      name: 'code_repo_map',
      arguments: { snapshotId: 'legacy-public-snapshot-id', limit: 10 },
      signal: new AbortController().signal,
      agent: { id: fixture.session.id, session: fixture.session },
    })
    expect(legacyResult).toMatchObject({ isError: true })
    expect(legacyResult.error.message).toMatch(/unknown|snapshot/i)
  })

  it('isolates registered project snapshots for two live Sessions with different cwd values', async () => {
    const fixture = await codeIntelligenceRuntimeReplayFixture()
    fixtures.push(fixture)
    const firstRoot = join(fixture.root, 'workspaces', 'first')
    const secondRoot = join(fixture.root, 'workspaces', 'second')
    await mkdir(firstRoot, { recursive: true })
    await mkdir(secondRoot, { recursive: true })
    await writeFile(join(firstRoot, 'first.ts'), 'export const firstProject = true\n')
    await writeFile(join(secondRoot, 'second.ts'), 'export const secondProject = true\n')
    await fixture.workspaceRegistry.create(firstRoot, 'first')
    await fixture.workspaceRegistry.create(secondRoot, 'second')
    const first = fixture.createSession('code-intelligence-replay-first', firstRoot)
    const second = fixture.createSession('code-intelligence-replay-second', secondRoot)
    try {
      const firstResult = await fixture.tools.execute({
        callId: 'replay-first-code-map',
        name: 'code_repo_map',
        arguments: { limit: 10 },
        signal: new AbortController().signal,
        agent: { id: first.session.id, session: first.session },
      })
      const secondResult = await fixture.tools.execute({
        callId: 'replay-second-code-map',
        name: 'code_repo_map',
        arguments: { limit: 10 },
        signal: new AbortController().signal,
        agent: { id: second.session.id, session: second.session },
      })
      expect(firstResult).toMatchObject({
        isError: false,
        value: { items: expect.arrayContaining([expect.objectContaining({ path: 'first.ts' })]) },
      })
      expect(secondResult).toMatchObject({
        isError: false,
        value: { items: expect.arrayContaining([expect.objectContaining({ path: 'second.ts' })]) },
      })
      expect(firstResult.value.snapshotId).not.toBe(secondResult.value.snapshotId)
    } finally {
      first.dispose()
      second.dispose()
    }
  })

  it('rejects a live Session whose cwd is not registered', async () => {
    const fixture = await codeIntelligenceRuntimeReplayFixture()
    fixtures.push(fixture)
    const unregisteredRoot = join(fixture.root, 'workspaces', 'unregistered')
    await mkdir(unregisteredRoot, { recursive: true })
    await writeFile(join(unregisteredRoot, 'unregistered.ts'), 'export const unregistered = true\n')
    const unregistered = fixture.createSession(
      'code-intelligence-replay-unregistered',
      unregisteredRoot,
    )
    try {
      const result = await fixture.tools.execute({
        callId: 'replay-unregistered-code-map',
        name: 'code_repo_map',
        arguments: { limit: 10 },
        signal: new AbortController().signal,
        agent: { id: unregistered.session.id, session: unregistered.session },
      })
      expect(result).toMatchObject({ isError: true })
      expect(result.error.message).toMatch(/workspace.*not registered|unregistered.*workspace/i)
    } finally {
      unregistered.dispose()
    }
  })

  it('releases the Session compiler when SessionStore disposes its owner', async () => {
    const fixture = await codeIntelligenceRuntimeReplayFixture()
    fixtures.push(fixture)
    const result = await fixture.tools.execute({
      callId: 'replay-disposed-session-map',
      name: 'code_repo_map',
      arguments: { limit: 10 },
      signal: new AbortController().signal,
      agent: { id: fixture.session.id, session: fixture.session },
    })
    if (result.isError) throw new Error(`real Loader replay result: ${JSON.stringify(result)}`)
    const compilerService = fixture.context.get('contextCompiler') as {
      forSession(session: object): Promise<{
        repoMap(
          request: { snapshotId: string; limit: number },
          signal: AbortSignal,
        ): Promise<unknown>
      }>
    }
    const compiler = await compilerService.forSession(fixture.session)

    fixture.disposeSession()

    await expect(compiler.repoMap(
      { snapshotId: result.value.snapshotId, limit: 10 },
      new AbortController().signal,
    )).rejects.toThrow(/disposed/i)
  })

  it('removes Code Intelligence tools when the real Loader profile is disposed', async () => {
    const fixture = await codeIntelligenceRuntimeReplayFixture()
    fixtures.push(fixture)
    expect(fixture.context.get('tools')?.get('code_repo_map')).toBeDefined()

    await fixture.dispose()
    fixtures.splice(fixtures.indexOf(fixture), 1)

    expect(fixture.context.get('tools')?.get('code_repo_map')).toBeUndefined()
  })

  it('replays deterministic bounded fallback map and symbol query results', async () => {
    const fixture = await codeIntelligenceReplayFixture()
    fixtures.push(fixture)
    const firstMap = await fixture.repoMap.execute({ limit: 10 }, execution())
    const secondMap = await fixture.repoMap.execute({ limit: 10 }, execution())
    const query = await fixture.symbolQuery.execute({ query: 'replayTarget', limit: 10 }, execution())
    expect(JSON.stringify(firstMap)).toBe(JSON.stringify(secondMap))
    expect(JSON.stringify(query)).not.toContain('export function')
    expect(JSON.stringify(firstMap)).not.toContain(fixture.root)
  })

  it('rejects snapshot overrides and tampered cursors before model-visible output', async () => {
    const fixture = await codeIntelligenceReplayFixture()
    fixtures.push(fixture)
    const page = await fixture.repoMap.execute({ limit: 1 }, execution()) as { nextCursor?: string }
    expect(page.nextCursor).toBeDefined()
    await expect(fixture.repoMap.execute({ snapshotId: fixture.store.snapshot.snapshotId, limit: 1 }, execution())).rejects.toThrow(/snapshot|unknown/i)
    const cursor = page.nextCursor!
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`
    await expect(fixture.repoMap.execute({ limit: 1, cursor: tampered }, execution())).rejects.toThrow(/cursor|digest|invalid/i)
  })
})
