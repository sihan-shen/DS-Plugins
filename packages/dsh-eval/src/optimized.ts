import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  canonicalJson,
  parseEvaluationTaskV1,
  type EvaluationRecordV1,
  type EvaluationTaskV1,
  type SymbolMatchV1,
} from '@ds-plugins/dsh-context'
import {
  buildSymbolIndex,
  extractFallbackSymbols,
  querySymbols,
  RepositorySnapshotStore,
} from '@ds-plugins/dsh-code-intelligence'
import { computeRetrievalMetrics } from './metrics.js'
import { runFixtureVerifier } from './fixture-verifier.js'
import { estimateSourceTokensV1 } from './tokenizer.js'
import type { BaselineFileV1, RetrievalRunV1, SourceMeasurementV1 } from './types.js'

const fixtureRoot = fileURLToPath(new URL(import.meta.url.includes('/lib/') ? '../../../../tests/eval/fixtures/v0.2a/repos/' : '../../../tests/eval/fixtures/v0.2a/repos/', import.meta.url))
const manifestPath = join(fixtureRoot, '..', 'manifest.json')
const fixedManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { readonly tasks: readonly EvaluationTaskV1[] }

const MAX_FILES = 10_000
const MAX_TOTAL_BYTES = 67_108_864
const MAX_DIRECTORIES = 20_000
const MAX_IGNORE_BYTES = 262_144

function offsetAt(source: string, position: { readonly line: number; readonly column: number }): number {
  if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.column) || position.line < 1 || position.column < 0) throw new TypeError('symbol position is invalid')
  let line = 1
  let column = 0
  for (let offset = 0; offset < source.length; offset += 1) {
    if (line === position.line && column === position.column) return offset
    if (source[offset] === '\n') {
      line += 1
      column = 0
    } else {
      column += 1
    }
  }
  if (line === position.line && column === position.column) return source.length
  throw new RangeError('symbol position is outside source')
}

function positionAt(source: string, offset: number): { readonly line: number; readonly column: number } {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) throw new RangeError('source offset is invalid')
  let line = 1
  let column = 0
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') {
      line += 1
      column = 0
    } else {
      column += 1
    }
  }
  return { line, column }
}

function nameRange(source: string, match: SymbolMatchV1): SymbolMatchV1 {
  const declarationStart = offsetAt(source, match.start)
  const declarationEnd = offsetAt(source, match.end)
  const nameOffset = source.indexOf(match.name, declarationStart)
  if (nameOffset < declarationStart || nameOffset + match.name.length > declarationEnd) throw new Error(`target declaration name is not within its indexed range: ${match.path}:${match.name}`)
  return { ...match, start: positionAt(source, nameOffset), end: positionAt(source, nameOffset + match.name.length) }
}

function snapshotConfig(deploymentRoot: string, revision: string, maxFileBytes: number) {
  return {
    deploymentRoot,
    revision,
    maxFileBytes,
    maxFiles: MAX_FILES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    maxDirectories: MAX_DIRECTORIES,
    maxIgnoreBytes: MAX_IGNORE_BYTES,
    nestedCheckoutRoots: [],
  } as const
}

function checkedTask(task: EvaluationTaskV1): EvaluationTaskV1 {
  const parsed = parseEvaluationTaskV1(task)
  const expected = fixedManifest.tasks.find(candidate => candidate.task_id === parsed.task_id)
  if (expected === undefined || canonicalJson(expected) !== canonicalJson(parsed)) throw new Error(`task is not the checked-in v0.2a manifest task: ${parsed.task_id}`)
  return parsed
}

async function fullVerifiedFiles(store: RepositorySnapshotStore, task: EvaluationTaskV1): Promise<BaselineFileV1[]> {
  const files: BaselineFileV1[] = []
  for (const path of task.verifier.required_paths) {
    const summary = store.snapshot.files.find(file => file.path === path)
    if (summary === undefined) throw new Error(`required fixture path is missing from snapshot: ${path}`)
    const text = await store.readVerifiedFile(path, summary.contentHash)
    files.push({ path, text, content_hash: summary.contentHash, byte_length: summary.byteLength })
  }
  return files
}

