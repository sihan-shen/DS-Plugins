import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSymbolIndex, createCodeIntelligenceTools, extractFallbackSymbols, parseSnapshotConfig, RepositorySnapshotStore } from '../../packages/dsh-code-intelligence/src/index.ts'

export async function codeIntelligenceReplayFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-code-replay-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'main.ts'), 'export function replayTarget() { return true }\n')
  await writeFile(join(root, 'src', 'secondary.ts'), 'export const secondary = 1\n')
  const store = await RepositorySnapshotStore.create(parseSnapshotConfig({
    deploymentRoot: root,
    revision: 'replay-fixture-1',
    maxFileBytes: 1_048_576,
    maxFiles: 10_000,
    maxTotalBytes: 67_108_864,
    maxDirectories: 20_000,
    maxIgnoreBytes: 262_144,
    nestedCheckoutRoots: [],
  }))
  const adapter = await extractFallbackSymbols(store)
  const index = buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries)
  const [repoMap, symbolQuery] = createCodeIntelligenceTools({ snapshot: store.snapshot, index })
  return { root, store, index, repoMap, symbolQuery, dispose: () => rm(root, { recursive: true, force: true }) }
}
