import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContextBlockV1, sha256Utf8 } from '@ds-plugins/dsh-context'
import { ContextCacheStore } from '../src/index.ts'
import type { CacheBoundaryV1, CacheLookupKeyV1 } from '../src/types.ts'

const sourceHashA = sha256Utf8('source-a')
const sourceHashB = sha256Utf8('source-b')

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-cache-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  await writeFile(join(root, 'src', 'b.ts'), 'export const b = 2\n', 'utf8')
  await writeFile(join(root, 'src', 'c.ts'), 'export const c = 3\n', 'utf8')
  roots.push(root)
  return root
}

async function removeRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
}

function boundary(overrides: Partial<CacheBoundaryV1> = {}): CacheBoundaryV1 {
  return {
    workspaceFingerprint: 'workspace-1',
    snapshotId: 'snapshot-1',
    adapterId: 'adapter-1',
    adapterVersion: '1.0.0',
    compilerPolicyVersion: 'policy-1',
    capabilityVersion: 'capability-1',
    ...overrides,
  }
}

function makeBlock(root: string, text: string, sources: readonly { path: string; contentHash: string }[] = [{ path: 'src/a.ts', contentHash: sourceHashA }], overrides: Partial<CacheBoundaryV1> = {}) {
  const currentBoundary = boundary(overrides)
  return {
    block: createContextBlockV1({
      schemaVersion: 1,
      workspaceRoot: root,
      kind: 'source-window',
      workspaceFingerprint: currentBoundary.workspaceFingerprint,
      snapshotId: currentBoundary.snapshotId,
      adapterId: currentBoundary.adapterId,
      adapterVersion: currentBoundary.adapterVersion,
      compilerPolicyVersion: currentBoundary.compilerPolicyVersion,
      sources,
      text,
      truncated: false,
    }),
    boundary: currentBoundary,
  }
}

function lookupKey(currentBoundary: CacheBoundaryV1, normalizedQuery: string, dependencyHashes: readonly string[]): CacheLookupKeyV1 {
  return { ...currentBoundary, normalizedQuery, dependencyHashes }
}

async function cacheFiles(root: string, directory: 'entries' | 'lookups' | 'quarantine'): Promise<string[]> {
  return readdir(join(root, '.dsh-context-cache', 'v1', directory))
}

afterEach(async () => {
  vi.restoreAllMocks()
  await removeRoots()
})

