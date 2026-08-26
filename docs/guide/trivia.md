# Whitespace & trivia

"Trivia" is the filler between meaningful tokens — whitespace, comments — that you
usually want to skip but sometimes need to keep around (formatters, editors care about
it). Parséman treats trivia as a first-class, grammar-defined concept, not an
afterthought bolted onto the lexer.

## Two steps: define, then install

Skipping filler always comes down to two steps. **Define** what counts as filler, then
**install** it as the ambient trivia so `sequence`, `sepBy`, `many`, and `choice` skip it
automatically between terms.

1. **Define** — wrap your filler pattern with `trivia()`. This only sets a metadata flag
   (`isTrivia`); it does *not* skip anything yet.

   ```ts
   const ws = trivia(regex(/\s+/))   // "this pattern is filler"
   ```

2. **Install** — two ways, depending on scope. Pick one; you don't need both.

### For a whole grammar — `rules({ trivia }, factory)`

Set the grammar's trivia here and every rule skips it between terms — the rule you start
at, and every rule it reaches. Parse a single rule directly and it skips trivia too.

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

Set the trivia for a single wrapped combinator. Reach for this to build a small,
standalone parser, or when one region of a larger grammar needs *different* trivia than
the rest (see [local overrides](#local-overrides) below).

```ts
import { parser, regex, trivia, sepBy, literal } from 'parseman'

const ws   = trivia(regex(/\s*/))
const list = parser({ trivia: ws }, sepBy(regex(/[a-z]+/), literal(',')))

list.parse('foo ,  bar , baz')   // { ok: true, value: ['foo','bar','baz'], … }
```

`rules({ … })` and `parser({ … })` overlap on document-level settings, but their option
sets aren't identical. `rules()` applies grammar-wide settings (`trivia`, `scanSkip`,
`trackLines`, `hostMode`) to every rule in the returned registry. `parser()` wraps one
combinator and carries local run settings such as `trivia`, `captureTrivia`, and
`trackLines`; it also gives the wrapped combinator a `.parse(input)` method.

### Grammar-level `scanSkip` — opaque units for scans

`scanSkip` is the scan-time companion to `trivia`. Where `trivia` is filler skipped
*between terms everywhere*, `scanSkip` lists **opaque non-trivia units** — strings,
`balanced` brackets — that `scanTo` and `balanced` treat as *atomic while scanning*, so a
delimiter hidden inside one never ends the scan early:

```ts
const dq = sequence(literal('"'), regex(/[^"\\]|\\./), literal('"'))

const g = rules({ trivia: rw, scanSkip: [dq] }, (r) => ({
  arg: scanTo(regex(/[,;)]/)),   // a `,`/`;`/`)` inside "…" is skipped, not matched
}))
```

`scanTo`/`balanced` also skip the ambient `trivia`, so a sentinel hidden in a comment is
safe. A per-call `skip` extends these; `raw: true` opts out. See
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

// Root trivia is opt-in; resolve selected kinds and gaps lazily:
const result = run(Document, input, { trivia: rw, rootTrivia: { select: ['blockComment'] } })
const entries = result.rootTrivia!.index.entries
entries.kind(0)         // 'blockComment'
entries.text(0, input)  // slice on demand
```

`label(name, combinator)` names a trivia arm; `Ruleset: node(…)` names a CST node through
`rules()`. Different namespaces, no conflict.

### The trivia log format

The log is a **flat number array**, not an array of objects. Each entry is a fixed-size
run of consecutive numbers, so entry `i` starts at `i * stride`:

| Log | Without labels | With labels |
| --- | --- | --- |
| Per-node `triviaLog` (`{ nodeLog: true }`) | `[start, end, insertIdx]` (stride 3) | `[start, end, insertIdx, kind]` (stride 4) |

`triviaEntries(log, labels?, opts?)` gives you an indexed view — `.start(i)`, `.end(i)`,
`.insertIndex(i)` (for a per-node log), `.kind(i)`, `.text(i, input)` — without
materializing objects. `insertIndex(i)` is the `rawChildren` boundary before which that
trivia was consumed.

### Sparse root capture

Most root consumers don't need a record for every space. Ask `run()` for only the
grammar-defined markers you actually preserve:

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

result.rootTrivia!.index.gapsWithKind(['blockComment', 'lineComment'])
```

Selected capture stores one numeric row per selected marker:
`[ownedRangeStart, ownedRangeEnd, markerStart, markerEnd, selectedKindIndex]`.
`selectedLabelIndex` indexes the requested `select` list, not a local grammar scope's
label table, so composed grammars and semantic leaves can use their own trivia-label
order safely. The first pair still lets `gapBefore` / `gapAfter` reproduce the full
authored range around the marker, while whitespace-only ranges allocate nothing.

