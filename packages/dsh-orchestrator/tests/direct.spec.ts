import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { apply, inject } from '../src/index.ts'
import type { OrchestratorConfig } from '../src/types.ts'

const config: OrchestratorConfig = {
  workspaceRoot: '/workspace/ds-plugins',
  mode: 'direct',
  worker: {
    provider: 'openai-codex',
    model: 'gpt-5.6-codex',
    maxTokens: 32_000,
  },
  budgets: {
    maxWorkers: 0,
    maxPluginToolActions: 2,
    toolTimeoutMs: 60_000,
  },
  verification: {
    commands: [{
      name: 'typecheck',
      executable: 'pnpm',
      fixedArgs: ['typecheck'],
      allowedArgs: 'none',
    }],
    timeoutMs: 60_000,
    maxOutputBytes: 4_096,
  },
}

interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string
}

function promptRegistry() {
  const sections = new Map<string, PromptSection>()
  return {
    section(section: PromptSection) {
      if (sections.has(section.name)) throw new Error(`duplicate prompt section: ${section.name}`)
      sections.set(section.name, section)
      return () => { sections.delete(section.name) }
    },
    assembledPrompt() {
      return [...sections.values()]
        .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
        .map(section => section.text)
        .join('\n\n')
    },
    sectionNames() {
      return [...sections.keys()]
    },
  }
}

function toolRegistry() {
  const tools = new Map<string, { readonly name: string }>()
  return {
    register(tool: { readonly name: string }) {
      if (tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`)
      tools.set(tool.name, tool)
      return () => { tools.delete(tool.name) }
    },
    get(name: string) {
      return tools.get(name)
    },
  }
}

async function mountedDirectMode() {
  const ctx = new Context()
  const sessionStore = await ctx.plugin(SessionStore)
  const prompts = promptRegistry()
  const tools = toolRegistry()
  ctx.provide('systemPrompt', prompts as never)
  ctx.provide('tools', tools as never)
  ctx.provide('subprocess', { spawn: () => { throw new Error('verification must not run in this test') } } as never)

  const fiber = await ctx.plugin(apply, config)
  return { ctx, sessionStore, fiber, prompts, tools }
}

function appendRootRequest(ctx: Context, sessionId: string) {
  const session = ctx.sessions.create(SessionId(sessionId), {
    meta: { cwd: '/workspace/ds-plugins' },
  })
  session.append('request/header', {
    header: { config: { provider: 'openai-codex', model: 'gpt-5.6-codex' } },
    reason: 'initial',
  })
  return session
}

describe('Direct orchestrator mode', () => {
  it('registers only targeted verification, a bounded prompt section, and one durable root run record', async () => {
    const { ctx, sessionStore, fiber, prompts, tools } = await mountedDirectMode()

    expect(inject).toEqual(['systemPrompt', 'tools', 'sessions', 'subprocess'])
    expect(tools.get('targeted_verify')).toBeDefined()
    expect(tools.get('delegate_worker')).toBeUndefined()
    expect(prompts.sectionNames()).toEqual(['ds-plugins:orchestrator'])
    const assembledPrompt = prompts.assembledPrompt()
    expect(assembledPrompt).toContain('Complete the coding task in this session. Use targeted_verify only for configured checks.')
    expect(assembledPrompt).toContain('Report only verification that was actually run')
    expect(assembledPrompt).toContain('Do not claim that an execution receipt proves correctness.')
    expect(assembledPrompt).not.toContain('openai-codex')
    expect(assembledPrompt).not.toContain('gpt-5.6-codex')
    expect(assembledPrompt).not.toContain('SECRET_TRANSCRIPT_MARKER')

    const root = appendRootRequest(ctx, 'direct-root')
    root.append('request/header', {
      header: { config: { provider: 'openai-codex', model: 'gpt-5.6-codex' } },
      reason: 'resume',
    })
    await Promise.resolve()

    expect(root.events.filter(event => event.type === 'dsh-plugin/run-started')).toEqual([
      expect.objectContaining({
        data: {
          schemaVersion: 1,
          mode: 'direct',
          provider: 'openai-codex',
          model: 'gpt-5.6-codex',
        },
      }),
    ])

    await fiber.dispose()
    expect(tools.get('targeted_verify')).toBeUndefined()
    expect(prompts.sectionNames()).toEqual([])
    await sessionStore.dispose()
  })

  it('remounts without duplicating its prompt, tool, or root-session listener', async () => {
    const first = await mountedDirectMode()
    await first.fiber.dispose()

    const secondFiber = await first.ctx.plugin(apply, config)
    expect(first.prompts.sectionNames()).toEqual(['ds-plugins:orchestrator'])
    expect(first.tools.get('targeted_verify')).toBeDefined()

    const root = appendRootRequest(first.ctx, 'direct-remount-root')
    await Promise.resolve()
    expect(root.events.filter(event => event.type === 'dsh-plugin/run-started')).toHaveLength(1)

    await secondFiber.dispose()
    await first.sessionStore.dispose()
  })
})
