import type {
  ContextBlockV1,
  EvaluationRecordV1,
  EvaluationTaskV1,
  FixtureVerifierV1,
  PluginCompatibilityReportV1,
  PromotionAggregateV1,
  PromotionReportV1,
  RepoFileSummaryV1,
  RepoMapItemV1,
  RepoMapPageV1,
  SymbolMatchV1,
  SymbolQueryResultV1,
  RepositorySnapshotV1,
} from './types.js'

type RecordValue = Record<string, unknown>

function record(value: unknown, path: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`)
  return value as RecordValue
}

function keys(value: RecordValue, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${path}.${key} is not allowed`)
  }
}

function required(value: RecordValue, name: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, name)) throw new TypeError(`${path}.${name} is required`)
  return value[name]
}

function stringValue(value: unknown, path: string, nonEmpty = true): string {
  if (typeof value !== 'string' || (nonEmpty && value.trim() === '')) throw new TypeError(`${path} must be a non-empty string`)
  return value
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${path} must be a boolean`)
  return value
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${path} must be an integer >= ${minimum}`)
  return value
}

function bounded(value: unknown, path: string, minimum = 0, maximum = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new TypeError(`${path} must be between ${minimum} and ${maximum}`)
  return value
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`)
  return value
}

function schema(value: RecordValue, field: 'schemaVersion' | 'schema_version', path: string): void {
  if (required(value, field, path) !== 1) throw new TypeError(`${path}.${field} must be 1`)
}

function safePath(value: unknown, path: string): string {
  const result = stringValue(value, path)
  if (result.includes('\0') || result.includes('\\') || result.startsWith('/') || /^[A-Za-z]:/.test(result)) {
    throw new TypeError(`${path} must be repository-relative`)
  }
  const parts = result.split('/')
  if (parts.some(part => part === '.' || part === '..' || part === '')) throw new TypeError(`${path} must not contain traversal, dot, or empty path segments`)
  return result
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${path} must not contain duplicates`)
}

function cursorPage(value: RecordValue, itemCount: number, total: number, truncated: boolean, path: string): void {
  if (total < itemCount) throw new TypeError(`${path}.total must cover returned items`)
  const hasCursor = Object.prototype.hasOwnProperty.call(value, 'nextCursor')
  if (truncated) {
    if (!hasCursor || typeof value.nextCursor !== 'string' || value.nextCursor.trim() === '') throw new TypeError(`${path}.nextCursor is required when truncated`)
    if (total <= itemCount) throw new TypeError(`${path}.total must exceed returned items when truncated`)
  } else if (hasCursor) {
    throw new TypeError(`${path}.nextCursor is only valid for truncated pages`)
  } else if (total !== itemCount) {
    throw new TypeError(`${path}.total must equal returned items when not truncated`)
  }
}

function parseFile(value: unknown, index: number): RepoFileSummaryV1 {
  const path = `files[${index}]`
  const object = record(value, path)
  keys(object, ['path', 'contentHash', 'byteLength', 'language'], path)
  return {
    path: safePath(required(object, 'path', path), `${path}.path`),
    contentHash: stringValue(required(object, 'contentHash', path), `${path}.contentHash`),
    byteLength: integer(required(object, 'byteLength', path), `${path}.byteLength`),
    language: stringValue(required(object, 'language', path), `${path}.language`),
  }
}

export function parseRepositorySnapshotV1(value: unknown): RepositorySnapshotV1 {
  const object = record(value, '$')
  keys(object, ['schemaVersion', 'snapshotId', 'workspaceFingerprint', 'revision', 'files'], '$')
  schema(object, 'schemaVersion', '$')
  const files = array(required(object, 'files', '$'), '$.files').map(parseFile)
  unique(files.map(file => file.path), '$.files')
  return {
    schemaVersion: 1,
    snapshotId: stringValue(required(object, 'snapshotId', '$'), '$.snapshotId'),
    workspaceFingerprint: stringValue(required(object, 'workspaceFingerprint', '$'), '$.workspaceFingerprint'),
    revision: stringValue(required(object, 'revision', '$'), '$.revision'),
    files,
  }
}

