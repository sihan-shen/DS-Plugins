import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'tests/fixtures/standalone-dsh-consumer')
const packages = ['dsh-context', 'dsh-context-cache', 'dsh-scheduling-contracts', 'dsh-orchestrator', 'dsh-code-intelligence', 'dsh-telemetry']
const temp = await mkdtemp(join('/tmp', 'dsh-standalone-consumer-'))

try {
  const tarballs = new Map()
  for (const name of packages) {
    await exec('pnpm', ['--filter', `@han_05/${name}`, 'build'], { cwd: root, maxBuffer: 20 * 1024 * 1024 })
    const { stdout } = await exec('pnpm', ['--filter', `@han_05/${name}`, 'pack', '--pack-destination', temp], { cwd: root, maxBuffer: 20 * 1024 * 1024 })
    const archive = stdout.trim().split(/\r?\n/).at(-1)
    if (!archive) throw new Error(`pnpm pack returned no archive for ${name}`)
    tarballs.set(name, resolve(root, archive))
  }

  const manifest = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'))
  let serialized = JSON.stringify(manifest, null, 2)
  for (const [name, archive] of tarballs) serialized = serialized.replaceAll(`__ARCHIVE_${name}__`, archive)
  const resolvedManifest = JSON.parse(serialized)
  const overrides = [...tarballs].map(([name, archive]) => `  '@han_05/${name}': 'file:${archive}'`).join('\n')
  await writeFile(join(temp, 'pnpm-workspace.yaml'), `packages: []\n\noverrides:\n${overrides}\n`)
  await writeFile(join(temp, 'package.json'), `${JSON.stringify(resolvedManifest, null, 2)}\n`)
  await exec('pnpm', ['install', '--lockfile-only'], { cwd: temp, maxBuffer: 20 * 1024 * 1024 })
  await exec('pnpm', ['install', '--frozen-lockfile'], { cwd: temp, maxBuffer: 20 * 1024 * 1024 })

  const lock = await readFile(join(temp, 'pnpm-lock.yaml'), 'utf8')
  if (lock.includes('workspace:') || lock.includes('link:')) throw new Error('standalone lockfile contains workspace/link protocol')
  for (const name of ['@han_05/dsh-orchestrator', '@han_05/dsh-code-intelligence', '@han_05/dsh-telemetry']) {
    await exec(process.execPath, ['-e', `const p = await import('${name}/package.json', { with: { type: 'json' } }); if (p.default.peerDependencies?.['@deepseek-ai/cordis'] !== '4.0.2') process.exit(2)`], { cwd: temp })
  }
  console.log('standalone consumer passed')
} finally {
  await rm(temp, { recursive: true, force: true })
}
