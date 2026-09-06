import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { canonicalJson, parseRunAnnotationV1, parseTelemetryRecordV1, type DatasetV1 } from '@ds-plugins/dsh-telemetry/contracts'
import { buildCandidates } from './candidates.js'
import { parseDatasetV1, getValidatedCompleteRunsV1 } from './dataset.js'
import { computeTelemetryMetrics } from './metrics.js'
import { calibrateModels } from './calibration.js'
import { buildLessons, writeLesson } from './lessons.js'
import { mineFailures } from './miner.js'

const MAX_INPUT_BYTES = 8 * 1024 * 1024
const MAX_ANNOTATION_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_OUTPUT_FILES = 4096
const SEGMENT = /^segment-\d{16}\.jsonl$/u
const fail = (message: string): never => { throw new Error(message) }

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function json(value: unknown): string { return `${canonicalJson(value)}\n` }
async function ensureAbsent(path: string): Promise<void> {
  try { await lstat(path); fail('output already exists') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
async function privateRegular(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail('telemetry input is not a private regular file')
}
async function readBounded(path: string, maximum: number): Promise<Buffer> {
  if (!isAbsolute(path)) fail('input paths must be absolute')
  await privateRegular(path)
  const info = await stat(path)
  if (info.size > maximum) fail('input exceeds byte limit')
  return readFile(path)
}
function parseJsonLines(bytes: Buffer, label: string): unknown[] {
  const text = bytes.toString('utf8')
  if (text.length && !text.endsWith('\n')) fail(`${label} has truncated final line`)
  const rows: unknown[] = []
  for (const [index, line] of text.split('\n').slice(0, -1).entries()) {
    if (!line) continue
    try { rows.push(JSON.parse(line)) } catch { fail(`${label} has invalid line ${index + 1}`) }
  }
  return rows
}
async function acquireLock(root: string): Promise<{ close: () => Promise<void> }> {
  const path = join(root, 'writer.lock')
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const identity = await handle.stat()
  return { close: async () => {
    await handle.close()
    try {
      const current = await lstat(path)
      if (current.dev === identity.dev && current.ino === identity.ino) await rm(path)
    } catch { /* the lock may already have been recovered */ }
  } }
}
async function exportStore(store: string, out: string): Promise<void> {
  if (!isAbsolute(store) || !isAbsolute(out)) fail('store and output paths must be absolute')
  await ensureAbsent(out)
  const root = resolve(store)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || (rootInfo.mode & 0o077) !== 0) fail('store must be a private directory')
  const lock = await acquireLock(root)
  try {
    const names = (await readdir(root)).filter(name => SEGMENT.test(name)).sort()
    let total = 0
    let inputBytes = 0
    const chunks: Buffer[] = []
    for (const name of names) {
      const path = join(root, name)
      const bytes = await readBounded(path, 1024 * 1024)
      inputBytes += bytes.byteLength
      if (inputBytes > MAX_INPUT_BYTES) fail('telemetry input exceeds byte limit')
      const rows = parseJsonLines(bytes, name)
      for (const row of rows) {
        const record = parseTelemetryRecordV1(row)
        const line = Buffer.from(json(record))
        total += line.byteLength
        if (total > MAX_OUTPUT_BYTES) fail('export exceeds output byte limit')
        chunks.push(line)
      }
    }
    await ensureAbsent(out)
    await writeFile(out, Buffer.concat(chunks), { mode: 0o600, flag: 'wx' })
  } finally { await lock.close() }
}
async function writeArtifact(path: string, value: unknown, state: { bytes: number; files: number }): Promise<void> {
  const content = Buffer.from(json(value))
  state.bytes += content.byteLength; state.files += 1
  if (state.bytes > MAX_OUTPUT_BYTES || state.files > MAX_OUTPUT_FILES) fail('analysis output exceeds artifact limits')
  await writeFile(path, content, { mode: 0o600, flag: 'wx' })
}
async function analyze(eventsPath: string, annotationsPath: string, out: string): Promise<void> {
  if (!isAbsolute(out)) fail('output path must be absolute')
  await ensureAbsent(out)
  const eventsBytes = await readBounded(eventsPath, MAX_INPUT_BYTES)
  const annotationsBytes = await readBounded(annotationsPath, MAX_ANNOTATION_BYTES)
  const records = parseJsonLines(eventsBytes, 'events')
  const annotationValues = JSON.parse(annotationsBytes.toString('utf8'))
  if (!Array.isArray(annotationValues)) fail('annotations must be an array')
  annotationValues.forEach((value: unknown) => parseRunAnnotationV1(value))
  const dataset = parseDatasetV1(records, annotationValues)
  const patterns = mineFailures(dataset)
  const lessons = buildLessons(patterns)
  const candidates = buildCandidates(lessons, dataset)
  const completeRuns = getValidatedCompleteRunsV1(dataset)
  const unknownRuns = dataset.annotations.filter(annotation => annotation.outcome === 'unknown').length
  const incompleteRuns = new Set(dataset.records.map(record => `${record.domainRef}:${record.runRef}`)).size - completeRuns.length
  const stage = await import('node:fs/promises').then(fs => fs.mkdtemp(join(dirname(out), '.dsh-analysis-')))
  const state = { bytes: 0, files: 0 }
  try {
    await mkdir(join(stage, 'lessons'), { mode: 0o700 }); await mkdir(join(stage, 'candidates'), { mode: 0o700 })
    await writeArtifact(join(stage, 'metrics.json'), computeTelemetryMetrics(dataset), state)
    await writeArtifact(join(stage, 'patterns.json'), patterns, state)
    await writeArtifact(join(stage, 'calibration.json'), calibrateModels(dataset), state)
    for (const lesson of lessons) await writeArtifact(join(stage, 'lessons', `${lesson.id}.json`), lesson, state)
    for (const candidate of candidates) await writeArtifact(join(stage, 'candidates', `${candidate.id}.json`), candidate, state)
    const manifest = {
      schemaVersion: 1,
      eventsSha256: digest(eventsBytes),
      annotationsSha256: digest(annotationsBytes),
      recordCount: dataset.records.length,
      annotationCount: dataset.annotations.length,
      completeRunCount: completeRuns.length,
      unknownRunCount: unknownRuns,
      incompleteRunCount: Math.max(0, incompleteRuns),
    }
    await writeArtifact(join(stage, 'manifest.json'), manifest, state)
    await rename(stage, out)
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error }
}
function value(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  if (index < 0 || args[index + 1] === undefined || args[index + 1].startsWith('--')) fail(`missing ${flag}`)
  return args[index + 1]
}
export async function runCli(args: string[]): Promise<void> {
  const command = args[0]
  if (command === 'export') return exportStore(value(args, '--store'), value(args, '--out'))
  if (command === 'analyze') return analyze(value(args, '--events'), value(args, '--annotations'), value(args, '--out'))
  fail('unknown command')
}
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'telemetry command failed'}\n`); process.exitCode = 1 })
}
