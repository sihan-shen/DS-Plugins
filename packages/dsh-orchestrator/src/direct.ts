import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { appendRunStarted } from './events.js'
import type { OrchestratorConfig } from './types.js'

/** Stable prompt-section name consumed by replay and prompt assembly tests. */
export const DIRECT_PROMPT_SECTION = 'ds-plugins:orchestrator'

/** Prompt ordering after the deployment persona and before tool-specific guidance. */
export const DIRECT_PROMPT_ORDER = 100

const DIRECT_PROMPT = [
  'Complete the coding task in this session. Use targeted_verify only for configured checks.',
  'Report the exact checks run and distinguish passed, failed, skipped, and unavailable checks.',
  'Report only verification that was actually run.',
  'Do not claim that an execution receipt proves correctness.',
].join('\n')

interface SystemPromptSection {
  readonly name: string
  readonly order: number
  readonly text: string
}

interface SystemPromptRegistry {
  section(section: SystemPromptSection): () => void
}

function requiredSystemPrompt(ctx: Context): SystemPromptRegistry {
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptRegistry | undefined
  if (systemPrompt === undefined) throw new Error('ds-orchestrator requires the systemPrompt service')
  return systemPrompt
}

/**
 * Mount Direct mode's root-only prompt guidance and durable run-start record.
 * @param ctx - Cordis context whose effect owns prompt and event-listener disposal.
 * @param config - Validated Direct-mode deployment configuration.
 */
export function mountDirectMode(ctx: Context, config: OrchestratorConfig): void {
  if (config.mode !== 'direct') throw new TypeError('mountDirectMode requires mode "direct"')
  const systemPrompt = requiredSystemPrompt(ctx)

  ctx.effect(() => {
    const started = new Set<SessionId>()
    let active = true
    const disposePrompt = systemPrompt.section({
      name: DIRECT_PROMPT_SECTION,
      order: DIRECT_PROMPT_ORDER,
      text: DIRECT_PROMPT,
    })
    const disposeEvents = ctx.on('session/event', (session, event) => {
      if (event.type !== 'request/header' || session.header.parentSession !== undefined || started.has(session.id)) return
      // Session observers run while the triggering append holds its no-reentry guard.
      // Publish the durable companion record immediately after that boundary closes.
      started.add(session.id)
      queueMicrotask(() => {
        if (!active || !started.has(session.id)) return
        appendRunStarted(session, {
          mode: 'direct',
          provider: config.worker.provider,
          model: config.worker.model,
        })
      })
    })
    return () => {
      active = false
      disposeEvents()
      disposePrompt()
      started.clear()
    }
  }, 'ds-orchestrator: direct mode')
}
