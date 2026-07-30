# Degradation diagnostics

Parseman sometimes cannot do the fast thing. A reducer's parameter list may be
unreadable, an artifact may be opaque, a regex may not lower to a `charCodeAt` scan.
Falling back is correct — the parse result is the same either way. Falling back
**silently** is the defect: a build that is quietly paying 5× looks exactly like a build
that is working properly, and the only way to find out is to read the generated
artifact.

Every such path reports on one channel.

## The format

```
[parseman] degraded [<code>] <where>: <subject> — <fell back to>; otherwise <what>
```

For example:

```
[parseman] degraded [build-arity-unconfirmed] node("Operation"): build reducer
`foldOperation` — could not confirm its formal parameter list (`foldOperation` did not
resolve to a module-scope function declaration (imported binding, shadowed name, or a
computed value)), so this node captures children, fields and raw children, logs trivia,
and clones `_ctx.state` on every match; otherwise only the tiers the reducer actually
declares would be captured (arity >= 1 children, >= 2 fields, >= 4 raw, >= 5 trivia,
>= 6 state)
```

Each line names **the rule**, **the reducer or input**, **what parseman did instead**,
and **what it would have done otherwise**. A diagnostic that only says "fallback" is not
actionable and is not worth printing.

## Levels

Default-on, exactly like [first-char gating](/guide/first-char-gating):

```sh
PARSEMAN_DEGRADATION=off     # silence
PARSEMAN_DEGRADATION=warn    # default — print
PARSEMAN_DEGRADATION=error   # fail the build
```

Under the macro plugin the findings arrive as ordinary bundler warnings (Vite/Rollup
`this.warn`), anchored to the module. A runtime `compile()` prints them directly.

## Asserting zero degradations

The message is greppable on the literal `[parseman] degraded`, so a consumer's build
gate can assert there are none — the same shape as grepping build output for
`falling back to runtime`:

```sh
pnpm build 2>&1 | tee build.log
! grep -q '\[parseman\] degraded' build.log
```

or, equivalently, set `PARSEMAN_DEGRADATION=error` and let the build fail.

## Aggregation

A diagnostic that fires on every rule gets filtered out, and filtered-out is the same as
silent. Above eight sites per code, the remainder collapses to one counted line:

```
[parseman] degraded [build-arity-unconfirmed] +12 more site(s) not listed (20 total).
Set PARSEMAN_DEGRADATION=error to fail the build on these.
```

## Codes

| Code | What was lost | Usual fix |
| --- | --- | --- |
| `build-arity-unconfirmed` | The node's build could not be read, so all five capture tiers stay on. | Declare the reducer in the same module (a `function` declaration or a `const` arrow), avoid rest/destructured parameters, and do not shadow its name. |
| `mk-inline-missed` | A reducer looks like an `mk(...)` wrapper but did not match the shape, so each match pays a call instead of an inlined object literal. | Use `(children, fields, span, rawChildren, triviaLog) => mk(type, children, rawChildren, span, triviaLog)` with the node's own type. |

## Why arity is read from source at all

A node's build receives `(children, fields, span, rawChildren, triviaLog, state)`.
Collecting a facility the build never declares is dead work — and the trivia log's
per-token push alone dominates real parses. Parseman therefore reads the build's formal
parameter list and elides the tiers above its arity.

That analysis is **conservative by construction**: anything it cannot parse yields
"unknown", and unknown keeps full capture. Capturing too much is safe; capturing too
little would be a correctness bug. The diagnostic exists so that "safe" does not also
mean "invisible".

Under macro compilation a reducer passed as a bare identifier — `node('Foo', p,
foldOperation)` — used to be exactly such an unknown, because the captured source was
the string `"foldOperation"`. The plugin now resolves that name against the module AST
it already holds, and only when the name is bound **exactly once** in the module by a
module-scope `function` declaration or `const` arrow/function expression. An imported
name is never resolved: its declaration lives in a module parseman does not hold, and
guessing an arity that is too low would under-capture.
