import { randomUUID } from 'node:crypto'
import {
  chmod,
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { canonicalJson, parseContextBlockV1, sha256Utf8 } from '@ds-plugins/dsh-context'
import type { ContextBlockV1 } from '@ds-plugins/dsh-context'
import type {
  CacheBoundaryV1,
  CacheLookupKeyV1,
  ContextCacheConfigV1,
  ContextCacheStoreApiV1,
} from './types.js'

const CACHE_DIRECTORY = '.dsh-context-cache'
const CACHE_VERSION = 'v1'
const MAX_ENTRIES = 10_000
const MAX_BYTES = 268_435_456
const MAX_QUARANTINE_FILES = 32
const MAX_QUARANTINE_BYTES = 10 * 1024 * 1024
const DEFAULT_LOCK_TIMEOUT_MS = 250
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

const boundaryKeys = [
  'workspaceFingerprint',
  'snapshotId',
  'adapterId',
  'adapterVersion',
  'compilerPolicyVersion',
  'capabilityVersion',
] as const

type CachePaths = {
  readonly root: string
  readonly entries: string
  readonly lookups: string
  readonly quarantine: string
  readonly lock: string
}

type StoredEntryV1 = {
  schemaVersion: 1
  block: ContextBlockV1
  boundary: CacheBoundaryV1
  dependencyHashes: readonly string[]
  createdAt: number
  lastAccessAt: number
}

type StoredLookupV1 = {
  schemaVersion: 1
  key: CacheLookupKeyV1
  blockIds: readonly string[]
  dependencyHashes: readonly string[]
  lastAccessAt: number
}

type StoredToolResultV1 = {
  schemaVersion: 1
  entryType: 'tool-result'
  key: string
  boundary: CacheBoundaryV1
  value: unknown
  createdAt: number
  lastAccessAt: number
}

type EntryFile = {
  readonly name: string
  readonly record: StoredEntryV1 | StoredToolResultV1
  readonly bytes: number
}

type BlockEntryFile = {
  readonly name: string
  readonly record: StoredEntryV1
  readonly bytes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) throw new TypeError(`${path}.${key} is not allowed`)
  for (const key of allowed) if (!(key in value)) throw new TypeError(`${path}.${key} is required`)
}

function requiredString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) throw new TypeError(`${path} must be a string`)
  return value
}

function requiredInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${path} must be a non-negative safe integer`)
  return value as number
}

function normalizeHashes(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`)
  const result = value.map((hash, index) => {
    const normalized = requiredString(hash, `${path}[${index}]`)
    if (!HASH_PATTERN.test(normalized)) throw new TypeError(`${path}[${index}] must be a sha256 hash`)
    return normalized
  })
  if (new Set(result).size !== result.length) throw new TypeError(`${path} must not contain duplicate hashes`)
  return [...result].sort()
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function normalizeBoundary(value: unknown, path = 'boundary'): CacheBoundaryV1 {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  exactKeys(value, boundaryKeys, path)
  return {
    workspaceFingerprint: requiredString(value.workspaceFingerprint, `${path}.workspaceFingerprint`),
    snapshotId: requiredString(value.snapshotId, `${path}.snapshotId`),
    adapterId: requiredString(value.adapterId, `${path}.adapterId`),
    adapterVersion: requiredString(value.adapterVersion, `${path}.adapterVersion`),
    compilerPolicyVersion: requiredString(value.compilerPolicyVersion, `${path}.compilerPolicyVersion`),
    capabilityVersion: requiredString(value.capabilityVersion, `${path}.capabilityVersion`),
  }
}

function dependencyHashesForBlock(block: ContextBlockV1): readonly string[] {
  return normalizeHashes(block.sources.map(source => source.contentHash), 'block.sources')
}

function assertBlockBoundary(block: ContextBlockV1, boundary: CacheBoundaryV1): void {
  if (
    block.workspaceFingerprint !== boundary.workspaceFingerprint
    || block.snapshotId !== boundary.snapshotId
    || block.adapterId !== boundary.adapterId
    || block.adapterVersion !== boundary.adapterVersion
    || block.compilerPolicyVersion !== boundary.compilerPolicyVersion
  ) throw new TypeError('boundary must match immutable block provenance')
}

