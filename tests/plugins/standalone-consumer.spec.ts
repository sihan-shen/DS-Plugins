import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const fixture = new URL('../fixtures/standalone-dsh-consumer/package.json', import.meta.url)

describe('standalone consumer fixture', () => {
  it('uses exact target versions and packed file references only', async () => {
    const manifest = JSON.parse(await readFile(fixture, 'utf8')) as { dependencies: Record<string, string> }
    expect(manifest.dependencies['@deepseek-ai/cordis']).toBe('4.0.2')
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(version).toBe('0.1.2-rc.1')
      expect(version).not.toMatch(/workspace:|link:/)
    }
  })
})
