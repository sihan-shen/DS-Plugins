import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_CONTEXT_BLOCK_BYTES,
  MAX_CONTEXT_SESSION_BYTES,
  parseContextBlockV1,
  parseRepoMapPageV1,
  parseSymbolQueryResultV1,
  sha256Utf8,
} from '@ds-plugins/dsh-context'
import { ContextCacheStore } from '../../dsh-context-cache/src/index.ts'
import type { CacheBoundaryV1 } from '../../dsh-context-cache/src/types.ts'
import { createContextCompiler } from '../src/context-compiler.ts'
import { parseSnapshotConfig } from '../src/config.ts'
import { extractFallbackSymbols } from '../src/fallback.ts'
import { buildSymbolIndex } from '../src/symbol-index.ts'
import { RepositorySnapshotStore } from '../src/snapshot.ts'
import { mountCodeIntelligence } from '../src/plugin.ts'
import { createContextTools } from '../src/tools.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function config(deploymentRoot: string) {
  return parseSnapshotConfig({
    deploymentRoot,
    revision: 'context-compiler-fixture-1',
    maxFileBytes: 1_048_576,
    maxFiles: 10_000,
    maxTotalBytes: 67_108_864,
    maxDirectories: 20_000,
    maxIgnoreBytes: 262_144,
    nestedCheckoutRoots: [],
  })
}

async function fixture(source = 'export function authenticate(token: string) { return token.length > 0 }\n') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-compiler-'))
  roots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'auth.ts'), source, 'utf8')
  await writeFile(join(root, 'src', 'billing.ts'), 'export class BillingService { charge() {} }\n', 'utf8')
  const store = await RepositorySnapshotStore.create(config(root))
  const adapter = await extractFallbackSymbols(store)
  const index = buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries)
  const cache = await ContextCacheStore.open({ deploymentRoot: root })
  const compiler = createContextCompiler({ workspaceRoot: root, store, index, cache })
  return { root, store, index, cache, compiler }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function fileHash(store: RepositorySnapshotStore, path: string): string {
  return store.snapshot.files.find(file => file.path === path)!.contentHash
}

function boundary(store: RepositorySnapshotStore, index: ReturnType<typeof buildSymbolIndex>, overrides: Partial<CacheBoundaryV1> = {}): CacheBoundaryV1 {
  return {
    workspaceFingerprint: store.snapshot.workspaceFingerprint,
    snapshotId: store.snapshot.snapshotId,
    adapterId: index.adapterId,
    adapterVersion: index.adapterVersion,
    compilerPolicyVersion: 'dsh-context-compiler-v1',
    capabilityVersion: 'dsh-context-capability-v1',
    ...overrides,
  }
}

describe('ContextCompiler projection blocks', () => {
  it('compiles parsed bounded Repo Map and Symbol Query blocks with exact source provenance', async () => {
    const { store, cache, compiler } = await fixture()
    const repoMap = parseContextBlockV1(await compiler.repoMap({ snapshotId: store.snapshot.snapshotId, limit: 10 }, signal()))
    const symbol = parseContextBlockV1(await compiler.symbolQuery({ snapshotId: store.snapshot.snapshotId, query: 'authenticate', limit: 10 }, signal()))

    expect(repoMap.kind).toBe('repo-map')
    expect(symbol.kind).toBe('symbol')
    expect(repoMap.snapshotId).toBe(store.snapshot.snapshotId)
    expect(symbol.snapshotId).toBe(store.snapshot.snapshotId)
    expect(repoMap.sources).toEqual([
      { path: 'src/auth.ts', contentHash: fileHash(store, 'src/auth.ts') },
      { path: 'src/billing.ts', contentHash: fileHash(store, 'src/billing.ts') },
    ])
    expect(symbol.sources).toEqual([
      { path: 'src/auth.ts', contentHash: fileHash(store, 'src/auth.ts') },
      { path: 'src/billing.ts', contentHash: fileHash(store, 'src/billing.ts') },
    ])
    expect(parseRepoMapPageV1(JSON.parse(repoMap.text))).toMatchObject({ snapshotId: store.snapshot.snapshotId })
    expect(parseSymbolQueryResultV1(JSON.parse(symbol.text))).toMatchObject({ snapshotId: store.snapshot.snapshotId })
    expect(repoMap.text).not.toContain('export function')
    expect(symbol.text).not.toContain('export function')
    expect(repoMap.byteLength).toBeLessThanOrEqual(MAX_CONTEXT_BLOCK_BYTES)
    expect(symbol.byteLength).toBeLessThanOrEqual(MAX_CONTEXT_BLOCK_BYTES)
    await cache.close()
  })

  it('records one projection miss, then a hit, and does not reuse a stale boundary', async () => {
    const { root, store, index, cache, compiler } = await fixture()
    const request = { snapshotId: store.snapshot.snapshotId, limit: 1 }
    const first = await compiler.repoMap(request, signal())
    const second = await compiler.repoMap(request, signal())
    expect(second).toEqual(first)
    expect(compiler.cacheStats).toEqual({ hits: 1, misses: 1 })

    const staleCompiler = createContextCompiler({
      workspaceRoot: root,
      store,
      index,
      cache,
      capabilityVersion: 'dsh-context-capability-stale',
    })
    await expect(staleCompiler.repoMap(request, signal())).resolves.toEqual(first)
    expect(staleCompiler.cacheStats).toEqual({ hits: 0, misses: 1 })
    await cache.close()
  })
})

