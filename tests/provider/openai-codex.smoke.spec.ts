import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const scriptPath = fileURLToPath(new URL('./openai-codex.smoke.ts', import.meta.url))
const DISABLED_MESSAGE = 'DISABLED: local OpenAI Codex provider smoke is intentionally unavailable; keyless verification only.\n'

function runProviderSmoke(environment: NodeJS.ProcessEnv): Promise<{
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', scriptPath], {
      env: environment,
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

describe('OpenAI Codex provider smoke command', () => {
  it.each([
    ['without opt-in', undefined],
    ['with opt-in', '1'],
  ])('is safely disabled %s', async (_label, optIn) => {
    const result = await runProviderSmoke({
      ...process.env,
      DSH_RUN_OPENAI_CODEX_SMOKE: optIn,
      DSH_HARNESS_ROOT: '/definitely-not-a-harness-checkout',
    })

    expect(result).toEqual({
      code: 0,
      stdout: DISABLED_MESSAGE,
      stderr: '',
    })
  })
})
