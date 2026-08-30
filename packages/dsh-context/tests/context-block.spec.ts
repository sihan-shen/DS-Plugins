import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  createContextBlockV1,
  parseContextBlockV1,
  sha256Utf8,
  truncateUtf8ByBytes,
} from '../src/index.ts'
import type { ContextBlockInputV1 } from '../src/types.ts'

const workspaceRoot = process.cwd()
const sourceHashA = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const sourceHashB = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const input: ContextBlockInputV1 = {
  schemaVersion: 1,
  kind: 'source-window',
  workspaceRoot,
  workspaceFingerprint: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  snapshotId: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  adapterId: 'typescript-ast-fallback',
  adapterVersion: '1.0.0',
  compilerPolicyVersion: 'v0.2c',
  sources: [
    { path: 'packages/dsh-context/src/types.ts', contentHash: sourceHashA },
    { path: 'packages/dsh-context/src/canonical.ts', contentHash: sourceHashB },
  ],
  text: 'α🙂z',
  truncated: false,
}

describe('ContextBlockV1 construction', () => {
  it('derives identity and content metadata, freezes copies, preserves order, and round-trips as JSON', () => {
    const block = createContextBlockV1(input)
    const identity = {
      schemaVersion: 1,
      kind: input.kind,
      workspaceFingerprint: input.workspaceFingerprint,
      snapshotId: input.snapshotId,
      adapterId: input.adapterId,
      adapterVersion: input.adapterVersion,
      compilerPolicyVersion: input.compilerPolicyVersion,
      sources: input.sources,
      text: input.text,
    }

    expect(block.contentHash).toBe(sha256Utf8(input.text))
    expect(block.byteLength).toBe(7)
    expect(block.blockId).toBe(sha256Utf8(canonicalJson(identity)))
    expect(block.sources.map(source => source.path)).toEqual([
      'packages/dsh-context/src/types.ts',
      'packages/dsh-context/src/canonical.ts',
    ])
    expect(Object.isFrozen(block)).toBe(true)
    expect(Object.isFrozen(block.sources)).toBe(true)
    expect(Object.isFrozen(block.sources[0])).toBe(true)
    expect(JSON.parse(JSON.stringify(block))).toEqual(block)
  })

  it('rejects forged and structurally invalid blocks', () => {
    const block = createContextBlockV1(input)
    const cases: readonly [string, unknown][] = [
      ['unknown keys', { ...block, extra: true }],
      ['content hash', { ...block, contentHash: sha256Utf8('forged') }],
      ['byte length', { ...block, byteLength: block.byteLength + 1 }],
      ['block id', { ...block, blockId: sha256Utf8('forged') }],
      ['duplicate paths', { ...block, sources: [block.sources[0], block.sources[0]] }],
      ['unsafe path', { ...block, sources: [{ ...block.sources[0], path: '../secret' }, block.sources[1]] }],
      ['unsupported schema', { ...block, schemaVersion: 2 }],
      ['unsupported kind', { ...block, kind: 'other' }],
      ['oversized text', { ...block, text: 'x'.repeat(65_537) }],
    ]

    for (const [name, value] of cases) expect(() => parseContextBlockV1(value), name).toThrow()
  })

  it('truncates at UTF-8 code-point boundaries and records truncation', () => {
    const text = truncateUtf8ByBytes('α🙂z', 5)
    expect(text).toBe('α')
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(5)
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(text))).not.toThrow()

    const block = createContextBlockV1({ ...input, text, truncated: true })
    expect(block.text).toBe('α')
    expect(block.truncated).toBe(true)
    expect(block.byteLength).toBe(2)
  })
})