Labels are arbitrary: use `significantNewline` if line layout is part of your
formatter's policy, but don't select broad `whitespace` just to make line layout
observable. Without `rootTrivia.select`, `run()` retains no root trivia at all. With it,
a result still omits `rootTrivia` when no selected marker occurred; otherwise
`result.rootTrivia.index` is the normal API, and `result.rootTrivia.rows` exposes the
raw compact rows when you need them.

`classifiedTrivia()` is the safe constructor for selected root capture: each name owns a
distinct grammar arm. Arms keep ordinary ordered-choice semantics, so categories such as
`lineComment` and `blockComment` can legitimately share their opening character. A bare
`label('whitespace', broadMatcher)` only says that the *whole* broad match is
whitespace — it can't expose a comment that matcher consumed internally. Every local
`parser({ trivia })` scope must likewise use `classifiedTrivia()`, or write
`rootCapture: 'opaque'` to acknowledge that selected categories don't survive inside
that scope. There's no permissive compatibility mode for selected capture.

Category names are opaque caller policy. Parseman doesn't infer a category's meaning
from names such as `comment` or `whitespace`, or from a CSS-shaped delimiter — it just
recognizes the grammar arm you supplied. Separately, every structurally scannable trivia
arm can use the compact scanner whether it's unlabeled, retained as a selected category,
or not retained at all. Selecting a category changes what gets recorded, not which
trivia syntax is fast.

`result.rootTrivia.index` is a lazy sparse root-gap index. It groups selected markers
sharing one authored range into one boundary gap, so
`index.entryIndicesBefore(node.span.start)` and `index.entryIndicesAfter(node.span.end)`
return indices into `index.entries` without slicing strings. If you persist sparse rows
separately, `buildRootTriviaIndex(rows, select)` rebuilds the same view.

For AST reducers and serializers, query the grouped gaps directly:

```ts
const index = result.rootTrivia!.index
const beforeNode = index.gapBefore(node.span.start)
const preserved: string[] = []

if (beforeNode?.hasKind('blockComment')) {
  preserved.push(beforeNode.text(input))
}

for (const gap of index.gapsWithKind(['blockComment', 'lineComment'])) {
  preserved.push(input.slice(gap.start, gap.end))
}
```

