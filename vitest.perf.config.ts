import { defineConfig } from 'vitest/config'

// Dedicated config for the heavy Parseman perf suite (full grammar sweep +
// 3-pass CSS ratio guard). Split out of the default `pnpm test` run because it
// benchmarks rather than unit-tests — run it explicitly via `pnpm test:perf`.
export default defineConfig({
  test: {
    include: ['test/perf/parseman-perf.test.ts'],
  },
})
