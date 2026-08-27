/** Caller-argument policy for one deployment-controlled verification program. */
export type VerificationAllowedArgs = 'none' | 'orchestrator-test-paths'

/** A named verification program whose executable, fixed prefix, and caller arguments are deployment controlled. */
export interface VerificationCommand {
  readonly name: string
  readonly executable: string
  readonly fixedArgs: readonly string[]
  readonly allowedArgs: VerificationAllowedArgs
}

/** Configuration validated before the orchestrator plugin is loaded. */
export interface OrchestratorConfig {
  /** Deployment-controlled repository root used by direct verification processes. */
  readonly workspaceRoot: string
  readonly mode: 'direct' | 'single-worker'
  readonly worker: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
    readonly maxTokens: number
  }
  readonly budgets: {
    readonly maxWorkers: 0 | 1
    readonly maxPluginToolActions: number
    readonly toolTimeoutMs: number
  }
  readonly verification: {
    readonly commands: readonly VerificationCommand[]
    readonly timeoutMs: number
    readonly maxOutputBytes: number
  }
}

/** Bounded child-session request persisted by a later orchestration task. */
export interface WorkerSpecV1 {
  readonly schemaVersion: 1
  readonly task: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly maxTokens: number
  readonly allowedTools: readonly string[]
  readonly expectedOutput: 'handoff-v1'
}

/** Result of one configured verification command. */
export interface VerificationEvidenceV1 {
  readonly schemaVersion: 1
  readonly commandName: string
  readonly args: readonly string[]
  readonly exitCode: number | null
  readonly status: 'passed' | 'failed' | 'timed-out' | 'spawn-error'
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly durationMs: number
}

/** Validated, bounded child result visible to the parent session. */
export interface HandoffV1 {
  readonly schemaVersion: 1
  readonly status: 'completed' | 'blocked' | 'failed'
  readonly summary: string
  readonly changedFiles: readonly string[]
  readonly decisions: readonly string[]
  readonly verification: readonly VerificationEvidenceV1[]
  readonly blockers: readonly string[]
}
