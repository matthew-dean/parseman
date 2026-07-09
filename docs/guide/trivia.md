# Whitespace & trivia

"Trivia" is the filler between meaningful tokens — whitespace, comments — that you
usually want to skip but sometimes need to preserve (formatters, editors). Parséman
treats trivia as a first-class, grammar-defined concept.

## Two steps: define, then install

Skipping filler is always: **define** what counts as filler, then **install** it as the
ambient trivia so `sequence` / `sepBy` / `many` / `choice` skip it automatically between
terms.

1. **Define** — wrap your filler pattern with `trivia()`. This only sets a metadata flag
   (`isTrivia`); it does *not* skip anything yet.

   ```ts
   const ws = trivia(regex(/\s+/))   // "this pattern is filler"
   ```

2. **Install** — there are two ways, depending on scope. **Pick one; you don't need both.**

### Install once for a whole grammar — `rules(factory, { trivia })`

This is what you want for a real grammar. Declare the trivia **once**, on the grammar, and
it is ambient for **every rule** — including when you parse a single rule on its own
(incremental parsing). You do **not** wrap individual rules.

```ts
import { rules, node, sequence, literal, regex, trivia, oneOrMore, run } from 'parseman'

const rw = trivia(oneOrMore(regex(/\s+/)))

const g = rules({ trivia: rw }, (r) => ({   // ← set once, ambient in every rule
  List:  sequence(literal('['), r.items, literal(']')),
  items: sepBy(r.value, literal(',')),
  value: choice(r.List, regex(/[a-z]+/)),
}))

run(g.List, '[ a , [ b , c ] ]')   // trivia skipped everywhere
run(g.value, '  a')                // even parsing one rule on its own
```

Every rule reached from any entry inherits `rw`. No per-rule `parser({ trivia })`. This is
the "set once" half of **set once, override when needed**.

### Install for a single combinator or a local scope — `parser({ trivia }, combinator)`

