import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { parseRepoMapPageV1, parseSymbolQueryResultV1, type RepoMapPageV1, type SymbolQueryResultV1 } from '@ds-plugins/dsh-context'
import { buildRepoMap, querySymbols, type RepoMapOptionsV1, type SymbolQueryV1 } from './projections.js'
import type { InternalSymbolIndexStore } from './symbol-index.js'
import type { RepositorySnapshotStore } from './snapshot.js'

type ToolExecution = { readonly signal: AbortSignal }
type ToolRuntime = { readonly snapshot: RepositorySnapshotStore['snapshot']; readonly index: InternalSymbolIndexStore }

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('code intelligence arguments must be an object')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`unknown code intelligence argument: ${key}`)
}

function input(value: unknown, runtime: ToolRuntime, query: boolean): RepoMapOptionsV1 | SymbolQueryV1 {
  const raw = object(value)
  exactKeys(raw, query ? ['snapshotId', 'query', 'limit', 'cursor'] : ['snapshotId', 'limit', 'cursor'])
  if (raw.snapshotId !== runtime.snapshot.snapshotId) throw new TypeError('snapshotId is stale or does not match the current snapshot')
  if (typeof raw.limit !== 'number' || !Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > 50) throw new RangeError('limit must be between 1 and 50')
  if (raw.cursor !== undefined && (typeof raw.cursor !== 'string' || new TextEncoder().encode(raw.cursor).byteLength > 1_024)) throw new RangeError('cursor exceeds 1024 UTF-8 bytes')
  if (query) {
    if (typeof raw.query !== 'string' || new TextEncoder().encode(raw.query).byteLength > 256) throw new RangeError('query exceeds 256 UTF-8 bytes')
    return { query: raw.query, limit: raw.limit, ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }) }
  }
  return { limit: raw.limit, ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }) }
}

function render(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

const parameters = (query: boolean) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    snapshotId: { type: 'string' },
    ...(query ? { query: { type: 'string' } } : {}),
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    cursor: { type: 'string' },
  },
  required: query ? ['snapshotId', 'query', 'limit'] : ['snapshotId', 'limit'],
})

export function createCodeIntelligenceTools(runtime: ToolRuntime): readonly ToolDefinition[] {
  const repoMap = {
    name: 'code_repo_map',
    description: 'Return a bounded repository map page for the current immutable snapshot.',
    parameters: parameters(false),
    output: { schema: { type: 'object' }, render },
    async execute(rawArgs: unknown, exec: ToolExecution): Promise<RepoMapPageV1> {
      if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
      const options = input(rawArgs, runtime, false) as RepoMapOptionsV1
      return parseRepoMapPageV1(buildRepoMap(runtime.snapshot, runtime.index, options))
    },
  } as ToolDefinition
  const symbolQuery = {
    name: 'code_symbol_query',
    description: 'Search bounded symbols in the current immutable repository snapshot.',
    parameters: parameters(true),
    output: { schema: { type: 'object' }, render },
    async execute(rawArgs: unknown, exec: ToolExecution): Promise<SymbolQueryResultV1> {
      if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
      const options = input(rawArgs, runtime, true) as SymbolQueryV1
      return parseSymbolQueryResultV1(querySymbols(runtime.snapshot, runtime.index, options))
    },
  } as ToolDefinition
  return Object.freeze([repoMap, symbolQuery])
}
