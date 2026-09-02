import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@ds-plugins/dsh-context': fileURLToPath(new URL('./packages/dsh-context/src/index.ts', import.meta.url)),
      '@ds-plugins/dsh-scheduling-contracts': fileURLToPath(new URL('./packages/dsh-scheduling-contracts/src/index.ts', import.meta.url)),
      '@ds-plugins/dsh-code-intelligence': fileURLToPath(new URL('./packages/dsh-code-intelligence/src/index.ts', import.meta.url)),
      '@ds-plugins/dsh-orchestrator': fileURLToPath(new URL('./packages/dsh-orchestrator/src/index.ts', import.meta.url)),
      '@ds-plugins/dsh-adaptive-scheduler': fileURLToPath(new URL('./packages/dsh-adaptive-scheduler/src/index.ts', import.meta.url)),
      '@deepseek-ai/cordis': fileURLToPath(new URL('./packages/dsh-orchestrator/node_modules/@deepseek-ai/cordis', import.meta.url)),
      '@deepseek-ai/dsh-agent': fileURLToPath(new URL('./packages/dsh-orchestrator/node_modules/@deepseek-ai/dsh-agent', import.meta.url)),
      'js-yaml': fileURLToPath(new URL('./packages/dsh-orchestrator/node_modules/js-yaml', import.meta.url)),
    },
  },
  test: {
    include: [
      'packages/dsh-scheduling-contracts/tests/**/*.spec.ts',
      'packages/dsh-adaptive-scheduler/tests/**/*.spec.ts',
      'packages/dsh-context/tests/**/*.spec.ts',
      'packages/dsh-context-cache/tests/**/*.spec.ts',
      'packages/dsh-code-intelligence/tests/**/*.spec.ts',
      'packages/dsh-eval/tests/**/*.spec.ts',
      'packages/dsh-orchestrator/tests/**/*.spec.ts',
      'tests/eval/**/*.spec.ts',
      'tests/plugins/**/*.spec.ts',
      'tests/replay/**/*.spec.ts',
      'tests/provider/**/*.spec.ts',
    ],
    exclude: ['upstream/**', '.worktrees/**'],
  },
})
