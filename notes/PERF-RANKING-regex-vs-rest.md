# Perf-idea ranking, from a real profile (regex lowering ranks LAST)

CPU profile of `parseCssCompiled(bootstrap4.css)` (156 KB), 400 parses after warm,
`node --prof`. This is the evidence for ranking regex lowering against the other
levers.

## Where the time actually goes

| bucket | % of ticks | what it is |
|---|---|---|
| **C++** | **66.5%** | V8 internals — object/array/string allocation, WeakMap, the RegExp engine, string slices. Allocation-dominated. |
| JavaScript | 31.9% | the compiled parser fns (`_pf*` reify, `_tf0` trivia-skip) |
| **GC** | **13.1%** | garbage collector — driven by the transient CST + per-node allocation |

Top JS self-time (compiled fns):

| fn | self % | likely |
|---|---|---|
| `_pf13` | 5.1% | value/decl dispatch (`_r_value` choice) |
| `_pf8` | 3.9% | a hot selector/value reifier |
| **`_tf0`** | **3.2%** | **trivia-skip** — called at every `many`/`sequence` boundary |
| `_pf10`/`_pf4`/`_pf7`/… | 1.8–2.9% ea | the reify tail |
| **all `RegExp:` lines combined** | **~1.2%** | **the number, hex, and nth regexes — the ENTIRE regex cost** |

## Regex is ~2.6% (profiler undercounts C++, but not by much)

The profiler's `RegExp:` self-time (1.2%) undercounts because Irregexp's matching
runs in C++ that isn't fully attributed to the JS `RegExp:` frame. Measured
attribution-independently instead — count exec calls per parse × real per-call
wall-clock (which *includes* the C++ engine):

- **7,631** live-`_reN` exec calls per parse of bootstrap4.css (the un-lowered
  regexes; the rest are already charCodeAt scans in the JS bucket).
- Hottest is the number regex `_re2` (6,762 calls) at **22 ns/exec including C++**.
- Total ≈ **168 µs of ~6,500 µs = ~2.6%**.

So the true regex cost is ~2.6%, not 1.2% — the profiler *did* undercount. But even
corrected it is tiny, and lowering it only *moves* the work from C++ regex into a
JS charCodeAt loop (not free either) — which is exactly why two prior lowering A/Bs
(keyword, escape-ident) moved the full-parse clock **0%**.

## The ranking (highest expected payoff → lowest)

1. **CST capture (rawChildren + cstTriviaLog).** MEASURED CEILING on bootstrap4.css
   (force each buffer's node() set-site to `void 0`, same span-end): skip
   cstTriviaLog **−28.6%**, skip rawChildren **−30.9%**, skip **both −51%**. This is
   the dominant cost and the OPPOSITE of the value-array-elision result (that was a
   tiny slice: ~7% alloc / 0% time). rawChildren captures *every leaf including
   trivia* per node — far more push/alloc volume than the value tuples.

   **Real-jess applicability** (checked `packages/css-parser/src/builders.ts`): the
   build host is `_dispatchBuild(type, span, children, rawChildren)` —
   - **children**: live.
   - **rawChildren**: LIVE — SelectorList/ComplexSelector/Declaration/Call/Paren/
     SquareParen all build from it. NOT recoverable without restructuring builders.
   - **cstTriviaLog (~28.6%)**: **DEAD** — the host never reads a trivia arg; jess
     trivia comes from the separate `_triviaLog` diagnostic log via
     `buildLazyTriviaMap`. Recoverable, byte-identical.
   - **state**: DEAD — `buildNode` receives it but never passes it to `_dispatchBuild`.

   → Actionable win: structural `node()` currently forces `capturesTrivia = true` +
   `clonesState = true` defensively (codegen.ts:1737-1738). Add a way for the host
   to declare its arity (reads children+rawChildren only) so structural nodes skip
   the cstTriviaLog + state capture. Ceiling ~28.6% on the stub path; must be
   re-measured on the real jess structural+host path before keeping.
2. **Compiled-fn dispatch** — `_pf13` (value choice, 5.1%). Bounded (~5%).
3. **Trivia-skip call-site reduction** — `_tf0` (3.2%). Bounded (~3%).
4. **Regex lowering** — **~2.6% total, ALL regexes, C++ included.** Lowest-value
   lever; measured 0% full-parse gain twice. Warning stays opt-in.

## LANDED: structural-node arity gate (2026-07-05)

Implemented in `emitNode` (codegen.ts): structural `node(type, parser)` now gates
cstTriviaLog + state capture on the injected host's arity at parse time —
`_ctx.build.length >= 5` reads trivia, `>= 6` reads state (host sig
`(type, children, rawChildren, span, trivia, state)`). Arity < 5 skips the
per-token cstTriviaLog push; the runtime twin of `buildReadsTrivia`/`buildReadsState`.

**Verified** (all jess hosts are arity-4 → both captures skipped):
- Isolated A/B, arity-4 vs arity-6 host, same grammar+input, byte-identical span:
  synthetic structural grammar **−24.0%**; **real jess CSS grammar on bootstrap.css
  (201 KB) −21.2%** (17266 → 13604 µs).
- Correctness: parseman 1440/1440; jess css-parser 188/188 byte-identical; scss
  265/265; less 485 pass (the 6 less fails are pre-existing — identical on baseline
  parseman, unrelated to the gate).

vs regex lowering's measured 0% — this is the real lever the ranking predicted.
rawChildren (the other ~30%) stays: the jess host genuinely reads it.

## Takeaway

Regex lowering is the *bottom* of the ranking (~2.6%). The real money is **CST
capture** — and unlike the earlier value-array elision (0% time), this is a
measured 28–51% ceiling. For real jess, ~28.6% of it (cstTriviaLog + state) is
provably dead because the build host reads only children+rawChildren. Next step:
add a host-arity declaration so structural `node()` skips dead trivia/state
capture, then re-measure on the real jess parse. Anything kept must show real gain
on a real parse (policy in `NOT-PURSUED-escape-ident-lowering.md`).
