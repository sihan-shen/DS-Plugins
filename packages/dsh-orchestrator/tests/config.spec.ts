import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { parseConfig } from '../src/config.ts'

const validConfig = {
  mode: 'direct',
  worker: {
    provider: 'openai-codex',
    model: 'gpt-5.6-codex',
    maxTokens: 32_000,
  },
  budgets: {
    maxWorkers: 0,
    maxPluginToolActions: 24,
    toolTimeoutMs: 60_000,
  },
  verification: {
    commands: [
      {
        name: 'typecheck',
        executable: 'pnpm',
        fixedArgs: ['typecheck'],
      },
    ],
    timeoutMs: 120_000,
    maxOutputBytes: 65_536,
  },
} as const

function configWith(patch: Record<string, unknown>) {
  return {
    ...validConfig,
    budgets: {
      ...validConfig.budgets,
      ...patch,
    },
  }
}

function configWithVerificationExecutable(executable: string) {
  return {
    ...validConfig,
    verification: {
      ...validConfig.verification,
      commands: [
        {
          ...validConfig.verification.commands[0],
          executable,
        },
      ],
    },
  }
}

describe('parseConfig', () => {
  it('returns valid bounded configuration', () => {
    expect(parseConfig(validConfig)).toEqual(validConfig)
  })

  it('accepts the v0.1 profile configuration at Cordis load time', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
    const patch = yaml.load(readFileSync(resolve(root, 'profiles/v0.1/cordis.patch.yml'), 'utf8'))
    if (!Array.isArray(patch)) throw new TypeError('profile patch must be a list')
    const entry = patch.find(value => typeof value === 'object' && value !== null && 'id' in value && value.id === 'ds-orchestrator')
    if (entry === undefined || typeof entry !== 'object' || entry === null || !('config' in entry)) {
      throw new TypeError('profile patch must configure ds-orchestrator')
    }

    expect(parseConfig(entry.config)).toMatchObject({
      mode: 'direct',
      budgets: { maxWorkers: 0 },
      verification: {
        commands: [
          { name: 'typecheck', executable: 'pnpm', fixedArgs: ['typecheck'] },
          { name: 'test:profile', executable: 'pnpm', fixedArgs: ['test:profile'] },
        ],
      },
    })
  })

  it('requires direct mode to disable workers', () => {
    expect(() => parseConfig({ ...validConfig, budgets: { ...validConfig.budgets, maxWorkers: 1 } }))
      .toThrow(/direct.*maxWorkers.*0/)
  })

  it('requires single-worker mode to admit exactly one worker', () => {
    expect(() => parseConfig({ ...validConfig, mode: 'single-worker', budgets: { ...validConfig.budgets, maxWorkers: 0 } }))
      .toThrow(/single-worker.*maxWorkers.*1/)
  })

  it('rejects a non-positive tool timeout', () => {
    expect(() => parseConfig(configWith({ toolTimeoutMs: 0 }))).toThrow(/toolTimeoutMs/)
  })

  it('rejects a non-integral plugin tool action limit', () => {
    expect(() => parseConfig(configWith({ maxPluginToolActions: 1.5 }))).toThrow(/maxPluginToolActions/)
  })

  it('rejects shell strings as verification executables', () => {
    expect(() => parseConfig(configWithVerificationExecutable('sh -c'))).toThrow(/executable/)
  })

  it('rejects duplicate verification command names', () => {
    expect(() => parseConfig({
      ...validConfig,
      verification: {
        ...validConfig.verification,
        commands: [
          validConfig.verification.commands[0],
          { name: 'typecheck', executable: 'pnpm', fixedArgs: ['test'] },
        ],
      },
    })).toThrow(/verification\.commands.*duplicate.*typecheck/i)
  })

  it.each([
    ['provider', { ...validConfig, worker: { ...validConfig.worker, provider: '' } }],
    ['model', { ...validConfig, worker: { ...validConfig.worker, model: '' } }],
  ])('rejects an empty worker %s', (_field, config) => {
    expect(() => parseConfig(config)).toThrow(/worker\.(provider|model)/)
  })
})
