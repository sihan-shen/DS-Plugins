import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SessionId } from '@deepseek-ai/dsh-session'
import { buildSymbolIndex, createCodeIntelligenceTools, extractFallbackSymbols, parseSnapshotConfig, RepositorySnapshotStore } from '../../packages/dsh-code-intelligence/src/index.ts'

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const sourceProfileDir = join(repositoryRoot, 'profiles/v0.2b-readonly')
const pinnedWebAppManifest = join(
  repositoryRoot,
  'upstream/deepseek-harness/packages/bundle/web-app/package.json',
)

type ProfileEntry = {
  readonly id?: string
}

type LoadedProfile = {
  readonly layers: readonly { readonly patches: readonly Record<string, unknown>[] }[]
  readonly patches: readonly Record<string, unknown>[]
}

type AppBoot = {
  healProfilesModuleFallback(installAnchor: string, home: string): void
  loadProfile(binName: string, name: string, installAnchor: string, home: string, options?: { readonly userLayer?: boolean }): LoadedProfile
  composeEntries(layers: readonly (readonly Record<string, unknown>[])[]): ProfileEntry[]
  boot(
    binName: string,
    configPath: string,
    patches: readonly Record<string, unknown>[],
    prepare?: undefined,
    bareModuleBaseUrl?: string,
  ): Promise<{
    readonly fiber: { dispose(): Promise<void> }
    get(name: string): any
    inject(dependencies: readonly string[], callback: (context: {
      readonly tools: { execute(input: unknown): Promise<never> }
      readonly sessions: {
        prepare(id: ReturnType<typeof SessionId>, options: unknown): any
        enter(session: any): () => void
        announce(session: any): void
      }
      readonly workspaceRegistry: {
        create(path: string, title?: string): Promise<{ readonly path: string }>
      }
    }) => void): Promise<unknown>
  }>
}

function actualAppBoot(): Promise<AppBoot> {
  return import('@deepseek-ai/dsh-app-boot') as Promise<AppBoot>
}

function disabledRows(entries: readonly ProfileEntry[]): Record<string, unknown>[] {
  const required = new Set([
    'session',
    'session-persistence-jsonl',
    'subprocess',
    'tools',
    'system-prompt',
    'storage',
    'storage-memory',
    'storage-domain',
    'workspace',
    'dsh-code-intelligence',
  ])
  return entries.flatMap(entry => entry.id === undefined || required.has(entry.id)
    ? []
    : [{ id: entry.id, disabled: true }])
}

