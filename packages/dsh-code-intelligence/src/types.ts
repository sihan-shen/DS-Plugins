import type { RepositorySnapshotV1, RepoFileSummaryV1 } from '@ds-plugins/dsh-context'

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

export type { RepoFileSummaryV1, RepositorySnapshotV1 }
