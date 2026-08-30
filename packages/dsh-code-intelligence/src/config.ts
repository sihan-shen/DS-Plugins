import { realpathSync, statSync } from 'node:fs'
import {
  MAX_DIRECTORIES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_IGNORE_BYTES,
  MAX_TOTAL_BYTES,
} from './constants.js'
import type { SnapshotConfigV1 } from './types.js'

const CONFIG_KEYS = ['deploymentRoot', 'revision', 'maxFileBytes', 'maxFiles', 'maxTotalBytes', 'maxDirectories', 'maxIgnoreBytes', 'nestedCheckoutRoots'] as const

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('snapshot config must be an object')
  return value as Record<string, unknown>
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function boundedInteger(value: unknown, name: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} must be an integer between 1 and ${maximum}`)
  return value
}

function safeRelativePath(value: unknown, name: string): string {
  const path = stringValue(value, name)
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) throw new TypeError(`${name} must be repository-relative`)
  const parts = path.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new TypeError(`${name} must not contain traversal or empty path segments`)
  return path
}

export function parseSnapshotConfig(value: unknown): SnapshotConfigV1 {
  const object = record(value)
  const allowed = new Set<string>(CONFIG_KEYS)
  for (const key of Object.keys(object)) if (!allowed.has(key)) throw new TypeError(`unknown snapshot config key: ${key}`)
  for (const key of CONFIG_KEYS) if (!Object.prototype.hasOwnProperty.call(object, key)) throw new TypeError(`snapshot config requires ${key}`)
  const root = stringValue(object.deploymentRoot, 'deploymentRoot')
  let canonicalRoot: string
  try {
    canonicalRoot = realpathSync(root)
    if (!statSync(canonicalRoot).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new TypeError('deploymentRoot must be an existing directory')
  }
  const nestedCheckoutRoots = object.nestedCheckoutRoots
  if (!Array.isArray(nestedCheckoutRoots)) throw new TypeError('nestedCheckoutRoots must be an array')
  const normalizedNestedRoots = nestedCheckoutRoots.map((item, index) => safeRelativePath(item, `nestedCheckoutRoots[${index}]`))
  if (new Set(normalizedNestedRoots).size !== normalizedNestedRoots.length) throw new TypeError('nestedCheckoutRoots must not contain duplicates')
  const config = {
    deploymentRoot: canonicalRoot,
    revision: stringValue(object.revision, 'revision'),
    maxFileBytes: boundedInteger(object.maxFileBytes, 'maxFileBytes', MAX_FILE_BYTES),
    maxFiles: boundedInteger(object.maxFiles, 'maxFiles', MAX_FILES),
    maxTotalBytes: boundedInteger(object.maxTotalBytes, 'maxTotalBytes', MAX_TOTAL_BYTES),
    maxDirectories: boundedInteger(object.maxDirectories, 'maxDirectories', MAX_DIRECTORIES),
    maxIgnoreBytes: boundedInteger(object.maxIgnoreBytes, 'maxIgnoreBytes', MAX_IGNORE_BYTES),
    nestedCheckoutRoots: normalizedNestedRoots,
  } satisfies SnapshotConfigV1
  return Object.freeze({ ...config, nestedCheckoutRoots: Object.freeze([...config.nestedCheckoutRoots]) })
}
