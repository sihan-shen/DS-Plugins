import { afterEach, describe, expect, it } from 'vitest'
import { type FileHandle, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, utimes, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, type TelemetryRecordV1 } from '../src/contracts.js'
import { addTelemetryCount, openTelemetryStore, type TelemetryStore } from '../src/store.js'

const ref = 'a'.repeat(64)
const seal: TelemetryRecordV1 = { schemaVersion: 1, kind: 'run-seal', domainRef: ref, runRef: ref,
  observationCount: 0, lostCount: 0, complete: true }
const line = canonicalJson(seal) + '\n'
const roots: string[] = []
const stores: TelemetryStore[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.dispose().catch(() => {})))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function location() {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  roots.push(parent)
  return join(parent, '.dsh-telemetry')
}
async function open(root: string, options?: Parameters<typeof openTelemetryStore>[1]) {
  const store = await openTelemetryStore(root, options)
  stores.push(store)
  return store
}
async function segments(root: string) {
  return (await readdir(root)).filter(name => /^segment-\d{16}\.jsonl$/.test(name)).sort()
}

describe('bounded telemetry storage', () => {
  it('persists canonical records and a stable private salt; serializes duplicate flush and dispose', async () => {
    const root = await location()
    const store = await open(root)
    expect(store.salt).toHaveLength(32)
    expect(store.enqueue(seal)).toBe(true)
    await Promise.all([store.flush(), store.flush(), store.dispose(), store.dispose()])
    expect(store.stats()).toEqual({ queued: 0, dropped: 0, writeErrors: 0 })
    const names = await segments(root)
    expect(names).toHaveLength(1)
    expect(await readFile(join(root, names[0]), 'utf8')).toBe(line)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    for (const name of [...names, 'salt.bin']) expect((await stat(join(root, name))).mode & 0o777).toBe(0o600)
    const reopened = await open(root)
    expect(reopened.salt).toEqual(store.salt)
  })

  it('applies record-byte and queue admission before persistence', async () => {
    const root = await location()
    const store = await open(root, { limits: { queueRecords: 2, recordBytes: Buffer.byteLength(line) } })
    expect(store.enqueue(seal)).toBe(true)
    expect(store.enqueue(seal)).toBe(true)
    expect(store.enqueue(seal)).toBe(false)
    expect(store.enqueue({ ...seal, secret: 'private' } as TelemetryRecordV1)).toBe(false)
    expect(store.stats()).toEqual({ queued: 2, dropped: 2, writeErrors: 0 })
    await store.flush()
    expect(await readFile(join(root, (await segments(root))[0]), 'utf8')).toBe(line.repeat(2))
    await store.dispose()
    const tiny = await open(root, { limits: { recordBytes: Buffer.byteLength(line) - 1 } })
    expect(tiny.enqueue(seal)).toBe(false)
  })

  it('refuses a second writer without disturbing the first writer lock', async () => {
    const root = await location()
    const store = await open(root)
    expect((await stat(join(root, 'writer.lock'))).mode & 0o777).toBe(0o600)
    await expect(openTelemetryStore(root)).rejects.toThrow('telemetry store unavailable')
    expect(await stat(join(root, 'writer.lock'))).toBeDefined()
    expect(store.enqueue(seal)).toBe(true)
    await store.flush()
  })

  it('rejects nonabsolute paths and symlink roots, salt, lock and segment files', async () => {
    await expect(openTelemetryStore('relative/private')).rejects.toThrow('telemetry store unavailable')
    for (const name of ['', 'salt.bin', 'writer.lock', 'segment-0000000000000001.jsonl']) {
      const root = await location()
      const target = root + '-target'
      if (name === '') {
        await mkdir(target, { mode: 0o700 })
        await symlink(target, root)
      } else {
        await mkdir(root, { mode: 0o700 })
        await writeFile(target, 'sensitive', { mode: 0o600 })
        await symlink(target, join(root, name))
      }
      await expect(openTelemetryStore(root)).rejects.toThrow('telemetry store unavailable')
      if (name) expect(await readFile(target, 'utf8')).toBe('sensitive')
    }
  })
})


