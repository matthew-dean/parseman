# bench/ typecheck — deferred items

`bench/` was outside `tsconfig.json`'s `include` until 0.47, so it had never been
typechecked. Bringing it in surfaced **82 errors**. All but the items below are
fixed; this file tracks what is knowingly left, so none of it is a silent drop.

## 1. `bench/table-alloc-ablation.ts` — excluded, owned by the `src/table/` lane

Two errors, both real:

```
bench/table-alloc-ablation.ts(131,19): TS2304: Cannot find name 'contests'.
bench/table-alloc-ablation.ts(132,19): TS2339: Property 'get' does not exist on type '[string, Samples][]'.
```

The first is the `ReferenceError` that prompted this work: the bench dies at
runtime the moment line 131 executes. It is being fixed on the lane that owns
`src/table/`, together with an `emitConst` failure in the same bench, so it is
excluded here rather than fixed twice and conflicted.

**Action:** delete the `bench/table-alloc-ablation.ts` entry from `exclude` in
`tsconfig.json` once that lane lands. Never add another entry to that list — the
whole point of 0.47's change is that `bench/` is checked under the same settings
as `src/`.

## 2. `bench/alloc-profile.ts` — dead at runtime, not visible to `tsc`

Typechecks clean, and throws on first execution at HEAD, before and after this
change:

```
TypeError: run({ profile: true }) is unavailable: profiling counters are no longer
compiled into parser artifacts, and the interpreter does not implement them yet.
```

`RunOptions.profile` still exists in the type, so the call is well-typed; the
implementation in `src/functional/run.ts` throws unconditionally. A typecheck
cannot catch this class — only running the bench can. The three phase numbers
this bench reports (recognizer / structuralCapture / hostConstruction) are
therefore unobtainable today.

**Action:** either restore profiling counters in interpreted mode and re-enable
the bench, or delete the bench and the now-unreachable `profile` option together.
Leaving a well-typed call to a throwing option is the worst of the three.

## 3. `bench/alloc-model.ts` — grammar-wide trivia capture was never enabled

`rules({ trivia: ws, captureTrivia: true })` silently dropped `captureTrivia`:
it is a `parser()`/`node()` option, not a `rules()` one. The invalid key is
removed and the module comment now states where capture actually comes from —
each consumer sets `captureTrivia: true` on the ParseContext it passes to
`parseWithContext`.

One consumer does **not**: `bench/alloc-profile.ts:33` calls
`run(entry, input, { build: host, profile: true })`, and `RunOptions` has no
`captureTrivia`, so the phase profile would measure a non-capturing parse. That
is moot while item 2 stands — the call throws before it measures anything — and
resolving it is part of item 2, not separate work.
