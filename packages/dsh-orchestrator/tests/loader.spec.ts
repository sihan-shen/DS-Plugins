import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const sourceProfileDir = join(repositoryRoot, 'profiles/v0.1')
const sourceProfileManifest = join(sourceProfileDir, 'package.json')
const sourceProfilePatch = join(sourceProfileDir, 'cordis.patch.yml')
const sourceProfileModules = join(sourceProfileDir, 'node_modules')

interface ProfileLayer {
  readonly patches: readonly Record<string, unknown>[]
}

interface LoadedProfile {
  readonly dir: string
  readonly layers: readonly ProfileLayer[]
  readonly patches: readonly Record<string, unknown>[]
}

interface ProfileEntry {
  readonly id?: string
  readonly name?: string
  readonly config?: unknown
}

interface BootedContext {
  readonly fiber: { dispose(): Promise<void> }
  readonly loader: {
    entries(): Iterable<{ readonly id: string; readonly options: { readonly name: string } }>
    remove(id: string): Promise<void>
  }
  get(name: 'tools'): { get(name: string): unknown } | undefined
}

interface AppBoot {
  healProfilesModuleFallback(installAnchor: string, home: string): void
  loadProfile(binName: string, name: string, installAnchor: string, home: string): LoadedProfile
  composeEntries(layers: readonly (readonly Record<string, unknown>[])[]): ProfileEntry[]
  boot(
    binName: string,
    configPath: string,
    patches: readonly Record<string, unknown>[],
  ): Promise<BootedContext>
}

interface ProfileLoadOptions {
  readonly mode: 'direct' | 'single-worker'
}

interface LoadedProfileRuntime {
  readonly root: string
  readonly resolvedOrchestratorEntry: string
  readonly context: BootedContext
  dispose(): Promise<void>
}

function actualAppBoot(): Promise<AppBoot> {
  return import('@deepseek-ai/dsh-app-boot') as Promise<AppBoot>
}

function profileRequire(profileDir: string) {
  return createRequire(join(profileDir, 'package.json'))
}

function disabledRows(entries: readonly ProfileEntry[]): Record<string, unknown>[] {
  const required = new Set(['session', 'subprocess', 'tools', 'system-prompt', 'ds-orchestrator'])
  return entries.flatMap(entry => entry.id === undefined || required.has(entry.id)
    ? []
    : [{ id: entry.id, disabled: true }])
}

function singleWorkerOverlay(entries: readonly ProfileEntry[]): Record<string, unknown> {
  const orchestrator = entries.find(entry => entry.id === 'ds-orchestrator')
  if (orchestrator?.config === undefined || typeof orchestrator.config !== 'object' || Array.isArray(orchestrator.config)) {
    throw new Error('actual profile did not compose the ds-orchestrator configuration')
  }
  const config = structuredClone(orchestrator.config) as Record<string, unknown>
  const budgets = config.budgets
  if (budgets === undefined || typeof budgets !== 'object' || Array.isArray(budgets)) {
    throw new Error('actual profile ds-orchestrator configuration has no budgets')
  }
  return {
    id: 'ds-orchestrator',
    config: {
      ...config,
      mode: 'single-worker',
      budgets: { ...(budgets as Record<string, unknown>), maxWorkers: 1 },
    },
  }
}

async function copyActualProfile(root: string): Promise<string> {
  const profileDir = join(root, 'profiles/v0.1')
  await mkdir(profileDir, { recursive: true })
  await Promise.all([
    copyFile(sourceProfileManifest, join(profileDir, 'package.json')),
    copyFile(sourceProfilePatch, join(profileDir, 'cordis.patch.yml')),
  ])
  await symlink(sourceProfileModules, join(profileDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n')
  return profileDir
}

async function loadActualProfile(options: ProfileLoadOptions): Promise<LoadedProfileRuntime> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-orchestrator-profile-'))
  try {
    const profileDir = await copyActualProfile(root)
    const appBoot = await actualAppBoot()
    const resolver = profileRequire(profileDir)
    const dshBaseManifest = resolver.resolve('@deepseek-ai/dsh-base/package.json')
    appBoot.healProfilesModuleFallback(dshBaseManifest, root)
    const profile = appBoot.loadProfile('dsh-orchestrator-loader-test', 'v0.1', dshBaseManifest, root)
    const profilePatches = [
      ...profile.layers.flatMap(layer => layer.patches),
      ...profile.patches,
    ]
    const entries = appBoot.composeEntries([profilePatches])
    const patches = [
      ...profilePatches,
      ...disabledRows(entries),
      ...(options.mode === 'single-worker' ? [singleWorkerOverlay(entries)] : []),
    ]
    const resolvedOrchestratorEntry = resolver.resolve('@ds-plugins/dsh-orchestrator')
    const context = await appBoot.boot(
      'dsh-orchestrator-loader-test',
      join(profile.dir, 'cordis.yml'),
      patches,
    )
    return {
      root,
      resolvedOrchestratorEntry,
      context,
      async dispose() {
        try {
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

async function withActualProfile<T>(options: ProfileLoadOptions, callback: (runtime: LoadedProfileRuntime) => Promise<T>): Promise<T> {
  const runtime = await loadActualProfile(options)
  try {
    return await callback(runtime)
  } finally {
    await runtime.dispose()
  }
}

describe('built DSH v0.1 profile Loader composition', () => {
  it('requires the test command to build the profile-resolved package entry', () => {
    const entry = profileRequire(sourceProfileDir).resolve('@ds-plugins/dsh-orchestrator')
    expect(entry).toMatch(/[\\/]packages[\\/]dsh-orchestrator[\\/]lib[\\/]index\.mjs$/)
  })

  it('boots the actual Direct profile through the bare built package entry and disposes it through the root Include', async () => {
    let root = ''
    await withActualProfile({ mode: 'direct' }, async (runtime) => {
      root = runtime.root
      expect(runtime.resolvedOrchestratorEntry).toMatch(/[\\/]packages[\\/]dsh-orchestrator[\\/]lib[\\/]index\.mjs$/)
      expect(runtime.resolvedOrchestratorEntry).not.toMatch(/[\\/]src[\\/]/)
      const entry = [...runtime.context.loader.entries()].find(candidate => candidate.id === 'include:ds-orchestrator')
      expect(entry?.options.name).toBe('@ds-plugins/dsh-orchestrator')
      expect(runtime.context.get('tools')?.get('targeted_verify')).toBeDefined()
      expect(runtime.context.get('tools')?.get('delegate_worker')).toBeUndefined()

      await runtime.context.loader.remove('include')
      expect(runtime.context.get('tools')?.get('targeted_verify')).toBeUndefined()
    })
    expect(existsSync(root)).toBe(false)
  })

  it('keeps a missing subagents service isolated to an independently cleaned Single Worker overlay', async () => {
    let root = ''
    await withActualProfile({ mode: 'single-worker' }, async (runtime) => {
      root = runtime.root
      expect(runtime.context.get('tools')?.get('targeted_verify')).toBeDefined()
      expect(runtime.context.get('tools')?.get('delegate_worker')).toBeUndefined()
    })
    expect(existsSync(root)).toBe(false)
  })
})