function parseMapItem(value: unknown, index: number): RepoMapItemV1 {
  const path = `items[${index}]`
  const object = record(value, path)
  keys(object, ['path', 'sourceHash', 'summary'], path)
  return {
    path: safePath(required(object, 'path', path), `${path}.path`),
    sourceHash: stringValue(required(object, 'sourceHash', path), `${path}.sourceHash`),
    summary: stringValue(required(object, 'summary', path), `${path}.summary`, false),
  }
}

export function parseRepoMapPageV1(value: unknown): RepoMapPageV1 {
  const object = record(value, '$')
  keys(object, ['schemaVersion', 'snapshotId', 'items', 'totalItems', 'truncated', 'nextCursor'], '$')
  schema(object, 'schemaVersion', '$')
  const items = array(required(object, 'items', '$'), '$.items').map(parseMapItem)
  unique(items.map(item => item.path), '$.items')
  const totalItems = integer(required(object, 'totalItems', '$'), '$.totalItems')
  const truncated = booleanValue(required(object, 'truncated', '$'), '$.truncated')
  cursorPage(object, items.length, totalItems, truncated, '$')
  return { schemaVersion: 1, snapshotId: stringValue(required(object, 'snapshotId', '$'), '$.snapshotId'), items, totalItems, truncated, ...(truncated ? { nextCursor: object.nextCursor as string } : {}) }
}

function position(value: unknown, path: string): { line: number; column: number } {
  const object = record(value, path)
  keys(object, ['line', 'column'], path)
  return { line: integer(required(object, 'line', path), `${path}.line`, 1), column: integer(required(object, 'column', path), `${path}.column`) }
}

function symbolMatch(value: unknown, index: number): SymbolMatchV1 {
  const path = `matches[${index}]`
  const object = record(value, path)
  keys(object, ['symbolId', 'path', 'sourceHash', 'start', 'end', 'kind', 'name', 'container', 'score'], path)
  const start = position(required(object, 'start', path), `${path}.start`)
  const end = position(required(object, 'end', path), `${path}.end`)
  if (end.line < start.line || (end.line === start.line && end.column < start.column)) throw new TypeError(`${path}.end must not precede start`)
  return {
    symbolId: stringValue(required(object, 'symbolId', path), `${path}.symbolId`),
    path: safePath(required(object, 'path', path), `${path}.path`),
    sourceHash: stringValue(required(object, 'sourceHash', path), `${path}.sourceHash`),
    start,
    end,
    kind: stringValue(required(object, 'kind', path), `${path}.kind`),
    name: stringValue(required(object, 'name', path), `${path}.name`),
    ...(Object.prototype.hasOwnProperty.call(object, 'container') ? { container: stringValue(object.container, `${path}.container`) } : {}),
    score: bounded(required(object, 'score', path), `${path}.score`, 0, Number.POSITIVE_INFINITY),
  }
}

export function parseSymbolQueryResultV1(value: unknown): SymbolQueryResultV1 {
  const object = record(value, '$')
  keys(object, ['schemaVersion', 'snapshotId', 'matches', 'totalMatches', 'truncated', 'nextCursor'], '$')
  schema(object, 'schemaVersion', '$')
  const matches = array(required(object, 'matches', '$'), '$.matches').map(symbolMatch)
  const totalMatches = integer(required(object, 'totalMatches', '$'), '$.totalMatches')
  const truncated = booleanValue(required(object, 'truncated', '$'), '$.truncated')
  cursorPage(object, matches.length, totalMatches, truncated, '$')
  return { schemaVersion: 1, snapshotId: stringValue(required(object, 'snapshotId', '$'), '$.snapshotId'), matches, totalMatches, truncated, ...(truncated ? { nextCursor: object.nextCursor as string } : {}) }
}

function source(value: unknown, index: number): { path: string; contentHash: string } {
  const path = `sources[${index}]`
  const object = record(value, path)
  keys(object, ['path', 'contentHash'], path)
  return { path: safePath(required(object, 'path', path), `${path}.path`), contentHash: stringValue(required(object, 'contentHash', path), `${path}.contentHash`) }
}

