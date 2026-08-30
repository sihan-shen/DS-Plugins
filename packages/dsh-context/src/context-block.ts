import { canonicalJson, sha256Utf8 } from './canonical.js'
import { assertSafeRepoPath } from './safe-paths.js'
import type { ContextBlockInputV1, ContextBlockV1 } from './types.js'

export const MAX_CONTEXT_BLOCK_BYTES = 65_536
export const MAX_CONTEXT_SESSION_BYTES = 262_144

type ContextSourceV1 = ContextBlockV1['sources'][number]
type NormalizedContextBlockInputV1 = Omit<ContextBlockInputV1, 'workspaceRoot'> & { readonly sources: readonly ContextSourceV1[] }

const sourceHashPattern = /^sha256:[0-9a-f]{64}$/

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`)
}

function assertInputKeys(value: Record<string, unknown>): void {
  const allowed = new Set([
    'schemaVersion', 'workspaceRoot', 'kind', 'workspaceFingerprint', 'snapshotId',
    'adapterId', 'adapterVersion', 'compilerPolicyVersion', 'sources', 'text', 'truncated',
  ])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`input.${key} is not allowed`)
}

function normalizedSources(input: ContextBlockInputV1): readonly ContextSourceV1[] {
  if (!Array.isArray(input.sources)) throw new TypeError('input.sources must be an array')
  const seen = new Set<string>()
  return input.sources.map((source, index) => {
    if (typeof source !== 'object' || source === null || Array.isArray(source)) throw new TypeError(`input.sources[${index}] must be an object`)
    const object = source as Record<string, unknown>
    if (Object.keys(object).some(key => key !== 'path' && key !== 'contentHash')) throw new TypeError(`input.sources[${index}] has an unknown key`)
    assertNonEmptyString(object.path, `input.sources[${index}].path`)
    assertNonEmptyString(object.contentHash, `input.sources[${index}].contentHash`)
    if (!sourceHashPattern.test(object.contentHash)) throw new TypeError(`input.sources[${index}].contentHash must be a sha256 hash`)
    const path = assertSafeRepoPath(input.workspaceRoot, object.path)
    if (seen.has(path)) throw new TypeError(`input.sources must not contain duplicate path ${path}`)
    seen.add(path)
    return { path, contentHash: object.contentHash }
  })
}

function normalizedInput(input: ContextBlockInputV1): NormalizedContextBlockInputV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('input must be an object')
  assertInputKeys(input as unknown as Record<string, unknown>)
  if (input.schemaVersion !== 1) throw new TypeError('input.schemaVersion must be 1')
  assertNonEmptyString(input.workspaceRoot, 'input.workspaceRoot')
  if (input.kind !== 'repo-map' && input.kind !== 'symbol' && input.kind !== 'source-window' && input.kind !== 'tool-result') throw new TypeError('input.kind is invalid')
  for (const name of ['workspaceFingerprint', 'snapshotId', 'adapterId', 'adapterVersion', 'compilerPolicyVersion'] as const) assertNonEmptyString(input[name], `input.${name}`)
  if (typeof input.text !== 'string') throw new TypeError('input.text must be a string')
  if (new TextEncoder().encode(input.text).byteLength > MAX_CONTEXT_BLOCK_BYTES) throw new TypeError(`input.text exceeds ${MAX_CONTEXT_BLOCK_BYTES} UTF-8 bytes`)
  if (typeof input.truncated !== 'boolean') throw new TypeError('input.truncated must be a boolean')
  return {
    schemaVersion: 1,
    kind: input.kind,
    workspaceFingerprint: input.workspaceFingerprint,
    snapshotId: input.snapshotId,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    compilerPolicyVersion: input.compilerPolicyVersion,
    sources: normalizedSources(input),
    text: input.text,
    truncated: input.truncated,
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export function buildContextBlockFromNormalizedInput(input: NormalizedContextBlockInputV1): ContextBlockV1 {
  const sources = input.sources.map(source => ({ path: source.path, contentHash: source.contentHash }))
  const identity = {
    schemaVersion: 1 as const,
    kind: input.kind,
    workspaceFingerprint: input.workspaceFingerprint,
    snapshotId: input.snapshotId,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    compilerPolicyVersion: input.compilerPolicyVersion,
    sources,
    text: input.text,
  }
  return deepFreeze({
    ...identity,
    blockId: sha256Utf8(canonicalJson(identity)),
    contentHash: sha256Utf8(input.text),
    byteLength: new TextEncoder().encode(input.text).byteLength,
    truncated: input.truncated,
  })
}

export function createContextBlockV1(input: ContextBlockInputV1): ContextBlockV1 {
  return buildContextBlockFromNormalizedInput(normalizedInput(input))
}

export function truncateUtf8ByBytes(text: string, maxBytes: number): string {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative safe integer')
  const encoder = new TextEncoder()
  let byteLength = 0
  let result = ''
  for (const codePoint of text) {
    const codePointBytes = encoder.encode(codePoint).byteLength
    if (byteLength + codePointBytes > maxBytes) break
    result += codePoint
    byteLength += codePointBytes
  }
  return result
}
