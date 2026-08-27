import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore from '@deepseek-ai/dsh-session'

const directConfig = {
  workspaceRoot: '.',
  mode: 'direct',
  worker: { provider: 'replay', model: 'replay', maxTokens: 32_000 },
  budgets: { maxWorkers: 0, maxPluginToolActions: 2, toolTimeoutMs: 60_000 },
  verification: {
    commands: [{ name: 'typecheck', executable: 'pnpm', fixedArgs: ['typecheck'], allowedArgs: 'none' }],
    timeoutMs: 60_000,
    maxOutputBytes: 4_096,
  },
}

const singleWorkerConfig = {
  ...directConfig,
  mode: 'single-worker',
  budgets: { ...directConfig.budgets, maxWorkers: 1 },
}

interface ToolRegistry {
  register(tool: { readonly name: string }): () => void
  get(name: string): { readonly name: string } | undefined
}

function toolRegistry(): ToolRegistry {
  const tools = new Map<string, { readonly name: string }>()
  return {
    register(tool) {
      if (tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`)
      tools.set(tool.name, tool)
      return () => { tools.delete(tool.name) }
    },
    get(name) { return tools.get(name) },
  }
}

function testSystemPrompt(ctx: Context) {
  ctx.provide('systemPrompt', {
    section: () => () => undefined,
  } as never)
}

function testSubprocess(ctx: Context) {
  ctx.provide('subprocess', {
    spawn: () => { throw new Error('Loader composition must not execute verification') },
  } as never)
}

function testSubagents(ctx: Context) {
  ctx.provide('subagents', {
    start: async () => { throw new Error('Loader composition must not start a worker') },
  } as never)
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function readProfileDependencies(): Promise<Record<string, string>> {
  const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
  const manifest = JSON.parse(await readFile(join(repositoryRoot, 'profiles/v0.1/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  return manifest.dependencies ?? {}
}

async function loadBuiltOrchestrator(config: object, includeSubagents: boolean): Promise<{ tools: ToolRegistry; imports: string[] }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-orchestrator-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- id: sessions\n  name: '@deepseek-ai/dsh-session'",
    "- id: system-prompt\n  name: 'dsh-test:system-prompt'",
    "- id: tools\n  name: 'dsh-test:tools'",
    "- id: subprocess\n  name: 'dsh-test:subprocess'",
    ...includeSubagents ? ["- id: subagents\n  name: 'dsh-test:subagents'"] : [],
    "- id: ds-orchestrator\n  name: '@ds-plugins/dsh-orchestrator'\n  config:",
    ...Object.entries(config).flatMap(([key, value]) => {
      if (key === 'worker' || key === 'budgets' || key === 'verification') return []
      return [`    ${key}: ${typeof value === 'string' ? value : String(value)}`]
    }),
    `    worker:\n      provider: ${String((config as typeof directConfig).worker.provider)}\n      model: ${String((config as typeof directConfig).worker.model)}\n      maxTokens: ${String((config as typeof directConfig).worker.maxTokens)}`,
    `    budgets:\n      maxWorkers: ${String((config as typeof directConfig).budgets.maxWorkers)}\n      maxPluginToolActions: ${String((config as typeof directConfig).budgets.maxPluginToolActions)}\n      toolTimeoutMs: ${String((config as typeof directConfig).budgets.toolTimeoutMs)}`,
    "    verification:\n      commands:\n        - name: typecheck\n          executable: pnpm\n          fixedArgs: [typecheck]\n          allowedArgs: none\n      timeoutMs: 60000\n      maxOutputBytes: 4096",
    '',
  ].join('\n'))

  const imports: string[] = []
  const orchestrator = await import('@ds-plugins/dsh-orchestrator')
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const tools = toolRegistry()
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['dsh-test:system-prompt', testSystemPrompt],
    ['dsh-test:tools', (ctx: Context) => ctx.provide('tools', tools as never)],
    ['dsh-test:subprocess', testSubprocess],
    ['dsh-test:subagents', testSubagents],
    ['@ds-plugins/dsh-orchestrator', orchestrator],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      imports.push(specifier)
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  const rootInclude: EntryOptions = {
    id: 'include',
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  }
  await context.loader.create(rootInclude)
  await context.loader.await()
  return { tools, imports }
}

describe('built DSH v0.1 profile Loader composition', () => {
  it('declares each Direct-mode Loader dependency in the profile resolver manifest', async () => {
    const dependencies = await readProfileDependencies()
    expect(dependencies).toMatchObject({
      '@deepseek-ai/dsh-session': '0.1.1-rc.2',
      '@deepseek-ai/dsh-subprocess': '0.1.1-rc.2',
      '@deepseek-ai/dsh-system-prompt': '0.1.1-rc.2',
      '@deepseek-ai/dsh-tools': '0.1.1-rc.2',
      '@ds-plugins/dsh-orchestrator': 'workspace:*',
    })
  })

  it('imports the built package entry for Direct mode and removes its registrations on disposal', async () => {
    const loaded = await loadBuiltOrchestrator(directConfig, false)
    expect(loaded.imports).toContain('@ds-plugins/dsh-orchestrator')
    expect(loaded.imports).not.toContain('../src/index.ts')
    expect(loaded.tools.get('targeted_verify')).toBeDefined()
    expect(loaded.tools.get('delegate_worker')).toBeUndefined()

    const orchestratorEntry = [...context?.loader.entries() ?? []]
      .find(entry => entry.options.name === '@ds-plugins/dsh-orchestrator')
    expect(orchestratorEntry?.id).toBe('include:ds-orchestrator')
    if (orchestratorEntry === undefined) throw new Error('missing orchestrator Loader entry')
    // A profile unloads through its root Include. Loader's public root remove
    // operation does not accept an already-prefixed nested child id here.
    await context?.loader.remove('include')
    expect(loaded.tools.get('targeted_verify')).toBeUndefined()
  })

  it('keeps a missing optional subagents service isolated to Single Worker mode', async () => {
    const direct = await loadBuiltOrchestrator(directConfig, false)
    expect(direct.tools.get('targeted_verify')).toBeDefined()
    expect(direct.tools.get('delegate_worker')).toBeUndefined()
    await context?.fiber.dispose()
    context = undefined

    const singleWithoutService = await loadBuiltOrchestrator(singleWorkerConfig, false)
    expect(singleWithoutService.tools.get('targeted_verify')).toBeDefined()
    expect(singleWithoutService.tools.get('delegate_worker')).toBeUndefined()
    await context?.fiber.dispose()
    context = undefined

    const singleWithService = await loadBuiltOrchestrator(singleWorkerConfig, true)
    expect(singleWithService.tools.get('targeted_verify')).toBeDefined()
    expect(singleWithService.tools.get('delegate_worker')).toBeDefined()
  })
})
