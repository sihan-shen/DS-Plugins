import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionId } from '@deepseek-ai/dsh-session'
import { injectedServices, injectedTelemetry, loadActualProfile } from '../../packages/dsh-orchestrator/tests/loader.spec.js'

export async function withTelemetryLoader<T>(callback: (value: {
  readonly runtime: Awaited<ReturnType<typeof loadActualProfile>>
  readonly storageRoot: string
  readonly services: Awaited<ReturnType<typeof injectedServices>>
  readonly telemetry: Awaited<ReturnType<typeof injectedTelemetry>>
}) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-telemetry-loader-'))
  const storageRoot = join(root, 'telemetry')
  const runtime = await loadActualProfile({ profile: 'v0.3-adaptive', mode: 'single-worker', telemetryStorageRoot: storageRoot, telemetryDirect: true })
  try {
    const services = await injectedServices(runtime.context)
    const telemetry = await injectedTelemetry(runtime.context)
    return await callback({ runtime, storageRoot, services, telemetry })
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

export async function readTelemetrySegments(root: string): Promise<unknown[]> {
  const names = (await readdir(root)).filter(name => /^segment-\d{16}\.jsonl$/u.test(name)).sort()
  const rows: unknown[] = []
  for (const name of names) {
    const text = await readFile(join(root, name), 'utf8')
    for (const line of text.split('\n')) if (line) rows.push(JSON.parse(line))
  }
  return rows
}

export function createRootSession(services: Awaited<ReturnType<typeof injectedServices>>, id: string) {
  const sessions = services.sessions as unknown as {
    prepare(id: ReturnType<typeof SessionId>, options: unknown): any
    enter(session: any): () => void
    announce(session: any): void
  }
  const session = sessions.prepare(SessionId(id), { meta: { cwd: process.cwd() } })
  const detach = sessions.enter(session)
  sessions.announce(session)
  return { session, detach }
}
