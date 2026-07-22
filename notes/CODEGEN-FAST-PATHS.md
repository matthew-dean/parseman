# How Parseman generated code is designed to be fast (agent-readable)

This is the working model for **why the macro/`compile()` output looks the way it
does**, and the rules to preserve (and extend) when touching `src/compiler/codegen.ts`.
It is prescriptive: new codegen should follow these, and new combinators should be
checked against the **"early exit before setup"** rule below.

## The one rule that matters most: pre-compute the early exit BEFORE any setup

**A combinator must reject on the cheapest available signal (usually a single
`input.codePointAt(pos)` first-set test) BEFORE it allocates or mutates anything.**

Parsing is dominated by *speculative* calls that fail immediately — an early arm of
a non-disjoint `choice`, a `many` body at its terminating iteration, a production
tried at every position by a non-dispatching caller. Every one of those must cost a
first-byte comparison, not a frame setup. Concretely, generated recognizers should
`break <failLabel>` / `return fail` on a first-set miss *above* the lines that:

- allocate collector arrays (`_ch`/`_raw`/`_tl = []`),
- swap CST context fields (`_ctx._cstChildren = …`),
- save rollback marks (`_ctx._cstLeaves?.length ?? 0`),
- clone state, install trivia, etc.

The guard is **sound** exactly when the body has a discrete (non-`any`) first set
and cannot match empty (`needsFirstSetGuard`): a first-set miss then *cannot* match,
so bailing is behavior-identical, and nothing was set up to roll back. It must record
the same static `expected` a body start-fail would (`armStaticExpected`) so
diagnostics are unchanged, and it is **skipped under compiled recovery**
(`ctx.recovery`), where a swallowed failure still feeds the completions probe.

### Where this guard is applied (keep this table current)

| construct | setup done before recognize | guard status |
|---|---|---|
| `choice` arm | — (already first-set dispatches; `asciiDispatch` / per-arm `firstSetCond`) | ✅ built-in |
| `many` / `oneOrMore` body | attempt-then-fail at the terminating iteration | ✅ 0.29.0 (`emitMany`, gated `!failsAtStart`) |
| `node()` capture frame | allocates `_ch`/`_raw`/`_tl` arrays + swaps CST context | ✅ 0.29.0 (`emitNode`, gated `capturesChildren \|\| structural`) |
| `attempt(inner)` | 6 rollback-mark reads (`_ctx._cstLeaves?.length ?? 0`, …) before `inner` | ✅ 0.29.0 (`emitAttempt`; ~1% — reads, not allocs) |
| `sepBy` separator loop | 4 rollback marks + trivia-skip before the separator | ⬜ CANDIDATE — trickier: marks precede the trivia-skip and the separator starts *after* trivia, so a clean pre-marks first-set check needs a post-trivia peek. 11 grammar uses vs 35 `many(sequence(sep,elem))` already covered by the `many` guard |
| `sequence` | tuple `[…]` only AFTER terms parse; skipped when `valueUnused` | ✅ already lazy |

**When adding a combinator, ask:** does it do any allocation/mutation/mark before
its first token is recognized? If yes and its first set is discrete + non-empty,
emit a `firstSetCond` guard before that setup, recording `armStaticExpected`, gated
on `!ctx.recovery`.

## The other techniques the generated code relies on

- **Labeled-block + `break` to skip logic, not nested `if/else`.** Recognizers wrap
  their body in `_pfail: { … }` (and trivia scanners in `_triv: { … }`). A failure
  anywhere `break`s straight to the boundary; the failure result is returned once
  after the block. This keeps the hot success path a straight line with no
  per-step branching to re-check "did we already fail", and lets any depth bail in
  one jump. Preserve this — do not convert `break _pfail` chains into nested
  conditionals.

- **First-set char dispatch for disjoint choices.** When a `choice`'s arms have
  pairwise-disjoint first sets, codegen emits one `input.codePointAt(pos)` read and
  a `switch`/`if` jump table (`planDisjointDispatch`) straight to the one arm that
  can match — no ordered tr-and-backtrack. Non-disjoint choices fall back to ordered
  `firstMatch`; that is exactly where the per-arm/per-node first-set guards above pay
  off (a shared-prefix arm is entered speculatively).

- **Arity-gated capture elision.** A direct `node(build)` only allocates the
  collectors its builder actually reads (`buildReadsChildren`/`buildReadsRaw`/
  `buildReadsFields`/`buildReadsTrivia`; structural/host nodes gate on `_hostReads`).
  An unread collector is never allocated. Don't defensively capture "just in case".

- **Profiling-phase hoist.** The `run({profile:true})` recognizer/capture/host phase
  split is read ONCE per node into `_pm`/`_rec`/`_cap` locals, not re-evaluated
  `_ctx._pmProfile?.phase === X` ~8× per node. On the normal path `_pm` is undefined
  and the ternaries collapse to cheap boolean locals.

- **Zero-alloc failure payloads.** Static `expected` arrays are hoisted+frozen
  module constants (`hoistExpected`); a leaf failure references the frozen array
  rather than building one. `recordFail` is OFF inside swallowers (optional / many /
  sepBy / not / choice arms) — a leaf failing there just `break`s and records
  nothing (the hot loop-termination / first-arm-miss path pays zero).

- **Trivia fast-path.** A scannable trivia (`oneOrMore(choice(<scannable arms>))`)
  lowers to a hand-rolled `while` char-scan (`analyzeTriviaFastPath` /
  `buildFastTriviaFnDecl`) instead of running the combinator, with a single
  whole-run capture. Labeled variants add per-chunk kind capture.

- **`markUnusedValues` / `valueUnused`.** When a `sequence` tuple or a `many` array is
  never observed (it sits under a `node()` that builds from captured children), the
  array is not built — the terms still parse and self-capture.

## Measured impact (Less `benchmark.less`, parse-only)

- Repeat-body first-set guard (`emitMany`): ~3–4% (loop-termination misses).
- Node-capture first-set guard (`emitNode`): ~6–7% on top (Less `@{…}` interpolation
  was invoked ~56k times/parse — 981 `@`, 26 real `@{` — almost all rejected on the
  first byte, each previously allocating a full capture frame).
- Cumulative vs no guards: ~11%. These are parseman-level, so **every** parser
  (css/less/scss/jess) that recompiles inherits them — the highest-leverage place to
  optimize is here, not in a single grammar.

## Loop early-exit review (2026-07-22)

Reviewed every generated loop for "does it keep iterating / doing setup when it
could already stop?". The only systematic finding is the **setup-before-recognize**
pattern above — a loop that allocates/marks/skip-trivia for an iteration whose body
then rejects on the first byte. That is now guarded for `many`/`oneOrMore` and the
speculative `node`/`attempt` entries. The `while (cur < input.length)` loops
otherwise exit correctly (body-fail, EOF, or zero-width `iterEnd <= itemPos`).
`choice` firstMatch stops at the first matching arm; on no match it must try all
(that is what the per-arm first-set guards make cheap). No other over-iteration
pattern found. Remaining: `sepBy` (above).

## Not-yet-done candidates (early-exit-before-setup rule)

1. **`sepBy` separator guard** — needs the post-trivia peek (marks precede the
   trivia-skip); do it when the post-trivia first-set machinery exists.
2. **Interpreter parity** — the interpreter (`src/combinators/*`) does the analogous
   allocate-before-recognize in `node`/`repeat`; a matching first-set pre-check keeps
   interpreter and compiled speed closer and is a natural mirror of the codegen guards.
