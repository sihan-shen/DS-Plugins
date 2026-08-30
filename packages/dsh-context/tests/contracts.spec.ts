import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  parseContextBlockV1,
  parseEvaluationRecordV1,
  parseEvaluationTaskV1,
  parseFixtureVerifierV1,
  parsePromotionReportV1,
  parseRepoMapPageV1,
  parseRepositorySnapshotV1,
  parseSymbolQueryResultV1,
  sha256Utf8,
} from '../src/index.ts'
import type { SymbolQueryResultV1 } from '../src/types.ts'

const symbolMatch = {
  symbolId: 'sha256:symbol',
  path: 'src/a.ts',
  sourceHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  start: { line: 1, column: 0 },
  end: { line: 3, column: 1 },
  kind: 'function',
  name: 'main',
  score: 1,
} as const

const validSnapshot = {
  schemaVersion: 1,
  snapshotId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  workspaceFingerprint: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  revision: 'rev-1',
  files: [{ path: 'src/a.ts', contentHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', byteLength: 10, language: 'typescript' }],
} as const

const validRepoMapPage = {
  schemaVersion: 1,
  snapshotId: 'snap-1',
  items: [{ path: 'src/a.ts', summary: 'function main', sourceHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' }],
  totalItems: 1,
  truncated: false,
} as const

const validContextBlock = {
  schemaVersion: 1,
  blockId: 'block-1',
  kind: 'repo-map',
  workspaceFingerprint: 'sha256:workspace',
  snapshotId: 'snap-1',
  adapterId: 'typescript',
  adapterVersion: '1.0.0',
  compilerPolicyVersion: 'policy-1',
  sources: [{ path: 'src/a.ts', contentHash: 'sha256:file' }],
  contentHash: 'sha256:content',
  text: 'function main() {}',
  byteLength: 19,
  truncated: false,
} as const

const validVerifier = {
  id: 'fixture-integrity-v1',
  expected_revision: 'rev-1',
  required_paths: ['src/a.ts'],
} as const

const validTask = {
  task_id: 'task-1',
  repository_shape: 'ts-small',
  revision: 'rev-1',
  query: 'main',
  target_symbols: [{ path: 'src/a.ts', name: 'main' }],
  baseline_paths: ['src/a.ts'],
  byte_limit: 1024,
  verifier: validVerifier,
} as const

const validRecord = {
  schema_version: 1,
  run_mode: 'baseline',
  task_id: 'task-1',
  cache_condition: 'none',
  run_index: 1,
  tokenizer_name: '@dqbd/tiktoken',
  tokenizer_encoding: 'cl100k_base',
  tokenizer_version: '1.0.22',
  source_token_estimate: 100,
  uncached_source_tokens: 100,
  context_blocks_requested: 1,
  cache_hits: 0,
  cache_misses: 0,
  symbol_query_precision: 1,
  symbol_query_recall_at_5: 1,
  symbol_query_mrr: 1,
  target_coverage: 1,
  oracle_success: true,
  verification_status: 'passed',
  duration_ms: 10,
} as const

const validAggregate = {
  median_source_token_reduction: 0.5,
  uncached_tokens_per_success: 100,
  mean_symbol_query_recall_at_5: 1,
  mean_target_coverage: 1,
  mean_oracle_success: 1,
} as const

const validPromotion = {
  schema_version: 1,
  corpus_id: 'corpus-1',
  task_count: 12,
  repository_shape_count: 3,
  thresholds: {
    min_median_source_token_reduction: 0.25,
    min_mean_symbol_query_recall_at_5: 0.95,
    min_mean_target_coverage: 0.95,
    min_mean_oracle_success: 0.95,
  },
  aggregates: { cold: validAggregate, warm: validAggregate },
  passes: true,
  status: 'passed',
} as const

describe('v0.2a context contracts', () => {
  it('keeps the public result JSON-shaped and canonicalizes JSON objects', () => {
    const result: SymbolQueryResultV1 = {
      schemaVersion: 1,
      snapshotId: 'snap-1',
      matches: [symbolMatch],
      totalMatches: 1,
      truncated: false,
    }
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(sha256Utf8('hello')).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('parses valid contract values', () => {
    expect(parseRepositorySnapshotV1(validSnapshot)).toEqual(validSnapshot)
    expect(parseRepoMapPageV1(validRepoMapPage)).toEqual(validRepoMapPage)
    expect(parseSymbolQueryResultV1({
      schemaVersion: 1,
      snapshotId: 'snap-1',
      matches: [symbolMatch],
      totalMatches: 1,
      truncated: false,
    })).toMatchObject({ totalMatches: 1 })
    expect(parseContextBlockV1(validContextBlock)).toEqual(validContextBlock)
    expect(parseFixtureVerifierV1(validVerifier)).toEqual(validVerifier)
    expect(parseEvaluationTaskV1(validTask)).toEqual(validTask)
    expect(parseEvaluationRecordV1(validRecord)).toEqual(validRecord)
    expect(parsePromotionReportV1(validPromotion)).toEqual(validPromotion)
  })

  it('requires verifier paths to cover every target and baseline path', () => {
    const targetOnly = {
      ...validTask,
      target_symbols: [{ path: 'src/support.ts', name: 'support' }],
      baseline_paths: ['src/support.ts'],
      verifier: { ...validTask.verifier, required_paths: ['src/a.ts'] },
    }
    expect(() => parseEvaluationTaskV1(targetOnly)).toThrow(/required_paths.*src\/support\.ts/i)
    const baselineOnly = {
      ...validTask,
      baseline_paths: ['src/a.ts', 'src/support.ts'],
      verifier: { ...validTask.verifier, required_paths: ['src/a.ts'] },
    }
    expect(() => parseEvaluationTaskV1(baselineOnly)).toThrow(/required_paths.*src\/support\.ts/i)
    expect(parseEvaluationTaskV1({
      ...baselineOnly,
      verifier: { ...baselineOnly.verifier, required_paths: ['src/a.ts', 'src/support.ts'] },
    })).toMatchObject({ baseline_paths: ['src/a.ts', 'src/support.ts'] })
  })

  it('rejects missing schema versions and unknown keys', () => {
    expect(() => parseRepositorySnapshotV1({ ...validSnapshot, schemaVersion: undefined })).toThrow()
    expect(() => parseRepoMapPageV1({ ...validRepoMapPage, extra: true })).toThrow()
    expect(() => parseContextBlockV1({ ...validContextBlock, schemaVersion: 2 })).toThrow()
    expect(() => parseEvaluationRecordV1({ ...validRecord, schema_version: undefined })).toThrow()
    expect(() => parseContextBlockV1({ ...validContextBlock, sourcePaths: ['src/a.ts'], sourceHashes: ['sha256:file'] })).toThrow()
  })

  it('rejects unsafe paths and malformed bounded page metadata', () => {
    expect(() => parseRepositorySnapshotV1({ ...validSnapshot, files: [{ ...validSnapshot.files[0], path: '/etc/passwd' }] })).toThrow()
    expect(() => parseRepositorySnapshotV1({ ...validSnapshot, files: [{ ...validSnapshot.files[0], path: 'src\\a.ts' }] })).toThrow()
    expect(() => parseRepositorySnapshotV1({ ...validSnapshot, files: [{ ...validSnapshot.files[0], path: 'src/./a.ts' }] })).toThrow()
    expect(() => parseRepoMapPageV1({ ...validRepoMapPage, items: [{ ...validRepoMapPage.items[0], path: '../secret' }] })).toThrow()
    expect(() => parseRepoMapPageV1({ ...validRepoMapPage, items: [{ ...validRepoMapPage.items[0], path: 'src/./a.ts' }] })).toThrow()
    expect(() => parseRepoMapPageV1({ ...validRepoMapPage, truncated: true })).toThrow()
    expect(() => parseRepoMapPageV1({ ...validRepoMapPage, nextCursor: '' })).toThrow()
    expect(() => parseRepoMapPageV1({ ...validRepoMapPage, totalItems: 0 })).toThrow()
    expect(() => parseRepositorySnapshotV1({ ...validSnapshot, snapshotId: 'sha256:not-a-hash' })).toThrow()
    expect(() => parseRepositorySnapshotV1({ ...validSnapshot, workspaceFingerprint: 'sha256:not-a-hash' })).toThrow()
    expect(() => parseRepositorySnapshotV1({ ...validSnapshot, files: [{ ...validSnapshot.files[0], contentHash: 'sha256:not-a-hash' }] })).toThrow()
    expect(() => parseRepositorySnapshotV1({ ...validSnapshot, files: Array.from({ length: 10_001 }, (_, index) => ({ ...validSnapshot.files[0], path: `src/${index}.ts` })) })).toThrow()
    expect(() => parseRepositorySnapshotV1({ ...validSnapshot, files: [{ ...validSnapshot.files[0], byteLength: 1_048_577 }] })).toThrow()
  })

  it('requires model-visible result bounds and validates cursor relationships', () => {
    expect(() => parseSymbolQueryResultV1({
      schemaVersion: 1,
      snapshotId: 'snap-1',
      matches: [],
    })).toThrow()
    expect(() => parseSymbolQueryResultV1({
      schemaVersion: 1,
      snapshotId: 'snap-1',
      matches: [],
      totalMatches: 0,
      truncated: true,
    })).toThrow()
    expect(() => parseSymbolQueryResultV1({
      schemaVersion: 1,
      snapshotId: 'snap-1',
      matches: [symbolMatch],
      totalMatches: 1,
      truncated: false,
      nextCursor: 'cursor',
    })).toThrow()
  })

  it('rejects verifier, task, and context-source violations', () => {
    expect(() => parseFixtureVerifierV1({ ...validVerifier, id: 'other' })).toThrow()
    expect(() => parseFixtureVerifierV1({ ...validVerifier, required_paths: ['src/a.ts', 'src/a.ts'] })).toThrow()
    expect(() => parseEvaluationTaskV1({ ...validTask, target_symbols: [] })).toThrow()
    expect(() => parseEvaluationTaskV1({ ...validTask, target_symbols: [{ path: 'src/a.ts', name: 'main' }, { path: 'src/a.ts', name: 'other' }] })).toThrow()
    expect(() => parseEvaluationTaskV1({ ...validTask, baseline_paths: [] })).toThrow()
    expect(() => parseEvaluationTaskV1({ ...validTask, verifier: { ...validVerifier, expected_revision: 'rev-2' } })).toThrow()
    expect(() => parseContextBlockV1({ ...validContextBlock, sources: [{ path: 'src/a.ts', contentHash: 'x', extra: true }] })).toThrow()
  })

  it('rejects all invalid evaluation pairings and invalid numeric bounds', () => {
    for (const run_mode of ['baseline', 'optimized'] as const) {
      for (const cache_condition of ['none', 'cold', 'warm'] as const) {
        if ((run_mode === 'baseline' && cache_condition === 'none') || (run_mode === 'optimized' && cache_condition !== 'none')) continue
        expect(() => parseEvaluationRecordV1({ ...validRecord, run_mode, cache_condition })).toThrow()
      }
    }
    expect(() => parseEvaluationRecordV1({ ...validRecord, run_index: 4 })).toThrow()
    expect(() => parseEvaluationRecordV1({ ...validRecord, symbol_query_mrr: 1.1 })).toThrow()
    expect(() => parseEvaluationRecordV1({ ...validRecord, source_token_estimate: -1 })).toThrow()
    expect(() => parseEvaluationRecordV1({ ...validRecord, oracle_success: true, verification_status: 'failed' })).toThrow()
    expect(() => parseEvaluationRecordV1({ ...validRecord, oracle_success: true, verification_status: 'not-run' })).toThrow()
  })

  it('rejects invalid promotion status and failure combinations', () => {
    expect(() => parsePromotionReportV1({ ...validPromotion, task_count: 0 })).toThrow()
    expect(() => parsePromotionReportV1({
      ...validPromotion,
      aggregates: {
        cold: { ...validAggregate, mean_oracle_success: 0 },
        warm: validAggregate,
      },
    })).toThrow()
    expect(() => parsePromotionReportV1({ ...validPromotion, status: 'failed', passes: true })).toThrow()
    expect(() => parsePromotionReportV1({ ...validPromotion, status: 'not-ready', passes: true })).toThrow()
    expect(() => parsePromotionReportV1({ ...validPromotion, status: 'failed', passes: false })).toThrow()
    expect(() => parsePromotionReportV1({ ...validPromotion, status: 'not-ready', passes: false, failure_class: 'threshold_failed' })).toThrow()
    expect(parsePromotionReportV1({ ...validPromotion, passes: false, status: 'failed', failure_class: 'threshold_failed' })).toMatchObject({ status: 'failed' })
    expect(parsePromotionReportV1({
      ...validPromotion,
      aggregates: {
        cold: { ...validAggregate, uncached_tokens_per_success: 100.5 },
        warm: validAggregate,
      },
    }).aggregates.cold?.uncached_tokens_per_success).toBe(100.5)
  })
})