The gap object keeps entry indices into `index.entries`; it doesn't materialize token
objects or copy strings. `gap.text(input)` slices only when you ask for authored text.
For older CST-tree access that materializes trivia token values, pass the tree to
[`buildTriviaIndex`](../reference/api#buildtriviaindex).

### Terminal document trivia

Normally a failed next item leaves its preceding trivia uncommitted — it's terminal, not
a gap between siblings. A document root that must retain an EOF comment can opt in
locally (for example, a CSS grammar's `Stylesheet` root):

```ts
const Document = node('Document', many(rule), undefined, { trailingTrivia: true })
```

`trailingTrivia: true` commits that one final active-trivia run to **this node's** log
and forces this node's trivia capture. Use it only for a meaningful terminal boundary,
normally a repeating document root — don't add it to ordinary nodes or blocks. A closing
delimiter such as `}` is already the next term, so normal trivia ownership records the
preceding gap. Keeping the opt-in node-local preserves ordinary sibling ownership and
avoids global capture work.

## Local overrides {#local-overrides}

Trivia skipping is ambient: wherever it's installed, `sequence`, `many`, and `choice`
skip filler between every term, in that rule and every rule it reaches. To change that
for one region, wrap it:

- **`parser({ trivia: other }, child)`** — use a *different* trivia for `child`. It
  applies to `child` and everything below it; the surrounding trivia resumes once
  `child` finishes. A `url()` body, for example, treats whitespace as significant and
  allows no comments, so it gets its own trivia — [more on that below](#no-separate-tokenization-step).
- **`noTrivia(child)`** — skip nothing inside `child`, so its terms must touch. Use it
  when a glued part is a **structured sub-rule** — recursive, or with its own
  trivia-enabled interior. For a static glued token, write one pattern instead: a
  decimal is `regex(/[0-9]+\.[0-9]+/)`, an operator is `literal('>=')`.

### No separate tokenization step

Most parsers split the work in two: a **lexer** turns source into a token stream, then a
**parser** turns tokens into a tree. Parséman skips the first phase and scans characters
directly. That's on purpose — a separate tokenization pass buys less than people assume,
especially in JS.

**Token boundaries depend on grammar context, but the lexer runs before the grammar
does.** A lexer has to decide "what's a token" with no idea where it is. Real languages
fight this constantly: in CSS, a `url(…)` body, a `calc()` interior, and
whitespace-as-a-descendant-combinator each want a *different* token shape. The canonical
case is in JS itself — a bare `/` is division or the start of a regex, and **only the
parser knows which**. A context-blind lexer either commits wrong or grows *modes* and
carried state to recover the context, which is really the parser's job, just relocated
to a phase that can't see the grammar.

**The two classic justifications for a lexer are weak here.** *Separation of concerns*
is exactly what breaks down for the languages above — you end up threading lexer state
anyway, so the split is leaky, not clean. *Speed* is the other claim, but in a JS parser
the token stream is an allocation-heavy intermediate (an array of token objects, i.e. GC
pressure) that a character scan never creates. A **compiled** scannerless parser lowers
rules to tight `charCodeAt` loops that are competitive with tokenizing parsers on
throughput (see [benchmarks](./benchmarks)). So you pay for a separate pass without
reliably getting either thing it promised.

**What you get instead:** a token's shape is a *grammar* decision, made right where the context
is obvious — which is exactly what scoped trivia (above) is. `url()`'s body gets its own
whitespace rule on the `Url` rule and nothing else has to know:

```ts
const Url = node(parser({ trivia: urlWs }, sequence(urlOpen, urlInner, literal(')'))))
```

None of this is unique to Parséman — any scannerless combinator library skips the lexer
— but it's a concrete reason CSS-family and other context-sensitive grammars come out
simpler here. (Tokenization isn't worthless: for genuinely regular lexical structure, or
when a downstream tool wants a token stream, it's fine. It just isn't a good *default*.)

### One compiled limitation to know

A single **shared rule** can't be both trivia-skipping *and* contiguous at the same time
in the **compiled/macro** build. The compiler bakes one trivia decision per rule; the
interpreter reads it dynamically per call, so the two would disagree. In practice: don't
reference the *same* rule from both a normal (trivia) context and a `noTrivia` context —
give the glued case its own rule (or a plain `regex`/`literal`). This is rare, and only
affects rule *reuse across a trivia boundary*; ordinary `noTrivia`/`parser({ trivia })`
overrides around distinct sub-rules are fine.

## Contiguous tokens (turning trivia off)

Sometimes you need parts that must touch.

If the whole thing is *static*, don't reach for `noTrivia` — just write one
`literal`/`regex`: a decimal is `regex(/[0-9]+\.[0-9]+/)`, an operator is
`literal('>=')`. `noTrivia` earns its keep only when a glued part is itself a
**structured sub-rule** you can't fold into one pattern — usually recursive, or with its
own trivia-enabled interior.

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
- **Wrap the whole spaced region in the nested `parser({ trivia })`,** including its
  leading `[`. `sequence` skips trivia only *between* terms, never before its first, so a
  `[` left *outside* the nested parser would glue fine but then reject a space right
  after it (`arr[ i ]`).

`noTrivia(child)` is exactly `parser({ trivia: null }, child)`.

## Asserting adjacency, not re-spelling trivia {#adjacency}

`noTrivia` says "these must touch." The opposite statement — "these must **not**
touch" — is [`notAdjacent()`](./combinators#adjacent-and-notadjacent), with
`adjacent()` as its dual. Both are zero-width assertions on the gap the trivia skip
already scanned; neither one consumes anything or contributes a child.

**The rule: a production should never disable trivia and re-spell it.** Writing

```ts
// DON'T — this re-implements the grammar's trivia table inside one production.
noTrivia(sequence(regex(/(?:[ \t\n\r\f]|\/\*(?:[^*]|\*(?!\/))*\*\/)+/), op, ...))
```

buys you a mandatory separator at the price of a second, private definition of what
trivia is. It drifts: two productions in one file end up disagreeing about what
separates two operands, and nothing reports it. Assert the gap instead — the assertion
consults `ctx.trivia`, so there's only ever one definition.

That's what the `calc()` case above needs. Per css-values-4 §10.1, the `+` and `-`
operators require **actual whitespace** on both sides, because a comment vanishes at
tokenization and so can't separate two tokens:

```ts
// [verify]
import { notAdjacent, sequence, regex, literal, parser, classifiedTrivia, parse } from 'parseman'

// One trivia table, with its categories named — the same table the parser skips with.
const cssTrivia = classifiedTrivia({
  whitespace: regex(/[ \t\n\r\f]+/),
  comment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
})

const operand = () => regex(/[0-9]+(?:px|em|%)?/)
const spaceRequired = () => notAdjacent({ kinds: ['whitespace'] })

const calcSum = parser({ trivia: cssTrivia }, sequence(
  operand(), spaceRequired(), literal('+'), spaceRequired(), operand(),
))

parse(calcSum, '10px + 2em').ok
// → true

// A comment is trivia, and it does separate — but it is not whitespace, so per
// spec it does not make this a valid calc() sum.
parse(calcSum, '10px/*c*/+/*c*/2em').ok
// → false

// Nor does no gap at all.
parse(calcSum, '10px+2em').ok
// → false
```

`kinds` names come from the `classifiedTrivia({...})` keys of the **active** table. An
unknown name, or a `kinds` filter over unclassified trivia, throws a `TypeError` rather
than quietly matching nothing — a silently-empty filter here would make the grammar
above accept the comment form, which is exactly the defect the filter exists to
prevent.