describe('ContextCompiler progressive source disclosure', () => {
  it('requires a cached projection block and matching path/hash, then returns bounded provenance', async () => {
    const { store, cache, compiler } = await fixture('const π = "🙂 source"\nexport function authenticate() { return true }\n')
    const base = await compiler.repoMap({ snapshotId: store.snapshot.snapshotId, limit: 10 }, signal())
    const sourceHash = fileHash(store, 'src/auth.ts')
    const startOffset = 0
    const endOffset = 'const π = "🙂 source"\n'.length
    const expanded = parseContextBlockV1(await compiler.expandSource({
      blockId: base.blockId,
      path: 'src/auth.ts',
      sourceHash,
      startOffset,
      endOffset,
    }, signal()))

    expect(expanded.kind).toBe('source-window')
    expect(expanded.sources).toEqual([{ path: 'src/auth.ts', contentHash: sourceHash }])
    expect(expanded.text).toBe('const π = "🙂 source"\n')
    expect(expanded.byteLength).toBe(new TextEncoder().encode(expanded.text).byteLength)
    expect(new TextEncoder().encode(expanded.text).byteLength).toBeLessThanOrEqual(MAX_CONTEXT_BLOCK_BYTES)
    await expect(compiler.expandSource({
      blockId: 'sha256:' + '0'.repeat(64),
      path: 'src/auth.ts',
      sourceHash,
      startOffset,
      endOffset,
    }, signal())).rejects.toThrow(/cached|block|unknown/i)
    await expect(compiler.expandSource({
      blockId: base.blockId,
      path: 'src/auth.ts',
      sourceHash: sha256Utf8('wrong'),
      startOffset,
      endOffset,
    }, signal())).rejects.toThrow(/source|hash|provenance/i)
    await expect(compiler.expandSource({
      blockId: base.blockId,
      path: '../secret',
      sourceHash,
      startOffset,
      endOffset,
    }, signal())).rejects.toThrow(/path|safe|traversal/i)
    await cache.close()
  })

  it('rejects overlapping, oversized, over-budget, and pre-aborted windows before disclosure', async () => {
    const source = 'x'.repeat(MAX_CONTEXT_SESSION_BYTES + 1)
    const { store, cache, compiler } = await fixture(source)
    const base = await compiler.repoMap({ snapshotId: store.snapshot.snapshotId, limit: 10 }, signal())
    const sourceHash = fileHash(store, 'src/auth.ts')
    const controller = new AbortController()
    const first = { blockId: base.blockId, path: 'src/auth.ts', sourceHash, startOffset: 0, endOffset: MAX_CONTEXT_BLOCK_BYTES }
    await compiler.expandSource(first, controller.signal)
    await expect(compiler.expandSource({ ...first, startOffset: MAX_CONTEXT_BLOCK_BYTES - 1, endOffset: MAX_CONTEXT_BLOCK_BYTES + 1 }, controller.signal)).rejects.toThrow(/overlap/i)
    await expect(compiler.expandSource({ ...first, startOffset: MAX_CONTEXT_BLOCK_BYTES, endOffset: MAX_CONTEXT_BLOCK_BYTES * 2 }, controller.signal)).resolves.toBeDefined()
    await compiler.expandSource({ ...first, startOffset: MAX_CONTEXT_BLOCK_BYTES * 2, endOffset: MAX_CONTEXT_BLOCK_BYTES * 3 }, controller.signal)
    await compiler.expandSource({ ...first, startOffset: MAX_CONTEXT_BLOCK_BYTES * 3, endOffset: MAX_CONTEXT_BLOCK_BYTES * 4 }, controller.signal)
    await expect(compiler.expandSource({ ...first, startOffset: MAX_CONTEXT_BLOCK_BYTES * 4, endOffset: MAX_CONTEXT_BLOCK_BYTES * 4 + 1 }, controller.signal)).rejects.toThrow(/session|budget/i)
    await expect(compiler.expandSource({ ...first, startOffset: 0, endOffset: MAX_CONTEXT_BLOCK_BYTES + 1 }, signal())).rejects.toThrow(/oversized|byte|window/i)
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    await expect(compiler.expandSource(first, aborted.signal)).rejects.toThrow(/cancel/i)
    await cache.close()
  })

  it('fails closed when the source mutates between the snapshot and verified read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-context-mutation-'))
    roots.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    const path = join(root, 'src', 'auth.ts')
    await writeFile(path, 'export function before() { return true }\n', 'utf8')
    let mutate = false
    const store = await RepositorySnapshotStore.create(config(root), {
      afterOpenForTest: async absolutePath => {
        if (mutate && absolutePath === path) await writeFile(absolutePath, 'export function after() { return false }\n', 'utf8')
      },
    })
    const adapter = await extractFallbackSymbols(store)
    const index = buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries)
    const cache = await ContextCacheStore.open({ deploymentRoot: root })
    const compiler = createContextCompiler({ workspaceRoot: root, store, index, cache })
    const base = await compiler.repoMap({ snapshotId: store.snapshot.snapshotId, limit: 10 }, signal())
    mutate = true
    await expect(compiler.expandSource({
      blockId: base.blockId,
      path: 'src/auth.ts',
      sourceHash: fileHash(store, 'src/auth.ts'),
      startOffset: 0,
      endOffset: 10,
    }, signal())).rejects.toThrow(/changed|mismatch|stable|source/i)
    await cache.close()
  })
})

