import type { Context } from '@deepseek-ai/cordis'
import { createCodeIntelligenceTools } from './tools.js'
import type { InternalSymbolIndexStore } from './symbol-index.js'
import type { RepositorySnapshotStore } from './snapshot.js'

export type CodeIntelligenceRuntimeOptions = {
  readonly snapshot: RepositorySnapshotStore['snapshot']
  readonly index: InternalSymbolIndexStore
}

export function mountCodeIntelligence(ctx: Pick<Context, 'effect'> & { readonly tools: { register(tool: unknown): () => void } }, options: CodeIntelligenceRuntimeOptions): void {
  const runtime = { snapshot: options.snapshot, index: options.index }
  ctx.effect(() => {
    const disposers = createCodeIntelligenceTools(runtime).map(tool => ctx.tools.register(tool))
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }, 'dsh-code-intelligence: read-only tools')
}

export const name = 'dsh-code-intelligence'
export const inject = ['tools'] as const
