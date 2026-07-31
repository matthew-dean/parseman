# Degradation diagnostics

Parseman sometimes cannot do the fast thing. A reducer's parameter list may be
unreadable, an artifact may be opaque, a regex may not lower to a `charCodeAt` scan.
Falling back is correct — the parse result is the same either way. Falling back
**silently** is the defect: a build that is quietly paying 5× looks exactly like a build
that is working properly, and the only way to find out is to read the generated
artifact.

Every such path reports on one channel.

## The format

```text
[parseman] degraded [<code>] <where>: <subject> — <fell back to>; otherwise <what>
```

For example:

```text
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

Default-on:

```sh
PARSEMAN_DEGRADATION=off     # silence
PARSEMAN_DEGRADATION=warn    # default — print
PARSEMAN_DEGRADATION=error   # fail the build
```

Under the macro plugin the findings arrive as ordinary bundler warnings (Vite/Rollup
`this.warn`), anchored to the module, and `error` throws once at the end of the module
with every finding listed. A runtime `compile()` drains at the end of that compile: at
`warn` it prints one aggregated block, at `error` it throws once with every finding
listed.

::: tip Both modes honour `error`
Before 0.45.0 `error` was inert for a runtime `compile()`: the drain that threw lived
only in the macro plugin, so library users got `warn` behaviour from a setting documented
as "fail the build".
:::

::: warning This channel is NOT like the gating diagnostic
0.45.0 moved the [first-char gating](/guide/first-char-gating) advice out of the compile
path entirely — `compile()` produces an artifact and says nothing, and you ask for a
diagnosis with `diagnoseGrammar()`. This channel deliberately did **not** follow it.

Gating advice is advice: the build did what you asked, and here are some notes. A
degradation is parseman telling you it **could not do what you asked** — and the whole
point of this release is that such a thing must not be silent. So it stays default-on, on
both paths.

What DID change is the shape on the runtime path. It used to print one full line per site
as each was discovered — 31 near-identical ~500-character lines for a single code in one
benchmark run, while the macro path had always aggregated. Now both drain the same way,
so the eight-site cap and the counted summary below apply everywhere.
:::

## Asserting zero degradations

The message is greppable on the literal `[parseman] degraded`, so a consumer's build
gate can assert there are none — the same shape as grepping build output for
`falling back to runtime`:

```sh
pnpm build 2>&1 | tee build.log
! grep -q '\[parseman\] degraded' build.log
```

or, equivalently, set `PARSEMAN_DEGRADATION=error` and let the build fail.

A degradation recorded by an **analysis** rather than a compile — an opaque contributing
artifact, say — is also returned structurally, on `diagnoseGrammar(g).degradations`, and
becomes a finding in that report. That is the machine-readable route: `d.ok` covers it,
no grepping.

## Aggregation

A diagnostic that fires on every rule gets filtered out, and filtered-out is the same as
silent. Above eight sites per code, the remainder collapses to one counted line:

```text
[parseman] degraded [build-arity-unconfirmed] +12 more site(s) not listed (20 total).
Set PARSEMAN_DEGRADATION=error to fail the build on these.
```

## Codes

| Code | What was lost | Usual fix |
| --- | --- | --- |
| `build-arity-unconfirmed` | The node's build could not be reduced to a parameter list, so all five capture tiers stay on. | See [below](#reducer-arity) — usually a rest parameter or a reassigned binding. Declare it with `node(..., { buildArity: n })`. |
| `mk-inline-missed` | A reducer looks like an `mk(...)` wrapper but did not match the shape, so each match pays a call instead of an inlined object literal. | Use `(children, fields, span, rawChildren, triviaLog) => mk(type, children, rawChildren, span, triviaLog)` with the node's own type. |

## Reducer arity {#reducer-arity}

A node's build receives `(children, fields, span, rawChildren, triviaLog, state)`.
Collecting a facility the build never declares is dead work — and the trivia log's
per-token push alone dominates real parses. Parseman therefore works out the build's
declared arity and elides every tier above it:

| Arity | Enables |
| --- | --- |
| `>= 1` | `children` |
| `>= 2` | `fields` |
| `>= 4` | `rawChildren` |
| `>= 5` | `triviaLog` |
| `>= 6` | a clone of `_ctx.state` |

### What the macro resolves

An inline arrow is self-describing. Everything else is a **name**, and the macro plugin
runs at `enforce: 'pre'` with the module AST and the filesystem available, so it resolves
the name rather than giving up on it:

```ts
const foldOperation = children => ({ … })
node('Fold', body, foldOperation)                      // ✓ module-scope const

function foldOperation(children) { … }
node('Fold', body, foldOperation)                      // ✓ function declaration

let foldOperation = children => ({ … })                // ✓ `let`/`var`, if never reassigned
import { foldOperation } from './reducers.ts'          // ✓ named import
import { foldOperation as fold } from './reducers.ts'  // ✓ aliased import
import fold from './reducers.ts'                       // ✓ default import
import * as helpers from './reducers.ts'
node('Fold', body, helpers.fold)                       // ✓ namespace member
export { fold } from './impl.ts'                       // ✓ re-exports, including `export *`
const fold = foldOperation                             // ✓ alias chains
```

Resolution is real lexical scope analysis, so **shadowing is decided rather than feared**:
a `foldOperation` declared inside some other function does not affect a call site where
the module-scope one is in scope, and a call site where an inner binding *does* shadow
resolves to that inner binding.

Parameter lists are read from the AST, so a **default** or a **destructured** parameter
counts positionally like any other — `(c, f = undefined, s, r)` is arity 4.

### What genuinely cannot be resolved

These are undecidable rather than merely unread, and they fail open (full capture) and
report `build-arity-unconfirmed`:

- a **rest parameter** — `(...args) => …` declares an unbounded arity
- a body that references **`arguments`**
- a **reassigned** binding — which function it names at parse time is not decidable
- a **computed** or dynamically constructed reducer
- an **import that cannot be resolved or parsed**

### Declaring the arity yourself

Fail-open is safe but permanent: the node pays for every tier on every match, forever.
`buildArity` is the escape hatch.

```ts
node('Fold', body, fold, { buildArity: 1 })
```

You are asserting the highest positional argument the reducer reads. Parseman then elides
everything above it exactly as if it had read the parameter list, and the diagnostic goes
away. A declaration is authoritative — it wins over anything the source appears to say.

**Declaring too low under-captures.** The reducer will receive an empty `rawChildren` /
`triviaLog` or an absent `state` rather than a wrong value. Count the parameters.
