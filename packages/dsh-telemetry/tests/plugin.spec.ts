import { afterEach, expect, it, vi } from 'vitest'
import * as storage from '../src/store.ts'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, Config, inject, name, provide } from '../src/index.ts'
const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function root() { const path = await mkdtemp(join(tmpdir(), 'telemetry-plugin-')); dirs.push(path); return join(path, 'store') }
const event = { seq: 1, type: 'dsh-plugin/run-started', data: { schemaVersion: 1, mode: 'direct', provider: 'p', model: 'm' } }
it('exports metadata and installs no effect, listener, service or directory when disabled', async () => {
  expect(name).toBe('dsh-telemetry'); expect(inject).toEqual(['sessions']); expect(provide).toEqual(['telemetry']); expect(apply.Config).toBe(Config)
  const ctx = new Context(); const path = await root()
  const fiber = await ctx.plugin(apply, { enabled: false, storageRoot: path })
  expect(ctx.get('telemetry')).toBeUndefined()
  expect(fiber.getEffects()).toEqual([])
  await expect(readdir(path)).rejects.toMatchObject({ code: 'ENOENT' })
  await fiber.dispose()
})
it('passively observes real Cordis events, seals roots only, then releases writer for a replacement', async () => {
  const ctx = new Context(); ctx.provide('sessions', {})
  const path = await root(); const fiber = await ctx.plugin(apply, { enabled: true, storageRoot: path })
  const service = ctx.get('telemetry') as any
  expect(service).toMatchObject({ flush: expect.any(Function), dispose: expect.any(Function), stats: expect.any(Function) })
  const session = Object.freeze({ id: 'root', header: Object.freeze({}), events: Object.freeze([]) })
  ctx.emit('session/event' as never, session as never, event as never)
  ctx.emit('session/disposed' as never, { id: 'child', header: { parentSession: 'root' } } as never)
  expect(service.stats().trackedRuns).toBe(1)
  ctx.emit('session/disposed' as never, session as never)
  await service.flush()
  await fiber.dispose()
  ctx.emit('session/event' as never, session as never, event as never)
  expect(ctx.get('telemetry')).toBeUndefined()
  expect((await readdir(path)).includes('writer.lock')).toBe(false)
  const records = (await readFile(join(path, 'segment-0000000000000001.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  expect(records).toHaveLength(2); expect(records[1]).toMatchObject({ complete: true })
  const replacement = await ctx.plugin(apply, { enabled: true, storageRoot: path })
  ctx.emit('session/event' as never, session as never, event as never)
  await replacement.dispose()
  const next = (await readFile(join(path, 'segment-0000000000000001.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  expect(next[2].runRef).not.toBe(records[0].runRef); expect(next[3].complete).toBe(false)
})
it('leaves collection unavailable on initialization failure without throwing into Cordis', async () => {
  const ctx = new Context(); ctx.provide('sessions', {})
  const fiber = await ctx.plugin(apply, { enabled: true, storageRoot: '/missing-telemetry-parent/subdir/store' })
  expect(ctx.get('telemetry')).toBeUndefined()
  await fiber.dispose()
})
it('attributes malformed event metadata to its known root and seals it incomplete', async () => {
  const ctx = new Context(); ctx.provide('sessions', {})
  const path = await root(); const fiber = await ctx.plugin(apply, { enabled: true, storageRoot: path })
  const session = { id: 'root', header: {} }
  ctx.emit('session/event' as never, session as never, event as never)
  expect(() => ctx.emit('session/event' as never, session as never, { ...event, get data() { throw new Error('secret') } } as never)).not.toThrow()
  ctx.emit('session/disposed' as never, session as never)
  await fiber.dispose()
  const records = (await readFile(join(path, 'segment-0000000000000001.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  expect(records.at(-1)).toMatchObject({ complete: false, lostCount: 1 })
})
it('stops listeners before service-dependent asynchronous cleanup runs', async () => {
  const ctx = new Context(); ctx.provide('sessions', {})
  const path = await root(); const fiber = await ctx.plugin(apply, { enabled: true, storageRoot: path })
  const session = { id: 'root', header: {} }
  ctx.emit('session/event' as never, session as never, event as never)
  const dependent = Object.assign((scope: Context) => {
    scope.effect(() => async () => {
      ctx.emit('session/event' as never, session as never, { seq: 2, type: 'dsh-plugin/budget-rejected', data: { schemaVersion: 1, reason: 'late', limit: 1, observed: 2 } } as never)
    })
  }, { inject: ['telemetry'] })
  const child = await ctx.plugin(dependent)
  await fiber.dispose()
  const records = (await readFile(join(path, 'segment-0000000000000001.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  expect(records).toHaveLength(2)
  expect(records[1]).toMatchObject({ complete: false, observationCount: 1 })
  await child.dispose()
})
it('closes a late-initializing store during generation cancellation', async () => {
  const ctx = new Context(); ctx.provide('sessions', {})
  const path = await root()
  let release!: () => void; let opened!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const opening = new Promise<void>(resolve => { opened = resolve })
  const original = storage.openTelemetryStore
  vi.spyOn(storage, 'openTelemetryStore').mockImplementation(async path => {
    const store = await original(path)
    opened(); await gate; return store
  })
  const fiber = ctx.plugin(apply, { enabled: true, storageRoot: path })
  await opening
  const unloading = fiber.dispose()
  release()
  await unloading
  expect(ctx.get('telemetry')).toBeUndefined()
  expect(await readdir(path)).not.toContain('writer.lock')
  const replacement = await ctx.plugin(apply, { enabled: true, storageRoot: path })
  expect(ctx.get('telemetry')).toBeDefined()
  await replacement.dispose()
})
it('rolls back store and partial listeners when service registration fails', async () => {
  const ctx = new Context(); ctx.provide('sessions', {})
  const occupied = { existing: true }; ctx.provide('telemetry', occupied)
  const path = await root(); const fiber = await ctx.plugin(apply, { enabled: true, storageRoot: path })
  expect(ctx.get('telemetry')).toBe(occupied)
  expect(await readdir(path)).not.toContain('writer.lock')
  ctx.emit('session/event' as never, { id: 'root', header: {} } as never, event as never)
  expect(await readFile(join(path, 'segment-0000000000000001.jsonl'), 'utf8')).toBe('')
  await fiber.dispose()
})
it('does not admit a root after rejecting its initial callback metadata', async () => {
  const ctx = new Context(); ctx.provide('sessions', {})
  const path = await root(); const fiber = await ctx.plugin(apply, { enabled: true, storageRoot: path })
  const session = { id: 'root', header: {} }
  expect(() => ctx.emit('session/event' as never, session as never, { ...event, get data() { throw new Error('secret') } } as never)).not.toThrow()
  ctx.emit('session/event' as never, session as never, event as never)
  ctx.emit('session/disposed' as never, session as never)
  const service = ctx.get('telemetry') as any
  expect(service.stats()).toMatchObject({ trackedRuns: 0, dropped: 2 })
  await fiber.dispose()
  expect(await readFile(join(path, 'segment-0000000000000001.jsonl'), 'utf8')).toBe('')
})
