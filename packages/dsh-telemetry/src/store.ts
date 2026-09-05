import { randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { canonicalJson, parseTelemetryRecordV1, type TelemetryRecordV1 } from './contracts.js'

export interface TelemetryStore {
  readonly salt: Uint8Array
  enqueue(record: TelemetryRecordV1): boolean
  flush(): Promise<void>
  dispose(): Promise<void>
  stats(): { queued: number; dropped: number; writeErrors: number }
}

const MAXIMA = { recordBytes: 8192, queueRecords: 256, segmentBytes: 1024 * 1024,
  segments: 8, ageMs: 30 * 24 * 60 * 60 * 1000 } as const
export interface TelemetryStoreOptions {
  /** Overrides may lower fixed production ceilings only. */
  limits?: Partial<Record<keyof typeof MAXIMA, number>>
  /** Narrow filesystem adapter for deterministic short-write and disk-failure tests. */
  io?: Partial<{
    write(file: FileHandle, data: Buffer, position: number): Promise<number>
    sync(file: FileHandle): Promise<void>
  }>
}
export function addTelemetryCount(value: number, amount = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + amount)
}

const segmentPattern = /^segment-(\d{16})\.jsonl$/
const unavailable = () => new Error('telemetry store unavailable')
const writeFailed = () => new Error('telemetry store write failed')
const privateFile = (info: Stats) => info.isFile() && info.nlink === 1 &&
  (info.mode & 0o777) === 0o600 && info.uid === process.getuid?.()

async function checkedOpen(path: string, create: boolean): Promise<FileHandle> {
  const expected = create ? undefined : await lstat(path)
  if (expected && !privateFile(expected)) throw unavailable()
  const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW |
    (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600)
  try {
    const actual = await file.stat()
    if (!privateFile(actual) || (expected && (actual.ino !== expected.ino || actual.dev !== expected.dev))) throw unavailable()
    return file
  } catch (error) {
    await file.close().catch(() => {})
    throw error
  }
}