export function parseContextBlockV1(value: unknown): ContextBlockV1 {
  const object = record(value, '$')
  keys(object, ['schemaVersion', 'blockId', 'kind', 'workspaceFingerprint', 'snapshotId', 'adapterId', 'adapterVersion', 'compilerPolicyVersion', 'sources', 'contentHash', 'text', 'byteLength', 'truncated'], '$')
  schema(object, 'schemaVersion', '$')
  const sources = array(required(object, 'sources', '$'), '$.sources').map(source)
  unique(sources.map(item => item.path), '$.sources')
  const kind = required(object, 'kind', '$')
  if (kind !== 'repo-map' && kind !== 'symbol' && kind !== 'source-window' && kind !== 'tool-result') throw new TypeError('$.kind is invalid')
  return {
    schemaVersion: 1,
    blockId: stringValue(required(object, 'blockId', '$'), '$.blockId'),
    kind,
    workspaceFingerprint: stringValue(required(object, 'workspaceFingerprint', '$'), '$.workspaceFingerprint'),
    snapshotId: stringValue(required(object, 'snapshotId', '$'), '$.snapshotId'),
    adapterId: stringValue(required(object, 'adapterId', '$'), '$.adapterId'),
    adapterVersion: stringValue(required(object, 'adapterVersion', '$'), '$.adapterVersion'),
    compilerPolicyVersion: stringValue(required(object, 'compilerPolicyVersion', '$'), '$.compilerPolicyVersion'),
    sources,
    contentHash: stringValue(required(object, 'contentHash', '$'), '$.contentHash'),
    text: stringValue(required(object, 'text', '$'), '$.text', false),
    byteLength: integer(required(object, 'byteLength', '$'), '$.byteLength'),
    truncated: booleanValue(required(object, 'truncated', '$'), '$.truncated'),
  }
}

export function parseFixtureVerifierV1(value: unknown): FixtureVerifierV1 {
  const object = record(value, '$')
  keys(object, ['id', 'expected_revision', 'required_paths'], '$')
  if (required(object, 'id', '$') !== 'fixture-integrity-v1') throw new TypeError('$.id is unsupported')
  const paths = array(required(object, 'required_paths', '$'), '$.required_paths').map((item, index) => safePath(item, `$.required_paths[${index}]`))
  if (paths.length === 0) throw new TypeError('$.required_paths must not be empty')
  unique(paths, '$.required_paths')
  return { id: 'fixture-integrity-v1', expected_revision: stringValue(required(object, 'expected_revision', '$'), '$.expected_revision'), required_paths: paths }
}

export function parseEvaluationTaskV1(value: unknown): EvaluationTaskV1 {
  const object = record(value, '$')
  keys(object, ['task_id', 'repository_shape', 'revision', 'query', 'target_symbols', 'baseline_paths', 'byte_limit', 'verifier'], '$')
  const targetSymbols = array(required(object, 'target_symbols', '$'), '$.target_symbols').map((item, index) => {
    const targetPath = `$.target_symbols[${index}]`
    const target = record(item, targetPath)
    keys(target, ['path', 'name'], targetPath)
    return { path: safePath(required(target, 'path', targetPath), `${targetPath}.path`), name: stringValue(required(target, 'name', targetPath), `${targetPath}.name`) }
  })
  if (targetSymbols.length === 0) throw new TypeError('$.target_symbols must not be empty')
  unique(targetSymbols.map(target => target.path), '$.target_symbols')
  const baselinePaths = array(required(object, 'baseline_paths', '$'), '$.baseline_paths').map((item, index) => safePath(item, `$.baseline_paths[${index}]`))
  unique(baselinePaths, '$.baseline_paths')
  const verifier = parseFixtureVerifierV1(required(object, 'verifier', '$'))
  const revision = stringValue(required(object, 'revision', '$'), '$.revision')
  if (verifier.expected_revision !== revision) throw new TypeError('$.verifier.expected_revision must match $.revision')
  for (const target of targetSymbols) if (!baselinePaths.includes(target.path)) throw new TypeError(`$.baseline_paths must include ${target.path}`)
  const requiredPaths = new Set(verifier.required_paths)
  for (const target of targetSymbols) if (!requiredPaths.has(target.path)) throw new TypeError(`$.verifier.required_paths must include ${target.path}`)
  for (const path of baselinePaths) if (!requiredPaths.has(path)) throw new TypeError(`$.verifier.required_paths must include ${path}`)
  return {
    task_id: stringValue(required(object, 'task_id', '$'), '$.task_id'),
    repository_shape: (() => { const shape = required(object, 'repository_shape', '$'); if (shape !== 'ts-small' && shape !== 'ts-medium' && shape !== 'ts-layered') throw new TypeError('$.repository_shape is invalid'); return shape })(),
    revision,
    query: stringValue(required(object, 'query', '$'), '$.query'),
    target_symbols: targetSymbols,
    baseline_paths: baselinePaths,
    byte_limit: (() => { const limit = integer(required(object, 'byte_limit', '$'), '$.byte_limit', 1); if (limit > 1_048_576) throw new TypeError('$.byte_limit must be at most 1048576'); return limit })(),
    verifier,
  }
}

