import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const communityCandidates = [
  'dsh-lsp-actions',
  'dsh-telemetry-redactor',
  'dsh-verification-receipt',
  'dsh-engineering-workflow',
  'dsh-openai-oauth',
  'dsh-project-memory',
  'dsh-task-relay',
  'dsh-subagent-model-router',
  'DSH-Subagent-Model-Router',
  'CypherNaught-0x/DSH-Subagent-Model-Router',
  'dsh-tier-router',
  'dsh-codex-harness',
  'dsh-codex-shim',
  'dsh-minimal-first-turn',
  'dsh-proactive',
  'dsh-trace',
] as const

describe('DSH v0.1 profile', () => {
  it('composes only the base and orchestrator bundles through a direct-mode user patch', () => {
    const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
    const profile = resolve(root, 'profiles/v0.1')
    const manifest = JSON.parse(readFileSync(resolve(profile, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: string[] } }
    }
    const bundle = resolve(root, 'packages/dsh-orchestrator')
    const bundleManifest = JSON.parse(readFileSync(resolve(bundle, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    const bundlePatch = yaml.load(
      readFileSync(resolve(bundle, bundleManifest.dsh?.bundle?.patch ?? ''), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(bundlePatch)) throw new TypeError('bundle patch must be a patch list')
    const profilePatch = yaml.load(
      readFileSync(resolve(profile, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(profilePatch)) throw new TypeError('profile patch must be a patch list')
    const rows = bundlePatch.flatMap((operation): Record<string, unknown>[] =>
      typeof operation === 'object' && operation !== null
        ? (operation as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    for (const operation of profilePatch) {
      if (typeof operation !== 'object' || operation === null || !('id' in operation)) continue
      const update = operation as { id: string; config?: unknown }
      const row = rows.find(candidate => candidate.id === update.id)
      if (row !== undefined && update.config !== undefined) row.config = update.config
    }

    expect(manifest.dsh?.profile?.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@ds-plugins/dsh-orchestrator',
    ])
    expect(rows.some(row => row.id === 'ds-orchestrator')).toBe(true)
    expect(rows.find(row => row.id === 'ds-orchestrator')?.name)
      .toBe('@ds-plugins/dsh-orchestrator')

    const orchestrator = rows.find(row => row.id === 'ds-orchestrator')
    expect(orchestrator?.config).toMatchObject({
      mode: 'direct',
      budgets: { maxWorkers: 0 },
      verification: {
        commands: [
          { name: 'typecheck', executable: 'pnpm', fixedArgs: ['typecheck'] },
          { name: 'test:profile', executable: 'pnpm', fixedArgs: ['test:profile'] },
        ],
      },
    })

    const profileSources = [JSON.stringify(manifest), JSON.stringify(rows)]
    for (const candidate of communityCandidates) {
      for (const source of profileSources) expect(source).not.toContain(candidate)
    }
  })
})
