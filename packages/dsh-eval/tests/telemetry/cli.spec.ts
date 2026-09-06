import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ref, observation, seal, annotation } from './fixture.js'
import { openTelemetryStore } from '../../../dsh-telemetry/src/store.js'

const root = process.cwd()
const cli = join(root, 'packages/dsh-eval/lib/src/telemetry/cli.js')
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })

describe('telemetry CLI', () => {
  it('rejects missing and unknown commands', () => {
    expect(run([]).status).not.toBe(0)
    expect(run(['unknown']).status).not.toBe(0)
  })

  it('analyzes a valid bounded fixture and publishes all artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-'))
    try {
      const events = join(dir, 'events.jsonl')
      const annotations = join(dir, 'annotations.json')
      const output = join(dir, 'analysis')
      const runRef = ref('1')
      await writeFile(events, `${JSON.stringify(observation(runRef, 1))}\n${JSON.stringify(seal(runRef, 1))}\n`, { mode: 0o600 })
      await writeFile(annotations, JSON.stringify([annotation(runRef)]), { mode: 0o600 })
      const result = run(['analyze', '--events', events, '--annotations', annotations, '--out', output])
      expect(result.status).toBe(0)
      expect(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')).schemaVersion).toBe(1)
      expect(JSON.parse(await readFile(join(output, 'metrics.json'), 'utf8')).task_success_rate).toBeDefined()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })


  it('exports sanitized numbered segments without salt or raw store files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-'))
    try {
      const store = await openTelemetryStore(join(dir, 'store'))
      const runRef = ref('2')
      expect(store.enqueue(observation(runRef, 1))).toBe(true)
      await store.flush()
      await store.dispose()
      const output = join(dir, 'events.jsonl')
      const result = run(['export', '--store', join(dir, 'store'), '--out', output])
      expect(result.status).toBe(0)
      const exported = await readFile(output, 'utf8')
      expect(exported).toContain('run-started')
      expect(exported).not.toContain('salt.bin')
      expect(exported).not.toContain('writer.lock')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('does not leave a partial output directory on invalid input or overwrite existing output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-'))
    try {
      const events = join(dir, 'events.jsonl')
      const annotations = join(dir, 'annotations.json')
      const output = join(dir, 'analysis')
      await writeFile(events, '{bad}\n', { mode: 0o600 })
      await writeFile(annotations, '[]', { mode: 0o600 })
      expect(run(['analyze', '--events', events, '--annotations', annotations, '--out', output]).status).not.toBe(0)
      await mkdir(output, { mode: 0o700 })
      expect(run(['analyze', '--events', events, '--annotations', annotations, '--out', output]).status).not.toBe(0)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
