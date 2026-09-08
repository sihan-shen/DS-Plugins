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
  readonly removeTelemetry: () => Promise<void>
  readonly reloadTelemetry: () => ReturnType<typeof injectedTelemetry>
}) => Promise<T>, options: { readonly parallel?: boolean } = {}): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-telemetry-loader-'))
  const storageRoot = join(root, 'telemetry')
  const parallel = options.parallel ?? false
  const runtime = await loadActualProfile({
    profile: 'v0.3-adaptive',
    mode: 'single-worker',
    enableSubagents: parallel,
    parallelOverlay: parallel,
    telemetryStorageRoot: storageRoot,
    telemetryDirect: !parallel,
  })
  try {
    const services = await injectedServices(runtime.context, parallel)
    const telemetry = await injectedTelemetry(runtime.context)
    const loader = runtime.context.loader as unknown as {
      create(options: unknown, parent?: string): Promise<string>
      entries(): Iterable<{
        readonly id: string
        readonly options: { readonly id: string }
        readonly parent: { remove(id: string): Promise<void> }
      }>
    }
    return await callback({
      runtime,
      storageRoot,
      services,
      telemetry,
      removeTelemetry: async () => {
        const entry = [...loader.entries()].find(candidate => candidate.id === 'include:dsh-telemetry')
        if (entry === undefined) throw new Error('actual Loader profile did not retain the telemetry entry')
        await entry.parent.remove(entry.options.id)
      },
      reloadTelemetry: async () => {
        await loader.create({
          id: 'dsh-telemetry',
          name: '@han_05/dsh-telemetry',
          config: { enabled: true, storageRoot },
        }, 'include')
        return injectedTelemetry(runtime.context)
      },
    })
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

export async function withControlAndTelemetryLoaders<T>(callback: (value: {
  readonly controlServices: Awaited<ReturnType<typeof injectedServices>>
  readonly services: Awaited<ReturnType<typeof injectedServices>>
  readonly storageRoot: string
  readonly telemetry: Awaited<ReturnType<typeof injectedTelemetry>>
}) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-telemetry-control-'))
  const storageRoot = join(root, 'telemetry')
  const controlRuntime = await loadActualProfile({
    profile: 'v0.1',
    mode: 'direct',
    enableSubagents: false,
  })
  const runtime = await loadActualProfile({
    profile: 'v0.1',
    mode: 'direct',
    enableSubagents: false,
    telemetryStorageRoot: storageRoot,
    telemetryDirect: true,
  })
  try {
    const controlServices = await injectedServices(controlRuntime.context, false)
    const services = await injectedServices(runtime.context, false)
    const telemetry = await injectedTelemetry(runtime.context)
    return await callback({ controlServices, services, storageRoot, telemetry })
  } finally {
    await runtime.dispose()
    await controlRuntime.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

export async function withUnavailableTelemetryLoader<T>(callback: (value: {
  readonly runtime: Awaited<ReturnType<typeof loadActualProfile>>
  readonly storageRoot: string
  readonly services: Awaited<ReturnType<typeof injectedServices>>
}) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-telemetry-unavailable-'))
  const storageRoot = join(root, 'missing-parent', 'telemetry')
  const runtime = await loadActualProfile({
    profile: 'v0.3-adaptive',
    mode: 'single-worker',
    enableSubagents: true,
    telemetryStorageRoot: storageRoot,
  })
  try {
    const services = await injectedServices(runtime.context, true)
    return await callback({ runtime, storageRoot, services })
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