describe('ContextCacheStore layout and boundaries', () => {
  it('creates a canonical 0700 cache below the deployment root and round-trips exact boundaries', async () => {
    const canonicalRoot = await makeRoot()
    const linkedRoot = `${canonicalRoot}-link`
    await symlink(canonicalRoot, linkedRoot)
    roots.push(linkedRoot)

    const store = await ContextCacheStore.open({ deploymentRoot: linkedRoot })
    const cacheRoot = join(canonicalRoot, '.dsh-context-cache', 'v1')
    expect(await realpath(cacheRoot)).toBe(cacheRoot)
    if (process.platform !== 'win32') expect((await stat(cacheRoot)).mode & 0o777).toBe(0o700)

    const { block, boundary: currentBoundary } = makeBlock(canonicalRoot, 'cached')
    await store.putBlock(block, currentBoundary)
    expect(await store.getBlock(block.blockId, currentBoundary)).toEqual(block)
    await store.close()
  })

  it.each([
    ['workspace', { workspaceFingerprint: 'workspace-2' }],
    ['snapshot', { snapshotId: 'snapshot-2' }],
    ['adapter', { adapterId: 'adapter-2' }],
    ['adapter version', { adapterVersion: '2.0.0' }],
    ['policy', { compilerPolicyVersion: 'policy-2' }],
    ['capability', { capabilityVersion: 'capability-2' }],
  ])('misses on an exact boundary %s mismatch', async (_name, mismatch) => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root })
    const { block, boundary: currentBoundary } = makeBlock(root, 'cached')
    await store.putBlock(block, currentBoundary)
    expect(await store.getBlock(block.blockId, { ...currentBoundary, ...mismatch })).toBeUndefined()
    await store.close()
  })

  it('rejects block boundaries that contradict immutable block provenance', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root })
    const { block, boundary: currentBoundary } = makeBlock(root, 'cached')
    for (const mismatch of [
      { workspaceFingerprint: 'workspace-2' },
      { snapshotId: 'snapshot-2' },
      { adapterId: 'adapter-2' },
      { adapterVersion: '2.0.0' },
      { compilerPolicyVersion: 'policy-2' },
    ]) await expect(store.putBlock(block, { ...currentBoundary, ...mismatch })).rejects.toThrow(TypeError)
    await store.close()
  })

  it('round-trips bounded JSON tool results only under the exact boundary', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root })
    const currentBoundary = boundary()
    const result = { matches: ['alpha', { score: 1 }], nextCursor: null }

    await store.putToolResult('symbol-query', currentBoundary, result, 1_024)

    expect(await store.getToolResult('symbol-query', currentBoundary)).toEqual(result)
    for (const mismatch of [
      { workspaceFingerprint: 'workspace-2' },
      { snapshotId: 'snapshot-2' },
      { adapterId: 'adapter-2' },
      { adapterVersion: '2.0.0' },
      { compilerPolicyVersion: 'policy-2' },
      { capabilityVersion: 'capability-2' },
    ]) expect(await store.getToolResult('symbol-query', { ...currentBoundary, ...mismatch })).toBeUndefined()
    expect(await store.getToolResult('other-query', currentBoundary)).toBeUndefined()
    await store.close()
  })

  it('accepts bounded cache caps and rejects invalid or production-exceeding caps', async () => {
    const root = await makeRoot()
    for (const config of [
      { maxEntries: 1, maxBytes: 1 },
      { maxEntries: 10_000, maxBytes: 268_435_456 },
      {},
    ]) await (await ContextCacheStore.open({ deploymentRoot: root, ...config })).close()

    for (const config of [
      { maxEntries: 0 },
      { maxEntries: 10_001 },
      { maxEntries: 1.5 },
      { maxBytes: 0 },
      { maxBytes: 268_435_457 },
      { maxBytes: 1.5 },
    ]) await expect(ContextCacheStore.open({ deploymentRoot: root, ...config })).rejects.toThrow(TypeError)
  })

  it('rejects oversized, non-JSON, and invalidly bounded tool results', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root })
    const currentBoundary = boundary()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    await expect(store.putToolResult('tool', currentBoundary, '🙂', 5)).rejects.toThrow(TypeError)
    await expect(store.putToolResult('tool', currentBoundary, { ok: true }, 0)).rejects.toThrow(TypeError)
    await expect(store.putToolResult('tool', currentBoundary, { ok: true }, 268_435_457)).rejects.toThrow(TypeError)
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, new Date(), cyclic]) {
      await expect(store.putToolResult('tool', currentBoundary, value, 1_024)).rejects.toThrow(TypeError)
    }
    expect(await store.getToolResult('tool', currentBoundary)).toBeUndefined()
    await store.close()
  })

  it('uses canonical lookup keys and returns only exact dependency sets', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root })
    const { block, boundary: currentBoundary } = makeBlock(root, 'cached', [
      { path: 'src/a.ts', contentHash: sourceHashA },
      { path: 'src/b.ts', contentHash: sourceHashB },
    ])
    await store.putBlock(block, currentBoundary)
    const key = lookupKey(currentBoundary, 'find symbols', [sourceHashB, sourceHashA])
    await store.putLookup(key, [block.blockId])
    expect(await store.getLookup(lookupKey(currentBoundary, 'find symbols', [sourceHashA, sourceHashB]))).toEqual([block.blockId])
    expect(await store.getLookup(lookupKey(currentBoundary, 'find symbols', [sourceHashA]))).toBeUndefined()
    await store.close()
  })

  it('does not expose a final entry when only a partial temporary write exists', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root })
    const { block, boundary: currentBoundary } = makeBlock(root, 'cached')
    const entries = join(root, '.dsh-context-cache', 'v1', 'entries')
    await writeFile(join(entries, 'partial-entry.tmp'), '{"block":', 'utf8')
    expect(await store.getBlock(block.blockId, currentBoundary)).toBeUndefined()
    expect((await cacheFiles(root, 'entries')).some(file => file.endsWith('.json'))).toBe(false)
    await store.close()
  })

  it('uses portable content-addressed JSON filenames', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root })
    const { block, boundary: currentBoundary } = makeBlock(root, 'cached')
    const key = lookupKey(currentBoundary, 'find symbols', [sourceHashA])
    await store.putBlock(block, currentBoundary)
    await store.putToolResult('tool', currentBoundary, { ok: true }, 1_024)
    await store.putLookup(key, [block.blockId])

    const names = [...await cacheFiles(root, 'entries'), ...await cacheFiles(root, 'lookups')]
    expect(names).not.toHaveLength(0)
    for (const name of names) expect(name).toMatch(/^[a-z0-9.-]+\.json$/)
    await store.close()
  })
})

