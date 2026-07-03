import { mergeConfig, defineConfig } from 'vitest/config'
import baseConfig from './vitest.config.ts'

// Coverage-specific overrides layered on top of the default config.
//
// `test/perf/` mixes correctness assertions with genuine timing loops
// (`codegen-ab.test.ts`: 4,000-iteration A/B perf floors with 60s timeouts;
// `css-parser.test.ts`: 20 timed passes over bootstrap4.css). Only
// `parseman-perf.test.ts` was excluded from the default config — the other
// two still ran under plain `pnpm test`. Running ANY of them under
// `--coverage` is pure waste: v8 coverage instrumentation adds real overhead
// per call, which can skew the very timings those tests assert on, and once
// a line has executed once, repeating it thousands more times for a stable
// median buys zero additional coverage. So: exclude the whole directory from
// the coverage run specifically. `pnpm test` (no coverage) is unaffected —
// codegen-ab.test.ts / css-parser.test.ts still run there exactly as before,
// so their correctness assertions aren't lost from the normal suite.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: ['test/perf/**'],
    },
  }),
)
