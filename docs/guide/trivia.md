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

### For a whole grammar — `rules({ trivia }, factory)`

Set the grammar's trivia here and every rule skips it between terms — the rule you start at
and every rule it reaches. Parse a single rule directly and it skips trivia too.

```ts
import { rules, sequence, sepBy, choice, literal, regex, trivia, oneOrMore, run } from 'parseman'

const rw = trivia(oneOrMore(regex(/\s+/)))

const g = rules({ trivia: rw }, (r) => ({
  List:  sequence(literal('['), r.items, literal(']')),
  items: sepBy(r.value, literal(',')),
  value: choice(r.List, regex(/[a-z]+/)),
}))

run(g.List, '[ a , [ b , c ] ]')   // spaces skipped between every term
run(g.value, '  a')                // …and when you parse one rule on its own
```

### For one combinator — `parser({ trivia }, combinator)`

Set the trivia for a single wrapped combinator. Reach for this to build a small standalone
parser, or when one region of a larger grammar needs *different* trivia than the rest (see
[local overrides](#local-overrides) below).

```ts
import { parser, regex, trivia, sepBy, literal } from 'parseman'

const ws   = trivia(regex(/\s*/))
const list = parser({ trivia: ws }, sepBy(regex(/[a-z]+/), literal(',')))

list.parse('foo ,  bar , baz')   // { ok: true, value: ['foo','bar','baz'], … }
```

`rules({ … })` and `parser({ … })` overlap on document-level settings, but their option
sets are not identical. `rules()` applies grammar-wide settings (`trivia`, `scanSkip`,
`trackLines`, `hostMode`) to every rule in the returned registry. `parser()` wraps one
combinator and carries local run settings such as `trivia`, `captureTrivia`, and
`trackLines`; it also gives the wrapped combinator a `.parse(input)` method.

### Grammar-level `scanSkip` — opaque units for scans

`scanSkip` is the scan-time companion to `trivia`. Where `trivia` is filler that's
skipped *between terms everywhere*, `scanSkip` lists **opaque non-trivia units** —
strings, `balanced` brackets — that `scanTo` and `balanced` treat as *atomic while
scanning*, so a delimiter hidden inside one never ends the scan early:

```ts
const dq = sequence(literal('"'), regex(/[^"\\]|\\./), literal('"'))

const g = rules({ trivia: rw, scanSkip: [dq] }, (r) => ({
  arg: scanTo(regex(/[,;)]/)),   // a `,`/`;`/`)` inside "…" is skipped, not matched
}))
```

`scanTo`/`balanced` also skip the ambient `trivia` (so a sentinel hidden in a comment
is safe). A per-call `skip` extends these; `raw: true` opts out. See
[scanTo & balanced](./combinators#scanto-and-balanced) for the full model.

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
import { trivia, oneOrMore, choice, label, regex, run } from 'parseman'

const rw = trivia(oneOrMore(choice(
  label('whitespace', regex(/[ \t\n\r\f]+/)),
  label('blockComment', regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)),
)))

// After a run(), resolve kinds and boundary gaps lazily:
const result = run(Document, input, { trivia: rw })
const entries = result.triviaMap.entries
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
`.insertIndex(i)` (for a per-node log), `.kind(i)`, `.text(i, input)` — without materializing
objects. `insertIndex(i)` is the `rawChildren` boundary before which that trivia was consumed;
it is `undefined` for a root log.

### Sparse root capture

Most root consumers do not need a record for every space. Ask `run()` for only the
grammar-defined markers you preserve:

```ts
import { classifiedTrivia, regex, run } from 'parseman'

const rootTrivia = classifiedTrivia({
  whitespace: regex(/[ \t\n\r\f]+/),
  blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
  lineComment: regex(/\/\/[^\n]*/),
})

const result = run(Document, input, {
  trivia: rootTrivia,
  rootTrivia: { select: ['blockComment', 'lineComment'] },
})

result.triviaMap.gapsWithKind(['blockComment', 'lineComment'])
```

Selected capture stores one numeric row per selected marker:
`[ownedRangeStart, ownedRangeEnd, markerStart, markerEnd, selectedKindIndex]`.
`selectedLabelIndex` indexes the requested `select` list, not a local
grammar scope's label table, so composed grammars and semantic leaves may use
their own trivia-label order safely. The first
pair still lets `gapBefore` / `gapAfter` reproduce the full authored range around
the marker, while whitespace-only ranges allocate nothing. Labels are arbitrary:
use `significantNewline` if line layout is part of your formatter's policy; do not
select broad `whitespace` merely to make line layout observable. In this mode
`result.triviaLog` is intentionally empty; `result.triviaMap` is the normal API and
`result.rootTrivia.rows` exposes the raw compact rows when needed.

`classifiedTrivia()` is the safe constructor for selected root capture: each
name owns a distinct grammar arm. A bare `label('whitespace', broadMatcher)`
only says that the *whole* broad match is whitespace; it cannot expose a
comment that matcher consumed internally. Every local `parser({ trivia })`
scope must likewise use `classifiedTrivia()`, or
write `rootCapture: 'opaque'` to acknowledge that selected categories do not
survive inside that scope. Strict mode is opt-in so existing grammars retain
their current behavior while they migrate.

`run()` also returns `triviaMap`, a lazy root-log gap index. It groups contiguous labeled chunks
into one boundary gap, so `triviaMap.entryIndicesBefore(node.span.start)` and
`triviaMap.entryIndicesAfter(node.span.end)` return indices into `triviaMap.entries` without
slicing strings. If you have only a raw root log, `buildRootTriviaIndex(log, labels?)` builds the
same view.

For AST reducers and serializers, query the grouped gaps directly:

```ts
const beforeNode = result.triviaMap.gapBefore(node.span.start)
const preserved: string[] = []

if (beforeNode?.hasKind('blockComment')) {
  preserved.push(beforeNode.text(input))
}

for (const gap of result.triviaMap.gapsWithKind(['blockComment', 'lineComment'])) {
  preserved.push(input.slice(gap.start, gap.end))
}
```

The gap object keeps entry indices into `triviaMap.entries`; it does not materialize token
objects or copy strings. `gap.text(input)` slices only when you ask for authored text. For older
CST-tree access that materializes trivia token values, pass the tree to
[`buildTriviaIndex`](../reference/api#buildtriviaindex).

### Terminal document trivia

Normally a failed next item leaves its preceding trivia uncommitted: it is terminal, not a
gap between siblings. A document root that must retain an EOF comment can opt in locally
(for example, a CSS grammar's `Stylesheet` root):

```ts
const Document = node('Document', many(rule), undefined, { trailingTrivia: true })
```

`trailingTrivia: true` commits that one final active-trivia run to **this node's** log and
forces this node's trivia capture. Use it only for a meaningful terminal boundary, normally a
repeating document root. Do not add it to ordinary nodes or blocks: a closing delimiter such
as `}` is already the next term, so normal trivia ownership records the preceding gap. Keeping
the opt-in node-local preserves ordinary sibling ownership and avoids global capture work.

## Local overrides {#local-overrides}

Trivia skipping is ambient: wherever it's installed, `sequence` / `many` / `choice` skip filler
between every term, in that rule and every rule it reaches. To change that for one region, wrap
it:

- **`parser({ trivia: other }, child)`** — use a *different* trivia for `child`. It applies to
  `child` and everything below it; the surrounding trivia resumes when `child` finishes. A
  `url()` body, for example, treats whitespace as significant and allows no comments, so it gets
  its own trivia — [more on that below](#no-separate-tokenization-step).
- **`noTrivia(child)`** — skip nothing inside `child`, so its terms must touch. Use it when a
  glued part is a **structured sub-rule** — recursive, or with its own trivia-enabled interior.
  For a static glued token, write one pattern instead: a decimal is `regex(/[0-9]+\.[0-9]+/)`,
  an operator is `literal('>=')`.

### No separate tokenization step

Most parsers split work in two: a **lexer** turns source into a token stream, then a **parser**
turns tokens into a tree. Parséman skips the first phase and scans characters directly. That's
deliberate — a separate tokenization pass buys less than it's assumed to, especially in JS.

**Token boundaries depend on grammar context, but the lexer runs before the grammar.** A lexer
has to decide "what's a token" with no idea where it is. Real languages fight this constantly:
in CSS, a `url(…)` body, a `calc()` interior, and whitespace-as-a-descendant-combinator each
want a *different* token shape; and the canonical case — in JS itself, a bare `/` is division or
the start of a regex, and **only the parser knows which**. A context-blind lexer either commits
wrong or grows *modes* and carried state to recover the context — which is the parser's job,
relocated to a phase that can't see the grammar.

**The two classic justifications for a lexer are weak here.** *Separation of concerns* is exactly
what breaks down for the languages above — you end up threading lexer state anyway, so the split
is leaky, not clean. *Speed* is the other claim, but in a JS parser the token stream is an
allocation-heavy intermediate — an array of token objects, i.e. GC pressure — that a character
scan never creates; and a **compiled** scannerless parser lowers rules to tight `charCodeAt`
loops that are competitive with tokenizing parsers on throughput (see [benchmarks](./benchmarks)).
So you pay for a separate pass without reliably getting either thing it promised.

**What you get instead:** a token's shape is a *grammar* decision, made right where the context
is obvious — which is exactly what scoped trivia (above) is. `url()`'s body gets its own
whitespace rule on the `Url` rule and nothing else has to know:

```ts
const Url = node(parser({ trivia: urlWs }, sequence(urlOpen, urlInner, literal(')'))))
```

None of this is unique to Parséman — any scannerless combinator library skips the lexer — but
it's a concrete reason CSS-family and other context-sensitive grammars come out simpler here.
(Tokenization isn't worthless: for genuinely regular lexical structure, or when a downstream
tool wants a token stream, it's fine. It just isn't a good *default*.)

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
