import type { JsonSchema } from './types.js'

const boundedString: JsonSchema = { type: 'string', maxLength: 16_384 }
const boundedIdentifier: JsonSchema = { type: 'string', minLength: 1, maxLength: 256 }
const stringArray: JsonSchema = { type: 'array', maxItems: 128, items: boundedString }
const identifierArray: JsonSchema = { type: 'array', maxItems: 128, items: boundedIdentifier }

const verificationEvidence: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    commandName: boundedIdentifier,
    args: stringArray,
    exitCode: { oneOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    status: { type: 'string', enum: ['passed', 'failed', 'timed-out', 'spawn-error'] },
    stdout: boundedString,
    stderr: boundedString,
    truncated: { type: 'boolean' },
    durationMs: { type: 'integer', minimum: 0, maximum: 600_000 },
  },
  required: ['schemaVersion', 'commandName', 'args', 'exitCode', 'status', 'stdout', 'stderr', 'truncated', 'durationMs'],
}

const handoff: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
    summary: boundedString,
    changedFiles: stringArray,
    decisions: stringArray,
    verification: { type: 'array', maxItems: 128, items: verificationEvidence },
    blockers: stringArray,
  },
  required: ['schemaVersion', 'status', 'summary', 'changedFiles', 'decisions', 'verification', 'blockers'],
}

const profile: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    coding: { type: 'number', minimum: 0, maximum: 100 },
    reasoning: { type: 'number', minimum: 0, maximum: 100 },
    toolUse: { type: 'number', minimum: 0, maximum: 100 },
    repoContext: { type: 'number', minimum: 0, maximum: 100 },
    risk: { type: 'number', minimum: 0, maximum: 100 },
    difficulty: { type: 'number', minimum: 0, maximum: 100 },
  },
  required: ['coding', 'reasoning', 'toolUse', 'repoContext', 'risk', 'difficulty'],
}

const constraints: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxWorkers: { type: 'integer', enum: [0, 1] },
    maxOutputTokens: { type: 'integer', minimum: 1, maximum: 128_000 },
    maxLatencyMs: { type: 'integer', minimum: 1, maximum: 600_000 },
    allowPaidFallback: { type: 'boolean' },
    allowedProviders: identifierArray,
    requiredTools: identifierArray,
  },
  required: ['maxWorkers', 'maxOutputTokens', 'maxLatencyMs', 'allowPaidFallback', 'requiredTools'],
}

const route: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: boundedIdentifier,
    model: boundedIdentifier,
    maxTokens: { type: 'integer', minimum: 1, maximum: 128_000 },
    reasoningEffort: boundedIdentifier,
    promptProfile: boundedIdentifier,
    modelFamily: boundedIdentifier,
  },
  required: ['provider', 'model', 'maxTokens'],
}

export const CAPABILITY_REQUEST_V1_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    target: { type: 'string', enum: ['root', 'worker'] },
    taskId: boundedIdentifier,
    objective: boundedString,
    profile,
    constraints,
    workspaceFingerprint: boundedIdentifier,
    repoRevision: boundedIdentifier,
    affinity: {
      type: 'object',
      additionalProperties: false,
      properties: {
        workerId: boundedIdentifier,
        modelFamily: boundedIdentifier,
        snapshotId: boundedIdentifier,
      },
    },
    priorHandoff: handoff,
  },
  required: ['schemaVersion', 'target', 'taskId', 'objective', 'profile', 'constraints'],
}

export const ROUTE_DECISION_V1_JSON_SCHEMA: JsonSchema = route

export const SCHEDULE_DECISION_V1_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    mode: { type: 'string', enum: ['direct', 'single-worker'] },
    route,
    workerCount: { type: 'integer', enum: [0, 1] },
    source: { type: 'string', enum: ['scheduler', 'profile-fallback'] },
    policyVersion: boundedIdentifier,
    affinityKey: boundedIdentifier,
    explanationCode: boundedIdentifier,
  },
  required: ['schemaVersion', 'mode', 'route', 'workerCount', 'source', 'policyVersion'],
}
