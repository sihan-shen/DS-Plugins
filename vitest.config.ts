import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@ds-plugins/dsh-context': fileURLToPath(new URL('./packages/dsh-context/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: [
      'packages/dsh-context/tests/**/*.spec.ts',
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
