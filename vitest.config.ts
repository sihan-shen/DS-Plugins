import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/dsh-orchestrator/tests/**/*.spec.ts',
      'tests/replay/**/*.spec.ts',
      'tests/provider/**/*.spec.ts',
    ],
    exclude: ['upstream/**', '.worktrees/**'],
  },
})