/** The caller must trust the parent directory and keep this private root unchanged. */
export async function openTelemetryStore(root: string, options: TelemetryStoreOptions = {}): Promise<TelemetryStore> {
  let lock: FileHandle | undefined
  let active: FileHandle | undefined
  let saltFile: FileHandle | undefined
  const releaseLock = async () => {
    const owned = await lock!.stat()
    try {
      const current = await lstat(join(root, 'writer.lock'))
      if (!privateFile(current) || current.ino !== owned.ino || current.dev !== owned.dev) throw writeFailed()
      await unlink(join(root, 'writer.lock'))
    } finally { await lock!.close() }
  }
  try {
    if (!isAbsolute(root) || resolve(root) !== root || dirname(root) === root) throw unavailable()
    const limits = { ...MAXIMA, ...options.limits }
    for (const key of Object.keys(MAXIMA) as (keyof typeof MAXIMA)[]) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > MAXIMA[key]) throw unavailable()
    }
    await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const directory = await lstat(root)
    if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700 || directory.uid !== process.getuid?.()) throw unavailable()
    lock = await checkedOpen(join(root, 'writer.lock'), true)
    let salt: Buffer
    try {
      await lstat(join(root, 'salt.bin'))
      saltFile = await checkedOpen(join(root, 'salt.bin'), false)
      if ((await saltFile.stat()).size !== 32) throw unavailable()
      salt = await saltFile.readFile()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      saltFile = await checkedOpen(join(root, 'salt.bin'), true)
      salt = randomBytes(32)
      await saltFile.writeFile(salt)
      await saltFile.sync()
    }
    await saltFile.close()
    saltFile = undefined
    const names = (await readdir(root)).filter(name => segmentPattern.test(name)).sort()
    const segments: { name: string; modified: number }[] = []
    for (const name of names) {
      const info = await lstat(join(root, name))
      const ordinal = Number(segmentPattern.exec(name)![1])
      if (!privateFile(info) || info.size > limits.segmentBytes || !Number.isSafeInteger(ordinal) || ordinal < 1) throw unavailable()
      segments.push({ name, modified: info.mtimeMs })
    }
    let ordinal = names.length ? Number(segmentPattern.exec(names.at(-1)!)![1]) : 1
    let activeName = names.at(-1) ?? 'segment-0000000000000001.jsonl'
    active = await checkedOpen(join(root, activeName), names.length === 0)
    if (!names.length) segments.push({ name: activeName, modified: Date.now() })
    let activeBytes = (await active.stat()).size
    if (activeBytes > limits.segmentBytes) throw unavailable()
    if (activeBytes) {
      // Allocation is bounded by the verified segment ceiling. Only its exclusive
      // writer repairs the last tail; closed segments are never rewritten.
      const bytes = Buffer.alloc(activeBytes)
      const read = await active.read(bytes, 0, bytes.length, 0)
      if (read.bytesRead !== bytes.length) throw unavailable()
      const completeBytes = bytes.lastIndexOf(10) + 1
      if (completeBytes !== activeBytes) {
        await active.truncate(completeBytes)
        await active.sync()
        activeBytes = completeBytes
      }
    }
    const prune = async (ceiling: number, protectedName: string | undefined) => {
      const cutoff = Date.now() - limits.ageMs
      for (let index = 0; index < segments.length;) {
        const segment = segments[index]
        if (segment.name !== protectedName && (segments.length > ceiling || segment.modified < cutoff)) {
          // Names originate only from the exact numbered-file grammar. Recheck
          // before deletion so a substituted symlink/nonregular file is refused.
          if (!privateFile(await lstat(join(root, segment.name)))) throw unavailable()
          await unlink(join(root, segment.name))
          segments.splice(index, 1)
        } else index++
      }
    }
    await prune(limits.segments, activeName)
    const io = {
      write: async (file: FileHandle, data: Buffer, position: number) =>
        (await file.write(data, 0, data.length, position)).bytesWritten,
      sync: (file: FileHandle) => file.sync(),
      ...options.io,
    }
    const rotate = async () => {
      if (!Number.isSafeInteger(ordinal + 1)) throw unavailable()
      await active!.close()
      active = undefined
      // The old active segment is now closed; prune before creating its successor
      // so even a one-segment store never temporarily exceeds its file cap.
      await prune(limits.segments - 1, undefined)
      ordinal++
      activeName = `segment-${String(ordinal).padStart(16, '0')}.jsonl`
      active = await checkedOpen(join(root, activeName), true)
      activeBytes = 0
      segments.push({ name: activeName, modified: Date.now() })
    }
    const queue: Buffer[] = []
    let dropped = 0
    let writeErrors = 0
    let accepting = true
    let failed = false
    let pending: Promise<void> | undefined
    let disposal: Promise<void> | undefined
    const flushQueue = (): Promise<void> => {
      if (failed) return Promise.reject(writeFailed())
      if (pending) return pending
      pending = (async () => {
        try {
          do {
            while (queue.length) {
              const data = queue[0]
              if (activeBytes + data.length > limits.segmentBytes) await rotate()
              let offset = 0
              while (offset < data.length) {
                const written = await io.write(active!, data.subarray(offset), activeBytes + offset)
                if (!Number.isSafeInteger(written) || written < 1 || written > data.length - offset) throw writeFailed()
                offset += written
              }
              activeBytes += data.length
              await io.sync(active!)
              segments.at(-1)!.modified = Date.now()
              queue.shift()
            }
            await prune(limits.segments, activeName)
          } while (queue.length)
        } catch {
          accepting = false
          failed = true
          writeErrors = addTelemetryCount(writeErrors)
          dropped = addTelemetryCount(dropped, queue.length)
          queue.length = 0
          await active?.close().catch(() => {})
          active = undefined
          throw writeFailed()
        } finally {
          // Clear ownership before resolving, with no await between the last
          // queue check and this assignment. A later admission can start a new
          // flush; disposal never joins a finished drain with an accepted tail.
          pending = undefined
        }
      })()
      return pending
    }
    return {
      get salt() { return Uint8Array.from(salt) },
      enqueue(record) {
        if (!accepting || queue.length >= limits.queueRecords) { dropped = addTelemetryCount(dropped); return false }
        try {
          const data = Buffer.from(canonicalJson(parseTelemetryRecordV1(record)) + '\n')
          if (data.length > limits.recordBytes || data.length > limits.segmentBytes) { dropped = addTelemetryCount(dropped); return false }
          queue.push(data)
          return true
        } catch { dropped = addTelemetryCount(dropped); return false }
      },
      flush() { return disposal ?? flushQueue() },
      dispose() {
        if (disposal) return disposal
        accepting = false
        disposal = (async () => {
          try { await flushQueue() }
          finally {
            let cleanupFailed = false
            await active?.close().catch(() => { cleanupFailed = true })
            active = undefined
            await releaseLock().catch(() => { cleanupFailed = true })
            if (cleanupFailed) throw writeFailed()
          }
        })()
        return disposal
      },
      stats() { return { queued: queue.length, dropped, writeErrors } },
    }
  } catch {
    await saltFile?.close().catch(() => {})
    await active?.close().catch(() => {})
    if (lock) {
      await releaseLock().catch(() => {})
    }
    throw unavailable()
  }
}
