# Error recovery

A parser that stops at the first error is useless to an editor. The code a language
server sees is *invalid most of the time* — mid-keystroke, half-typed, missing a brace.
To power diagnostics, autocomplete, folding, and refactors, a parser has to keep going:
report **every** error, not just the first, and still hand back a usable tree for the
parts that did parse.

Parséman keeps the strict path — the compiler's path — untouched, and layers recovery on
top as a **cold path** that only runs when something fails. Recovery has two pieces:

| Tool | Use it for | On failure |
| --- | --- | --- |
| [Tolerant lists](#tolerant-lists) (`tolerant` + `many`/`sepBy`) | A list/repetition whose bad elements shouldn't truncate the rest | Skips the bad element to a **sync point**, emits a `ParseError`, keeps parsing the list |
| [`expect`](#expect-required-tokens) | A required delimiter/terminator (`}`, `)`, `;`) | Records an error, recovers **in place** (zero width), keeps going |
| [`scanTo` / `balanced`](#positional-recovery-scanto-balanced) | Consuming an opaque region up to a boundary | Positional scanning; independently useful building blocks |

All of them turn a failure into a *successful* parse whose value carries a `ParseError`, so
the enclosing `sequence` / list continues. Errors are collected through the
[error channel](#collecting-every-error).

## The `ParseError` value

Recovery produces a single shape:

```ts
type ParseError = {
  _tag: 'parseError'
  span: Span          // where the problem is (zero-width for expect, the skipped range for a list)
  expected: string[]  // what the parser wanted there
}
```

Test for it with the `isParseError` guard when walking results or children:

```ts
import { isParseError } from 'parseman'

if (isParseError(value)) {
  console.warn(`expected ${value.expected.join(' or ')} at ${value.span.start}`)
}
```

> **Note:** `ParseError` (`_tag: 'parseError'`) is the recovery value. In value/AST mode
> it appears in the list's value array; when a [CST host](./ast) is active
> (`cstBuildHost`, the language service) the **same** node is embedded in the tree's
> `children` as a `CSTError` (also `_tag: 'parseError'`) — so a tree walk finds every
> error, and it rides reused subtrees across incremental edits.

## Tolerant lists

The most common recovery need is a list — a block body, a declaration list, arguments —
where one malformed element must not truncate everything after it. Turn it on with the
run-level `tolerant` flag; then `many`, `oneOrMore`, and `sepBy` recover from a failed
element instead of stopping at it.

```ts
import { run, sequence, sepBy, literal } from 'parseman'

const block = sequence(literal('{'), sepBy(decl, literal(';')), literal('}'))

const r = run(block, '{a:1;$$;b:2}', { tolerant: true })
// r.value's list  → [decl, ParseError, decl]   (the `$$` is one recovered error)
// r.errors        → [ParseError]                (every recovery point that fired)
// r.ok            → true                        (the closing `}` was still reached)
```

With a CST host active — `cstBuildHost`, or the
[language service](./editor-integration) — the recovered error is also embedded in the
tree as a `parseError` child spanning the skipped text, on both the interpreter and the
compiled (`{ recovery: true }`) path. That's what lets an incremental editor document
carry diagnostics inside the tree.

Recovery's one hard requirement is a **sync point** — where to resume after a bad element.
It comes from two layers.

### C — the sync point is inferred for free

The enclosing combinator already knows where a list resynchronizes, so no annotation is
needed:

- `sepBy(elem, sep)` knows its **separator** — the natural per-element resync token.
- A list inside `sequence(open, …, close)` learns the **enclosing delimiter**: the
  `sequence` publishes the first set of its following terms as the sync point while it
  parses each term, so the nested list resyncs to `close`.

That covers the block-body / declaration-list shapes an editor cares about, with the
grammar written exactly as it is for strict parsing:

```ts
// No recovery annotation anywhere — the inner sepBy infers `;` (its separator) and
// `}` (the block's close). A bad element is skipped to whichever comes first.
const block = sequence(literal('{'), sepBy(decl, literal(';')), literal('}'))
run(block, '{a:1;$$;b:2}', { tolerant: true })   // → [decl, error, decl]
```

A top-level list with no separator and no enclosing delimiter has no sync point to skip
to, so it falls back to the strict behavior (stop at the first bad element) — a `tolerant`
flag alone can't recover. In practice a list that an editor cares about is always inside a
block or separated, so inference covers it.

### The grammar carries no recovery annotation

Recovery is a *policy the caller turns on*, never a fact baked into the combinators. The
grammar written for strict parsing is the same grammar the editor recovers with — there is
no inline `{ recover }` hint, no sync argument on `many` / `sepBy`. The sync point is
inferred from structure (above), and that is the whole surface.

If you need to attach editor behaviour — override a rule's completions, add lint
diagnostics, or map structural expectations to semantic suggestions — wrap the grammar in
[`languageService`](./editor-integration), whose config is keyed by rule name and lives
entirely outside the grammar. See [Editor / language-server integration](./editor-integration).

### Guarantees

- **The span covers only the skipped text**, never the sync token.
- **A missing element between two separators** (`{a:1;;b}`) is a zero-width `ParseError`;
  the loop then consumes the separator, so a zero-width failure can never spin.
- **A trailing separator before the close** (`{a:1;}`) is not junk — the list ends cleanly
  with no spurious error.
- **Cold path.** None of this runs on well-formed input, and the strict default (no
  `tolerant`) is byte-identical to a parser with no recovery at all.

## `expect` — required tokens

Use `expect` to mark a token that **must** be there — a closing brace, a statement
terminator, the `)` after arguments. On success it's transparent (returns the value
verbatim). On failure it does **not** fail the parse: it records a `ParseError` and
recovers *in place* with a zero-width span, so the enclosing sequence proceeds as if the
token were present.

**Happens when:** a required terminal is missing at the current position.

```ts
import { sequence, literal, expect } from 'parseman'

// A block that must close with `}`.
const block = sequence(literal('{'), declList, expect(literal('}')))
```

