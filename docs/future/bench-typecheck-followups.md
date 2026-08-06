# bench/ typecheck — deferred items

`bench/` was outside `tsconfig.json`'s `include` until 0.47, so it had never been
typechecked. Bringing it in surfaced **82 errors**. All but the items below are
fixed; this file tracks what is knowingly left, so none of it is a silent drop.

## 1. `bench/table-alloc-ablation.ts` — RESOLVED, fixed and no longer excluded

Two errors, both real:

```text
bench/table-alloc-ablation.ts(131,19): TS2304: Cannot find name 'contests'.
bench/table-alloc-ablation.ts(132,19): TS2339: Property 'get' does not exist on type '[string, Samples][]'.
```

The first is the `ReferenceError` that prompted this work: the bench died at
runtime the moment line 131 executed. Both had the same cause — `interleave`
returns `Map<string, Samples>` and the results of two calls were SPREAD into an
array, so `out` had no `.get`, and the loop over it reached for a `contests`
binding that this scope never defined (it has `baselineContests` and
`gateContests`).

**Resolution.** `out` is built as one `Map<string, Samples>` from the same two
`interleave` calls, and the reporting loop iterates
`[...baselineContests, ...gateContests]` — the list the map was populated from,
so the two cannot drift. The bench now runs to completion (exit 0) and reports
all five contests.

The "`emitConst` failure in the same bench" this entry also mentioned is not
present: the bench encodes and RUNS tables (`encodeTable` + `tableRules`) and
never calls `emitTableModule`, so nothing in it reaches `emitConst`.

**`exclude` is now empty of bench entries** and must stay that way — the whole
point of 0.47's change is that `bench/` is checked under the same settings as
`src/`.

## 2. `bench/alloc-profile.ts` + `RunOptions.profile` — RESOLVED, both removed

The bench typechecked clean and threw on first execution, because
`RunOptions.profile` existed in the type while `src/functional/run.ts` threw
unconditionally. A typecheck structurally cannot catch that class — only running
the bench can — so the option survived every gate and would only ever have failed
in the hands of whoever tried to use it.

**Resolution: the option was removed, not restored.** Evidence for that call:

- The counters went in `9751cce` ("perf(codegen): stop emitting profiling
  machinery into compiled parsers"), deliberately and with a measurement:
  examples/css 261,512 → 251,697 bytes (−3.75%), 4,612 → 4,450 LOC, 108 → 0
  `_pmProfile` sites. Every node emission site was paying a `_ctx._pmProfile`
  read plus two locals, and threading a phase ternary through ~15 further
  per-node expressions. The stated rule is that diagnostic capability must not
  reach codegen. That reason still holds for the codegen path.
- `6da3dad` then made `run({ profile })` throw rather than report an all-zero
  profile — correct, but it left the option advertised in the type.
- Nothing depended on the capability except this one bench, and the half of the
  bench that still worked (GC scavenge count + heap delta over a parse batch)
  duplicates `bench/alloc-count.ts`, which measures the same thing over the same
  model for both host variants. So the bench was deleted rather than rewritten.

**What was removed:** `RunOptions.profile`, `RunResult.profile`, the exported
`RunProfile` / `RunProfilePass` types (and their re-export from `src/index.ts`),
the `ProfilePhase` / `ProfileState` plumbing and `phase` / `profileState`
parameters of `runOnce`, the `skipGlobalSinks` branch that built the profiling
context, `ParseContext._pmProfile`, `bench/alloc-profile.ts`, and the `entry`
export in `bench/alloc-model.ts` that only that bench used.

**What was deliberately kept:** the `profileRecognizer` / `profileCapture`
emission-time gates in `src/compiler/codegen.ts`. **They went with that file in 0.47.0**
— the ~15 emission sites they were preserving no longer exist, so a reinstatement now
has to be stated over `src/table/` from scratch.

### What restoring it would take

The three numbers were: a **recognizer** pass (no global sinks, no `ch`/`raw`/`tl`
capture), a **structuralCapture** pass (capture buffers and slot counts, host
suppressed), and the ordinary **hostConstruction** pass — so CST-array cost is
`capture − recognizer` and AST/span cost is `host − capture`. Each pass got a
shallow copy of `options.state`; the counters were `{ ms, nodes, childSlots,
rawSlots, triviaSlots, fieldSlots, hostCalls }`.

Restoring it under **codegen** means re-emitting per-rule counter sites and
paying the −3.75% size and the per-node reads back. Do not do that.

Restoring it under the **`src/table/` driver** is a different proposition: the
driver is one shared interpreter over a data table, so instrumentation is *one*
site rather than one per emitted rule, and it costs the artifact nothing. That is
a note about where a future restoration becomes cheap, **not a request to build
it**.

> **Updated for 0.47.0.** "The table is an unexported prototype, roughly 2.65× slower
> than codegen, and not on the shipping path. Do not build profiling for the table."
> — all four clauses are now false. The table is what `compile()` and the macro emit,
> it is the only recogniser, and the codegen figures it was measured against are gone.
> The observation above (one instrumentation site rather than one per emitted rule)
> survives and is now the *only* way this could be restored. It is still not a request
> to build it.

If it comes back, it must come back as a *working* option. The previous shape —
declared in the public type, unimplemented underneath — is the defect this entry
records, and it is worse than having no option at all.

## 3. `bench/alloc-model.ts` — grammar-wide trivia capture was never enabled

`rules({ trivia: ws, captureTrivia: true })` silently dropped `captureTrivia`:
it is a `parser()`/`node()` option, not a `rules()` one. The invalid key is
removed and the module comment now states where capture actually comes from —
each consumer sets `captureTrivia: true` on the ParseContext it passes to
`parseWithContext`.

The one consumer that did **not** was `bench/alloc-profile.ts`, which drove
`run(..., { profile: true })` — and `RunOptions` has no `captureTrivia`, so the
phase profile would have measured a non-capturing parse. That bench is deleted
under item 2, so every remaining consumer sets `captureTrivia` on its own
ParseContext and this discrepancy is closed.
