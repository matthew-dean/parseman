# Combinators

A **combinator** is any building block that reads input at the current position and
either succeeds (returning a value) or fails. You compose them with `sequence`,
`choice`, `many`, and so on to express parsing decisions. That composition *is* your
grammar.

## Terminology

Three words that sound alike but play different roles:

- **Combinator** — matches input. `literal`, `choice`, `sequence`, `node`, …
- **`parser()`** — a *function* that wraps a root combinator with document-level
  options (trivia skipping, line tracking) and gives you `.parse(input)`. It configures
  *how you run* a grammar; it doesn't match input itself. See [Whitespace & trivia](./trivia).
- **Helpers** — definition-time factories that *produce* combinators (`makeWord`,
  `rules`, `trivia`). They never match input themselves.

## Matching combinators

| Combinator | Description |
| --- | --- |
| `literal(s, opts?)` | Exact string match. `opts.caseInsensitive` for locale-aware comparison. |
| `word(s, boundary?)` | Single keyword with an automatic word-boundary guard. |
| `keywords(words, opts?)` | Match one of many keywords (longest-first), with optional boundary and case folding. |
| `regex(pattern)` | Match a regex at the current position. Patterns are optimized via `regexp-tree`. |
| `sequence(...combinators)` | Match all in order; returns a tuple `[v1, v2, …]`. Skips trivia between terms when trivia is active. |
| `choice(...combinators)` | Ordered alternatives (PEG — first match wins). Disjoint first chars → O(1) dispatch. |
| `many(combinator)` | Zero or more; compiles to a `while` loop. |
| `oneOrMore(combinator)` | One or more; fails if nothing matches. |
| `optional(combinator)` | Zero or one; returns `null` on no match. |
| `sepBy(combinator, sep)` | Zero or more `combinator` matches separated by `sep`. |
| `transform(combinator, fn)` | Map the result: `fn(value, span) → newValue`. |
| `skip(main, skipped)` | Match `main` then `skipped`; return `main`'s value. |
| `label(name, combinator)` | Attach a string label to a combinator arm (metadata; used for per-chunk trivia kinds). |
| `not(combinator)` | Negative lookahead — succeeds (consuming nothing) when `combinator` fails. |
| `node(type, combinator, build, opts?)` | CST/AST rule: captures terminals + trivia, then calls `build`. See [CST / AST nodes](./ast). |
| `ref<T>()` | Low-level forward-declaration slot (prefer `rules()`). |
| `guard(predicate)` | Succeeds only when `predicate(ctx)` is true; for context-sensitive rules. See [Context](./context). |
| `withCtx(extra, combinator)` | Merge `extra` into the user context for the duration of `combinator`. |
| `recover(combinator, sentinel)` | On failure, skip to `sentinel` and return a `ParseError`. See [Error recovery](./error-recovery). |
| `expect(combinator, label?)` | Required token: on failure, record an error and recover in place. See [Error recovery](./error-recovery). |
| `scanTo(sentinel, opts?)` | Scan forward until `sentinel` matches (sentinel not consumed). |
| `balanced(open, close, opts?)` | Match a single balanced delimited region — e.g. `(…)` — including the delimiters. |

## Helpers (produce combinators at definition time)

| Helper | Description |
| --- | --- |
| `trivia(combinator)` | Label a combinator as skippable filler. Pass the result to `parser({ trivia })` to turn on auto-skipping. |
| `makeWord(boundary?)` | Returns `(str) => Combinator` with a fixed word-boundary class. Not a combinator. |
| `rules(factory)` | Named, mutually-recursive rule bundle. See [Recursive rules](./recursive-rules). |
| `parser({ trivia }, combinator)` | Wrap a root combinator with document-level options. See [Whitespace & trivia](./trivia). |
| `noTrivia(combinator)` | Run `combinator` with active trivia cleared — terms must be contiguous. |
| `triviaEntries(log, labels?, opts?)` | Indexed view over a trivia log. See [Whitespace & trivia](./trivia). |

For the full list of exports — including error/IDE helpers like `completionsAt`,
`isParseError`, `staticExpected`, and the line-index utilities — see the
[API reference](../reference/api).

## The essentials, up close

### `literal` and `regex`

The two terminals. `literal` matches an exact string; `regex` matches a pattern at the
current position (compiled to a sticky `/…/y` regex under the hood).

```ts
import { literal, regex, parse } from 'parseman'

parse(literal('const'), 'const x')   // { ok: true, value: 'const', span: { start: 0, end: 5 } }
parse(regex(/[0-9]+/), '42px')       // { ok: true, value: '42', span: { start: 0, end: 2 } }

parse(literal('HELLO', { caseInsensitive: true }), 'hello') // ok
```

### `sequence`

Match terms in order; get back a tuple of their values. Destructure it — often inside a
`transform`.

```ts
import { sequence, literal, regex, transform } from 'parseman'

const assign = transform(
  sequence(regex(/[a-z]+/), literal('='), regex(/[0-9]+/)),
  ([name, , value]) => ({ name, value: Number(value) })
)
```

The `,` gaps in the destructure skip terms you don't need (here the `=`).

### `choice`

Ordered alternatives with PEG semantics: **first match wins**. Order matters, and when
alternatives share a prefix, put the longer one first (see
[Ordered choice & keywords](./keywords)).

```ts
import { choice, literal } from 'parseman'

const op = choice(literal('instanceof'), literal('in'), literal('if'))
```

When the arms start with disjoint characters, the compiler turns the whole `choice` into
a single O(1) character dispatch.

### `many`, `oneOrMore`, `optional`, `sepBy`

Repetition and optionality.

```ts
import { many, oneOrMore, optional, sepBy, regex, literal } from 'parseman'

many(regex(/[0-9]/))            // '' , '5', '512' → number[] of digits
oneOrMore(regex(/[0-9]/))       // like many, but fails on zero matches
optional(literal('-'))          // '-' → '-', otherwise → null
sepBy(regex(/[a-z]+/), literal(',')) // 'a,b,c' → ['a', 'b', 'c']
```

`optional` returns `null` on no match and rolls back any CST/trivia it speculatively
captured.

### `transform` and `skip`

`transform` maps a successful value (and its span) through a function — the workhorse for
turning raw matches into your own shapes. `skip(main, skipped)` matches both but returns
only `main`'s value, extending the span across both.

```ts
import { transform, skip, sequence, regex, literal } from 'parseman'

const int = transform(regex(/[0-9]+/), (s) => parseInt(s, 10))
const line = skip(regex(/[^\n]*/), literal('\n')) // value is the line, '\n' consumed
```

> `transform` is for plain value-mapping. For rules that build a syntax tree with
> captured children and trivia, use [`node()`](./ast) instead — it adds the capture
> `transform` doesn't.

### `not`

Negative lookahead. Succeeds *consuming nothing* when its inner combinator fails —
useful for boundary guards and "anything but" patterns.

```ts
import { not, sequence, literal, regex, transform } from 'parseman'

const wordChar = regex(/\w/)
const keyword  = (s: string) => transform(sequence(literal(s), not(wordChar)), ([kw]) => kw)
// keyword('if') matches 'if' but not the 'if' inside 'ifdef'
```

## What's next

- Put terms together with automatic whitespace handling in
  [Whitespace & trivia](./trivia).
- Disambiguate keywords and shared prefixes in [Ordered choice & keywords](./keywords).
- Let rules reference each other in [Recursive rules](./recursive-rules).
- Build a typed tree with [CST / AST nodes](./ast).