describe('ContextCacheStore maintenance', () => {
  it('invalidates only entries that declare an affected source hash', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root })
    const first = makeBlock(root, 'first', [{ path: 'src/a.ts', contentHash: sourceHashA }])
    const second = makeBlock(root, 'second', [{ path: 'src/b.ts', contentHash: sourceHashB }], { snapshotId: 'snapshot-2' })
    await store.putBlock(first.block, first.boundary)
    await store.putBlock(second.block, second.boundary)
    await store.putLookup(lookupKey(first.boundary, 'first', [sourceHashA]), [first.block.blockId])
    await store.putLookup(lookupKey(second.boundary, 'second', [sourceHashB]), [second.block.blockId])

    await store.invalidateBySourceHashes([sourceHashA])
    expect(await store.getBlock(first.block.blockId, first.boundary)).toBeUndefined()
    expect(await store.getBlock(second.block.blockId, second.boundary)).toEqual(second.block)
    expect(await store.getLookup(lookupKey(first.boundary, 'first', [sourceHashA]))).toBeUndefined()
    expect(await store.getLookup(lookupKey(second.boundary, 'second', [sourceHashB]))).toEqual([second.block.blockId])
    await store.close()
  })

  it('does not globally flush unrelated entries for a revision-only change', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root })
    const oldSnapshot = makeBlock(root, 'old', [{ path: 'src/a.ts', contentHash: sourceHashA }], { snapshotId: 'snapshot-old' })
    const unrelated = makeBlock(root, 'unrelated', [{ path: 'src/b.ts', contentHash: sourceHashB }], { snapshotId: 'snapshot-new' })
    await store.putBlock(oldSnapshot.block, oldSnapshot.boundary)
    await store.putBlock(unrelated.block, unrelated.boundary)
    await store.invalidateBySourceHashes([])
    expect(await store.getBlock(unrelated.block.blockId, unrelated.boundary)).toEqual(unrelated.block)
    await store.close()
  })

  it('misses and quarantines an entry with incomplete dependency metadata', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root })
    const { block, boundary: currentBoundary } = makeBlock(root, 'cached', [
      { path: 'src/a.ts', contentHash: sourceHashA },
      { path: 'src/b.ts', contentHash: sourceHashB },
    ])
    await store.putBlock(block, currentBoundary)
    const entries = join(root, '.dsh-context-cache', 'v1', 'entries')
    const entryName = (await readdir(entries)).find(name => name.endsWith('.json')) as string
    const entry = JSON.parse(await readFile(join(entries, entryName), 'utf8')) as { dependencyHashes: string[] }
    entry.dependencyHashes = [sourceHashA]
    await writeFile(join(entries, entryName), JSON.stringify(entry), 'utf8')

    expect(await store.getBlock(block.blockId, currentBoundary)).toBeUndefined()
    expect((await cacheFiles(root, 'quarantine')).length).toBe(1)
    await store.close()
  })

  it('misses and quarantines an entry whose boundary contradicts its block', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root })
    const { block, boundary: currentBoundary } = makeBlock(root, 'cached')
    await store.putBlock(block, currentBoundary)
    const entries = join(root, '.dsh-context-cache', 'v1', 'entries')
    const entryName = (await readdir(entries)).find(name => name.endsWith('.json')) as string
    const entry = JSON.parse(await readFile(join(entries, entryName), 'utf8')) as { boundary: CacheBoundaryV1 }
    entry.boundary.snapshotId = 'snapshot-forged'
    await writeFile(join(entries, entryName), JSON.stringify(entry), 'utf8')

    expect(await store.getBlock(block.blockId, { ...currentBoundary, snapshotId: 'snapshot-forged' })).toBeUndefined()
    expect((await cacheFiles(root, 'quarantine')).length).toBe(1)
    await store.close()
  })

  it('evicts oldest entries at a configured entry cap', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root, maxEntries: 2, maxBytes: 1_000_000 })
    const first = makeBlock(root, 'first', [{ path: 'src/a.ts', contentHash: sourceHashA }], { snapshotId: 'snapshot-1' })
    const second = makeBlock(root, 'second', [{ path: 'src/b.ts', contentHash: sourceHashB }], { snapshotId: 'snapshot-2' })
    const third = makeBlock(root, 'third', [{ path: 'src/c.ts', contentHash: sha256Utf8('source-c') }], { snapshotId: 'snapshot-3' })
    await store.putBlock(first.block, first.boundary)
    await store.putBlock(second.block, second.boundary)
    await store.putBlock(third.block, third.boundary)
    expect(await store.getBlock(first.block.blockId, first.boundary)).toBeUndefined()
    expect(await store.getBlock(second.block.blockId, second.boundary)).toEqual(second.block)
    expect(await store.getBlock(third.block.blockId, third.boundary)).toEqual(third.block)
    await store.close()
  })

  it('evicts entries that exceed a configured byte cap', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root, maxEntries: 10, maxBytes: 1 })
    const { block, boundary: currentBoundary } = makeBlock(root, 'larger than one byte')
    await store.putBlock(block, currentBoundary)
    expect(await store.getBlock(block.blockId, currentBoundary)).toBeUndefined()
    await store.close()
  })

  it('returns a miss on lock timeout without changing a valid entry', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root, lockTimeoutMs: 0 })
    const { block, boundary: currentBoundary } = makeBlock(root, 'cached')
    await store.putBlock(block, currentBoundary)
    const lock = join(root, '.dsh-context-cache', 'v1', '.lock')
    await writeFile(lock, 'held', { flag: 'wx' })
    expect(await store.getBlock(block.blockId, currentBoundary)).toBeUndefined()
    await unlink(lock)
    expect(await store.getBlock(block.blockId, currentBoundary)).toEqual(block)
    await store.close()
  })

  it('quarantines a malformed lookup and returns a miss', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root })
    const { block, boundary: currentBoundary } = makeBlock(root, 'cached')
    const key = lookupKey(currentBoundary, 'find symbols', [sourceHashA])
    await store.putBlock(block, currentBoundary)
    await store.putLookup(key, [block.blockId])
    const lookups = join(root, '.dsh-context-cache', 'v1', 'lookups')
    const lookupName = (await readdir(lookups)).find(name => name.endsWith('.json')) as string
    await writeFile(join(lookups, lookupName), '{not-json', 'utf8')
    expect(await store.getLookup(key)).toBeUndefined()
    expect((await cacheFiles(root, 'quarantine')).length).toBe(1)
    await store.close()
  })

  it('quarantines malformed lookup records during open maintenance', async () => {
    const root = await makeRoot()
    await (await ContextCacheStore.open({ deploymentRoot: root })).close()
    const lookups = join(root, '.dsh-context-cache', 'v1', 'lookups')
    await writeFile(join(lookups, 'malformed-lookup.json'), '{not-json', 'utf8')

    const reopened = await ContextCacheStore.open({ deploymentRoot: root })
    expect(await cacheFiles(root, 'lookups')).toEqual([])
    expect((await cacheFiles(root, 'quarantine')).length).toBe(1)
    await reopened.close()
  })

  it('quarantines malformed records and bounds quarantine by file count and bytes', async () => {
    const root = await makeRoot()
    const store = await ContextCacheStore.open({ deploymentRoot: root })
    const quarantine = join(root, '.dsh-context-cache', 'v1', 'quarantine')
    for (let index = 0; index < 40; index += 1) await writeFile(join(quarantine, `old-${index}.json`), 'x'.repeat(400_000), 'utf8')
    const entries = join(root, '.dsh-context-cache', 'v1', 'entries')
    const { block, boundary: currentBoundary } = makeBlock(root, 'malformed')
    await store.putBlock(block, currentBoundary)
    const entryName = (await readdir(entries)).find(name => name.endsWith('.json')) as string
    await writeFile(join(entries, entryName), '{not-json', 'utf8')
    expect(await store.getBlock(block.blockId, currentBoundary)).toBeUndefined()
    expect((await cacheFiles(root, 'quarantine')).length).toBeLessThanOrEqual(32)
    let bytes = 0
    for (const file of await cacheFiles(root, 'quarantine')) bytes += (await stat(join(quarantine, file))).size
    expect(bytes).toBeLessThanOrEqual(10 * 1024 * 1024)
    await store.close()
  })

  it('leaves one valid immutable entry after simultaneous writers', async () => {
    const root = await makeRoot()
    const firstStore = await ContextCacheStore.open({ deploymentRoot: root })
    const secondStore = await ContextCacheStore.open({ deploymentRoot: root })
    const { block, boundary: currentBoundary } = makeBlock(root, 'concurrent')
    await Promise.all([
      ...Array.from({ length: 4 }, () => firstStore.putBlock(block, currentBoundary)),
      ...Array.from({ length: 4 }, () => secondStore.putBlock(block, currentBoundary)),
    ])
    expect(await firstStore.getBlock(block.blockId, currentBoundary)).toEqual(block)
    const entries = await cacheFiles(root, 'entries')
    expect(entries.filter(file => file.endsWith('.json'))).toHaveLength(1)
    await firstStore.close()
    await secondStore.close()
  })

  it('updates deterministic LRU order after a successful cross-store read', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const root = await makeRoot()
    const writer = await ContextCacheStore.open({ deploymentRoot: root, maxEntries: 2 })
    const reader = await ContextCacheStore.open({ deploymentRoot: root, maxEntries: 2 })
    const first = makeBlock(root, 'first', [{ path: 'src/a.ts', contentHash: sourceHashA }], { snapshotId: 'snapshot-1' })
    const second = makeBlock(root, 'second', [{ path: 'src/b.ts', contentHash: sourceHashB }], { snapshotId: 'snapshot-2' })
    const third = makeBlock(root, 'third', [{ path: 'src/c.ts', contentHash: sha256Utf8('source-c') }], { snapshotId: 'snapshot-3' })
    await writer.putBlock(first.block, first.boundary)
    await writer.putBlock(second.block, second.boundary)
    expect(await reader.getBlock(first.block.blockId, first.boundary)).toEqual(first.block)
    await writer.putBlock(third.block, third.boundary)

    expect(await writer.getBlock(first.block.blockId, first.boundary)).toEqual(first.block)
    expect(await writer.getBlock(second.block.blockId, second.boundary)).toBeUndefined()
    expect(await writer.getBlock(third.block.blockId, third.boundary)).toEqual(third.block)
    await writer.close()
    await reader.close()
  })
})
