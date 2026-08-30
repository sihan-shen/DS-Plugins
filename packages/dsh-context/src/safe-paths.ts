// @ts-expect-error The contract package intentionally has no Node runtime type dependency.
import { realpathSync } from 'node:fs'
// @ts-expect-error The contract package intentionally has no Node runtime type dependency.
import { isAbsolute, relative, resolve, sep } from 'node:path'

export type IndexableFileStat = {
  readonly isFile: () => boolean
  readonly isSymbolicLink: () => boolean
  readonly size: number
}

export type IgnoreRules = {
  readonly maxBytes: number
  readonly ignoredPaths?: readonly string[]
  readonly nestedCheckoutRoots?: readonly string[]
  readonly isIgnored?: (path: string) => boolean
}

const PRIVATE_KEY_SUFFIXES = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.der'])
const BINARY_SUFFIXES = new Set([
  '.7z', '.a', '.avi', '.bin', '.class', '.dll', '.dmg', '.doc', '.docx', '.exe', '.gif',
  '.ico', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.o', '.pdf', '.png', '.so', '.tar', '.tgz',
  '.ttf', '.wasm', '.webm', '.webp', '.woff', '.woff2', '.xls', '.xlsx', '.zip',
])

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError(`${name} must be a non-empty path without NUL bytes`)
}

function validateRelativePath(candidate: unknown): string {
  assertString(candidate, 'candidate')
  if (candidate.includes('\\') || candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate)) throw new TypeError('candidate must be repository-relative POSIX path')
  const parts = candidate.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new TypeError('candidate must not contain traversal, dot, or empty path segments')
  return candidate
}

function resolvedRoot(root: unknown): string {
  assertString(root, 'root')
  return resolve(root)
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate)
  return relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

export function normalizeRepoPath(root: string, candidate: string): string {
  const deploymentRoot = resolvedRoot(root)
  const relativePath = validateRelativePath(candidate)
  const absoluteCandidate = resolve(deploymentRoot, ...relativePath.split('/'))
  if (!contained(deploymentRoot, absoluteCandidate)) throw new TypeError('candidate escapes deployment root')
  return relative(deploymentRoot, absoluteCandidate).split(sep).join('/')
}

export function assertSafeRepoPath(root: string, candidate: string): string {
  const normalized = normalizeRepoPath(root, candidate)
  const canonicalRoot = realpathSync(resolvedRoot(root))
  const canonicalCandidate = realpathSync(resolve(canonicalRoot, ...normalized.split('/')))
  if (!contained(canonicalRoot, canonicalCandidate)) throw new TypeError('candidate symlink escapes deployment root')
  return normalized
}

function hasExcludedDirectory(path: string, rules: IgnoreRules): boolean {
  const parts = path.split('/')
  if (parts.some(part => part === '.git' || part === '.dsh' || part === 'node_modules' || part === '.worktrees')) return true
  if (parts[0] === 'upstream') return true
  return rules.nestedCheckoutRoots?.some(root => {
    try {
      const normalizedRoot = validateRelativePath(root)
      return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`)
    } catch {
      return true
    }
  }) ?? false
}

function hasSecretName(path: string): boolean {
  return path.split('/').some(part => part.startsWith('.env') || PRIVATE_KEY_SUFFIXES.has(part.slice(part.lastIndexOf('.')).toLowerCase()))
}

function hasBinaryExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
  return BINARY_SUFFIXES.has(extension)
}

function isIgnored(path: string, rules: IgnoreRules): boolean {
  if (rules.isIgnored?.(path) === true) return true
  return rules.ignoredPaths?.some(ignored => path === ignored || path.startsWith(`${ignored}/`)) ?? false
}

export function isIndexableFile(path: string, stat: IndexableFileStat, ignoreRules: IgnoreRules): boolean {
  let normalized: string
  try {
    normalized = validateRelativePath(path)
  } catch {
    return false
  }
  if (!Number.isSafeInteger(ignoreRules.maxBytes) || ignoreRules.maxBytes < 0) return false
  if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > ignoreRules.maxBytes) return false
  if (hasExcludedDirectory(normalized, ignoreRules) || hasSecretName(normalized) || isIgnored(normalized, ignoreRules)) return false
  return !hasBinaryExtension(normalized)
}

export function assertSnapshotHash(expected: string, actual: string): void {
  if (typeof expected !== 'string' || expected.length === 0 || typeof actual !== 'string' || actual.length === 0 || expected !== actual) {
    throw new Error('source-window snapshot hash mismatch')
  }
}
