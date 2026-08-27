import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name for the DSH v0.1 orchestration bundle. */
export const name = 'ds-orchestrator'

/**
 * Mount the v0.1 bundle entry point.
 * @param _ctx - Cordis context that later v0.1 tasks extend with orchestration services.
 */
export function apply(_ctx: Context): void {}
