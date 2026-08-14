# Historical source-codegen fast paths

> **Authority/status (2026-08-08): historical evidence, not current architecture.**
> The source generator described here (`src/compiler/codegen.ts`,
> `trivia-fast-path.ts`, and `scannable-run.ts`) was deleted during the 0.47
> cutover. The shipping lowering is the closure-based TableProgram assembler in
> `src/table/assemble.ts`; current piece and token integration rules live in
> [`DESIGN-piece-library.md`](./DESIGN-piece-library.md) and
> [`derived-tokenization.md`](../docs/design/derived-tokenization.md). Keep this
> note for the old mechanisms, recovery point, and weakly-proven measurements.

## Provenance and status

The deletion was an LLM oversight, not an owner decision. Recovery point:
**`3d4dac6`** (`trivia-fast-path.ts` 296 lines,
`scannable-run.ts` 1,627 lines). The 0.48 owner ledger tracks recovery under
[`RELEASE-0.48-TARGET.md`](./RELEASE-0.48-TARGET.md) §9 and
[`PERF_IDEAS.md`](./PERF_IDEAS.md) U-53.

The historical register contained **16 items**. Under the repository status
convention, 11 mechanisms below are **LANDED, THEN
REMOVED**, two are `QUEUED`, one is `UNMEASURED`, and two blocks are
`REFERENCE`. That exceptional state is deliberate: the work once shipped and
was later removed without a decision, so neither `REJECTED` nor `QUEUED` is
accurate.

The figures below name Less `benchmark.less` (parse-only), but name **no commit,
harness, sample count, protocol, or instrumentation**. The old engine no longer
exists at HEAD, so none is re-derivable as stated. Treat `~3–4%`, `~6–7%`,
`~11%`, `~1%`, `~56k`, `981`, `26`, and the `11`/`35` site counts as weak
historical evidence, never as a current performance claim.

## Engine-independent law

Reject on the cheapest sound signal **before** allocating, saving rollback
marks, swapping capture sinks, cloning state, or installing trivia. A first-set
guard is sound when the body has a discrete first set and is non-nullable. It
must preserve the body's static `expected` result and must not bypass recovery
or completion semantics.

The old generator implemented that law with a first-character check above the
setup. These were the exact historical sites:

| construct | setup avoided | old status / evidence |
|---|---|---|
| disjoint `choice` arm | ordered speculative arm entry | built in via `asciiDispatch` / `firstSetCond` |
| `many` / `oneOrMore` body | terminating attempt | landed 0.29.0 in `emitMany`; claimed ~3–4% |
| `node()` | `_ch`/`_raw`/`_tl` allocation and CST sink swap | landed 0.29.0 in `emitNode`; claimed ~6–7% on top |
| `attempt(inner)` | six rollback-mark reads | landed 0.29.0 in `emitAttempt`; claimed ~1% |
| `sepBy` separator loop | four marks plus trivia skip | **QUEUED**; 11 alleged uses vs 35 `many(sequence(sep, elem))` |
| `sequence` | tuple allocation | already lazy; `valueUnused` skipped it |

The claimed node result came from Less interpolation: `@{…}` was allegedly
entered ~56k times per parse for 981 `@` bytes and 26 real interpolations, so
almost every entry rejected after previously allocating a capture frame. The
claimed cumulative repeat-plus-node result was ~11%.

The current architecture must re-measure the mechanism at current production
sites. A standalone recognizer win is not evidence for boundary elimination;
the relevant question is whether a TableProgram piece can reject before its
closure/capture/rollback setup while preserving the one recognition contract.

## Other old generated shapes worth auditing, not copying blindly

- **Labeled failure blocks.** `_pfail: { … }` and `_triv: { … }` let any depth
  `break` to one failure boundary without success-path rechecks.
- **One-read disjoint dispatch.** `planDisjointDispatch` read the lead character
  once and jumped directly to the only possible arm; overlapping arms retained
  ordered first-match semantics.
- **Arity-gated capture elision.** `buildReadsChildren`, `buildReadsRaw`,
  `buildReadsFields`, `buildReadsTrivia`, and `_hostReads` avoided collectors a
  builder could not observe.
- **Profile-phase hoisting.** `_pm`/`_rec`/`_cap` cached the profile phase once
  per node instead of repeating `_ctx._pmProfile?.phase === …` roughly eight
  times.
- **Zero-allocation static failures.** `hoistExpected` froze payloads; swallowed
  optional/repeat/choice misses did not record a failure.
- **Trivia scan fusion.** `analyzeTriviaFastPath` /
  `buildFastTriviaFnDecl` recognized scannable trivia with one character loop
  and one whole-run capture; labeled trivia additionally captured per kind.
- **Unused-value elimination.** `markUnusedValues` / `valueUnused` omitted
  sequence tuples and repeat arrays whose enclosing node only observed captures.

All of those concrete names refer to deleted source codegen. Current equivalents
must bind through the fixed-piece library and keep its bounded-family and
fallback rules; they are not instructions to restore per-rule emitted source.

## Completed loop audit and remaining candidates

The 2026-07-22 audit found no systematic over-iteration beyond
setup-before-recognize. Old loops otherwise stopped on body failure, EOF, or
zero-width progress (`iterEnd <= itemPos`); first-match stopped at the first
matching arm. The one unbuilt old-generator case was `sepBy`: its separator
starts after trivia but rollback marks preceded the trivia skip, so a sound
pre-mark guard needed a post-trivia peek.

Two candidates remain only as questions:

1. **`sepBy` post-trivia separator guard — `QUEUED`.** Re-express through the
   current skip/piece seam, then measure production dynamic coverage.
2. **Interpreter `node()` parity — `UNMEASURED`.** Do not repeat the
   `many`/`oneOrMore` half: [`INTERPRETER_PERF_IDEAS.md`](./INTERPRETER_PERF_IDEAS.md)
   records that experiment regressing GraphQL, CSS, and TOML.
