import { defineConfig, configDefaults, coverageConfigDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Heavy benchmark suite (full grammar sweep + 3-pass CSS ratio guard) —
    // slow by design, and already covered on relevant commits by the
    // pre-commit hook (`pnpm perf:guard`). Run explicitly via `pnpm test:perf`.
    exclude: [...configDefaults.exclude, 'test/perf/parseman-perf.test.ts'],
    coverage: {
      provider: 'v8',
      // `text` for a human-readable summary in the terminal; `json-summary`
      // is what `scripts/coverage-guard.mjs` / `update-coverage-baseline.mjs`
      // read (a single `coverage/coverage-summary.json` with a `total` row);
      // `html` for local browsing (`open coverage/index.html`).
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        'src/**/*.d.ts',
        // Type re-exports / barrel files — no executable logic to cover.
        'src/types.ts',
        'src/index.ts',
        'src/cst/types.ts',
      ],
    },
  },
})
