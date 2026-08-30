import type { Context } from '@deepseek-ai/cordis'
import { buildSymbolIndex } from './symbol-index.js'
import { extractFallbackSymbols } from './fallback.js'
import { parseSnapshotConfig } from './config.js'
import { RepositorySnapshotStore } from './snapshot.js'
import { createCodeIntelligenceTools } from './tools.js'
import type { InternalSymbolIndexStore } from './symbol-index.js'
import type { SnapshotConfigV1 } from './types.js'

export type CodeIntelligenceRuntimeOptions = {
  readonly snapshot: RepositorySnapshotStore['snapshot']
  readonly index: InternalSymbolIndexStore
}

export type CodeIntelligenceConfig = SnapshotConfigV1

export function mountCodeIntelligence(ctx: Pick<Context, 'effect'> & { readonly tools: { register(tool: unknown): () => void } }, options: CodeIntelligenceRuntimeOptions): void {
  const runtime = { snapshot: options.snapshot, index: options.index }
  ctx.effect(() => {
    const disposers = createCodeIntelligenceTools(runtime).map(tool => ctx.tools.register(tool))
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }, 'dsh-code-intelligence: read-only tools')
}

export const name = 'dsh-code-intelligence'
export const inject = ['tools'] as const

export const apply = async (
  ctx: Pick<Context, 'effect'> & { readonly tools: { register(tool: unknown): () => void } },
  config: CodeIntelligenceConfig,
): Promise<void> => {
  const parsed = parseSnapshotConfig(config)
  const store = await RepositorySnapshotStore.create(parsed)
  const adapter = await extractFallbackSymbols(store)
  const index = buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries)
  mountCodeIntelligence(ctx, { snapshot: store.snapshot, index })
}
