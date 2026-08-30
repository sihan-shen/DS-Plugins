import type { EvaluationRecordV1 } from '@ds-plugins/dsh-context'
import { sha256Utf8 } from '@ds-plugins/dsh-context'
import { estimateSourceTokensV1, tokenizerMetadataV1 } from './tokenizer.js'
import type { BaselineFileV1, RetrievalRunV1 } from './types.js'

function assertSourceBinding(run: RetrievalRunV1): void {
  if (!Array.isArray(run.files)) throw new TypeError('source binding requires verified files')
  const sourcePaths = Object.keys(run.source_text)
  const filePaths = new Set<string>()
  for (const file of run.files as readonly BaselineFileV1[]) {
    if (filePaths.has(file.path)) throw new TypeError('source binding contains duplicate file paths')
    filePaths.add(file.path)
    const source = run.source_text[file.path]
    if (source === undefined || source !== file.text) throw new TypeError(`source binding mismatch for ${file.path}`)
    if (sha256Utf8(file.text) !== file.content_hash) throw new TypeError(`source binding hash mismatch for ${file.path}`)
    if (new TextEncoder().encode(file.text).byteLength !== file.byte_length) throw new TypeError(`source binding byte length mismatch for ${file.path}`)
  }
  if (sourcePaths.length !== filePaths.size || sourcePaths.some(path => !filePaths.has(path))) throw new TypeError('source binding paths mismatch')
}

function sourceHashForPath(run: RetrievalRunV1, path: string): string | undefined {
  const text = run.source_text[path]
  return text === undefined ? undefined : sha256Utf8(text)
}

function validRange(text: string, start: { line: number; column: number }, end: { line: number; column: number }): boolean {
  if (start.line < 1 || end.line < start.line || (end.line === start.line && end.column < start.column)) return false
  const lines = text.split('\n')
  if (start.line > lines.length || end.line > lines.length) return false
  if (start.column > lines[start.line - 1].length || end.column > lines[end.line - 1].length) return false
  return true
}

function rangeText(text: string, start: { line: number; column: number }, end: { line: number; column: number }): string | null {
  if (!validRange(text, start, end)) return null
  const lines = text.split('\n')
  const offset = (line: number, column: number): number => lines.slice(0, line - 1).reduce((total, item) => total + item.length + 1, 0) + column
  return text.slice(offset(start.line, start.column), offset(end.line, end.column))
}

function isRelevant(run: RetrievalRunV1, result: { path: string; name: string; sourceHash: string; start: { line: number; column: number }; end: { line: number; column: number } }): boolean {
  return run.task.target_symbols.some(target => target.path === result.path && target.name === result.name) &&
    run.source_text[result.path] !== undefined &&
    validRange(run.source_text[result.path], result.start, result.end) &&
    rangeText(run.source_text[result.path], result.start, result.end) === result.name &&
    sourceHashForPath(run, result.path) === result.sourceHash
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

export function computeRetrievalMetrics(run: RetrievalRunV1): EvaluationRecordV1 {
  assertSourceBinding(run)
  const validResults = run.ranked_results.filter(result => isRelevant(run, result))
  const topFive = run.ranked_results.slice(0, 5)
  const relevantTopFive = new Set(topFive.filter(result => isRelevant(run, result)).map(result => `${result.path}:${result.name}`))
  const targetKeys = new Set(run.task.target_symbols.map(target => `${target.path}:${target.name}`))
  const coveredTargets = new Set(validResults.map(result => `${result.path}:${result.name}`)).size
  const targetCoverage = targetKeys.size === 0 ? 0 : coveredTargets / targetKeys.size
  const precision = run.ranked_results.length === 0 ? 0 : validResults.length / run.ranked_results.length
  const firstRelevantIndex = run.ranked_results.findIndex(result => isRelevant(run, result))
  const mrr = firstRelevantIndex < 0 ? 0 : 1 / (firstRelevantIndex + 1)
  const recallAt5 = targetKeys.size === 0 ? 0 : [...relevantTopFive].filter(key => targetKeys.has(key)).length / targetKeys.size
  const source = Object.values(run.source_text).join('\n')
  const sourceTokenEstimate = estimateSourceTokensV1(source)
  let uncachedSourceTokens: number
  if (run.run_mode === 'baseline') {
    uncachedSourceTokens = sourceTokenEstimate
  } else {
    const optimizedUncachedTokens = run.uncached_source_tokens
    if (optimizedUncachedTokens === undefined || !Number.isSafeInteger(optimizedUncachedTokens) || optimizedUncachedTokens < 0) {
      throw new TypeError('optimized runs require a non-negative integer uncached_source_tokens value')
    }
    uncachedSourceTokens = optimizedUncachedTokens
  }
  const oracleSuccess = targetCoverage === 1 && run.revision === run.task.revision && run.verifier_result
  return {
    schema_version: 1,
    run_mode: run.run_mode,
    task_id: run.task.task_id,
    cache_condition: run.cache_condition,
    run_index: run.run_index,
    ...tokenizerMetadataV1,
    source_token_estimate: sourceTokenEstimate,
    uncached_source_tokens: uncachedSourceTokens,
    context_blocks_requested: run.context_blocks_requested,
    cache_hits: run.cache_hits,
    cache_misses: run.cache_misses,
    symbol_query_precision: precision,
    symbol_query_recall_at_5: recallAt5,
    symbol_query_mrr: mrr,
    target_coverage: targetCoverage,
    oracle_success: oracleSuccess,
    verification_status: run.verifier_result ? 'passed' : 'failed',
    ...(run.verifier_result ? {} : { failure_class: 'fixture_integrity_failed' }),
    duration_ms: run.duration_ms ?? 0,
  }
}

export { median }