function normalizeLookupKey(value: unknown): CacheLookupKeyV1 {
  if (!isRecord(value)) throw new TypeError('key must be an object')
  exactKeys(value, [...boundaryKeys, 'normalizedQuery', 'dependencyHashes'], 'key')
  const boundary = normalizeBoundary(Object.fromEntries(boundaryKeys.map(key => [key, value[key]])), 'key')
  return {
    ...boundary,
    normalizedQuery: requiredString(value.normalizedQuery, 'key.normalizedQuery', true),
    dependencyHashes: normalizeHashes(value.dependencyHashes, 'key.dependencyHashes'),
  }
}

function sameBoundary(left: CacheBoundaryV1, right: CacheBoundaryV1): boolean {
  return boundaryKeys.every(key => left[key] === right[key])
}

function sameLookupKey(left: CacheLookupKeyV1, right: CacheLookupKeyV1): boolean {
  return sameBoundary(left, right)
    && left.normalizedQuery === right.normalizedQuery
    && sameStrings(left.dependencyHashes, right.dependencyHashes)
}

function blockIdIsValid(blockId: string): boolean {
  return typeof blockId === 'string' && HASH_PATTERN.test(blockId)
}

function ensureContained(root: string, child: string): void {
  const childRelative = relative(root, child)
  if (childRelative === '' || childRelative === '..' || childRelative.startsWith(`..${sep}`) || isAbsolute(childRelative)) {
    throw new TypeError('cache path must remain below the deployment root')
  }
}

async function ensurePrivateDirectory(path: string, deploymentRoot: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const canonicalPath = await realpath(path)
  ensureContained(deploymentRoot, canonicalPath)
  if (!(await stat(canonicalPath)).isDirectory()) throw new TypeError(`${path} must be a directory`)
  try {
    await chmod(canonicalPath, 0o700)
  } catch {
    // Windows and some mounted filesystems do not support Unix directory modes.
  }
}

async function cachePaths(deploymentRoot: string): Promise<CachePaths> {
  const root = join(deploymentRoot, CACHE_DIRECTORY, CACHE_VERSION)
  await ensurePrivateDirectory(root, deploymentRoot)
  const entries = join(root, 'entries')
  const lookups = join(root, 'lookups')
  const quarantine = join(root, 'quarantine')
  await ensurePrivateDirectory(entries, deploymentRoot)
  await ensurePrivateDirectory(lookups, deploymentRoot)
  await ensurePrivateDirectory(quarantine, deploymentRoot)
  return { root, entries, lookups, quarantine, lock: join(root, '.lock') }
}

function parseStoredEntry(value: unknown): StoredEntryV1 {
  if (!isRecord(value)) throw new TypeError('entry must be an object')
  exactKeys(value, ['schemaVersion', 'block', 'boundary', 'dependencyHashes', 'createdAt', 'lastAccessAt'], 'entry')
  if (value.schemaVersion !== 1) throw new TypeError('entry.schemaVersion must be 1')
  const block = parseContextBlockV1(value.block)
  const boundary = normalizeBoundary(value.boundary)
  assertBlockBoundary(block, boundary)
  const dependencyHashes = normalizeHashes(value.dependencyHashes, 'entry.dependencyHashes')
  if (!sameStrings(dependencyHashes, dependencyHashesForBlock(block))) throw new TypeError('entry dependency hashes do not match block sources')
  return {
    schemaVersion: 1,
    block,
    boundary,
    dependencyHashes,
    createdAt: requiredInteger(value.createdAt, 'entry.createdAt'),
    lastAccessAt: requiredInteger(value.lastAccessAt, 'entry.lastAccessAt'),
  }
}

