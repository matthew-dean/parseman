# Error recovery

A parser that stops at the first error is useless to an editor. The code a language
server sees is *invalid most of the time* — mid-keystroke, half-typed, missing a brace.
To power diagnostics, autocomplete, folding, and refactors, a parser has to keep going:
report **every** error, not just the first, and still hand back a usable tree for the
parts that did parse.

Parséman makes recovery explicit rather than magical. You mark the places where the
grammar can resynchronize, and the parser produces a `ParseError` value there instead of
aborting. There are three tools, from smallest to largest blast radius:

| Tool | Use it for | On failure |
| --- | --- | --- |
| [`expect`](#expect-required-tokens) | A required delimiter/terminator (`}`, `)`, `;`) | Records an error, recovers **in place** (zero width), keeps going |
| [`recover`](#recover-skip-to-a-sentinel) | A whole construct that failed (a statement, a declaration) | **Skips forward** to a sentinel, returns a `ParseError` spanning the junk |
| [`scanTo` / `balanced`](#positional-recovery-scanto-balanced) | Consuming an opaque region up to a boundary | Positional scanning; the building blocks the other two lean on |

All of them turn a failure into a *successful* parse whose value is a `ParseError`, so the
enclosing `sequence` / `many` continues. You collect the errors through the
[`{ recover: true }` channel](#collecting-every-error).

## The `ParseError` value

Both `expect` and `recover` produce the same shape:

```ts
type ParseError = {
  _tag: 'parseError'
  span: Span          // where the problem is (zero-width for expect, the skipped range for recover)
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

> **Note:** `ParseError` (`_tag: 'parseError'`) is the runtime recovery value. It is
> distinct from the `CSTError` *type* (`_tag: 'error'`), which describes an error-node
> shape you may choose to build in your own AST. The combinators here produce
> `ParseError`.

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

## `recover` — skip to a sentinel

Use `recover` when a whole construct fails to parse and you want to **discard the junk up
to a known re-sync point** and carry on. On failure it scans forward one character at a
time until `sentinel` matches (or EOF), then returns a `ParseError` spanning the skipped
range. The sentinel is **not** consumed — your grammar continues from there.

**Happens when:** an entire sub-rule (a statement, a list item, a declaration) fails, and
there's a natural boundary to skip to.

```ts
import { recover, many, sequence, literal } from 'parseman'

// A tolerant statement list: if a statement is broken, skip to the next ';'.
const stmt  = recover(g.Stmt, literal(';'))
const block = many(sequence(stmt, literal(';')))
```

::: code-group

```ts [Good input]
// "a = 1; b = 2;"  →  both statements parse; no ParseError produced.
```

```ts [Bad input]
// "a = @#$; b = 2;"
//   1. g.Stmt fails at "@#$".
//   2. recover scans forward: '@' no, '#' no, '$' no, ';' matches → stop (not consumed).
//   3. returns { _tag: 'parseError', span: { start: 4, end: 7 }, expected: [ … ] }
//   4. the outer sequence consumes ';', many() loops, "b = 2" parses cleanly.
// Result: the second statement is recovered; you get one error, not a dead parse.
```

:::

A few important properties:

- **The span covers only the skipped text**, never the sentinel.
- **`expected` is preserved** from the inner failure, so the message still says what the
  construct wanted.
- **If the sentinel is never found**, the scan runs to EOF and returns a `ParseError`
  spanning the rest of the input.
- **The error path is not optimized.** `recover` is meant for IDE / incremental parsers
  that must produce a result on broken input — put it where recovery is genuinely needed,
  not on a hot path.

## Positional recovery: `scanTo` & `balanced`

`scanTo` and `balanced` are pure cursor arithmetic — they advance the position with zero
CST allocation. They're the building blocks `recover` and `balanced` themselves use, and
they're independently useful for consuming opaque regions.

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

By default, recovered errors are produced as values but not gathered anywhere central. To
collect them — the whole point, for a language server — run with `{ recover: true }`:

```ts
import { parse } from 'parseman'

const r = parse(document, source, { recover: true })

if (r.ok) {
  r.value        // the (possibly partial) tree
  r.errors       // ParseError[] — every recovery point that fired, in order
  r.furthestFail // the deepest failure position reached (see below)
}
```

- `errors` is populated by every `expect` / `recover` that fired during the parse.
- Without `{ recover: true }`, `expect` and `recover` still recover in place, but nothing
  is recorded (zero overhead beyond the inner attempt).
- The compiled path has the same channel via `compiled.parseWithErrors(input)`.

### `furthestFail`

Even when a parse *succeeds*, it may have succeeded too early — matching a prefix and
leaving trailing input, or taking a recovery arm that hid a deeper problem.
`furthestFail` records the **deepest position any alternative reached before failing**,
with the merged `expected` set at that point. It's the single most useful signal for
"why didn't this parse the way I expected," and for producing a good top-level error
message when the tree is technically valid but the input clearly wasn't.

## Design guidance & tradeoffs

Recovery is never free, and it's never pretty. Be deliberate:

- **Prefer `expect` for punctuation, `recover` for whole constructs.** `expect` is
  zero-width and cheap — reach for it on required delimiters. `recover` discards input, so
  reserve it for "this statement is hopeless, skip to the next `;`."
- **Recovery loses input.** A `recover` that skips to a sentinel throws away everything in
  between. Your tree will have gaps; downstream consumers (visitors, formatters) must be
  **defensive** and not assume every expected child exists.
- **Choose re-sync points that actually resynchronize.** A statement list recovers to `;`;
  a block recovers to `}`; a comma-separated list recovers to `,` or the closing bracket.
  The better the sentinel matches the grammar's real structure, the less input you lose.
- **Keep it off the hot path.** The recovery scans are intentionally simple, not fast. In
  a batch parser that only cares about valid input, you may not want any recovery at all;
  in an editor, you want it at every construct boundary.
- **Pair it with [incremental re-parsing](./incremental).** Recovery keeps the tree alive
  through a broken keystroke; incremental re-parsing keeps re-parsing cheap. Together
  they're the foundation of a responsive language server.

## Tolerant lists

Wrapping every list element in `recover` by hand is the most common recovery chore, so
`sepByRecover` and `manyRecover` do it for you. They behave like `sepBy` / `many`, but a
malformed element is skipped to the next separator (or the list terminator) and recorded
as a `ParseError` in the result — instead of truncating the list at the first bad item.

```ts
import { sepByRecover, literal } from 'parseman'

const elements = sepByRecover(value, literal(','), literal(']'))
const array = sequence(literal('['), elements, literal(']'))

// "[1,,3]"  → [1, ParseError, 3]   (the hole is one recovered error)
// "[]"      → []                    (empty list — no spurious error)
```

The third argument is the list's **terminator** (matched but not consumed). It's required:
it's how an empty list is told apart from a malformed first element, so `[]` yields `[]`
rather than a bogus error. The terminator must not overlap with what a valid element can
start with.

`manyRecover(item, until)` is the separator-less form: with no separator to resync on, a
bad run is captured as a single `ParseError` up to the terminator. Both are built from
`recover` under the hood, so the collected errors show up in `{ recover: true }` exactly
like hand-written recovery, and the macro build behaves identically to the interpreter.

## Cheat sheet

| I want to… | Use |
| --- | --- |
| Require a `}` / `)` / `;` but keep parsing if it's missing | `expect(literal('}'))` |
| Skip a broken statement and resume at the next `;` | `recover(stmt, literal(';'))` |
| Parse a list, tolerating bad elements | `sepByRecover(item, literal(','), literal(']'))` |
| Parse a repetition, tolerating junk | `manyRecover(item, literal('}'))` |
| Consume everything up to a boundary token | `scanTo(sentinel, { skip: […] })` |
| Match a whole `(…)` / `[…]` / `{…}` region as text | `balanced('(', ')')` |
| Collect all errors from a parse | `parse(p, src, { recover: true }).errors` |
| Know why a "successful" parse stopped short | `.furthestFail` |
| Test a value for a recovered error | `isParseError(value)` |
| Walk / visit the result tree | `walk(tree, …)` · `createVisitor({ … })` |
