import { defineConfig } from 'vitest/config'

// Dedicated config for timing guards. They must not race each other or ordinary
// unit tests: a neighboring GC/CPU phase is not a parser-codegen regression.
// Correctness assertions in these files still run in the default suite.
export default defineConfig({
  test: {
    include: ['test/perf/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    env: { PARSEMAN_PERF: '1' },
  },
})