const recordKeys = ['schema_version', 'run_mode', 'task_id', 'cache_condition', 'run_index', 'tokenizer_name', 'tokenizer_encoding', 'tokenizer_version', 'source_token_estimate', 'uncached_source_tokens', 'context_blocks_requested', 'cache_hits', 'cache_misses', 'symbol_query_precision', 'symbol_query_recall_at_5', 'symbol_query_mrr', 'target_coverage', 'oracle_success', 'verification_status', 'failure_class', 'duration_ms'] as const

export function parseEvaluationRecordV1(value: unknown): EvaluationRecordV1 {
  const object = record(value, '$')
  keys(object, recordKeys, '$')
  schema(object, 'schema_version', '$')
  const runMode = required(object, 'run_mode', '$')
  const cacheCondition = required(object, 'cache_condition', '$')
  if ((runMode !== 'baseline' || cacheCondition !== 'none') && (runMode !== 'optimized' || (cacheCondition !== 'cold' && cacheCondition !== 'warm'))) throw new TypeError('$.run_mode and $.cache_condition pairing is invalid')
  const runIndex = required(object, 'run_index', '$')
  if (runIndex !== 1 && runIndex !== 2 && runIndex !== 3) throw new TypeError('$.run_index must be 1, 2, or 3')
  if (required(object, 'tokenizer_name', '$') !== '@dqbd/tiktoken' || required(object, 'tokenizer_encoding', '$') !== 'cl100k_base' || required(object, 'tokenizer_version', '$') !== '1.0.22') throw new TypeError('tokenizer metadata is unsupported')
  for (const name of ['source_token_estimate', 'uncached_source_tokens', 'context_blocks_requested', 'cache_hits', 'cache_misses'] as const) integer(required(object, name, '$'), `$.${name}`)
  for (const name of ['symbol_query_precision', 'symbol_query_recall_at_5', 'symbol_query_mrr', 'target_coverage'] as const) bounded(required(object, name, '$'), `$.${name}`)
  const verificationStatus = required(object, 'verification_status', '$')
  if (verificationStatus !== 'passed' && verificationStatus !== 'failed' && verificationStatus !== 'not-run') throw new TypeError('$.verification_status is invalid')
  const oracleSuccess = booleanValue(required(object, 'oracle_success', '$'), '$.oracle_success')
  if (oracleSuccess && verificationStatus !== 'passed') throw new TypeError('$.oracle_success requires passed verification_status')
  if (Object.prototype.hasOwnProperty.call(object, 'failure_class')) stringValue(object.failure_class, '$.failure_class')
  return {
    schema_version: 1,
    run_mode: runMode,
    task_id: stringValue(required(object, 'task_id', '$'), '$.task_id'),
    cache_condition: cacheCondition,
    run_index: runIndex,
    tokenizer_name: '@dqbd/tiktoken',
    tokenizer_encoding: 'cl100k_base',
    tokenizer_version: '1.0.22',
    source_token_estimate: object.source_token_estimate as number,
    uncached_source_tokens: object.uncached_source_tokens as number,
    context_blocks_requested: object.context_blocks_requested as number,
    cache_hits: object.cache_hits as number,
    cache_misses: object.cache_misses as number,
    symbol_query_precision: object.symbol_query_precision as number,
    symbol_query_recall_at_5: object.symbol_query_recall_at_5 as number,
    symbol_query_mrr: object.symbol_query_mrr as number,
    target_coverage: object.target_coverage as number,
    oracle_success: oracleSuccess,
    verification_status: verificationStatus,
    ...(Object.prototype.hasOwnProperty.call(object, 'failure_class') ? { failure_class: object.failure_class as string } : {}),
    duration_ms: bounded(required(object, 'duration_ms', '$'), '$.duration_ms', 0, Number.POSITIVE_INFINITY),
  }
}

