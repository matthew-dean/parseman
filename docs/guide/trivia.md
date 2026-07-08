# Whitespace & trivia

"Trivia" is the filler between meaningful tokens — whitespace, comments — that you
usually want to skip but sometimes need to preserve (formatters, editors). Parséman
treats trivia as a first-class, grammar-defined concept.

## The two-step setup

Skipping filler between tokens is a two-step setup:

1. **Define** what counts as filler — usually `regex(/\s+/)`, comments, or both — and
   wrap it with `trivia()`. This only sets a metadata flag (`isTrivia`); it does *not*
   change when the parser runs.
2. **Activate** skipping by passing that combinator to `parser({ trivia }, combinator)`.
   That installs it on the parse context so `sequence`, `sepBy`, `choice`, etc. consume
   matching filler automatically between terms.

```ts
import { parser, regex, trivia, sepBy, literal } from 'parseman'

const ws   = trivia(regex(/\s*/))   // "this pattern is filler" — not skipped yet
const word = regex(/[a-z]+/)
const list = parser({ trivia: ws }, sepBy(word, literal(',')))  // skipping on

list.parse('foo ,  bar , baz')
// { ok: true, value: ['foo', 'bar', 'baz'], … }
```

`parser()` also gives you the `.parse(input)` convenience method and controls
line tracking (`trackLines`) and trivia capture (`captureTrivia`).

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

## Contiguous tokens (turning trivia off)

Trivia skipping is ambient: once `parser({ trivia })` installs it, `sequence` / `many` /
`choice` skip filler between **every** term. Sometimes you need the opposite — parts that
must touch.

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