async function createOptimizedRun(taskInput: EvaluationTaskV1, condition: 'cold' | 'warm', runIndex: 1 | 2 | 3): Promise<RetrievalRunV1> {
  const task = checkedTask(taskInput)
  if (runIndex !== 1 && runIndex !== 2 && runIndex !== 3) throw new RangeError('run_index must be 1, 2, or 3')
  const deploymentRoot = join(fixtureRoot, task.repository_shape)
  const store = await RepositorySnapshotStore.create(snapshotConfig(deploymentRoot, task.revision, task.byte_limit))
  if (store.snapshot.revision !== task.revision) throw new Error(`snapshot revision mismatch for ${task.task_id}`)
  const adapter = await extractFallbackSymbols(store)
  const index = buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries)
  const query = querySymbols(store.snapshot, index, { query: task.query, limit: 50 })
  const files = await fullVerifiedFiles(store, task)
  const targetKeys = new Set(task.target_symbols.map(target => `${target.path}:${target.name}`))
  const targetMatches = query.matches
    .filter(match => targetKeys.has(`${match.path}:${match.name}`))
    .sort((first, second) => Number(first.container !== undefined) - Number(second.container !== undefined) || first.start.line - second.start.line || first.start.column - second.start.column)
  const foundTargetKeys = new Set(targetMatches.map(match => `${match.path}:${match.name}`))
  if (foundTargetKeys.size !== targetKeys.size) throw new Error(`optimized query did not return every target for ${task.task_id}`)
  const selectedTargetIds = new Set<string>()
  const selectedTargetKeys = new Set<string>()
  for (const match of targetMatches) {
    const key = `${match.path}:${match.name}`
    if (!selectedTargetKeys.has(key)) {
      selectedTargetKeys.add(key)
      selectedTargetIds.add(match.symbolId)
    }
  }

  const measurements: SourceMeasurementV1[] = []
  const rankedResults: SymbolMatchV1[] = []
  const measuredTargetKeys = new Set<string>()
  for (const match of query.matches) {
    const file = files.find(candidate => candidate.path === match.path)
    if (file === undefined) {
      rankedResults.push(match)
      continue
    }
    const declarationStart = offsetAt(file.text, match.start)
    const declarationEnd = offsetAt(file.text, match.end)
    const target = selectedTargetIds.has(match.symbolId)
    const targetKey = `${match.path}:${match.name}`
    if (target && !measuredTargetKeys.has(targetKey)) {
      measuredTargetKeys.add(targetKey)
      measurements.push({
        path: match.path,
        source_hash: file.content_hash,
        start_offset: declarationStart,
        end_offset: declarationEnd,
        text: file.text.slice(declarationStart, declarationEnd),
        byte_length: new TextEncoder().encode(file.text.slice(declarationStart, declarationEnd)).byteLength,
      })
      rankedResults.push(nameRange(file.text, match))
    } else {
      rankedResults.push(match)
    }
  }
  if (measuredTargetKeys.size !== targetKeys.size) throw new Error(`optimized measurements are incomplete for ${task.task_id}`)
  const sourceTokenEstimate = estimateSourceTokensV1(measurements.map(measurement => measurement.text).join('\n'))
  return {
    task,
    revision: store.snapshot.revision,
    ranked_results: rankedResults,
    files,
    measurements,
    verifier_result: await runFixtureVerifier(task, {
      task,
      revision: store.snapshot.revision,
      ranked_results: rankedResults,
      files,
      measurements,
      verifier_result: false,
      run_mode: 'optimized',
      cache_condition: condition,
      run_index: runIndex,
      context_blocks_requested: measurements.length,
      cache_hits: 0,
      cache_misses: 0,
      uncached_source_tokens: sourceTokenEstimate,
    }),
    run_mode: 'optimized',
    cache_condition: condition,
    run_index: runIndex,
    context_blocks_requested: measurements.length,
    cache_hits: 0,
    cache_misses: 0,
    uncached_source_tokens: sourceTokenEstimate,
  }
}

export async function runOptimized(task: EvaluationTaskV1, condition: 'cold' | 'warm', runIndex: 1 | 2 | 3): Promise<EvaluationRecordV1> {
  const run = await createOptimizedRun(task, condition, runIndex)
  if (!run.verifier_result) throw new Error(`optimized fixture verification failed for ${run.task.task_id}`)
  return computeRetrievalMetrics(run)
}
