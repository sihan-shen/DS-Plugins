import { dirname, isAbsolute, resolve } from 'node:path'

export interface TelemetryConfig { enabled: boolean; storageRoot?: string }
const invalid = () => new TypeError('Invalid telemetry configuration')
export function parseTelemetryConfig(value: unknown): TelemetryConfig {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) throw invalid()
    for (const key of Reflect.ownKeys(value)) {
      if (key !== 'enabled' && key !== 'storageRoot') throw invalid()
      if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) throw invalid()
    }
    const input = value as Record<string, unknown>
    const enabled = Object.hasOwn(input, 'enabled') ? input.enabled : false
    if (typeof enabled !== 'boolean') throw invalid()
    const storageRoot = input.storageRoot
    if (Object.hasOwn(input, 'storageRoot')) {
      if (typeof storageRoot !== 'string' || storageRoot.includes('\0') || !isAbsolute(storageRoot) || resolve(storageRoot) !== storageRoot || dirname(storageRoot) === storageRoot) throw invalid()
    }
    if (enabled && storageRoot === undefined) throw invalid()
    return { enabled, ...(storageRoot === undefined ? {} : { storageRoot: storageRoot as string }) }
  } catch { throw invalid() }
}
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: '@ds-plugins/dsh-telemetry',
    validate(value: unknown) {
      try { return { value: parseTelemetryConfig(value) } }
      catch { return { issues: [{ message: 'Invalid telemetry configuration' }] } }
    },
  },
}