function parseAggregate(value: unknown, path: string): PromotionAggregateV1 {
  const object = record(value, path)
  keys(object, ['median_source_token_reduction', 'uncached_tokens_per_success', 'mean_symbol_query_recall_at_5', 'mean_target_coverage', 'mean_oracle_success'], path)
  const nullable = (name: string, maximum: number): number | null => {
    const item = required(object, name, path)
    return item === null ? null : bounded(item, `${path}.${name}`, 0, maximum)
  }
  return {
    median_source_token_reduction: (() => {
      const item = required(object, 'median_source_token_reduction', path)
      return item === null ? null : bounded(item, `${path}.median_source_token_reduction`, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
    })(),
    uncached_tokens_per_success: (() => {
      const item = required(object, 'uncached_tokens_per_success', path)
      return item === null ? null : bounded(item, `${path}.uncached_tokens_per_success`, 0, Number.POSITIVE_INFINITY)
    })(),
    mean_symbol_query_recall_at_5: nullable('mean_symbol_query_recall_at_5', 1),
    mean_target_coverage: nullable('mean_target_coverage', 1),
    mean_oracle_success: nullable('mean_oracle_success', 1),
  }
}

export function parsePromotionReportV1(value: unknown): PromotionReportV1 {
  const object = record(value, '$')
  keys(object, ['schema_version', 'corpus_id', 'task_count', 'repository_shape_count', 'thresholds', 'aggregates', 'passes', 'status', 'failure_class'], '$')
  schema(object, 'schema_version', '$')
  const thresholds = record(required(object, 'thresholds', '$'), '$.thresholds')
  keys(thresholds, ['min_median_source_token_reduction', 'min_mean_symbol_query_recall_at_5', 'min_mean_target_coverage', 'min_mean_oracle_success'], '$.thresholds')
  if (thresholds.min_median_source_token_reduction !== 0.25 || thresholds.min_mean_symbol_query_recall_at_5 !== 0.95 || thresholds.min_mean_target_coverage !== 0.95 || thresholds.min_mean_oracle_success !== 0.95) throw new TypeError('$.thresholds must use the v0.2a literals')
  const aggregates = record(required(object, 'aggregates', '$'), '$.aggregates')
  keys(aggregates, ['cold', 'warm'], '$.aggregates')
  const cold = required(aggregates, 'cold', '$.aggregates') === null ? null : parseAggregate(aggregates.cold, '$.aggregates.cold')
  const warm = required(aggregates, 'warm', '$.aggregates') === null ? null : parseAggregate(aggregates.warm, '$.aggregates.warm')
  const passes = booleanValue(required(object, 'passes', '$'), '$.passes')
  const status = required(object, 'status', '$')
  if (status !== 'not-ready' && status !== 'passed' && status !== 'failed') throw new TypeError('$.status is invalid')
  const failureClass = object.failure_class
  if (failureClass !== undefined && failureClass !== 'optimized_records_missing' && failureClass !== 'threshold_failed' && failureClass !== 'invalid_pairing' && failureClass !== 'baseline_zero') throw new TypeError('$.failure_class is invalid')
  const meetsThresholds = (aggregate: PromotionAggregateV1 | null): boolean => aggregate !== null &&
    aggregate.median_source_token_reduction !== null && aggregate.median_source_token_reduction >= 0.25 &&
    aggregate.mean_symbol_query_recall_at_5 !== null && aggregate.mean_symbol_query_recall_at_5 >= 0.95 &&
    aggregate.mean_target_coverage !== null && aggregate.mean_target_coverage >= 0.95 &&
    aggregate.mean_oracle_success !== null && aggregate.mean_oracle_success >= 0.95
  if (status === 'passed' && (!passes || failureClass !== undefined || object.task_count === undefined || integer(object.task_count, '$.task_count') < 12 || object.repository_shape_count === undefined || integer(object.repository_shape_count, '$.repository_shape_count') < 3 || !meetsThresholds(cold) || !meetsThresholds(warm))) throw new TypeError('passed reports require the complete corpus and passing aggregates')
  if (status === 'not-ready' && (passes || failureClass !== 'optimized_records_missing' || cold !== null || warm !== null)) throw new TypeError('not-ready reports require missing optimized records')
  if (status === 'failed' && (passes || failureClass === undefined || failureClass === 'optimized_records_missing')) throw new TypeError('failed reports require a non-ready failure class')
  return {
    schema_version: 1,
    corpus_id: stringValue(required(object, 'corpus_id', '$'), '$.corpus_id'),
    task_count: integer(required(object, 'task_count', '$'), '$.task_count'),
    repository_shape_count: integer(required(object, 'repository_shape_count', '$'), '$.repository_shape_count'),
    thresholds: { min_median_source_token_reduction: 0.25, min_mean_symbol_query_recall_at_5: 0.95, min_mean_target_coverage: 0.95, min_mean_oracle_success: 0.95 },
    aggregates: { cold, warm },
    passes,
    status,
    ...(failureClass === undefined ? {} : { failure_class: failureClass }),
  }
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => stringValue(item, `${path}[${index}]`))
}