describe('context read-only tools', () => {
  it('exposes only exact bounded context arguments and parsed ContextBlockV1 results', async () => {
    const { store, compiler, cache } = await fixture()
    const tools = createContextTools(compiler)
    expect(tools.map(tool => tool.name)).toEqual(['context_repo_map', 'context_symbol_query', 'context_expand_source'])
    const repoMap = tools[0]!
    await expect(repoMap.execute({ snapshotId: store.snapshot.snapshotId, limit: 1, extra: true }, { signal: signal() } as never)).rejects.toThrow(/unknown|allowed|key/i)
    const result = await repoMap.execute({ snapshotId: store.snapshot.snapshotId, limit: 1 }, { signal: signal() } as never)
    expect(parseContextBlockV1(result)).toEqual(result)
    await cache.close()
  })

  it('registers the compiler service and context tools in one disposable lifecycle effect', async () => {
    const { store, index, compiler, cache } = await fixture()
    const values = new Map<string, unknown>()
    const services = new Map<string, unknown>()
    const effects: Array<() => void | Promise<void>> = []
    const ctx = {
      tools: {
        register(tool: { readonly name: string }) {
          values.set(tool.name, tool)
          return () => { values.delete(tool.name) }
        },
      },
      provide(name: string, value: unknown) {
        services.set(name, value)
        return () => { services.delete(name) }
      },
      effect(effect: () => () => void | Promise<void>) {
        const dispose = effect()
        effects.push(dispose)
        return dispose
      },
    }
    mountCodeIntelligence(ctx as never, { snapshot: store.snapshot, index, compiler })
    expect(services.get('contextCompiler')).toBe(compiler)
    expect([...values.keys()]).toEqual([
      'code_repo_map',
      'code_symbol_query',
      'context_repo_map',
      'context_symbol_query',
      'context_expand_source',
    ])
    expect(effects).toHaveLength(1)
    await effects[0]!()
    expect(values).toHaveLength(0)
    expect(services).toHaveLength(0)
    await expect(compiler.repoMap({ snapshotId: store.snapshot.snapshotId, limit: 1 }, signal())).rejects.toThrow(/disposed/i)
    await cache.close()
  })
})
