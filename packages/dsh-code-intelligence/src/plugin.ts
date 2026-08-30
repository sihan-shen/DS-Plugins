import type { Context } from '@deepseek-ai/cordis'
import { ContextCacheStore } from '@ds-plugins/dsh-context-cache'
import { buildSymbolIndex } from './symbol-index.js'
import { extractFallbackSymbols } from './fallback.js'
import { parseSnapshotConfig } from './config.js'
import { RepositorySnapshotStore } from './snapshot.js'
import { createCodeIntelligenceTools, createContextTools } from './tools.js'
import { createContextCompiler } from './context-compiler.js'
import type { InternalSymbolIndexStore } from './symbol-index.js'
import type { ContextCompiler, SnapshotConfigV1 } from './types.js'

export type CodeIntelligenceRuntimeOptions = {
  readonly snapshot: RepositorySnapshotStore['snapshot']
  readonly index: InternalSymbolIndexStore
  readonly compiler?: ContextCompiler
}

export type CodeIntelligenceConfig = SnapshotConfigV1

export function mountCodeIntelligence(ctx: Pick<Context, 'effect'> & { readonly tools: { register(tool: unknown): () => void }; readonly provide?: (name: string, value: unknown) => () => void }, options: CodeIntelligenceRuntimeOptions): void {
  const runtime = { snapshot: options.snapshot, index: options.index }
  ctx.effect(() => {
    const contextEnabled = options.compiler !== undefined && typeof ctx.provide === 'function'
    const serviceDisposer = contextEnabled ? ctx.provide!('contextCompiler', options.compiler) : undefined
    const tools = [
      ...createCodeIntelligenceTools(runtime),
      ...(contextEnabled ? createContextTools(options.compiler!) : []),
    ]
    const disposers = tools.map(tool => ctx.tools.register(tool))
    return async () => {
      for (const dispose of disposers.reverse()) dispose()
      serviceDisposer?.()
      const disposable = options.compiler as (ContextCompiler & { dispose?: () => Promise<void> }) | undefined
      await disposable?.dispose?.()
    }
  }, 'dsh-code-intelligence: read-only tools')
}

export const name = 'dsh-code-intelligence'
export const inject = ['tools'] as const
export const provide = ['contextCompiler'] as const

export const apply = async (
  ctx: Pick<Context, 'effect'> & { readonly tools: { register(tool: unknown): () => void } },
  config: CodeIntelligenceConfig,
): Promise<void> => {
  const parsed = parseSnapshotConfig(config)
  const cache = await ContextCacheStore.open({ deploymentRoot: parsed.deploymentRoot })
  try {
    const store = await RepositorySnapshotStore.create(parsed)
    const adapter = await extractFallbackSymbols(store)
    const index = buildSymbolIndex(store.snapshot.snapshotId, adapter, adapter.entries)
    const compiler = createContextCompiler({ workspaceRoot: parsed.deploymentRoot, store, index, cache })
    mountCodeIntelligence(ctx, { snapshot: store.snapshot, index, compiler })
  } catch (error) {
    await cache.close()
    throw error
  }
}

apply.provide = provide