describe('rotation, retention and failure recovery', () => {
  it('rotates before the byte cap and deletes only oldest closed numbered segments', async () => {
    const root = await location()
    const store = await open(root, { limits: { segmentBytes: Buffer.byteLength(line), segments: 2 } })
    await writeFile(join(root, 'unrelated.jsonl'), 'private unrelated content')
    for (let n = 0; n < 4; n++) {
      expect(store.enqueue({ ...seal, runRef: String(n).repeat(64) })).toBe(true)
      await store.flush()
    }
    expect(await segments(root)).toEqual(['segment-0000000000000003.jsonl', 'segment-0000000000000004.jsonl'])
    for (const name of await segments(root)) expect((await stat(join(root, name))).size).toBe(Buffer.byteLength(line))
    expect(await readFile(join(root, 'unrelated.jsonl'), 'utf8')).toBe('private unrelated content')
  })

  it('prunes expired closed segments while preserving the active one', async () => {
    const root = await location()
    await mkdir(root, { mode: 0o700 })
    for (let n = 1; n <= 3; n++) {
      const path = join(root, `segment-${String(n).padStart(16, '0')}.jsonl`)
      await writeFile(path, line, { mode: 0o600 })
      await utimes(path, new Date(0), new Date(0))
    }
    await open(root)
    expect(await segments(root)).toEqual(['segment-0000000000000003.jsonl'])
  })

  it('repairs only an incomplete active tail after restart', async () => {
    const root = await location()
    const store = await open(root)
    store.enqueue(seal)
    await store.dispose()
    const name = (await segments(root))[0]
    await writeFile(join(root, name), line + '{"private-partial":', { mode: 0o600 })
    const restarted = await open(root)
    expect(await readFile(join(root, name), 'utf8')).toBe(line)
    restarted.enqueue(seal)
    await restarted.dispose()
    expect(await readFile(join(root, name), 'utf8')).toBe(line.repeat(2))
  })

  it('retries successful short writes without losing or duplicating bytes', async () => {
    const root = await location()
    const store = await open(root, { io: { async write(file, data, position) {
      return (await file.write(data, 0, Math.min(7, data.length), position)).bytesWritten
    } } })
    store.enqueue(seal)
    await store.flush()
    expect(await readFile(join(root, (await segments(root))[0]), 'utf8')).toBe(line)
    expect(store.stats()).toEqual({ queued: 0, dropped: 0, writeErrors: 0 })
  })

  it.each(['ENOSPC', 'partial', 'zero', 'sync'])('fails closed on %s without exposing filesystem details', async failure => {
    const root = await location()
    let writes = 0
    let descriptor: FileHandle | undefined
    const store = await open(root, { io: {
      async write(file, data, position) {
        descriptor = file
        writes++
        if (failure === 'sync') return (await file.write(data, 0, data.length, position)).bytesWritten
        if (failure === 'partial' && writes === 1) return (await file.write(data, 0, 11, position)).bytesWritten
        if (failure === 'zero') return 0
        throw Object.assign(new Error('SECRET /private/directory'), { code: 'ENOSPC' })
      },
      async sync(file) {
        if (failure === 'sync') throw new Error('SECRET sync error')
        await file.sync()
      },
    } })
    store.enqueue(seal)
    store.enqueue(seal)
    await expect(store.flush()).rejects.toThrow(/^telemetry store write failed$/)
    expect(store.enqueue(seal)).toBe(false)
    await expect(descriptor!.stat()).rejects.toMatchObject({ code: 'EBADF' })
    const before = await readFile(join(root, (await segments(root))[0]), 'utf8')
    await expect(store.flush()).rejects.toThrow(/^telemetry store write failed$/)
    await expect(store.dispose()).rejects.toThrow(/^telemetry store write failed$/)
    await expect(store.dispose()).rejects.toThrow(/^telemetry store write failed$/)
    expect(store.stats().writeErrors).toBe(1)
    expect(store.stats().queued).toBe(0)
    expect(store.stats().dropped).toBe(3)
    expect(await readFile(join(root, (await segments(root))[0]), 'utf8')).toBe(before)
    const restarted = await open(root)
    restarted.enqueue(seal)
    await restarted.flush()
    expect((await readFile(join(root, (await segments(root))[0]), 'utf8')).endsWith(line)).toBe(true)
  })

  it('bounds in-flight queue admission and disposal drains records exactly once', async () => {
    const root = await location()
    let resume!: () => void
    const pause = new Promise<void>(resolve => { resume = resolve })
    const store = await open(root, { limits: { queueRecords: 2 }, io: { async write(file, data, position) {
      await pause
      return (await file.write(data, 0, data.length, position)).bytesWritten
    } } })
    store.enqueue(seal)
    const flush = store.flush()
    expect(store.enqueue(seal)).toBe(true)
    expect(store.enqueue(seal)).toBe(false)
    const disposal = store.dispose()
    expect(store.enqueue(seal)).toBe(false)
    resume()
    await Promise.all([flush, disposal, store.flush(), store.dispose()])
    expect(await readFile(join(root, (await segments(root))[0]), 'utf8')).toBe(line.repeat(2))
    expect(store.stats()).toEqual({ queued: 0, dropped: 2, writeErrors: 0 })
  })

  it('rejects raised, nonfinite and nonsensical ceilings', async () => {
    for (const limits of [{ queueRecords: 257 }, { recordBytes: 8193 }, { segmentBytes: 1048577 },
      { segments: 9 }, { ageMs: 2592000001 }, { segments: Infinity }, { queueRecords: 0 }, { segments: 1.5 }]) {
      await expect(openTelemetryStore(await location(), { limits })).rejects.toThrow('telemetry store unavailable')
    }
  })

  it('rejects records that cannot fit a lowered segment ceiling', async () => {
    const store = await open(await location(), { limits: { segmentBytes: 1 } })
    expect(store.enqueue(seal)).toBe(false)
    expect(store.stats()).toEqual({ queued: 0, dropped: 1, writeErrors: 0 })
  })

  it('rejects oversized existing segments before reading them and nonregular or linked files', async () => {
    for (const kind of ['oversized', 'directory', 'hardlink', 'public-salt']) {
      const root = await location()
      await mkdir(root, { mode: 0o700 })
      const target = join(root, 'segment-0000000000000001.jsonl')
      if (kind === 'directory') await mkdir(target)
      if (kind === 'oversized') await writeFile(target, Buffer.alloc(1048577), { mode: 0o600 })
      if (kind === 'hardlink') {
        await writeFile(root + '-outside', line, { mode: 0o600 })
        await link(root + '-outside', target)
      }
      if (kind === 'public-salt') await writeFile(join(root, 'salt.bin'), Buffer.alloc(32), { mode: 0o644 })
      await expect(openTelemetryStore(root)).rejects.toThrow('telemetry store unavailable')
    }
  })

  it('saturates loss counters at the largest safe integer', () => {
    expect(addTelemetryCount(Number.MAX_SAFE_INTEGER - 1, 2)).toBe(Number.MAX_SAFE_INTEGER)
    expect(addTelemetryCount(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER)
    expect(addTelemetryCount(4, 2)).toBe(6)
  })
})

describe('lifecycle edge cases', () => {
  it('drains an accepted tail when dispose races the final flush cleanup', async () => {
    const root = await location()
    let scheduled = false
    let disposal: Promise<void> | undefined
    const store = await open(root, { io: { async sync(file) {
      await file.sync()
      if (!scheduled) {
        scheduled = true
        // After the durable write leaves the queue, but before the pending
        // flush's finalization resolves, admit a tail and request disposal.
        queueMicrotask(() => queueMicrotask(() => {
          expect(store.enqueue(seal)).toBe(true)
          disposal = store.dispose()
        }))
      }
    } } })
    store.enqueue(seal)
    await store.flush()
    await disposal
    expect(store.stats().queued).toBe(0)
    expect(await readFile(join(root, (await segments(root))[0]), 'utf8')).toBe(line.repeat(2))
  })

  it('retains a formerly old active segment after new writes refresh its age', async () => {
    const root = await location()
    await mkdir(root, { mode: 0o700 })
    const name = 'segment-0000000000000001.jsonl'
    await writeFile(join(root, name), line, { mode: 0o600 })
    await utimes(join(root, name), new Date(0), new Date(0))
    const store = await open(root, { limits: { segmentBytes: Buffer.byteLength(line) * 2 } })
    store.enqueue(seal)
    await store.flush()
    store.enqueue(seal)
    await store.flush()
    expect(await segments(root)).toHaveLength(2)
  })

  it('never deletes a substituted writer lock owned by someone else', async () => {
    const root = await location()
    const store = await open(root)
    await rm(join(root, 'writer.lock'))
    await writeFile(join(root, 'writer.lock'), 'replacement owner', { mode: 0o600 })
    await expect(store.dispose()).rejects.toThrow(/^telemetry store write failed$/)
    expect(await readFile(join(root, 'writer.lock'), 'utf8')).toBe('replacement owner')
  })
})