export function parsePluginCompatibilityReportV1(value: unknown): PluginCompatibilityReportV1 {
  const object = record(value, '$')
  keys(object, [
    'schema_version', 'package_name', 'package_version', 'reviewed_commit', 'dsh_version', 'status', 'peer_range',
    'peer_accepts_dsh', 'node_range', 'node_version_checked', 'node_compatible', 'permissions', 'network_permission',
    'network_isolation_proven', 'lifecycle_scripts', 'lifecycle_safe', 'registration_tools', 'registration_write_tools',
    'read_only_session_sufficient', 'manifest_sha256', 'registration_snapshot_sha256', 'artifact_integrity',
    'artifact_metadata_bound', 'next_action',
  ], '$')
  schema(object, 'schema_version', '$')
  const status = required(object, 'status', '$')
  if (status !== 'direct-compatible' && status !== 'patch-required' && status !== 'rejected') throw new TypeError('$.status is invalid')
  const artifactIntegrity = required(object, 'artifact_integrity', '$')
  if (artifactIntegrity !== 'verified' && artifactIntegrity !== 'not-provided' && artifactIntegrity !== 'failed') throw new TypeError('$.artifact_integrity is invalid')
  const hash = (name: string): string => {
    const value = stringValue(required(object, name, '$'), `$.${name}`)
    if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError(`$.${name} must be a sha256 value`)
    return value
  }
  return {
    schema_version: 1,
    package_name: stringValue(required(object, 'package_name', '$'), '$.package_name'),
    package_version: stringValue(required(object, 'package_version', '$'), '$.package_version'),
    reviewed_commit: stringValue(required(object, 'reviewed_commit', '$'), '$.reviewed_commit'),
    dsh_version: stringValue(required(object, 'dsh_version', '$'), '$.dsh_version'),
    status,
    peer_range: stringValue(required(object, 'peer_range', '$'), '$.peer_range'),
    peer_accepts_dsh: booleanValue(required(object, 'peer_accepts_dsh', '$'), '$.peer_accepts_dsh'),
    node_range: stringValue(required(object, 'node_range', '$'), '$.node_range'),
    node_version_checked: stringValue(required(object, 'node_version_checked', '$'), '$.node_version_checked'),
    node_compatible: booleanValue(required(object, 'node_compatible', '$'), '$.node_compatible'),
    permissions: stringArray(required(object, 'permissions', '$'), '$.permissions'),
    network_permission: booleanValue(required(object, 'network_permission', '$'), '$.network_permission'),
    network_isolation_proven: booleanValue(required(object, 'network_isolation_proven', '$'), '$.network_isolation_proven'),
    lifecycle_scripts: stringArray(required(object, 'lifecycle_scripts', '$'), '$.lifecycle_scripts'),
    lifecycle_safe: booleanValue(required(object, 'lifecycle_safe', '$'), '$.lifecycle_safe'),
    registration_tools: stringArray(required(object, 'registration_tools', '$'), '$.registration_tools'),
    registration_write_tools: stringArray(required(object, 'registration_write_tools', '$'), '$.registration_write_tools'),
    read_only_session_sufficient: booleanValue(required(object, 'read_only_session_sufficient', '$'), '$.read_only_session_sufficient'),
    manifest_sha256: hash('manifest_sha256'),
    registration_snapshot_sha256: hash('registration_snapshot_sha256'),
    artifact_integrity: artifactIntegrity,
    artifact_metadata_bound: booleanValue(required(object, 'artifact_metadata_bound', '$'), '$.artifact_metadata_bound'),
    next_action: stringValue(required(object, 'next_action', '$'), '$.next_action'),
  }
}
