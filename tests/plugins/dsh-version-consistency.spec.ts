import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  TARGET_CORDIS_VERSION,
  TARGET_DSH_COMMIT,
  TARGET_DSH_PACKAGES,
  TARGET_DSH_VERSION,
} from '../../scripts/dsh-version.mjs'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

async function currentManifestPaths() {
  const profileEntries = await readdir(`${repositoryRoot}/profiles`, { withFileTypes: true })
  const profileManifests = profileEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${repositoryRoot}/profiles/${entry.name}/package.json`)

  return [
    `${repositoryRoot}/package.json`,
    ...profileManifests,
    `${repositoryRoot}/packages/dsh-adaptive-scheduler/package.json`,
    `${repositoryRoot}/packages/dsh-code-intelligence/package.json`,
    `${repositoryRoot}/packages/dsh-orchestrator/package.json`,
    `${repositoryRoot}/packages/dsh-telemetry/package.json`,
    `${repositoryRoot}/packages/dsh-eval/package.json`,
  ]
}

async function readCurrentManifests() {
  return Promise.all((await currentManifestPaths()).map(async (path) => ({
    path,
    manifest: JSON.parse(await readFile(path, 'utf8')) as Record<string, Record<string, string>>,
  })))
}

describe('DSH 0.1.2-rc.1 current-manifest consistency', () => {
  it('pins the reviewed upstream DSH commit', () => {
    expect(TARGET_DSH_COMMIT).toBe('a66e4702047846cdaa10c66c9d3df3951f5ea70d')
  })

  it('uses the target DSH and Cordis versions in every current runtime manifest', async () => {
    const manifests = await readCurrentManifests()
    const versionAssertions: Array<{ path: string, packageName: string, version: string, expected: string }> = []

    for (const { path, manifest } of manifests) {
      for (const section of dependencySections) {
        for (const [packageName, version] of Object.entries(manifest[section] ?? {})) {
          if (TARGET_DSH_PACKAGES.includes(packageName)) {
            versionAssertions.push({ path, packageName, version, expected: TARGET_DSH_VERSION })
          }
          if (packageName === '@deepseek-ai/cordis') {
            versionAssertions.push({ path, packageName, version, expected: TARGET_CORDIS_VERSION })
          }
        }
      }
    }

    expect(versionAssertions).not.toEqual([])
    for (const assertion of versionAssertions) {
      expect(assertion.version, `${assertion.path}: ${assertion.packageName}`).toBe(assertion.expected)
    }
  })
})
