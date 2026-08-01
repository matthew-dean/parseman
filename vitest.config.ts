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
        // Frozen ABLATION copies. bench/g5-ablate.ts keeps the PREVIOUS driver and
        // encoder alive in-process to measure one change against a same-path control
        // -- isolating a driver change needs the encoder frozen too, since the change
        // spans both. They are benchmark fixtures that must not drift, not shipped
        // code: nothing imports them outside bench/, and covering them would mean
        // testing a snapshot of code that already has its own tests at HEAD.
        'src/table/exec-baseline.ts',
        'src/table/encode-baseline.ts',
        // DELIBERATELY UNREFERENCED, and that is the point -- nothing in src/
        // imports them, so they execute on no code path a test could reach without
        // first wiring them in. They are the build-out of the settled predictive
        // token-cursor direction (design ledger G14), which under G19 must always
        // have a builder. Deleting them because a coverage gate flagged 0% is the
        // obvious reading and the wrong one; excluding them keeps the gate honest
        // about the code that DOES ship. Remove these lines the moment either is
        // imported by shipped code -- at that point coverage is a real requirement.
        'src/compiler/token-scanner.ts',
        'src/compiler/token-alphabet.ts',
        // Reachability walker used only by bench/g5-coverage.ts to report which
        // constructs a grammar reaches. Not a runtime path.
        'src/table/inspect.ts',
      ],
    },
  },
})
