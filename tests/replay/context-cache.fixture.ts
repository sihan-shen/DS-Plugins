import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createContextBlockV1,
  MAX_CONTEXT_SESSION_BYTES,
  type ContextBlockV1,
} from '../../packages/dsh-context/src/index.ts'
import {
  ContextCacheStore,
  type CacheBoundaryV1,
  type CacheLookupKeyV1,
  type ContextCacheConfigV1,
} from '../../packages/dsh-context-cache/src/index.ts'
import {
  buildSymbolIndex,
  createContextCompiler,
  extractFallbackSymbols,
  RepositorySnapshotStore,
  type ContextCompilerHandle,
} from '../../packages/dsh-code-intelligence/src/index.ts'

const RAW_SOURCE_MARKER = 'export const replayRawSourceMarker = true\n'

export type ReplayCacheRecord = {
  readonly block: ContextBlockV1
  readonly boundary: CacheBoundaryV1
  readonly lookup: CacheLookupKeyV1
}

export type ContextCacheReplayFixture = {
  readonly root: string
  readonly sourcePath: string
  readonly sourceHash: string
  readonly rawSourceMarker: string
  readonly repoMapRequest: { readonly snapshotId: string; readonly limit: number }
  readonly entriesPath: string
  readonly quarantinePath: string
  readonly lockPath: string
  signal(): AbortSignal
  openCache(overrides?: Omit<ContextCacheConfigV1, 'deploymentRoot'>): Promise<ContextCacheStore>
  mountCompiler(overrides?: {
    readonly compilerPolicyVersion?: string
    readonly capabilityVersion?: string
  }): Promise<ContextCompilerHandle>
  cacheRecord(text: string): ReplayCacheRecord
  dispose(): Promise<void>
}

export async function createContextCacheReplayFixture(): Promise<ContextCacheReplayFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-cache-replay-'))
  const sourcePath = 'src/main.ts'
  await mkdir(join(root, 'src'), { recursive: true })
  const trailerBytes = MAX_CONTEXT_SESSION_BYTES + 1 - RAW_SOURCE_MARKER.length - 4
  const sourceText = `${RAW_SOURCE_MARKER}/*${'x'.repeat(trailerBytes)}*/`
  await writeFile(join(root, sourcePath), sourceText, 'utf8')

  const store = await RepositorySnapshotStore.create({
    deploymentRoot: root,
    revision: 'context-cache-replay-v1',
    maxFileBytes: 1_048_576,
    maxFiles: 10_000,
    maxTotalBytes: 67_108_864,
    maxDirectories: 20_000,
    maxIgnoreBytes: 262_144,
    nestedCheckoutRoots: [],
  })
  const adapter = await extractFallbackSymbols(store)
  const index = buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries)
  const source = store.snapshot.files.find(file => file.path === sourcePath)
  if (source === undefined) throw new Error('replay source was not indexed')

  const cacheRoot = join(root, '.dsh-context-cache', 'v1')
  const boundary: CacheBoundaryV1 = {
    workspaceFingerprint: store.snapshot.workspaceFingerprint,
    snapshotId: store.snapshot.snapshotId,
    adapterId: index.adapterId,
    adapterVersion: index.adapterVersion,
    compilerPolicyVersion: 'replay-cache-policy-v1',
    capabilityVersion: 'replay-cache-capability-v1',
  }

  async function openCache(overrides: Omit<ContextCacheConfigV1, 'deploymentRoot'> = {}): Promise<ContextCacheStore> {
    return ContextCacheStore.open({ deploymentRoot: root, ...overrides })
  }

  async function mountCompiler(overrides: {
    readonly compilerPolicyVersion?: string
    readonly capabilityVersion?: string
  } = {}): Promise<ContextCompilerHandle> {
    const cache = await openCache()
    return createContextCompiler({
      workspaceRoot: root,
      store,
      index,
      cache,
      ...(overrides.compilerPolicyVersion === undefined ? {} : { compilerPolicyVersion: overrides.compilerPolicyVersion }),
      ...(overrides.capabilityVersion === undefined ? {} : { capabilityVersion: overrides.capabilityVersion }),
    })
  }

  function cacheRecord(text: string): ReplayCacheRecord {
    const block = createContextBlockV1({
      schemaVersion: 1,
      workspaceRoot: root,
      kind: 'source-window',
      workspaceFingerprint: boundary.workspaceFingerprint,
      snapshotId: boundary.snapshotId,
      adapterId: boundary.adapterId,
      adapterVersion: boundary.adapterVersion,
      compilerPolicyVersion: boundary.compilerPolicyVersion,
      sources: [{ path: sourcePath, contentHash: source.contentHash }],
      text,
      truncated: false,
    })
    return {
      block,
      boundary,
      lookup: {
        ...boundary,
        normalizedQuery: text,
        dependencyHashes: [source.contentHash],
      },
    }
  }

  return {
    root,
    sourcePath,
    sourceHash: source.contentHash,
    rawSourceMarker: RAW_SOURCE_MARKER.trim(),
    repoMapRequest: { snapshotId: store.snapshot.snapshotId, limit: 50 },
    entriesPath: join(cacheRoot, 'entries'),
    quarantinePath: join(cacheRoot, 'quarantine'),
    lockPath: join(cacheRoot, '.lock'),
    signal: () => new AbortController().signal,
    openCache,
    mountCompiler,
    cacheRecord,
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}