function parseStoredLookup(value: unknown): StoredLookupV1 {
  if (!isRecord(value)) throw new TypeError('lookup must be an object')
  exactKeys(value, ['schemaVersion', 'key', 'blockIds', 'dependencyHashes', 'lastAccessAt'], 'lookup')
  if (value.schemaVersion !== 1) throw new TypeError('lookup.schemaVersion must be 1')
  const key = normalizeLookupKey(value.key)
  const dependencyHashes = normalizeHashes(value.dependencyHashes, 'lookup.dependencyHashes')
  if (!sameStrings(dependencyHashes, key.dependencyHashes)) throw new TypeError('lookup dependency hashes do not match key')
  if (!Array.isArray(value.blockIds)) throw new TypeError('lookup.blockIds must be an array')
  const blockIds = value.blockIds.map((blockId, index) => {
    if (!blockIdIsValid(blockId as string)) throw new TypeError(`lookup.blockIds[${index}] must be a block id`)
    return blockId as string
  })
  if (new Set(blockIds).size !== blockIds.length) throw new TypeError('lookup.blockIds must not contain duplicates')
  return {
    schemaVersion: 1,
    key,
    blockIds,
    dependencyHashes,
    lastAccessAt: requiredInteger(value.lastAccessAt, 'lookup.lastAccessAt'),
  }
}

function normalizeJsonValue(value: unknown, path: string): { readonly serialized: string; readonly value: unknown } {
  try {
    const serialized = canonicalJson(value)
    return { serialized, value: JSON.parse(serialized) as unknown }
  } catch {
    throw new TypeError(`${path} must be a JSON value`)
  }
}

function parseStoredToolResult(value: unknown): StoredToolResultV1 {
  if (!isRecord(value)) throw new TypeError('tool result must be an object')
  exactKeys(value, ['schemaVersion', 'entryType', 'key', 'boundary', 'value', 'createdAt', 'lastAccessAt'], 'toolResult')
  if (value.schemaVersion !== 1) throw new TypeError('toolResult.schemaVersion must be 1')
  if (value.entryType !== 'tool-result') throw new TypeError('toolResult.entryType must be tool-result')
  return {
    schemaVersion: 1,
    entryType: 'tool-result',
    key: requiredString(value.key, 'toolResult.key'),
    boundary: normalizeBoundary(value.boundary),
    value: normalizeJsonValue(value.value, 'toolResult.value').value,
    createdAt: requiredInteger(value.createdAt, 'toolResult.createdAt'),
    lastAccessAt: requiredInteger(value.lastAccessAt, 'toolResult.lastAccessAt'),
  }
}

function lookupId(key: CacheLookupKeyV1): string {
  return sha256Utf8(canonicalJson({ schemaVersion: 1, ...key }))
}

function lookupName(key: CacheLookupKeyV1): string {
  return `${hashFileStem(lookupId(key))}.json`
}

function boundaryId(boundary: CacheBoundaryV1): string {
  return sha256Utf8(canonicalJson(boundary))
}

function hashFileStem(hash: string): string {
  return hash.slice('sha256:'.length)
}

function toolResultName(key: string, boundary: CacheBoundaryV1): string {
  const id = sha256Utf8(canonicalJson({ schemaVersion: 1, key, boundary }))
  return `tool-result.${hashFileStem(id)}.json`
}

function isToolResultName(name: string): boolean {
  return name.startsWith('tool-result.')
}

function directEntryName(blockId: string): string {
  return `block.${hashFileStem(blockId)}.json`
}

function variantEntryName(blockId: string, boundary: CacheBoundaryV1): string {
  return `block.${hashFileStem(blockId)}.${hashFileStem(boundaryId(boundary))}.json`
}

