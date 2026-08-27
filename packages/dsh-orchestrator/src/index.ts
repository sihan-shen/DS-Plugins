import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'
import type { OrchestratorConfig } from './types.js'

export { Config, parseConfig } from './config.js'
export { failedHandoff, normalizeWorkerOutput, parseHandoff } from './handoff.js'
export type {
  HandoffV1,
  OrchestratorConfig,
  VerificationCommand,
  VerificationEvidenceV1,
  WorkerSpecV1,
} from './types.js'

/** Stable Cordis plugin name for the DSH v0.1 orchestration bundle. */
export const name = 'ds-orchestrator'

/**
 * Mount the v0.1 bundle entry point.
 * @param _ctx - Cordis context that later v0.1 tasks extend with orchestration services.
 * @param _config - Validated deployment configuration reserved for later v0.1 tasks.
 */
export function apply(_ctx: Context, _config: OrchestratorConfig): void {}

apply.Config = Config
