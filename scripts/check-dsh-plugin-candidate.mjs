import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REVIEWED_COMMIT = 'ea0354ca444075b37b791bd8638fecdbc40fb5d0'
export const REVIEWED_PACKAGE_VERSION = '0.4.0'
export const PINNED_DSH_VERSION = '0.1.1-rc.2'
export const SHELL_NODE_VERSION = '24.0.0'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = resolve(root, 'tests/fixtures/plugins/dsh-lsp-actions')
const manifestPath = resolve(fixtureRoot, 'package.json')
const artifactPath = resolve(fixtureRoot, 'artifact.json')
const registrationPath = resolve(fixtureRoot, 'src-index-registration.txt')
const expectedTools = [
  'lsp_diagnostics',
  'lsp_symbols',
  'lsp_completion',
  'lsp_signature_help',
  'lsp_inlay_hints',
  'lsp_format',
  'lsp_code_action',
  'lsp_rename',
]
const writeTools = ['lsp_format', 'lsp_code_action', 'lsp_rename']
const hashPattern = /^sha256:[0-9a-f]{64}$/

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedJson(value[key])]))
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(sortedJson(value))
}

function hashText(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function hashManifest(manifest) {
  return hashText(canonicalJson(manifest))
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (!match) throw new Error(`Unsupported semver value: ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part)) : [],
  }
}

function compareIdentifiers(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  if (typeof left === 'number') return -1
  if (typeof right === 'number') return 1
  return left < right ? -1 : left > right ? 1 : 0
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    if (index >= left.prerelease.length) return -1
    if (index >= right.prerelease.length) return 1
    const comparison = compareIdentifiers(left.prerelease[index], right.prerelease[index])
    if (comparison !== 0) return comparison
  }
  return 0
}

function satisfiesComparator(version, comparator) {
  const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(comparator)
  if (!match) throw new Error(`Unsupported semver comparator: ${comparator}`)
  const comparison = compareVersions(version, parseVersion(match[2]))
  switch (match[1] ?? '=') {
    case '>=': return comparison >= 0
    case '<=': return comparison <= 0
    case '>': return comparison > 0
    case '<': return comparison < 0
    default: return comparison === 0
  }
}

function satisfiesNpmRange(versionText, range) {
  const version = parseVersion(versionText)
  return range.split('||').some(alternative => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean)
    if (version.prerelease.length > 0) {
      const hasSameBasePrereleaseComparator = comparators.some(comparator => {
        const match = /^(?:>=|<=|>|<|=)?(\d+\.\d+\.\d+)-/.exec(comparator)
        return match !== null && match[1] === `${version.major}.${version.minor}.${version.patch}`
      })
      if (!hasSameBasePrereleaseComparator) return false
    }
    return comparators.every(comparator => satisfiesComparator(version, comparator))
  })
}

function satisfiesNodeRange(versionText, range) {
  return range.split('||').some(alternative => {
    const clause = alternative.trim()
    const version = parseVersion(versionText)
    if (clause.startsWith('^')) {
      const floor = parseVersion(clause.slice(1))
      return compareVersions(version, floor) >= 0 && version.major === floor.major
    }
    if (clause.startsWith('>=')) return compareVersions(version, parseVersion(clause.slice(2))) >= 0
    throw new Error(`Unsupported Node engine clause: ${clause}`)
  })
}

function parseJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid JSON fixture ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertArtifactMetadata(metadata) {
  const requiredKeys = [
    'reviewed_commit',
    'package_version',
    'artifact_kind',
    'artifact_url',
    'integrity',
    'manifest_sha256',
    'registration_snapshot_sha256',
    'snapshot_source',
  ]
  if (JSON.stringify(Object.keys(metadata)) !== JSON.stringify(requiredKeys)) {
    throw new Error('artifact metadata has an unexpected shape')
  }
  if (metadata.reviewed_commit !== REVIEWED_COMMIT) throw new Error('artifact commit is not pinned')
  if (metadata.package_version !== REVIEWED_PACKAGE_VERSION) throw new Error('artifact version mismatch')
  if (metadata.artifact_kind !== 'source-snapshot') throw new Error('artifact kind mismatch')
  if (metadata.artifact_url !== null || metadata.integrity !== null) throw new Error('source snapshot must not claim installable integrity')
  if (metadata.snapshot_source !== 'src/index.ts at reviewed_commit') throw new Error('snapshot source mismatch')
  if (!hashPattern.test(metadata.manifest_sha256) || !hashPattern.test(metadata.registration_snapshot_sha256)) {
    throw new Error('artifact hashes must be sha256 values')
  }
}

function parseRegistration(snapshot) {
  const tools = snapshot.split(/\r?\n/).filter(Boolean).map(line => {
    const match = /^tool:([a-z_]+)$/.exec(line)
    if (!match) throw new Error(`invalid registration snapshot line: ${line}`)
    return match[1]
  })
  if (tools.length !== expectedTools.length || new Set(tools).size !== tools.length) throw new Error('registration must contain eight unique tools')
  if (!expectedTools.every((tool, index) => tools[index] === tool)) throw new Error('registration tool order mismatch')
  return tools
}

export function checkCandidate() {
  const manifest = parseJson(manifestPath)
  const artifact = parseJson(artifactPath)
  const registrationSnapshot = readFileSync(registrationPath, 'utf8')
  assertArtifactMetadata(artifact)

  if (manifest.name !== 'dsh-lsp-actions' || manifest.version !== REVIEWED_PACKAGE_VERSION) throw new Error('candidate identity mismatch')
  const nodeRange = manifest.engines?.node
  const peerRange = manifest.peerDependencies?.['@deepseek-ai/dsh-base']
  const permissions = manifest.workshop?.permissions
  const lifecycleScripts = Object.keys(manifest.scripts ?? {})
  if (nodeRange !== '^22.19.0 || >=24.0.0') throw new Error('Node engine range mismatch')
  if (peerRange !== '>=0.1.0-rc.8 <0.2.0') throw new Error('DSH peer range mismatch')
  if (JSON.stringify(permissions) !== JSON.stringify(['filesystem:read', 'filesystem:write', 'subprocess'])) throw new Error('permission metadata mismatch')
  if (JSON.stringify(lifecycleScripts) !== JSON.stringify(['prepare'])) throw new Error('lifecycle metadata mismatch')

  const manifestSha = hashManifest(manifest)
  const registrationSha = hashText(registrationSnapshot)
  if (artifact.manifest_sha256 !== manifestSha) throw new Error('manifest hash does not match artifact metadata')
  if (artifact.registration_snapshot_sha256 !== registrationSha) throw new Error('registration hash does not match artifact metadata')
  const registrationTools = parseRegistration(registrationSnapshot)
  const peerAcceptsDsh = satisfiesNpmRange(PINNED_DSH_VERSION, peerRange)
  const nodeCompatible = satisfiesNodeRange(SHELL_NODE_VERSION, nodeRange)
  const registrationWriteTools = registrationTools.filter(tool => writeTools.includes(tool))

  return {
    schema_version: 1,
    package_name: manifest.name,
    package_version: manifest.version,
    reviewed_commit: artifact.reviewed_commit,
    dsh_version: PINNED_DSH_VERSION,
    status: 'patch-required',
    peer_range: peerRange,
    peer_accepts_dsh: peerAcceptsDsh,
    node_range: nodeRange,
    node_version_checked: SHELL_NODE_VERSION,
    node_compatible: nodeCompatible,
    permissions: [...permissions],
    network_permission: permissions.includes('network'),
    network_isolation_proven: false,
    lifecycle_scripts: lifecycleScripts,
    lifecycle_safe: false,
    registration_tools: registrationTools,
    registration_write_tools: registrationWriteTools,
    read_only_session_sufficient: false,
    manifest_sha256: manifestSha,
    registration_snapshot_sha256: registrationSha,
    artifact_integrity: 'not-provided',
    artifact_metadata_bound: true,
    next_action: 'Use an upstream peer-range correction, an audited fixed tarball/patch with integrity, or a self-owned read-only adapter; a read-only session is insufficient while write tools remain registered.',
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(checkCandidate(), null, 2)}\n`)
}
