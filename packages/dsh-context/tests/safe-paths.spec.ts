import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSafeRepoPath, assertSnapshotHash, isIndexableFile, normalizeRepoPath } from '../src/index.ts'

const roots: string[] = []

function repositoryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-safe-paths-'))
  roots.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  return root
}

const regularFile = {
  isFile: () => true,
  isSymbolicLink: () => false,
  size: 20,
}

const rules = {
  maxBytes: 64,
  ignoredPaths: ['src/ignored.ts'],
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('safe repository paths', () => {
  it('normalizes a safe path to repository-relative POSIX form', () => {
    const root = repositoryRoot()

    expect(normalizeRepoPath(root, 'src/a.ts')).toBe('src/a.ts')
    expect(assertSafeRepoPath(root, 'src/a.ts')).toBe('src/a.ts')
  })

  it('rejects absolute, Windows, traversal, and NUL paths', () => {
    const root = repositoryRoot()
    const unsafe = [
      '/tmp/a.ts',
      String.raw`C:\repo\a.ts`,
      String.raw`\\server\share\a.ts`,
      '..',
      'a/../b.ts',
      'src/a.ts\0extra',
    ]

    for (const candidate of unsafe) {
      expect(() => normalizeRepoPath(root, candidate), candidate).toThrow()
      expect(() => assertSafeRepoPath(root, candidate), candidate).toThrow()
    }
  })

  it('rejects a symlink whose canonical target escapes the deployment root', () => {
    const root = repositoryRoot()
    const outside = mkdtempSync(join(tmpdir(), 'dsh-safe-paths-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'secret.ts'), 'secret\n')
    symlinkSync(join(outside, 'secret.ts'), join(root, 'src', 'link.ts'))

    expect(() => assertSafeRepoPath(root, 'src/link.ts')).toThrow()
  })

  it('excludes secrets, state, nested checkouts, private keys, and binary files', () => {
    const excluded = [
      '.env',
      '.env.local',
      '.dsh/state.json',
      '.git/config',
      'node_modules/pkg/index.js',
      'upstream/deepseek-harness/apps/cli/src/bin.ts',
      'certs/server.pem',
      'keys/private.key',
      'archive.zip',
      'image.png',
    ]

    for (const path of excluded) {
      expect(isIndexableFile(path, regularFile, rules), path).toBe(false)
    }
  })

  it('excludes non-regular, symlink, ignored, and oversized files', () => {
    expect(isIndexableFile('src/a.ts', { ...regularFile, isFile: () => false }, rules)).toBe(false)
    expect(isIndexableFile('src/a.ts', { ...regularFile, isSymbolicLink: () => true }, rules)).toBe(false)
    expect(isIndexableFile('src/ignored.ts', regularFile, rules)).toBe(false)
    expect(isIndexableFile('src/large.ts', { ...regularFile, size: 65 }, rules)).toBe(false)
    expect(isIndexableFile('../outside.ts', regularFile, rules)).toBe(false)
  })

  it('excludes caller-declared nested checkout roots and their descendants', () => {
    const nestedRules = { ...rules, nestedCheckoutRoots: ['vendor/child-repo'] }
    expect(isIndexableFile('vendor/child-repo/src/a.ts', regularFile, nestedRules)).toBe(false)
    expect(isIndexableFile('vendor/child-repo', regularFile, nestedRules)).toBe(false)
    expect(isIndexableFile('vendor/other/src/a.ts', regularFile, nestedRules)).toBe(true)
  })

  it('rejects a source-window read when the file hash differs from the snapshot hash', () => {
    expect(() => assertSnapshotHash('sha256:snapshot', 'sha256:current')).toThrow()
    expect(() => assertSnapshotHash('sha256:same', 'sha256:same')).not.toThrow()
  })
})