`parser()` wraps *one* combinator with scope options. Use it for a small standalone parser,
or to **override** the grammar's trivia inside a sub-region (see
[overrides](#local-overrides-set-once-override-when-needed) below).

```ts
import { parser, regex, trivia, sepBy, literal } from 'parseman'

const ws   = trivia(regex(/\s*/))
const list = parser({ trivia: ws }, sepBy(regex(/[a-z]+/), literal(',')))  // one-off

list.parse('foo ,  bar , baz')   // { ok: true, value: ['foo','bar','baz'], … }
```

`rules({ ... })` and `parser({ ... })` accept the same **grammar-level** options — `trivia`
today — so you can set it once on the grammar or scope it locally with `parser()`; they are
not both required. `parser()` additionally carries per-scope knobs (`captureTrivia`,
`trackLines`) and the `.parse(input)` convenience method.

## Combining multiple trivia types

Whitespace and comments combine with `choice()` and `many()`:

```ts
import { sequence, literal, regex, choice, many, trivia, scanTo } from 'parseman'

const lineComment  = sequence(literal('//'), regex(/[^\n]*/))
const blockComment = sequence(literal('/*'), scanTo(literal('*/'), {}))
const ws           = trivia(many(choice(regex(/\s+/), lineComment, blockComment)))
```

## Capturing trivia kinds

Label each trivia arm so every captured chunk records its kind in the trivia log:

```ts
import { trivia, oneOrMore, choice, label, regex, triviaEntries } from 'parseman'

const rw = trivia(oneOrMore(choice(
  label('whitespace', regex(/[ \t\n\r\f]+/)),
  label('blockComment', regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)),
)))

// After a parse, resolve kinds lazily:
const entries = triviaEntries(triviaLog, rw._meta.triviaKindLabels)
entries.kind(0)         // 'whitespace'
entries.text(0, input)  // slice on demand
```

`label(name, combinator)` names a trivia arm; `Ruleset: node(…)` names a CST node through
`rules()` — different namespaces, no conflict.

### The trivia log format

The log is a **flat number array** — no per-entry objects. Each entry is a fixed-size
run of consecutive numbers, so entry `i` starts at `i * stride`:

| Log | Without labels | With labels |
| --- | --- | --- |
| Root `_triviaLog` | `[start, end]` (stride 2) | `[start, end, kind]` (stride 3) |
| Per-node `triviaLog` (`{ nodeLog: true }`) | `[start, end, insertIdx]` (stride 3) | `[start, end, insertIdx, kind]` (stride 4) |

`triviaEntries(log, labels?, opts?)` gives you an indexed view — `.start(i)`, `.end(i)`,
`.kind(i)`, `.text(i, input)` — without materializing objects. For tree-shaped access
(trivia before/after each node), pass the tree to
[`buildTriviaIndex`](../reference/api#buildtriviaindex).

## Local overrides — "set once, override when needed" {#local-overrides-set-once-override-when-needed}

Once trivia is installed (grammar-wide via `rules({ trivia })`, or on a scope via
`parser({ trivia })`), skipping is **ambient**: `sequence` / `many` / `choice` skip filler
between **every** term, in every rule reached from there — you do not re-declare it. When you
need *different* trivia for a sub-region, wrap just that region:

- **`noTrivia(child)`** — turn skipping **off** for a contiguous region (`child` and its terms
  must touch).
- **`parser({ trivia: other }, child)`** — swap in a *different* trivia for `child`. Innermost
  wins; the outer trivia resumes on exit.

These are **overrides**, meant to be rare. If you find yourself wrapping many rules to
re-establish the *same* trivia, that's a smell — the grammar-level `rules({ trivia })` already
covers them; delete the wrappers.

> **Don't reach for `noTrivia` to glue static tokens.** A decimal is `regex(/[0-9]+\.[0-9]+/)`,
> an operator is `literal('>=')` — one pattern, no override needed. `noTrivia` earns its keep
> only when a glued part is itself a **structured sub-rule** you can't fold into one pattern
> (recursive, or with its own trivia-enabled interior).

### One compiled limitation to know

A single **shared rule** cannot be both trivia-skipping *and* contiguous at the same time in
the **compiled/macro** build. The compiler bakes one trivia decision per rule; the interpreter
reads it dynamically per call, so the two would disagree. In practice: don't reference the
*same* rule from both a normal (trivia) context and a `noTrivia` context — give the glued case
its own rule (or a plain `regex`/`literal`). This is rare and only affects rule *reuse across a
trivia boundary*; ordinary `noTrivia`/`parser({ trivia })` overrides around distinct sub-rules
are fine.

## Contiguous tokens (turning trivia off)

Sometimes you need parts that must touch.

If the whole thing is *static*, don't reach for `noTrivia` — just write one
`literal`/`regex`: a decimal is `regex(/[0-9]+\.[0-9]+/)`, an operator is `literal('>=')`.
`noTrivia` earns its keep only when a glued part is itself a **structured sub-rule** you
can't fold into one pattern — usually recursive, or with its own trivia-enabled interior.

The classic case is a head that must touch a bracket, wrapping a sub-expression that
*does* allow spaces:

```ts
import { noTrivia, parser, sequence, literal, trivia, regex } from 'parseman'

const ws = trivia(regex(/[ \t\n]+/))

// `arr[i + 1]` — `arr` is glued to `[` (no `arr [i]`), but the bracketed
// subscript is a full, space-tolerant expression. A regex can't express that:
// `expr` is recursive. Turn trivia back on for a region by nesting another
// parser({ trivia }) — the innermost one wins, and reverts on exit.
const indexed = noTrivia(sequence(
  name,
  parser({ trivia: ws }, sequence(literal('['), expr, literal(']'))),
))
```

Two rules of thumb:

- **Wrap the whole contiguous run in `noTrivia`.** An enclosing `sequence` skips trivia
  *before* a term, so wrapping just the inner part leaks leading trivia.
- **Wrap the whole spaced region in the nested `parser({ trivia })`**, including its
  leading `[`. `sequence` skips trivia only *between* terms, never before its first — so
  a `[` left *outside* the nested parser would glue fine but then reject a space right
  after it (`arr[ i ]`).

`noTrivia(child)` is exactly `parser({ trivia: null }, child)`.
