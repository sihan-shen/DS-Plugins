import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/plugin.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function config(root: string) {
  return {
    deploymentRoot: root,
    revision: 'loader-fixture-1',
    maxFileBytes: 1_048_576,
    maxFiles: 10_000,
    maxTotalBytes: 67_108_864,
    maxDirectories: 20_000,
    maxIgnoreBytes: 262_144,
    nestedCheckoutRoots: [],
  }
}

describe('loadable code intelligence bundle', () => {
  it('registers exactly two tools and removes them through one lifecycle effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-loader-'))
    roots.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'main.ts'), 'export function main() { return true }\n')
    const values = new Map<string, unknown>()
    const disposers: Array<() => void> = []
    const ctx = {
      tools: { register(tool: { readonly name: string }) { values.set(tool.name, tool); return () => { values.delete(tool.name) } } },
      effect(effect: () => () => void) { const dispose = effect(); disposers.push(dispose); return dispose },
    }
    await apply(ctx as never, config(root))
    expect([...values.keys()]).toEqual(['code_repo_map', 'code_symbol_query'])
    expect(disposers).toHaveLength(1)
    disposers[0]!()
    expect([...values.keys()]).toEqual([])
  })

  it('keeps the v0.2b overlay read-only and separate from v0.1', async () => {
    const overlay = JSON.parse(await readFile(new URL('../../../profiles/v0.2b-readonly/package.json', import.meta.url), 'utf8')) as { dsh: { profile: { bundles: string[] } }; dependencies: Record<string, string> }
    const v01 = JSON.parse(await readFile(new URL('../../../profiles/v0.1/package.json', import.meta.url), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(overlay.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@ds-plugins/dsh-code-intelligence'])
    expect(overlay.dsh.profile.bundles).not.toContain('@ds-plugins/dsh-orchestrator')
    expect(Object.keys(overlay.dependencies)).not.toContain('dsh-lsp-actions')
    expect(v01.dsh.profile.bundles).toContain('@ds-plugins/dsh-orchestrator')
    expect(v01.dsh.profile.bundles).not.toContain('@ds-plugins/dsh-code-intelligence')
  })
})
