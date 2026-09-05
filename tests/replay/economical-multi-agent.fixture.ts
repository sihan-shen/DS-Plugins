import type { TaskDagV1 } from '@ds-plugins/dsh-scheduling-contracts'

const profile = { coding: 50, reasoning: 50, toolUse: 50, repoContext: 50, risk: 50, difficulty: 50 } as const
const constraints = { maxWorkers: 1, maxOutputTokens: 32_000, maxLatencyMs: 60_000, allowPaidFallback: false, requiredTools: ['read_file'] } as const

export const economicalMultiAgentDag: TaskDagV1 = {
  schemaVersion: 1,
  rootTaskId: 'economical-root',
  nodes: [
    { schemaVersion: 1, nodeId: 'worker-a', objective: 'Research the first independent area.', profile, constraints, readPaths: [{ path: 'src/a.ts', recursive: false }], writePaths: [], dependsOn: [] },
    { schemaVersion: 1, nodeId: 'worker-b', objective: 'Research the second independent area.', profile, constraints, readPaths: [{ path: 'src/b.ts', recursive: false }], writePaths: [], dependsOn: [] },
  ],
}

export function parallelReplayEvents(events: readonly { type: string; data: unknown }[]) {
  return events.filter(event => event.type.startsWith('dsh-plugin/parallel-') || event.type === 'dsh-plugin/schedule-selected' || event.type === 'dsh-plugin/worker-requested' || event.type === 'dsh-plugin/worker-finished')
}