::: code-group

```ts [Good input]
// "{ a: 1 }"  →  parses normally; expect(literal('}')) matches, contributes '}'.
```

```ts [Bad input]
// "{ a: 1"    →  declList consumes "a: 1", then expect(literal('}')) fails.
//               Instead of aborting, it records:
//                 { _tag: 'parseError', span: { start: 6, end: 6 }, expected: ['}'] }
//               and returns a zero-width success. The block node is still produced.
```

:::

The second argument is an optional **label** for the `expected` message. Without it,
Parséman derives the expected set from the combinator's structure:

```ts
expect(literal('}'))                 // expected: ['"}"']  (derived literal)
expect(literal('identifier'), 'id')  // expected: ['id']   (your label)
expect(choice(a, b))                 // expected: union of a's and b's expected sets
```

Because `expect` never moves the cursor on failure, it's the right tool when the missing
token is *punctuation the surrounding grammar can continue past* — the classic
"single-token insertion" recovery, made explicit.

## Positional recovery: `scanTo` & `balanced`

`scanTo` and `balanced` are pure cursor arithmetic — they advance the position with zero
CST allocation. They're independently useful for consuming opaque regions.

### `scanTo(sentinel, opts?)`

Consume input **up to (but not including)** the sentinel; return the consumed text. Fails
if the sentinel is never found — unless `orEOF: true`, which makes reaching EOF a success.

Pass `opts.skip` to declare patterns that should be treated as opaque blobs, so their
contents are never mistaken for the sentinel:

```ts
import { scanTo, choice, literal, balanced } from 'parseman'

// Consume a CSS at-rule prelude up to '{' or ';',
// but don't stop on a delimiter that's inside parens or a string.
const prelude = scanTo(choice(literal('{'), literal(';')), {
  skip: [balanced('(', ')'), singleStr, doubleStr],
})
```

### `balanced(open, close, opts?)`

Match a single self-contained delimited region and get its full text back, **including**
the delimiters. Nested same-type pairs are counted correctly, so `{{x}}` matches to the
outer `}`.

```ts
import { balanced } from 'parseman'

const parenGroup  = balanced('(', ')')   // matches "(a + b)" including the parens
const bracketExpr = balanced('[', ']')   // matches "[0]" including the brackets
```

::: warning Delimiters are strings
`balanced` takes **string** delimiters — `balanced('(', ')')` — not `literal()`
combinators. Its `opts.skip`, on the other hand, takes combinators (like `scanTo`).
:::

