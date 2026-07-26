# Dispatch vs Choice Perf Evidence

Date: 2026-07-26

`dispatch(selector, when(...), otherwise(...))` is the preferred grammar shape when
branches first share an opener, then diverge by the value that opener returned. A
plain `choice(...)` can be correct for the same language, but late and generic arms
recheck the shared opener before they can fail.

## Fixture

`bench/dispatch-vs-choice.ts` builds equivalent grammars for two shared-opener
shapes:

- At-rule timing fixture: exact `@keyword` `choice` arms plus a generic
  `@[A-Za-z-]+ ;` fallback, compared with a `dispatch` grammar that parses
  `@[A-Za-z-]+` once and routes exact names with `when(...)`.
- Media-feature diagnostics fixture: `(width >= 50em)` and `(min-width: 50em)`
  share `(` + identifier, then diverge by range operator vs `:`. The
  `dispatch` form parses the feature head plus marker once and routes the tail.

Both grammars return identical values on the benchmark workload and on focused
representative inputs. The normal test suite checks that equivalence and that the
choice form emits the shared-opener gating warning while the dispatch form does not:
`test/perf/dispatch-vs-choice.test.ts`.

## Local measurement

Command:

```bash
pnpm bench:dispatch
```

Four local runs on the same checkout:

| Run | Choice | Dispatch | Ratio |
| --- | ---: | ---: | ---: |
| 1 | 74.44 µs/op | 39.77 µs/op | 1.87x |
| 2 | 61.86 µs/op | 33.16 µs/op | 1.87x |
| 3 | 70.12 µs/op | 37.60 µs/op | 1.87x |
| 4 | 58.85 µs/op | 31.65 µs/op | 1.86x |

The absolute times moved between runs; the ratio did not. Treat this as a
benchmark-style proof artifact for the grammar-authoring recommendation, not as
a release gate.

## Test policy

`pnpm test` runs the deterministic validity and correctness checks only. Timing is
opt-in:

```bash
PARSEMAN_PERF=1 pnpm vitest run --config vitest.perf.config.ts test/perf/dispatch-vs-choice.test.ts
```

The opt-in timing assertion uses a deliberately loose `1.25x` floor against a
locally measured `1.87x` margin. It is useful for manual verification and review,
but it is not part of the hard release gate. The timing assertion covers only the
at-rule workload; the media-feature case is correctness and diagnostic evidence
for the docs pattern, not a speed claim.
