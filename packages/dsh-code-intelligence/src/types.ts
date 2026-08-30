import type { InternalSymbolEntryV1, RepositorySnapshotV1, RepoFileSummaryV1 } from '@ds-plugins/dsh-context'

export type SnapshotConfigV1 = {
  readonly deploymentRoot: string
  readonly revision: string
  readonly maxFileBytes: number
  readonly maxFiles: number
  readonly maxTotalBytes: number
  readonly maxDirectories: number
  readonly maxIgnoreBytes: number
  readonly nestedCheckoutRoots: readonly string[]
}

export type LspDeploymentEnvironmentKey = 'LANG' | 'LC_ALL' | 'TMPDIR' | 'TEMP' | 'TMP'

export type LspDeploymentConfigV1 = {
  readonly executable: string
  readonly fixedArgs: readonly string[]
  readonly environment: Readonly<Partial<Record<LspDeploymentEnvironmentKey, string>>>
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxMessageBytes: number
  readonly maxStderrBytes: number
  readonly graceMs: number
}

export type HostNetworkIsolation =
  | { readonly networkIsolation: 'enforced'; readonly capabilityId: symbol }
  | { readonly networkIsolation: 'unavailable' }

export type SourceMeasurementV1 = {
  readonly path: string
  readonly sourceHash: string
  readonly startOffset: number
  readonly endOffset: number
  readonly text: string
  readonly byteLength: number
}

export type SnapshotTestHooks = {
  readonly afterOpenForTest?: (absolutePath: string) => void | Promise<void>
}

export type AdapterUnavailableCode = 'network-isolation-unavailable' | 'spawn-failed' | 'timed-out' | 'protocol-invalid' | 'capability-missing'

export type AdapterUnavailableV1 = {
  readonly adapterId: 'typescript-lsp'
  readonly adapterVersion: string
  readonly code: AdapterUnavailableCode
}

export type InternalSymbolRelationV1 = {
  readonly kind: 'imports' | 'exports' | 'contains' | 'calls'
  readonly targetName: string
  readonly targetPath?: string
}

export type SymbolAdapterResultV1 = {
  readonly adapterId: 'typescript-ast-fallback' | 'typescript-lsp'
  readonly adapterVersion: string
  readonly entries: readonly InternalSymbolEntryV1[]
  readonly relations: Readonly<Record<string, readonly InternalSymbolRelationV1[]>>
}

export type { InternalSymbolEntryV1, RepoFileSummaryV1, RepositorySnapshotV1 }