async function copyActualCodeProfile(root: string): Promise<string> {
  const profileDir = join(root, 'profiles/v0.2b-readonly')
  await mkdir(join(profileDir, 'src'), { recursive: true })
  await Promise.all([
    copyFile(join(sourceProfileDir, 'package.json'), join(profileDir, 'package.json')),
    copyFile(join(sourceProfileDir, 'cordis.patch.yml'), join(profileDir, 'cordis.patch.yml')),
    symlink(join(sourceProfileDir, 'node_modules'), join(profileDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'),
    writeFile(join(profileDir, 'src', 'main.ts'), 'export function replayTarget() { return true }\n'),
  ])
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n')
  return profileDir
}

export async function codeIntelligenceRuntimeReplayFixture(options: {
  readonly disableWorkspaceRegistry?: boolean
  readonly codeConfigOverrides?: Readonly<Record<string, unknown>>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-code-loader-replay-'))
  try {
    const profileDir = await copyActualCodeProfile(root)
    const appBoot = await actualAppBoot()
    appBoot.healProfilesModuleFallback(pinnedWebAppManifest, root)
    const profile = appBoot.loadProfile(
      'dsh-code-intelligence-replay',
      'v0.2b-readonly',
      pinnedWebAppManifest,
      root,
      { userLayer: false },
    )
    const profilePatches = [
      ...profile.layers.flatMap(layer => layer.patches),
      {
        id: 'dsh-code-intelligence',
        config: {
          deploymentRoot: '.',
          revision: 'code-intelligence-replay-1',
          maxFileBytes: 1_048_576,
          maxFiles: 10_000,
          maxTotalBytes: 67_108_864,
          maxDirectories: 20_000,
          maxIgnoreBytes: 262_144,
          nestedCheckoutRoots: [],
          ...options.codeConfigOverrides,
        },
      },
      {
        insert: [{
          id: 'storage-memory',
          name: fileURLToPath(new URL('./workspace-memory-backend.fixture.mjs', import.meta.url)),
        }],
      },
      { id: 'storage-domain', config: { backend: 'memory' } },
    ]
    const entries = appBoot.composeEntries([profilePatches])
    const bootPatches = [
      ...profilePatches,
      ...disabledRows(entries),
      ...(options.disableWorkspaceRegistry ? [{ id: 'workspace', disabled: true }] : []),
    ]
    const context = await appBoot.boot(
      'dsh-code-intelligence-replay',
      join(profileDir, 'cordis.yml'),
      bootPatches,
      undefined,
      pathToFileURL(join(profileDir, 'package.json')).href,
    )
    if (options.disableWorkspaceRegistry) {
      await context.fiber.dispose()
      throw new Error('code intelligence unexpectedly booted without workspaceRegistry')
    }
    if (options.codeConfigOverrides !== undefined) {
      await context.fiber.dispose()
      throw new Error('code intelligence unexpectedly booted with invalid config')
    }
    let services: {
      readonly tools: { execute(input: unknown): Promise<any> }
      readonly sessions: {
        prepare(id: ReturnType<typeof SessionId>, options: unknown): any
        enter(session: any): () => void
        announce(session: any): void
      }
      readonly workspaceRegistry: {
        create(path: string, title?: string): Promise<{ readonly path: string }>
      }
    } | undefined
    await context.inject(['tools', 'sessions', 'workspaceRegistry'], child => { services = child })
    if (services === undefined) {
      throw new Error('actual code intelligence profile did not inject tools, sessions, and workspaceRegistry')
    }
    await services.workspaceRegistry.create(profileDir, 'replay-root')
    const session = services.sessions.prepare(
      SessionId('code-intelligence-replay-root'),
      { meta: { cwd: profileDir } },
    )
    let disposeSession = services.sessions.enter(session)
    services.sessions.announce(session)
    return {
      root,
      workspaceRoot: profileDir,
      context,
      tools: services.tools,
      sessions: services.sessions,
      workspaceRegistry: services.workspaceRegistry,
      session,
      createSession(id: string, cwd: string) {
        const created = services!.sessions.prepare(SessionId(id), { meta: { cwd } })
        const detach = services!.sessions.enter(created)
        services!.sessions.announce(created)
        return { session: created, dispose: detach }
      },
      disposeSession() {
        disposeSession()
        disposeSession = () => undefined
      },
      async dispose() {
        try {
          disposeSession()
          await context.fiber.dispose()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export async function codeIntelligenceReplayFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-code-replay-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'main.ts'), 'export function replayTarget() { return true }\n')
  await writeFile(join(root, 'src', 'secondary.ts'), 'export const secondary = 1\n')
  const store = await RepositorySnapshotStore.create(parseSnapshotConfig({
    deploymentRoot: root,
    revision: 'replay-fixture-1',
    maxFileBytes: 1_048_576,
    maxFiles: 10_000,
    maxTotalBytes: 67_108_864,
    maxDirectories: 20_000,
    maxIgnoreBytes: 262_144,
    nestedCheckoutRoots: [],
  }))
  const adapter = await extractFallbackSymbols(store)
  const index = buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries)
  const [repoMap, symbolQuery] = createCodeIntelligenceTools({ snapshot: store.snapshot, index })
  return { root, store, index, repoMap, symbolQuery, dispose: () => rm(root, { recursive: true, force: true }) }
}
