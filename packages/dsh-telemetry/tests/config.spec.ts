import { expect, it } from 'vitest'
import { Config, parseTelemetryConfig } from '../src/config.ts'
it('defaults to disabled and accepts only an explicit absolute normalized root', () => {
  expect(parseTelemetryConfig({})).toEqual({ enabled: false })
  expect(parseTelemetryConfig({ enabled: true, storageRoot: '/tmp/private-telemetry' })).toEqual({ enabled: true, storageRoot: '/tmp/private-telemetry' })
  expect(Config['~standard'].validate({})).toEqual({ value: { enabled: false } })
})
it.each([null, [], { enabled: 1 }, { enabled: true }, { storageRoot: 'relative' }, { storageRoot: '/tmp/../x' }, { storageRoot: '/' }, { storageRoot: '/tmp/a\0b' }, { enabled: false, extra: true }, Object.create({ enabled: true }), { get enabled() { throw new Error('secret') } }])('rejects malformed configuration generically', value => {
  expect(() => parseTelemetryConfig(value)).toThrow('Invalid telemetry configuration')
  expect(Config['~standard'].validate(value)).toEqual({ issues: [{ message: 'Invalid telemetry configuration' }] })
})
