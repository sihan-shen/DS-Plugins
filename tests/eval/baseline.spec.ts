import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseEvaluationTaskV1, parseFixtureVerifierV1 } from '../../packages/dsh-context/src/index.ts'
import manifest from './fixtures/v0.2a/manifest.json'
import { runBaseline, runBaselineThreeTimes } from '../../packages/dsh-eval/src/baseline.js'
import { runFixtureVerifier } from '../../packages/dsh-eval/src/fixture-verifier.js'
import { computeRetrievalMetrics } from '../../packages/dsh-eval/src/metrics.js'
import type { EvaluationTaskV1 } from '../../packages/dsh-context/src/types.ts'

const tasks = (manifest as { tasks: unknown[] }).tasks.map(value => parseEvaluationTaskV1(value))

describe('v0.2a fixed baseline corpus', () => {
  it('contains at least twelve tasks across all three repository shapes', () => {
    expect(tasks).toHaveLength(12)
    expect(new Set(tasks.map(task => task.repository_shape))).toEqual(new Set(['ts-small', 'ts-medium', 'ts-layered']))
    for (const task of tasks) {
      expect(task.query).not.toBe('')
      expect(task.baseline_paths.length).toBeGreaterThan(0)
      expect(task.byte_limit).toBeGreaterThan(0)
      expect(task.verifier).toEqual(parseFixtureVerifierV1(task.verifier))
    }
  })

  it('keeps the manifest JSON-only and closed to executable commands', () => {
    const keys: string[] = []
    const collectKeys = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collectKeys)
      } else if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          keys.push(key)
          collectKeys(child)
        }
      }
    }
    collectKeys(manifest)
    expect(keys).not.toEqual(expect.arrayContaining(['shell', 'command', 'executable', 'spawn', 'exec']))
    expect(Object.keys(manifest)).toEqual(['schema_version', 'corpus_id', 'revision', 'fixture_hashes', 'tasks'])
    expect(Object.keys(manifest.fixture_hashes)).toHaveLength(9)
  })

  it('selects only listed files in manifest order and enforces the byte limit in process', async () => {
    const task = tasks[0]
    const result = await runBaseline(task)
    expect(result.selected_paths).toEqual(task.baseline_paths)
    expect(result.files.map(file => file.path)).toEqual(task.baseline_paths)
    const sourceBytes = Object.values(result.source_text).reduce((total, text) => total + new TextEncoder().encode(text).byteLength, 0)
    expect(sourceBytes).toBe(result.files.reduce((total, file) => total + file.byte_length, 0))
    expect(sourceBytes).toBeLessThanOrEqual(task.byte_limit)
    await expect(runBaseline({ ...task, byte_limit: 1 })).rejects.toThrow(/byte limit/i)
  })

  it('can produce the three baseline run indices explicitly', async () => {
    const runs = await runBaselineThreeTimes(tasks[0])
    expect(runs.map(run => run.run_index)).toEqual([1, 2, 3])
    await expect(runBaseline(tasks[0], { run_index: 4 as 1 })).rejects.toThrow(/run_index/i)
  })

  it('revalidates task paths at the public read boundary', async () => {
    const task = tasks[0]
    await expect(runBaseline({ ...task, baseline_paths: ['../outside.ts'] })).rejects.toThrow(/repository-relative|path|traversal/i)
  })

  it('verifies checked-in fixture hashes without spawning a command', async () => {
    const task = tasks[0]
    const result = await runBaseline(task)
    expect(await runFixtureVerifier(task, result)).toBe(true)
    const changed = { ...result, files: [{ ...result.files[0], content_hash: 'sha256:wrong' }, ...result.files.slice(1)] }
    expect(await runFixtureVerifier(task, changed)).toBe(false)
    const unregisteredPathTask = { ...task, verifier: { ...task.verifier, required_paths: ['src/not-registered.ts'] } }
    expect(await runFixtureVerifier(unregisteredPathTask, result)).toBe(false)
  })

  it('rejects a task revision that matches its verifier but not the checked-in manifest revision', async () => {
    const task = tasks[0]
    const mismatchedRevisionTask = {
      ...task,
      revision: 'v0.2a-fixture-rev-2',
      verifier: { ...task.verifier, expected_revision: 'v0.2a-fixture-rev-2' },
    }
    const result = await runBaseline(mismatchedRevisionTask)
    expect(await runFixtureVerifier(mismatchedRevisionTask, result)).toBe(false)
  })

  it('produces canonical snake_case baseline records with fixed tokenizer metadata', async () => {
    const task = tasks[0]
    const result = await runBaseline(task)
    const verified = await runFixtureVerifier(task, result)
    const record = computeRetrievalMetrics({ ...result, verifier_result: verified })
    expect(record).toMatchObject({
      schema_version: 1,
      run_mode: 'baseline',
      cache_condition: 'none',
      run_index: 1,
      tokenizer_name: '@dqbd/tiktoken',
      tokenizer_encoding: 'cl100k_base',
      tokenizer_version: '1.0.22',
      source_token_estimate: expect.any(Number),
      uncached_source_tokens: expect.any(Number),
    })
    expect(record.uncached_source_tokens).toBe(record.source_token_estimate)
    expect(Object.keys(record)).not.toContain('sourceTokensPerTask')
    expect(Object.keys(record)).not.toContain('uncachedTokensPerSuccess')
  })

  it('uses only fixture files as the baseline source corpus', async () => {
    const task = tasks.find(item => item.repository_shape === 'ts-layered') as EvaluationTaskV1
    const result = await runBaseline(task)
    expect(result.files.every(file => file.path.startsWith('src/'))).toBe(true)
    expect(result.files.some(file => file.path.includes('node_modules'))).toBe(false)
    expect(await readFile(new URL(`./fixtures/v0.2a/repos/${task.repository_shape}/${result.files[0].path}`, import.meta.url), 'utf8')).toBe(result.files[0].text)
  })
})
