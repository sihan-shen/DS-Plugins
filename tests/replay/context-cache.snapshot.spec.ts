import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_CONTEXT_SESSION_BYTES, truncateUtf8ByBytes } from '../../packages/dsh-context/src/index.ts'
import { createContextCacheReplayFixture, type ContextCacheReplayFixture } from './context-cache.fixture.ts'
import { copyProfileResolutionSurface, profileNames } from './profile-compatibility.fixture.ts'

const fixtures: ContextCacheReplayFixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose()))
})

async function fixture(): Promise<ContextCacheReplayFixture> {
  const value = await createContextCacheReplayFixture()
  fixtures.push(value)
  return value
}

describe('v0.2c separate provider-disabled profile', () => {
  it('resolves every profile from its own fresh module surface at the target versions', async () => {
    const expected = new Map([
      ['v0.1', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-session', '@deepseek-ai/cordis']],
      ['v0.2b-readonly', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tools', '@deepseek-ai/cordis']],
      ['v0.2c-context', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-session', '@deepseek-ai/cordis']],
      ['v0.3-adaptive', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-session', '@deepseek-ai/cordis']],
    ] as const)
    const surfaces = await Promise.all(profileNames.map(profile => copyProfileResolutionSurface(profile)))
    try {
      for (const surface of surfaces) {
        const packageNames = expected.get(surface.profile) ?? []
        for (const name of packageNames) {
          const version = surface.resolveManifest(name).version
          expect(version, `${surface.profile} ${name}`).toBe(name === '@deepseek-ai/cordis' ? '4.0.2' : '0.1.2-rc.1')
        }
      }
    } finally {
      await Promise.all(surfaces.map(surface => surface.dispose()))
    }
  })

  it('composes the official Web workspace service with orchestrator, code intelligence, and cache', async () => {
    const root = new URL('../../', import.meta.url)
    const manifest = JSON.parse(await readFile(new URL('profiles/v0.2c-context/package.json', root), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    const patch = JSON.parse(await readFile(new URL('profiles/v0.2c-context/cordis.patch.yml', root), 'utf8')) as unknown[]
    const v01Manifest = JSON.parse(await readFile(new URL('profiles/v0.1/package.json', root), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    const v01Patch = await readFile(new URL('profiles/v0.1/cordis.patch.yml', root), 'utf8')
    const rootManifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as { scripts: Record<string, string> }

    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@han_05/dsh-orchestrator',
      '@han_05/dsh-code-intelligence',
    ])
    expect(Object.keys(manifest.dependencies)).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-base',
      '@han_05/dsh-orchestrator',
      '@han_05/dsh-code-intelligence',
      '@han_05/dsh-context-cache',
    ]))
    expect(JSON.stringify(patch)).toContain('v0.2c-context')
    expect(v01Manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@han_05/dsh-orchestrator'])
    expect(v01Patch).not.toContain('dsh-code-intelligence')
    expect(v01Patch).not.toContain('dsh-context-cache')
    expect(rootManifest.scripts['test:v0.2c']).not.toMatch(/test:provider|openai|headless/i)
    expect(JSON.stringify(manifest)).not.toMatch(/dsh-llm|dsh-headless/i)
  })
})

describe('context cache keyless replay', () => {
  it('replays a cold miss and warm hit without exposing raw source in projection blocks', async () => {
    const replay = await fixture()
    const cold = await replay.mountCompiler()
    const coldBlock = await cold.repoMap(replay.repoMapRequest, replay.signal())
    expect(cold.cacheStats).toEqual({ hits: 0, misses: 1 })
    expect(coldBlock.text).not.toContain(replay.rawSourceMarker)
    await cold.dispose()

    const warm = await replay.mountCompiler()
    const warmBlock = await warm.repoMap(replay.repoMapRequest, replay.signal())
    expect(warm.cacheStats).toEqual({ hits: 1, misses: 0 })
    expect(warmBlock).toEqual(coldBlock)
    await warm.dispose()
  })

  it('treats boundary changes and dependency invalidation as misses', async () => {
    const replay = await fixture()
    const first = await replay.mountCompiler()
    await first.repoMap(replay.repoMapRequest, replay.signal())
    await first.dispose()

    const changed = await replay.mountCompiler({ capabilityVersion: 'dsh-context-capability-v2' })
    await changed.repoMap(replay.repoMapRequest, replay.signal())
    expect(changed.cacheStats).toEqual({ hits: 0, misses: 1 })
    await changed.dispose()

    const cache = await replay.openCache()
    const { block, boundary, lookup } = replay.cacheRecord('dependency-bound')
    await cache.putBlock(block, boundary)
    await cache.putLookup(lookup, [block.blockId])
    await cache.invalidateBySourceHashes([replay.sourceHash])
    expect(await cache.getBlock(block.blockId, boundary)).toBeUndefined()
    expect(await cache.getLookup(lookup)).toBeUndefined()
    await cache.close()
  })

  it('misses malformed, stale, oversized, and quarantined data while bounding quarantine', async () => {
    const replay = await fixture()
    const cache = await replay.openCache()
    const { block, boundary } = replay.cacheRecord('corrupt-me')
    await cache.putBlock(block, boundary)
    const entryName = (await readdir(replay.entriesPath)).find(name => name.endsWith('.json'))
    if (entryName === undefined) throw new Error('expected cache entry')
    await writeFile(join(replay.entriesPath, entryName), '{not-json', 'utf8')
    expect(await cache.getBlock(block.blockId, boundary)).toBeUndefined()
    await expect(cache.putToolResult('oversized', boundary, '🙂', 5)).rejects.toThrow(/exceed|byte/i)

    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(replay.quarantinePath, `old-${index}.json`), 'x'.repeat(300_000), 'utf8')
    }
    const next = replay.cacheRecord('trigger-quarantine')
    await cache.putBlock(next.block, next.boundary)
    const nextEntry = (await readdir(replay.entriesPath)).find(name => name.endsWith('.json'))
    if (nextEntry === undefined) throw new Error('expected trigger cache entry')
    await writeFile(join(replay.entriesPath, nextEntry), '{not-json', 'utf8')
    expect(await cache.getBlock(next.block.blockId, next.boundary)).toBeUndefined()
    const quarantineFiles = await readdir(replay.quarantinePath)
    expect(quarantineFiles.length).toBeLessThanOrEqual(32)
    let quarantineBytes = 0
    for (const name of quarantineFiles) quarantineBytes += (await stat(join(replay.quarantinePath, name))).size
    expect(quarantineBytes).toBeLessThanOrEqual(10 * 1024 * 1024)
    await cache.close()

    const compiler = await replay.mountCompiler()
    await expect(compiler.expandSource({
      blockId: 'sha256:' + '0'.repeat(64),
      path: replay.sourcePath,
      sourceHash: replay.sourceHash,
      startOffset: 0,
      endOffset: 1,
    }, replay.signal(), 'stale-session')).rejects.toThrow(/prior|cached|block/i)
    await compiler.dispose()
  })

  it('serializes concurrent writers and returns a miss on lock timeout', async () => {
    const replay = await fixture()
    const first = await replay.openCache({ lockTimeoutMs: 0 })
    const second = await replay.openCache({ lockTimeoutMs: 0 })
    const { block, boundary } = replay.cacheRecord('concurrent')
    await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? first : second).putBlock(block, boundary)))
    expect((await readdir(replay.entriesPath)).filter(name => name.endsWith('.json'))).toHaveLength(1)

    await writeFile(replay.lockPath, 'held', { flag: 'wx' })
    expect(await first.getBlock(block.blockId, boundary)).toBeUndefined()
    await unlink(replay.lockPath)
    expect(await first.getBlock(block.blockId, boundary)).toEqual(block)
    await first.close()
    await second.close()
  })

  it('preserves UTF-8 boundaries and admits exactly 262,144 source bytes per session', async () => {
    expect(truncateUtf8ByBytes('A🙂B', 5)).toBe('A🙂')
    expect(truncateUtf8ByBytes('A🙂B', 4)).toBe('A')

    const replay = await fixture()
    const compiler = await replay.mountCompiler()
    const base = await compiler.repoMap(replay.repoMapRequest, replay.signal(), 'budget-session')
    const source = base.sources.find(value => value.path === replay.sourcePath)
    if (source === undefined) throw new Error('expected source provenance')
    const blockSize = 65_536
    let admitted = 0
    for (let index = 0; index < 4; index += 1) {
      const block = await compiler.expandSource({
        blockId: base.blockId,
        path: source.path,
        sourceHash: source.contentHash,
        startOffset: index * blockSize,
        endOffset: (index + 1) * blockSize,
      }, replay.signal(), 'budget-session')
      admitted += block.byteLength
    }
    expect(admitted).toBe(MAX_CONTEXT_SESSION_BYTES)
    await expect(compiler.expandSource({
      blockId: base.blockId,
      path: source.path,
      sourceHash: source.contentHash,
      startOffset: MAX_CONTEXT_SESSION_BYTES,
      endOffset: MAX_CONTEXT_SESSION_BYTES + 1,
    }, replay.signal(), 'budget-session')).rejects.toThrow(/session byte budget/i)
    await compiler.dispose()
  })

  it('closes a disposed compiler and permits a cache-backed remount', async () => {
    const replay = await fixture()
    const first = await replay.mountCompiler()
    await first.repoMap(replay.repoMapRequest, replay.signal())
    await first.dispose()
    await expect(first.repoMap(replay.repoMapRequest, replay.signal())).rejects.toThrow(/disposed/i)

    const remounted = await replay.mountCompiler()
    await remounted.repoMap(replay.repoMapRequest, replay.signal())
    expect(remounted.cacheStats).toEqual({ hits: 1, misses: 0 })
    await remounted.dispose()
  })
})
