import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@han_05/dsh-telemetry/contracts': fileURLToPath(new URL('./packages/dsh-telemetry/src/contracts.ts', import.meta.url)),
      '@han_05/dsh-context': fileURLToPath(new URL('./packages/dsh-context/src/index.ts', import.meta.url)),
      '@han_05/dsh-code-intelligence': fileURLToPath(new URL('./packages/dsh-code-intelligence/lib/index.mjs', import.meta.url)),
      '@han_05/dsh-scheduling-contracts': fileURLToPath(new URL('./packages/dsh-scheduling-contracts/src/index.ts', import.meta.url)),
      '@han_05/dsh-orchestrator': fileURLToPath(new URL('./packages/dsh-orchestrator/src/index.ts', import.meta.url)),
      '@han_05/dsh-adaptive-scheduler': fileURLToPath(new URL('./packages/dsh-adaptive-scheduler/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: [
      'packages/dsh-telemetry/tests/**/*.spec.ts',
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
