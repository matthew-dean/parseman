# Dispatch vs Choice Perf Evidence

Date: 2026-07-27

`dispatch(selector, when(...), otherwise(...))` is the preferred grammar shape when
branches first share an opener, then diverge by the value that opener returned. A
plain `choice(...)` can be correct for the same language, but late and generic arms
recheck the shared opener before they can fail.

## Fixture

`bench/dispatch-vs-choice.ts` builds equivalent grammars for broad shared-opener
shapes:

- Identifier/function two-arm grammars where both arms begin by parsing an
  identifier and only then diverge by `(`.
- Identifier/function grammars with specific function cases, a generic function
  fallback, and a keyword fallback.
- Identifier grammars with a `matches(...)` dispatch arm. This is generated-code
  coverage for matcher routing, not a speed-gate fixture.
- Multi-branch identifier grammars with several same-opener continuations.
- At-rule timing fixture: exact `@keyword` `choice` arms plus a generic
  `@[A-Za-z-]+ ;` fallback, compared with a `dispatch` grammar that parses
  `@[A-Za-z-]+` once and routes exact names with `when(...)`.

The normal test suite checks equivalence and diagnostic shape:
`test/perf/dispatch-vs-choice.test.ts`.

## Local Measurement

Command:

```bash
pnpm bench:dispatch
```

Local run on 2026-07-27, same checkout as the 0.41.0 release prep:

| Workload | Choice | Dispatch | Ratio | Policy |
| --- | ---: | ---: | ---: | --- |
| identifier/function, all keywords | 68.97 us/op | 30.92 us/op | 2.23x | target > 1.25x |
| identifier/function, 10% functions | 76.48 us/op | 38.12 us/op | 2.01x | target > 1.20x |
| identifier/function, 50% functions | 68.74 us/op | 45.03 us/op | 1.53x | target > 1.05x |
| identifier/function, 90% functions | 62.10 us/op | 50.54 us/op | 1.23x | tracked, not a win gate |
| specific + generic function opener | 66.02 us/op | 44.87 us/op | 1.47x | target > 1.10x |
| identifier `matches(...)` arm | 43.38 us/op | 44.11 us/op | 0.98x | tracked, not a win gate |
| identifier multi-branch opener | 126.06 us/op | 40.49 us/op | 3.11x | target > 1.20x |
| at-rule shared opener | 57.47 us/op | 21.99 us/op | 2.61x | target > 1.25x |

Treat these as benchmark-style evidence for the grammar-authoring recommendation,
not as a release gate. The matcher case is intentionally tracked even when it is
flat: the regex predicate itself is real work, and the fixture exists to keep
matcher routing covered by generated-code tests.

## Test Policy

`pnpm test` runs deterministic validity and correctness checks only. Timing is
opt-in:

```bash
PARSEMAN_PERF=1 pnpm vitest run --config vitest.perf.config.ts test/perf/dispatch-vs-choice.test.ts
```

The opt-in timing assertions use deliberately loose per-workload floors and skip
tracked-only cases. They are useful for manual verification and review, but they
are not part of the hard release gate.
