export type RepoFileSummaryV1 = {
  readonly path: string
  readonly contentHash: string
  readonly byteLength: number
  readonly language: string
}

export type InternalSymbolEntryV1 = {
  readonly symbolId: string
  readonly path: string
  readonly sourceHash: string
  readonly start: { readonly line: number; readonly column: number }
  readonly end: { readonly line: number; readonly column: number }
  readonly kind: string
  readonly name: string
  readonly container?: string
  readonly score: number
}

export type RepoMapItemV1 = {
  readonly path: string
  readonly sourceHash: string
  readonly summary: string
}

export type RepositorySnapshotV1 = {
  schemaVersion: 1
  snapshotId: string
  workspaceFingerprint: string
  revision: string
  files: readonly RepoFileSummaryV1[]
}

export type SymbolIndexV1 = {
  schemaVersion: 1
  snapshotId: string
  adapterId: string
  adapterVersion: string
  entries: readonly InternalSymbolEntryV1[]
}

export type RepoMapPageV1 = {
  schemaVersion: 1
  snapshotId: string
  items: readonly RepoMapItemV1[]
  totalItems: number
  truncated: boolean
  nextCursor?: string
}

export type SymbolQueryResultV1 = {
  schemaVersion: 1
  snapshotId: string
  matches: readonly SymbolMatchV1[]
  totalMatches: number
  truncated: boolean
  nextCursor?: string
}

export type SymbolMatchV1 = {
  symbolId: string
  path: string
  sourceHash: string
  start: { line: number; column: number }
  end: { line: number; column: number }
  kind: string
  name: string
  container?: string
  score: number
}

export type ContextBlockV1 = {
  schemaVersion: 1
  blockId: string
  kind: 'repo-map' | 'symbol' | 'source-window' | 'tool-result'
  workspaceFingerprint: string
  snapshotId: string
  adapterId: string
  adapterVersion: string
  compilerPolicyVersion: string
  sources: readonly { path: string; contentHash: string }[]
  contentHash: string
  text: string
  byteLength: number
  truncated: boolean
}

export type PluginCompatibilityReportV1 = {
  schema_version: 1
  package_name: string
  package_version: string
  reviewed_commit: string
  dsh_version: string
  status: 'direct-compatible' | 'patch-required' | 'rejected'
  peer_range: string
  peer_accepts_dsh: boolean
  node_range: string
  node_version_checked: string
  node_compatible: boolean
  permissions: readonly string[]
  network_permission: boolean
  network_isolation_proven: boolean
  lifecycle_scripts: readonly string[]
  lifecycle_safe: boolean
  registration_tools: readonly string[]
  registration_write_tools: readonly string[]
  read_only_session_sufficient: boolean
  manifest_sha256: string
  registration_snapshot_sha256: string
  artifact_integrity: 'verified' | 'not-provided' | 'failed'
  artifact_metadata_bound: boolean
  next_action: string
}

export type FixtureVerifierV1 = {
  id: 'fixture-integrity-v1'
  expected_revision: string
  required_paths: readonly string[]
}

export type EvaluationTaskV1 = {
  task_id: string
  repository_shape: 'ts-small' | 'ts-medium' | 'ts-layered'
  revision: string
  query: string
  target_symbols: readonly { path: string; name: string }[]
  baseline_paths: readonly string[]
  byte_limit: number
  verifier: FixtureVerifierV1
}

export type EvaluationRecordV1 = {
  schema_version: 1
  run_mode: 'baseline' | 'optimized'
  task_id: string
  cache_condition: 'none' | 'cold' | 'warm'
  run_index: 1 | 2 | 3
  tokenizer_name: '@dqbd/tiktoken'
  tokenizer_encoding: 'cl100k_base'
  tokenizer_version: '1.0.22'
  source_token_estimate: number
  uncached_source_tokens: number
  context_blocks_requested: number
  cache_hits: number
  cache_misses: number
  symbol_query_precision: number
  symbol_query_recall_at_5: number
  symbol_query_mrr: number
  target_coverage: number
  oracle_success: boolean
  verification_status: 'passed' | 'failed' | 'not-run'
  failure_class?: string
  duration_ms: number
}

export type PromotionAggregateV1 = {
  median_source_token_reduction: number | null
  uncached_tokens_per_success: number | null
  mean_symbol_query_recall_at_5: number | null
  mean_target_coverage: number | null
  mean_oracle_success: number | null
}

export type PromotionReportV1 = {
  schema_version: 1
  corpus_id: string
  task_count: number
  repository_shape_count: number
  thresholds: {
    min_median_source_token_reduction: 0.25
    min_mean_symbol_query_recall_at_5: 0.95
    min_mean_target_coverage: 0.95
    min_mean_oracle_success: 0.95
  }
  aggregates: {
    cold: PromotionAggregateV1 | null
    warm: PromotionAggregateV1 | null
  }
  passes: boolean
  status: 'not-ready' | 'passed' | 'failed'
  failure_class?: 'optimized_records_missing' | 'threshold_failed' | 'invalid_pairing' | 'baseline_zero'
}