function unionDependencies(entries: readonly StoredEntryV1[]): readonly string[] {
  return [...new Set(entries.flatMap(entry => entry.dependencyHashes))].sort()
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

export class ContextCacheStore implements ContextCacheStoreApiV1 {
  private readonly paths: CachePaths
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly lockTimeoutMs: number
  private closed = false
  private logicalClock = 0

  private constructor(paths: CachePaths, config: Required<Pick<ContextCacheConfigV1, 'maxEntries' | 'maxBytes' | 'lockTimeoutMs'>>) {
    this.paths = paths
    this.maxEntries = config.maxEntries
    this.maxBytes = config.maxBytes
    this.lockTimeoutMs = config.lockTimeoutMs
  }

  static async open(config: ContextCacheConfigV1): Promise<ContextCacheStore> {
    if (!isRecord(config)) throw new TypeError('config must be an object')
    const deploymentRoot = requiredString(config.deploymentRoot, 'config.deploymentRoot')
    const canonicalDeploymentRoot = await realpath(deploymentRoot)
    if (!(await stat(canonicalDeploymentRoot)).isDirectory()) throw new TypeError('config.deploymentRoot must be a directory')
    const maxEntries = config.maxEntries ?? MAX_ENTRIES
    const maxBytes = config.maxBytes ?? MAX_BYTES
    const lockTimeoutMs = config.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) throw new TypeError(`config.maxEntries must be between 1 and ${MAX_ENTRIES}`)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new TypeError(`config.maxBytes must be between 1 and ${MAX_BYTES}`)
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0) throw new TypeError('config.lockTimeoutMs must be a non-negative safe integer')
    const paths = await cachePaths(canonicalDeploymentRoot)
    const store = new ContextCacheStore(paths, { maxEntries, maxBytes, lockTimeoutMs })
    await store.withLock(async () => {
      await store.maintainLocked()
    })
    return store
  }

  async getBlock(blockId: string, boundary: CacheBoundaryV1): Promise<ContextBlockV1 | undefined> {
    if (this.closed || !blockIdIsValid(blockId)) return undefined
    const normalizedBoundary = normalizeBoundary(boundary)
    return (await this.withLock(async () => {
      const entry = await this.findEntryLocked(blockId, normalizedBoundary)
      if (entry === undefined) return undefined
      const { __fileName: name, ...storedEntry } = entry
      const touched: StoredEntryV1 = { ...storedEntry, lastAccessAt: this.nextTimestampAfter(storedEntry.lastAccessAt) }
      await this.writeJsonAtomic(this.paths.entries, name, touched)
      return touched.block
    })) as ContextBlockV1 | undefined
  }

  async putBlock(block: ContextBlockV1, boundary: CacheBoundaryV1): Promise<void> {
    if (this.closed) return
    const parsedBlock = parseContextBlockV1(block)
    const normalizedBoundary = normalizeBoundary(boundary)
    assertBlockBoundary(parsedBlock, normalizedBoundary)
    const dependencyHashes = dependencyHashesForBlock(parsedBlock)
    await this.withLock(async () => {
      const existing = await this.findEntryLocked(parsedBlock.blockId, normalizedBoundary)
      if (existing !== undefined) return
      const directName = directEntryName(parsedBlock.blockId)
      const direct = await this.readEntryLocked(directName)
      const name = direct === undefined ? directName : variantEntryName(parsedBlock.blockId, normalizedBoundary)
      const now = this.nextTimestamp()
      const entry: StoredEntryV1 = {
        schemaVersion: 1,
        block: parsedBlock,
        boundary: normalizedBoundary,
        dependencyHashes,
        createdAt: now,
        lastAccessAt: now,
      }
      await this.writeJsonAtomic(this.paths.entries, name, entry)
      await this.maintainLocked()
    })
  }

  async getToolResult(key: string, boundary: CacheBoundaryV1): Promise<unknown | undefined> {
    if (this.closed) return undefined
    const normalizedKey = requiredString(key, 'key')
    const normalizedBoundary = normalizeBoundary(boundary)
    return this.withLock(async () => {
      const name = toolResultName(normalizedKey, normalizedBoundary)
      const result = await this.readToolResultLocked(name)
      if (result === undefined || result.key !== normalizedKey || !sameBoundary(result.boundary, normalizedBoundary)) return undefined
      const touched: StoredToolResultV1 = { ...result, lastAccessAt: this.nextTimestampAfter(result.lastAccessAt) }
      await this.writeJsonAtomic(this.paths.entries, name, touched)
      return touched.value
    })
  }

  async putToolResult(key: string, boundary: CacheBoundaryV1, value: unknown, maxBytes: number): Promise<void> {
    if (this.closed) return
    const normalizedKey = requiredString(key, 'key')
    const normalizedBoundary = normalizeBoundary(boundary)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) {
      throw new TypeError(`maxBytes must be between 1 and ${MAX_BYTES}`)
    }
    const normalizedValue = normalizeJsonValue(value, 'value')
    if (new TextEncoder().encode(normalizedValue.serialized).byteLength > maxBytes) {
      throw new TypeError(`value exceeds ${maxBytes} UTF-8 bytes`)
    }
    await this.withLock(async () => {
      const name = toolResultName(normalizedKey, normalizedBoundary)
      if (await this.readToolResultLocked(name) !== undefined) return
      const now = this.nextTimestamp()
      const result: StoredToolResultV1 = {
        schemaVersion: 1,
        entryType: 'tool-result',
        key: normalizedKey,
        boundary: normalizedBoundary,
        value: normalizedValue.value,
        createdAt: now,
        lastAccessAt: now,
      }
      await this.writeJsonAtomic(this.paths.entries, name, result)
      await this.maintainLocked()
    })
  }

  async getLookup(key: CacheLookupKeyV1): Promise<readonly string[] | undefined> {
    if (this.closed) return undefined
    const normalizedKey = normalizeLookupKey(key)
    return (await this.withLock(async () => {
      const name = lookupName(normalizedKey)
      const lookup = await this.readLookupLocked(name)
      if (lookup === undefined || !sameLookupKey(lookup.key, normalizedKey)) return undefined
      const entries: StoredEntryV1[] = []
      for (const blockId of lookup.blockIds) {
        const entry = await this.findEntryLocked(blockId, normalizedKey)
        if (entry === undefined) return undefined
        entries.push(entry)
      }
      if (!sameStrings(unionDependencies(entries), normalizedKey.dependencyHashes)) return undefined
      const touched = { ...lookup, lastAccessAt: this.nextTimestampAfter(lookup.lastAccessAt) }
      await this.writeJsonAtomic(this.paths.lookups, name, touched)
      return Object.freeze([...touched.blockIds])
    })) as readonly string[] | undefined
  }

  async putLookup(key: CacheLookupKeyV1, blockIds: readonly string[]): Promise<void> {
    if (this.closed) return
    const normalizedKey = normalizeLookupKey(key)
    if (!Array.isArray(blockIds)) throw new TypeError('blockIds must be an array')
    const normalizedBlockIds = blockIds.map((blockId, index) => {
      if (!blockIdIsValid(blockId)) throw new TypeError(`blockIds[${index}] must be a block id`)
      return blockId
    })
    if (new Set(normalizedBlockIds).size !== normalizedBlockIds.length) throw new TypeError('blockIds must not contain duplicates')
    await this.withLock(async () => {
      const entries: StoredEntryV1[] = []
      for (const blockId of normalizedBlockIds) {
        const entry = await this.findEntryLocked(blockId, normalizedKey)
        if (entry === undefined) return
        entries.push(entry)
      }
      if (!sameStrings(unionDependencies(entries), normalizedKey.dependencyHashes)) return
      const now = this.nextTimestamp()
      const lookup: StoredLookupV1 = {
        schemaVersion: 1,
        key: normalizedKey,
        blockIds: normalizedBlockIds,
        dependencyHashes: normalizedKey.dependencyHashes,
        lastAccessAt: now,
      }
      await this.writeJsonAtomic(this.paths.lookups, lookupName(normalizedKey), lookup)
    })
  }

  async invalidateBySourceHashes(hashes: readonly string[]): Promise<void> {
    if (this.closed) return
    const normalizedHashes = normalizeHashes(hashes, 'hashes')
    if (normalizedHashes.length === 0) return
    await this.withLock(async () => {
      const affectedBlockIds = new Set<string>()
      for (const entryFile of await this.readAllEntriesLocked()) {
        if (!normalizedHashes.some(hash => entryFile.record.dependencyHashes.includes(hash))) continue
        affectedBlockIds.add(entryFile.record.block.blockId)
        await unlink(join(this.paths.entries, entryFile.name)).catch(error => { if (!isMissing(error)) throw error })
      }

      for (const name of await this.jsonFiles(this.paths.lookups)) {
        const lookup = await this.readLookupLocked(name)
        if (lookup === undefined) continue
        const retained = lookup.blockIds.filter(blockId => !affectedBlockIds.has(blockId))
        if (retained.length === lookup.blockIds.length) continue
        if (retained.length === 0) {
          await unlink(join(this.paths.lookups, name)).catch(error => { if (!isMissing(error)) throw error })
          continue
        }
        const retainedEntries: StoredEntryV1[] = []
        for (const blockId of retained) {
          const entry = await this.findEntryLocked(blockId, lookup.key)
          if (entry !== undefined) retainedEntries.push(entry)
        }
        if (!sameStrings(unionDependencies(retainedEntries), lookup.dependencyHashes)) {
          await unlink(join(this.paths.lookups, name)).catch(error => { if (!isMissing(error)) throw error })
          continue
        }
        await this.writeJsonAtomic(this.paths.lookups, name, { ...lookup, blockIds: retained })
      }
      await this.maintainLocked()
    })
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private nextTimestamp(): number {
    this.logicalClock = Math.max(Date.now(), this.logicalClock + 1)
    return this.logicalClock
  }

  private nextTimestampAfter(previous: number): number {
    this.logicalClock = Math.max(this.logicalClock, previous)
    return this.nextTimestamp()
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.closed) return undefined
    const deadline = Date.now() + this.lockTimeoutMs
    let handle: FileHandle | undefined
    while (handle === undefined) {
      try {
        handle = await open(this.paths.lock, 'wx', 0o600)
      } catch (error) {
        if (!isRecord(error) || error.code !== 'EEXIST') throw error
        const remaining = deadline - Date.now()
        if (remaining <= 0) return undefined
        await delay(Math.min(10, remaining))
      }
    }
    try {
      if (this.closed) return undefined
      return await operation()
    } finally {
      await handle.close().catch(() => undefined)
      await unlink(this.paths.lock).catch(error => { if (!isMissing(error)) throw error })
    }
  }

  private async writeJsonAtomic(directory: string, name: string, value: unknown): Promise<void> {
    const target = join(directory, name)
    const temporary = join(directory, `.${name}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, canonicalJson(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, target)
    } finally {
      await unlink(temporary).catch(error => { if (!isMissing(error)) throw error })
    }
  }

  private async jsonFiles(directory: string): Promise<string[]> {
    const children = await readdir(directory, { withFileTypes: true })
    return children.filter((child: Dirent) => child.isFile() && child.name.endsWith('.json')).map(child => child.name)
  }

  private async readEntryLocked(name: string): Promise<StoredEntryV1 | undefined> {
    const path = join(this.paths.entries, name)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return undefined
      await this.quarantineLocked(path)
      return undefined
    }
    try {
      const record = parseStoredEntry(JSON.parse(raw))
      return Object.assign(record, { __fileName: name }) as StoredEntryV1 & { __fileName: string }
    } catch {
      await this.quarantineLocked(path)
      return undefined
    }
  }

  private async readLookupLocked(name: string): Promise<StoredLookupV1 | undefined> {
    const path = join(this.paths.lookups, name)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return undefined
      await this.quarantineLocked(path)
      return undefined
    }
    try {
      return parseStoredLookup(JSON.parse(raw))
    } catch {
      await this.quarantineLocked(path)
      return undefined
    }
  }

  private async readToolResultLocked(name: string): Promise<StoredToolResultV1 | undefined> {
    const path = join(this.paths.entries, name)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return undefined
      await this.quarantineLocked(path)
      return undefined
    }
    try {
      return parseStoredToolResult(JSON.parse(raw))
    } catch {
      await this.quarantineLocked(path)
      return undefined
    }
  }

  private async findEntryLocked(blockId: string, boundary: CacheBoundaryV1): Promise<(StoredEntryV1 & { __fileName: string }) | undefined> {
    const names = [directEntryName(blockId), variantEntryName(blockId, boundary)]
    for (const name of names) {
      const entry = await this.readEntryLocked(name) as (StoredEntryV1 & { __fileName: string }) | undefined
      if (entry === undefined) continue
      if (entry.block.blockId !== blockId) {
        await this.quarantineLocked(join(this.paths.entries, name))
        continue
      }
      if (sameBoundary(entry.boundary, boundary)) return entry
    }
    return undefined
  }

  private async readAllEntriesLocked(): Promise<BlockEntryFile[]> {
    const files: BlockEntryFile[] = []
    for (const name of await this.jsonFiles(this.paths.entries)) {
      if (isToolResultName(name)) continue
      const record = await this.readEntryLocked(name)
      if (record === undefined) continue
      const bytes = (await stat(join(this.paths.entries, name))).size
      this.logicalClock = Math.max(this.logicalClock, record.lastAccessAt)
      files.push({ name, record, bytes })
    }
    return files
  }

  private async readAllCacheEntriesLocked(): Promise<EntryFile[]> {
    const files: EntryFile[] = []
    for (const name of await this.jsonFiles(this.paths.entries)) {
      const record = isToolResultName(name)
        ? await this.readToolResultLocked(name)
        : await this.readEntryLocked(name)
      if (record === undefined) continue
      const bytes = (await stat(join(this.paths.entries, name))).size
      this.logicalClock = Math.max(this.logicalClock, record.lastAccessAt)
      files.push({ name, record, bytes })
    }
    return files
  }

  private async scanLookupsLocked(): Promise<void> {
    for (const name of await this.jsonFiles(this.paths.lookups)) await this.readLookupLocked(name)
  }

  private async maintainLocked(): Promise<void> {
    await this.scanLookupsLocked()
    await this.scanAndMaintainEntriesLocked()
    await this.trimQuarantineLocked()
  }

  private async scanAndMaintainEntriesLocked(): Promise<void> {
    let files = await this.readAllCacheEntriesLocked()
    let totalBytes = files.reduce((total, file) => total + file.bytes, 0)
    const needsEviction = () => files.length > this.maxEntries || totalBytes > this.maxBytes
    if (!needsEviction()) return
    files = [...files].sort((left, right) => left.record.lastAccessAt - right.record.lastAccessAt || left.name.localeCompare(right.name))
    while (needsEviction() && files.length > 0) {
      const oldest = files.shift() as EntryFile
      await unlink(join(this.paths.entries, oldest.name)).catch(error => { if (!isMissing(error)) throw error })
      totalBytes -= oldest.bytes
    }
  }

  private async quarantineLocked(path: string): Promise<void> {
    try {
      const destination = join(this.paths.quarantine, `${Date.now()}-${randomUUID()}-${basename(path)}`)
      await rename(path, destination)
    } catch (error) {
      if (!isMissing(error)) return
    }
    await this.trimQuarantineLocked()
  }

  private async trimQuarantineLocked(): Promise<void> {
    const children = await readdir(this.paths.quarantine, { withFileTypes: true })
    const files: { name: string; bytes: number; modified: number }[] = []
    for (const child of children) {
      if (!child.isFile()) continue
      try {
        const details = await stat(join(this.paths.quarantine, child.name))
        files.push({ name: child.name, bytes: details.size, modified: details.mtimeMs })
      } catch {
        // A concurrent cleanup can remove a quarantine file between readdir and stat.
      }
    }
    files.sort((left, right) => left.modified - right.modified || left.name.localeCompare(right.name))
    let totalBytes = files.reduce((total, file) => total + file.bytes, 0)
    while (files.length > MAX_QUARANTINE_FILES || totalBytes > MAX_QUARANTINE_BYTES) {
      const oldest = files.shift()
      if (oldest === undefined) break
      await rm(join(this.paths.quarantine, oldest.name), { force: true })
      totalBytes -= oldest.bytes
    }
  }
}
