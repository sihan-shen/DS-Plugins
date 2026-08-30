import type {
  EvaluationTaskV1,
  SymbolMatchV1,
} from '@ds-plugins/dsh-context'

export type BaselineFileV1 = {
  readonly path: string
  readonly text: string
  readonly content_hash: string
  readonly byte_length: number
}

export type RetrievalRunV1 = {
  readonly task: EvaluationTaskV1
  readonly revision: string
  readonly ranked_results: readonly SymbolMatchV1[]
  readonly source_text: Readonly<Record<string, string>>
  readonly files: readonly BaselineFileV1[]
  readonly verifier_result: boolean
  readonly run_mode: 'baseline' | 'optimized'
  readonly cache_condition: 'none' | 'cold' | 'warm'
  readonly run_index: 1 | 2 | 3
  readonly context_blocks_requested: number
  readonly cache_hits: number
  readonly cache_misses: number
  readonly uncached_source_tokens?: number
  readonly duration_ms?: number
}

export type BaselineRunOptionsV1 = {
  readonly run_index?: number
}

export type BaselineRunV1 = RetrievalRunV1 & {
  readonly selected_paths: readonly string[]
  readonly files: readonly BaselineFileV1[]
}
