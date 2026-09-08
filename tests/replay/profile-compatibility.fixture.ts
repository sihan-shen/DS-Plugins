import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const profileNames = ['v0.1', 'v0.2b-readonly', 'v0.2c-context', 'v0.3-adaptive'] as const
export type ProfileName = (typeof profileNames)[number]

const repositoryRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)))

export async function copyProfileResolutionSurface(profile: ProfileName) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-compatibility-'))
  const source = join(repositoryRoot, 'profiles', profile)
  const target = join(root, 'profiles', profile)
  try {
    await cp(source, target, { recursive: true, filter: path => !path.split(/[\\/]/).includes('node_modules') })
    await symlink(join(source, 'node_modules'), join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    await mkdir(join(target, 'node_modules', '@deepseek-ai'), { recursive: true })
    const cordisTarget = join(target, 'node_modules/@deepseek-ai/cordis')
    if (!existsSync(cordisTarget)) await symlink(join(repositoryRoot, 'node_modules/@deepseek-ai/cordis'), cordisTarget, process.platform === 'win32' ? 'junction' : 'dir')
    const require = createRequire(join(target, 'package.json'))
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const resolveManifest = (name: string) => require(`${name}/package.json`) as { version: string }
    return {
      root,
      profile,
      manifest,
      resolveManifest,
      async dispose() { await rm(root, { recursive: true, force: true }) },
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
