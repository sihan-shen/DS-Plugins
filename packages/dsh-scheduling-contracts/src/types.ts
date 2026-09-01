export type JsonSchema = {
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  readonly additionalProperties?: boolean
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  readonly items?: JsonSchema
  readonly enum?: readonly (string | number | boolean | null)[]
  readonly const?: string | number | boolean | null
  readonly minimum?: number
  readonly maximum?: number
  readonly maxItems?: number
  readonly minLength?: number
  readonly maxLength?: number
  readonly oneOf?: readonly JsonSchema[]
}

export type SchedulingTargetV1 = 'root' | 'worker'

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

export interface HandoffV1 {
  readonly schemaVersion: 1
  readonly status: 'completed' | 'blocked' | 'failed'
  readonly summary: string
  readonly changedFiles: readonly string[]
  readonly decisions: readonly string[]
  readonly verification: readonly VerificationEvidenceV1[]
  readonly blockers: readonly string[]
}

export interface CapabilityProfileV1 {
  readonly coding: number
  readonly reasoning: number
  readonly toolUse: number
  readonly repoContext: number
  readonly risk: number
  readonly difficulty: number
}

export interface SchedulingConstraintsV1 {
  readonly maxWorkers: 0 | 1
  readonly maxOutputTokens: number
  readonly maxLatencyMs: number
  readonly allowPaidFallback: boolean
  readonly allowedProviders?: readonly string[]
  readonly requiredTools: readonly string[]
}

export interface CapabilityRequestV1 {
  readonly schemaVersion: 1
  readonly target: SchedulingTargetV1
  readonly taskId: string
  readonly objective: string
  readonly profile: CapabilityProfileV1
  readonly constraints: SchedulingConstraintsV1
  readonly workspaceFingerprint?: string
  readonly repoRevision?: string
  readonly affinity?: {
    readonly workerId?: string
    readonly modelFamily?: string
    readonly snapshotId?: string
  }
  readonly priorHandoff?: HandoffV1
}

export interface RouteDecisionV1 {
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
  readonly reasoningEffort?: string
  readonly promptProfile?: string
  readonly modelFamily?: string
}

export interface ScheduleDecisionV1 {
  readonly schemaVersion: 1
  readonly mode: 'direct' | 'single-worker'
  readonly route: RouteDecisionV1
  readonly workerCount: 0 | 1
  readonly source: 'scheduler' | 'profile-fallback'
  readonly policyVersion: string
  readonly affinityKey?: string
  readonly explanationCode?: string
}
