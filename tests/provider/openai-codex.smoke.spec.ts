import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findHarnessRoot } from './openai-codex.smoke.ts'

const scriptPath = fileURLToPath(new URL('./openai-codex.smoke.ts', import.meta.url))
const profileManifestPath = fileURLToPath(new URL('../../profiles/v0.1/package.json', import.meta.url))

function runKeylessSmoke(): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', scriptPath], {
      env: { ...process.env, DSH_RUN_OPENAI_CODEX_SMOKE: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

describe('openai-codex provider smoke command', () => {
  it('skips without loading provider code until the explicit opt-in is set', async () => {
    const result = await runKeylessSmoke()

    expect(result).toEqual({
      code: 0,
      stdout: 'SKIP: set DSH_RUN_OPENAI_CODEX_SMOKE=1 to run the authorized OpenAI Codex smoke.\n',
      stderr: '',
    })
  })

  it('finds the repository harness checkout when launched from this linked worktree', async () => {
    const checkout = resolve(fileURLToPath(new URL('../../../../upstream/deepseek-harness', import.meta.url)))
    expect(existsSync(resolve(checkout, 'apps/cli/src/bin.ts'))).toBe(true)
    await expect(findHarnessRoot()).resolves.toBe(checkout)
  })

  it('declares the official headless bundle required by the opt-in smoke profile', () => {
    const manifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.['@deepseek-ai/dsh-headless']).toBe('0.1.1-rc.2')
  })
})