`balanced` uses `expect` internally for its closing delimiter, so a **stray close**, a
**cross-type close** (`(a]`), or an **unmatched open** all surface as errors rather than
being silently swallowed. It can itself take a `skip` list for regions that may contain
unbalanced delimiters:

```ts
// Match (…) allowing strings inside to contain unbalanced parens.
const parenWithStrings = balanced('(', ')', { skip: [singleStr, doubleStr] })
```

### `scanTo` vs. `balanced` — which one

- **`scanTo` scans *until* a boundary** — an open-ended region whose end is a specific
  token.
- **`balanced` matches *across* a known delimited region** — a self-contained `(…)`.

Use `balanced` inside `scanTo`'s `skip` list to keep the scanner from stopping at a
sentinel that appears inside a nested structure. Neither pushes terminals into the
enclosing `node()`'s child list; only the final scanned span appears as a single leaf.

## Collecting every error

`run()` always returns an `errors` array (empty when nothing recovered). With the
interpreter `parse()`, opt in with `{ recover: true }` to gather them centrally:

```ts
import { parse } from 'parseman'

const r = parse(document, source, { recover: true })

if (r.ok) {
  r.value        // the (possibly partial) tree
  r.errors       // ParseError[] — every recovery point that fired, in order
  r.furthestFail // the deepest failure position reached (see below)
}
```

- `errors` is populated by every tolerant-list recovery and every `expect` that fired.
- Without `{ recover: true }`, `expect` still recovers in place, but nothing is recorded
  (zero overhead beyond the inner attempt).
- The compiled path has the same channel via `compiled.parseWithErrors(input)`.

### `furthestFail`

Even when a parse *succeeds*, it may have succeeded too early — matching a prefix and
leaving trailing input, or recovering past a deeper problem. `furthestFail` records the
**deepest position any alternative reached before failing**, with the merged `expected`
set at that point. It's the single most useful signal for "why didn't this parse the way I
expected," and it's what [`completionsAt`](./incremental) reads to offer completions at a
cursor: run it `tolerant` so the enclosing list keeps parsing to the cursor and records the
expectation there.

## Design guidance & tradeoffs

Recovery is never free, and it's never pretty. Be deliberate:

- **Prefer `expect` for punctuation, tolerant lists for elements.** `expect` is zero-width
  and cheap — reach for it on required delimiters. A tolerant list discards input between
  the bad element and the sync point, so reserve it for "this element is hopeless, skip to
  the next one."
- **Recovery loses input.** Skipping to a sync point throws away everything in between.
  Your tree will have gaps; downstream consumers (visitors, formatters) must be
  **defensive** and not assume every expected child exists.
- **Sync points that actually resynchronize.** The inferred separator/close covers the
  list shapes an editor cares about (block bodies, declaration lists, argument lists). A
  bare top-level repetition with no separator and no enclosing delimiter has nothing to
  resync to — wrap it in the delimiter it really has rather than reaching for a knob.
- **It's off by default.** Strict parsing pays nothing. Turn `tolerant` on for the editor
  path; leave it off for a batch compile that only cares about valid input.
- **Pair it with [incremental re-parsing](./incremental).** Recovery keeps the tree alive
  through a broken keystroke; incremental re-parsing keeps re-parsing cheap. Together
  they're the foundation of a responsive language server.

## Cheat sheet

| I want to… | Use |
| --- | --- |
| Require a `}` / `)` / `;` but keep parsing if it's missing | `expect(literal('}'))` |
| Parse a list, tolerating bad elements | `run(list, src, { tolerant: true })` |
| Recover on the compiled fast path | `compile(g, { recovery: true })` |
| Add editor completions / diagnostics | `languageService(grammar, config)` |
| Consume everything up to a boundary token | `scanTo(sentinel, { skip: […] })` |
| Match a whole `(…)` / `[…]` / `{…}` region as text | `balanced('(', ')')` |
| Collect all errors from a parse | `run(p, src, { tolerant: true }).errors` |
| Know why a "successful" parse stopped short | `.furthestFail` |
| Test a value for a recovered error | `isParseError(value)` |
| Walk / visit the result tree | `walk(tree, …)` · `createVisitor({ … })` |
