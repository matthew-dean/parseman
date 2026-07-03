import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Heavy benchmark suite (full grammar sweep + 3-pass CSS ratio guard) —
    // slow by design, and already covered on relevant commits by the
    // pre-commit hook (`pnpm perf:guard`). Run explicitly via `pnpm test:perf`.
    exclude: [...configDefaults.exclude, 'test/perf/parseman-perf.test.ts'],
  },
})
