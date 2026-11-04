import { defineConfig, configDefaults, coverageConfigDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The gating diagnostic no longer needs silencing: nothing in the compile path
    // runs it. It is a deliberate call (`diagnoseGrammar`), so a test that wants it
    // makes that call and a test that does not is unaffected — which is the point.
    // The degradation diagnostic IS still default-on for real consumers. This suite
    // compiles hundreds of deliberately-degenerate grammars, so silence it here; the
    // tests that exercise it set `PARSEMAN_DEGRADATION` explicitly.
    env: { PARSEMAN_DEGRADATION: 'off' },
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
        // DELIBERATELY UNREFERENCED: no shipped module imports it, so it runs on no
        // code path a test could reach without first wiring it in. It is the
        // dormant build-out of the predictive token-cursor direction (Jess design
        // ledger G14, kept under G19). Remove this line the moment shipped code
        // imports it: coverage is then a real requirement. `token-alphabet.ts`
        // and `table/inspect.ts` were excluded on the same grounds once; both are
        // imported by shipped code now, so both are covered.
        'src/compiler/token-scanner.ts',
        // Vendored railroad-diagrams, kept verbatim. It used to ship as a source
        // string, which coverage never counted; as real code its builders that the
        // spec tooling never calls would count against parseman's own code.
        'src/spec/railroad-lib.ts',
      ],
    },
  },
})
