import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
it('publishes compiled Cordis lifecycle at root and pure contracts separately', async () => {
  const entry = await import('@ds-plugins/dsh-telemetry')
  const contracts = await import('@ds-plugins/dsh-telemetry/contracts')
  const storage = await import('@ds-plugins/dsh-telemetry/storage')
  expect(entry.name).toBe('dsh-telemetry')
  expect(entry.provide).toEqual(['telemetry']); expect(entry.inject).toEqual(['sessions'])
  expect(entry.apply).toBeTypeOf('function'); expect(entry.Config).toBeDefined()
  expect(contracts.parseTelemetryRecordV1).toBeTypeOf('function')
  expect(contracts).not.toHaveProperty('apply')
  expect(storage.openTelemetryStore).toBeTypeOf('function')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  expect(manifest.peerDependencies['@deepseek-ai/cordis']).toBe('4.0.1')
  expect(manifest.files).toEqual(expect.arrayContaining(['cordis.patch.yml', 'README.md']))
  const pure = await readFile(new URL('../lib/src/contracts.js', import.meta.url), 'utf8')
  expect(pure).not.toMatch(/\bimport\s|\brequire\(/)
})
