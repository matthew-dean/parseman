# Combinators

A **combinator** is any building block that reads input at the current position and
either succeeds (returning a value) or fails. You compose them with `sequence`,
`choice`, `many`, and so on to express parsing decisions. That composition *is* your
grammar.

Every example on this page is executed by `scripts/verify-doc-examples.mjs` and the
`// →` outputs are pasted from the real run — if the engine changes, the check fails.

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
| `word(s, boundary?, opts?)` | Single keyword with an automatic word-boundary guard. `opts.caseInsensitive` for ASCII case folding. |
| `keywords(words, opts?)` | Match one of many keywords (longest-first), with optional boundary and case folding. |
| `regex(pattern)` | Match a regex at the current position. |
| `sequence(...combinators)` | Match all in order; returns a tuple `[v1, v2, …]`. Skips trivia between terms when trivia is active. |
| `choice(...combinators)` | Ordered alternatives (PEG — first match wins). Disjoint first chars → O(1) dispatch. |
| `dispatch(selector, when(...), otherwise(...))` | Parse a broad selector token once, route selected values to specialized tails, and commit matched-tail failures. |
| `attempt(c)` | All-or-nothing arm: on failure, every framework side effect from the rejected branch is rolled back. |
| `many(c, opts?)` | Zero or more; `{ min, max }` bound the item count. |
| `oneOrMore(c, opts?)` | One or more — sugar for `many(c, { min: 1 })`. |
| `optional(c)` | Zero or one; returns `null` on no match. |
| `sepBy(c, sep, opts?)` | Separated list; `{ min, max, trailing }`. **Nullable by default.** |
| `oneOrMoreSep(c, sep, opts?)` | Non-empty separated list — sugar for `sepBy(c, sep, { min: 1 })`. |
| `transform(c, fn)` | Map the result: `fn(value, span) → newValue`. |
| `skip(main, skipped)` | Match `main` then `skipped`; return `main`'s value. |
| `token(c)` | Treat a contiguous parser run as one source-text token and one CST leaf. |
| `leaf(c, reducer)` | Treat a structural grammar as one semantic leaf, without touching trivia. |
| `label(name, c)` | Attach a string label to a combinator arm (metadata; used for per-chunk trivia kinds). |
| `field(name, c)` | Capture a named value/span for the nearest enclosing `node()` builder. |
| `not(c)` | **Negative** lookahead — succeeds (consuming nothing) when `c` fails. |
| `peek(c)` | **Positive** lookahead — succeeds (consuming nothing) when `c` matches, carrying its first-set. |
| `node(c, build?, opts?)` / `node(type, c, build?, opts?)` | CST/AST rule: captures terminals + trivia. Inside `rules()`, the node type is inferred from the rule key. See [CST / AST nodes](./ast). |
| `ref<T>()` | Low-level forward-declaration slot (prefer `rules()`). |
| `gate(predicate)` | Zero-width ASSERT: succeeds only when `predicate(ctx.state)` is true. See [Context](./context). (`guard()` is a deprecated alias.) |
| `withCtx(extra, c)` | Merge `extra` into the user context for the duration of `c`. |
| `expect(c, label?)` | Required token: on failure, record an error and recover in place. See [Error recovery](./error-recovery). |
| `scanTo(sentinel, opts?)` | Scan forward until `sentinel` matches (sentinel not consumed). Skips ambient trivia + `scanSkip` opaque units by default. |
| `balanced(open, close, opts?)` | Match a single balanced delimited region — e.g. `(…)` — including the delimiters. |

## Helpers (produce combinators at definition time)

| Helper | Description |
| --- | --- |
| `trivia(c)` | Label a combinator as skippable filler. Pass the result to `parser({ trivia })` to turn on auto-skipping. |
| `noTrivia(c)` | Run `c` with active trivia cleared — terms must be contiguous. |
| `makeWord(boundary?, opts?)` | Returns `(str) => Combinator` with a fixed word-boundary class and keyword options. Not a combinator. |
| `rules(factory)` / `rules({ trivia, scanSkip }, factory)` | Named, mutually-recursive rule bundle. See [Recursive rules](./recursive-rules) and [scanTo & balanced](#scanto-and-balanced). |
| `parser({ trivia }, c)` | Wrap a root combinator with document-level options. See [Whitespace & trivia](./trivia). |
| `parse(c, input, opts?)` | Run a combinator once, without building a `parser()`. |
| `compile(c, …, opts?)` | Compile a combinator to optimized JavaScript. See [Compilation](../reference/api#compilation). |
| `compose([...])` / `composeLeaf([...])` | Fuse independently-compiled grammars. See [Composing grammars](../reference/api#composing-grammars). |
| `completionsAt(target, input, offset)` | What could come next at a cursor. See [IDE support](../reference/api#ide-support). |
| `isParseError(v)` | Type guard for a recovered `ParseError` embedded in a value. |
| `cstBuildHost(opts?)` | A ready-made `build` host that produces the default CST shape. |

For the full list of exports — including the line-index utilities — see the
[API reference](../reference/api). For the terse DO/DON'T rules an agent should
follow while authoring, see `AGENTS.md` at the repo root.

## Reading the examples

`parse(combinator, input)` returns `{ ok, value, span }` on success and
`{ ok: false, expected, span }` on failure. Most examples below read `.value` or
`.ok` to keep the output tight.

```ts
// [verify]
import { literal, parse } from 'parseman'

parse(literal('const'), 'const x')
// → { ok: true, value: 'const', span: { start: 0, end: 5 } }

parse(literal('const'), 'let x')
// → { ok: false, expected: ['"const"'], span: { start: 0, end: 0 } }
```

## Terminals

### `literal`

Exact string match — punctuation, operators, fixed tokens. No word boundary: it will
happily match inside a longer word.

```ts
// [verify]
import { literal, parse } from 'parseman'

parse(literal('=>'), '=> x').value
// → '=>'

// The instructive failure — there is none. That is the point:
// `literal` does NOT guard a word boundary.
parse(literal('if'), 'ifdef').value
// → 'if'

parse(literal('HELLO', { caseInsensitive: true }), 'hello').value
// → 'hello'
```

**Gating:** exact first-set, always dispatches. → compare with
[`word` vs `literal` vs `regex`](#recognizing-a-keyword-word-vs-literal-vs-regex).

### `regex`

Match a pattern at the current position (compiled to a sticky `/…/y` regex). For
genuine *patterns* — numbers, identifiers, escapes — not for keywords.

```ts
// [verify]
import { regex, parse } from 'parseman'

parse(regex(/[0-9]+/), '42px').value
// → '42'

parse(regex(/[0-9]+/), 'px42').ok
// → false

// A nullable pattern SUCCEEDS on no match, consuming nothing — usually not
// what you want as a choice arm.
parse(regex(/[0-9]*/), 'px').value
// → ''
```

**Gating:** the first-set is derived from the pattern, so a narrow class gates and a
broad one does not. Under `/i` it is ASCII case-folded; under `/iu` it falls back to
`any` (Unicode case folding cannot be enumerated).

### `word` and `keywords`

A keyword with a trailing word-boundary guard — the thing `literal` deliberately
does not do.

```ts
// [verify]
import { word, keywords, parse } from 'parseman'

parse(word('if'), 'if (x)').value
// → 'if'

// The instructive failure: the boundary guard is the whole point.
parse(word('if'), 'ifdef').ok
// → false

// A custom boundary class — CSS identifiers allow `-`.
parse(word('color', 'A-Za-z0-9_-'), 'color-scheme').ok
// → false

// ASCII case-insensitive keywords (CSS at-keywords, units, function names).
parse(word('media', 'A-Za-z0-9_-', { caseInsensitive: true }), 'MEDIA').value
// → 'MEDIA'

// One of many, longest-first — `border` wins over `bord`.
parse(keywords(['bord', 'border']), 'border-top').value
// → 'border'
```

**Gating:** exact first-set (the union of the keywords' first characters, ASCII
case-folded under `caseInsensitive`), so a keyword arm always dispatches. Prefer
these over `regex(/kw/)`, which the [gating diagnostic](./first-char-gating) flags
as `keyword-regex`.

### `makeWord`

A definition-time factory that fixes the boundary class and keyword options, for
grammars where every keyword shares them.

```ts
// [verify]
import { makeWord, parse } from 'parseman'

const cssKw = makeWord('A-Za-z0-9_-', { caseInsensitive: true })

parse(cssKw('screen'), 'SCREEN and (x)').value
// → 'SCREEN'
parse(cssKw('screen'), 'screen-only').ok
// → false
```

## Composition

### `sequence`

Match terms in order; get back a tuple of their values. Destructure it — often inside
a `transform`. The `,` gaps skip terms you don't need.

```ts
// [verify]
import { sequence, literal, regex, transform, parse } from 'parseman'

const assign = transform(
  sequence(regex(/[a-z]+/), literal('='), regex(/[0-9]+/)),
  ([name, , value]) => ({ name, value: Number(value) }),
)

parse(assign, 'x=42').value
// → { name: 'x', value: 42 }

// A sequence fails as a unit — a partial match consumes nothing.
parse(assign, 'x=').ok
// → false
```

**Gating:** the sequence's first-set comes from its leading non-nullable term, so
leading with a concrete terminal is what keeps an arm dispatching.

### `choice`

Ordered alternatives with PEG semantics: **first match wins**. Write the longer of
two overlapping alternatives first (see [Ordered choice & keywords](./keywords)).

```ts
// [verify]
import { choice, literal, regex, parse } from 'parseman'

const op = choice(literal('instanceof'), literal('in'), literal('if'))
parse(op, 'instanceof x').value
// → 'instanceof'

// The instructive failure: a SHORT arm placed first wins and shadows the long one
// for good. PEG never backtracks into an earlier arm's success, so `instanceof`
// here is unreachable — no input can ever select it.
const shadowed = choice(regex(/in/), regex(/instanceof/))
parse(shadowed, 'instanceof x').value
// → 'in'
```

::: tip Bare literals are reordered for you
When **every** arm is a plain `literal()`, the compiler recognizes the shape and
sorts the arms longest-first (`literalsLongestFirst` — see
[Literal-heavy choices](./natural-grammars#literal-heavy-choices-collapse-to-one-scan)),
so `choice(literal('in'), literal('instanceof'))` still yields `'instanceof'`. The
shadowing above needs `regex()` arms precisely because that rewrite no longer
applies. Don't rely on it: add one non-literal arm and ordering matters again.
:::

When the arms start with disjoint characters the compiler turns the whole `choice`
into a single O(1) character dispatch.

### `dispatch`

Token-once routing by a parsed string value. Use it when one broad selector
token is valid generally, and selected selector values have specialized
continuation grammars. CSS at-rules are the model: the selector consumes one
at-keyword token; values such as `@media` or `@scope` choose specific
prelude/body tails; unmatched values take the generic at-rule tail.

The `when(...)` keys are classifier keys for the consumed selector value, not
tokens parsed after the selector. A matched key's bad tail is an error.

```ts
// [verify]
import { choice, dispatch, literal, otherwise, parse, regex, sequence, when } from 'parseman'

const atRule = dispatch(
  regex(/@[a-z]+/),
  when('@media', literal('{')),
  otherwise(literal(';')),
)

parse(atRule, '@media{').value
// → ['@media', '{']

parse(atRule, '@unknown;').value
// → ['@unknown', ';']

const committed = choice(
  dispatch(literal('@media'), when('@media', literal('{'))),
  sequence(literal('@media'), literal('x')),
)

parse(committed, '@mediax').ok
// → false
```

If the selector fails, an enclosing `choice` can still try a later arm. If the
selector succeeds and a `when` key matches, that tail is committed: its failure is
returned immediately and neither `otherwise` nor an outer fallback is attempted.
Duplicate keys, including duplicates across grouped `when([keyA, keyB], tail)`
arms, fail at grammar construction time.

In macro-compiled `rules()` factories, `when()` and `otherwise()` arms can be
bound to local `const`s and passed by name. Put the generic continuation in
`otherwise(...)`. V1 macro lowering expects explicit arm arguments;
`dispatch(selector, ...arms)` is future work.

### `attempt`

An all-or-nothing arm. An ordinary `choice` arm that fails mid-way leaves the
framework's speculative side effects (recovered errors, captured fields) behind;
`attempt` rolls every one of them back.

```ts
// [verify]
import { attempt, choice, sequence, literal, regex, parse } from 'parseman'

const call = attempt(sequence(regex(/[a-z]+/), literal('('), regex(/[a-z]*/), literal(')')))
const bare = regex(/[a-z]+/)

parse(choice(call, bare), 'f(x)').value
// → ['f', '(', 'x', ')']

// The call arm gets partway through `foo` then fails at the missing `(` —
// `attempt` discards it cleanly and `bare` matches instead.
parse(choice(call, bare), 'foo').value
// → 'foo'
```

Reach for `attempt` when a *rejected* arm could otherwise leave state behind. It is
not a lookahead — see [`attempt` vs `peek`](#committing-vs-looking-attempt-vs-peek).

## Repetition

The four repetition combinators are one family. The named ones are sugar for the
common option combinations, and the options are available on all of them.

| | nullable (min 0) | non-empty (min 1) |
| --- | --- | --- |
| plain | `many(item, opts?)` | `oneOrMore(item, opts?)` |
| separated | `sepBy(item, sep, opts?)` | `oneOrMoreSep(item, sep, opts?)` |

`oneOrMore(x)` **is** `many(x, { min: 1 })` and `oneOrMoreSep(i, s)` **is**
`sepBy(i, s, { min: 1 })` — the same combinator, not a lookalike.

### `many` and `oneOrMore`

```ts
// [verify]
import { many, oneOrMore, regex, parse } from 'parseman'

const digit = regex(/[0-9]/)

parse(many(digit), '512').value
// → ['5', '1', '2']

// The instructive failure — there isn't one. `many` MATCHES THE EMPTY STRING.
parse(many(digit), 'abc')
// → { ok: true, value: [], span: { start: 0, end: 0 } }

// …which is exactly what `oneOrMore` is for.
parse(oneOrMore(digit), 'abc').ok
// → false

// `min`/`max` count ITEMS.
parse(many(digit, { max: 2 }), '512').value
// → ['5', '1']
parse(many(digit, { min: 3 }), '51').ok
// → false
```

**Gating:** `many` is **nullable** — a `many`-led choice arm matches at every
position and disables the choice's first-char dispatch. `oneOrMore` / `{ min: 1 }` is
non-nullable and carries the item's first-set. `max` never affects nullability.

### `sepBy` and `oneOrMoreSep`

```ts
// [verify]
import { sepBy, oneOrMoreSep, regex, literal, parse } from 'parseman'

const ident = regex(/[a-z]+/)
const comma = literal(',')

parse(oneOrMoreSep(ident, comma), 'a,b,c').value
// → ['a', 'b', 'c']

// THE defect this family exists to fix: plain `sepBy` matches the EMPTY STRING.
parse(sepBy(ident, comma), '')
// → { ok: true, value: [], span: { start: 0, end: 0 } }

parse(oneOrMoreSep(ident, comma), '').ok
// → false

// A trailing separator is left for the enclosing rule by default…
parse(sepBy(ident, comma), 'a,b,').span
// → { start: 0, end: 3 }

// …unless you ask for it.
parse(sepBy(ident, comma, { trailing: 'allow' }), 'a,b,').span
// → { start: 0, end: 4 }
```

**Gating:** the single most consequential nullability in the library. A selector
list, value list, media-query prelude or keyframe selector is *never* empty — use
`oneOrMoreSep`. Plain `sepBy` is for the genuinely-optional list.

### `optional`

```ts
// [verify]
import { optional, literal, parse } from 'parseman'

parse(optional(literal('-')), '-5').value
// → '-'

// No match is a SUCCESS with `null` — it never fails.
parse(optional(literal('-')), '5')
// → { ok: true, value: null, span: { start: 0, end: 0 } }
```

**Gating:** nullable by definition. Never lead a choice arm with it; put the
concrete terminal first and make the optional part follow.

## Lookahead

Both lookaheads are **zero-width**: they assert and consume nothing. An author who
finds one should immediately find the other.

- **`not(X)`** — NEGATIVE (PEG `!X`). Succeeds when X does *not* match.
- **`peek(X)`** — POSITIVE (PEG `&X`). Succeeds when X *does* match.

### `not`

```ts
// [verify]
import { not, sequence, literal, regex, transform, parse } from 'parseman'

const kw = (s: string) => transform(sequence(literal(s), not(regex(/\w/))), ([k]) => k)

parse(kw('if'), 'if (x)').value
// → 'if'
parse(kw('if'), 'ifdef').ok
// → false

// Zero-width: the lookahead itself consumes nothing and yields null.
parse(not(literal('#')), 'abc')
// → { ok: true, value: null, span: { start: 0, end: 0 } }
```

**Gating:** `not()`'s first-set is `any` — it cannot know what it forbids. Keep it as
a **trailing** boundary; leading an arm with it poisons the whole choice's dispatch
(the diagnostic reports `leading-not`). For a keyword boundary reach for
[`word`](#word-and-keywords) instead, which does this with an exact first-set.

### `peek`

```ts
// [verify]
import { peek, sequence, literal, regex, parse } from 'parseman'

// "only try this arm when the punctuation is ahead" — then let the real
// production consume it.
const mixinRef = sequence(peek(regex(/[.#]/)), regex(/[.#][\w-]+/))

parse(mixinRef, '.rounded').value
// → [null, '.rounded']

parse(mixinRef, 'rounded').ok
// → false

// Zero-width, like `not`.
parse(peek(literal('@')), '@media').span
// → { start: 0, end: 0 }
```

**Gating — this is why `peek` exists.** Unlike `not`, `peek` knows what it requires,
so it carries its body's first-set and a **leading** `peek()` *narrows* the arm:

```ts
// [verify]
import { peek, not, sequence, choice, regex, literal } from 'parseman'

const broadBody = regex(/[^\s;{}]+/)

// The whole choice dispatches: `peek`'s chars are intersected into the arm's.
const good = choice(sequence(peek(regex(/[.#]/)), broadBody), literal('@rule'))
good._def.disjoint
// → true

// `not(not(X))` is merely zero-width, so it is SKIPPED rather than
// intersected, and the broad body decides the first chars.
const bad = choice(sequence(not(not(regex(/[.#]/))), broadBody), literal('@rule'))
bad._def.disjoint
// → false
```

A nullable body constrains no first character, so `peek()` reports `any` in that
case — sound, just not narrowing.

## Mapping and shaping

### `transform`

Map a successful value (and its span) through a function — the workhorse for turning
raw matches into your own shapes.

```ts
// [verify]
import { transform, regex, parse } from 'parseman'

const int = transform(regex(/[0-9]+/), s => parseInt(s, 10))
parse(int, '0042').value
// → 42

// The span is the second argument.
const spanned = transform(regex(/[a-z]+/), (s, span) => `${s}@${span.start}-${span.end}`)
parse(spanned, 'abc').value
// → 'abc@0-3'
```

`transform` is for plain value-mapping. For rules that build a syntax tree with
captured children and trivia, use [`node()`](./ast) — see
[`transform` vs `node`](#mapping-vs-building-transform-vs-node).

### `skip`

Match both, return only `main`'s value, with the span extended across both.

```ts
// [verify]
import { skip, regex, literal, parse } from 'parseman'

const line = skip(regex(/[^\n]*/), literal('\n'))
parse(line, 'hello\nworld')
// → { ok: true, value: 'hello', span: { start: 0, end: 6 } }
```

### `token`

Run a contiguous region with trivia disabled, return the matched **source text**, and
contribute one CST leaf inside `node()`.

```ts
// [verify]
import { token, sequence, literal, regex, parse } from 'parseman'

const important = token(sequence(literal('!'), regex(/important/i)))
parse(important, '!important').value
// → '!important'
```

Use it when the grammar is clearer as combinators but the result is semantically one
source token. Keep the parts exposed when a builder needs distinct leaves.

### `leaf`

Treat a structural grammar as one *semantic* leaf. Unlike `token`, it does not alter
trivia — the reducer chooses the value the parent sees.

```ts
// [verify]
import { leaf, noTrivia, sequence, choice, literal, optional, regex, parse } from 'parseman'

const gap = regex(/\s+/)
const operator = leaf(
  noTrivia(sequence(optional(gap), choice(literal('*'), literal('/')), optional(gap))),
  parts => parts[1],
)

parse(operator, ' * ').value
// → '*'
```

### `label` and `field`

`label` attaches metadata (used for per-chunk trivia kinds); parse behaviour is
unchanged. `field` captures a named value/span for the nearest enclosing `node()`
builder.

```ts
// [verify]
import { node, field, sequence, literal, regex, parse } from 'parseman'

const Attr = node('Attr',
  sequence(literal('['), field('name', regex(/[a-z]+/)), literal('='), field('value', regex(/[a-z]+/)), literal(']')),
  (_children, fields) => ({ name: fields!.name.value, value: fields!.value.value }),
)

parse(Attr, '[href=x]').value
// → { name: 'href', value: 'x' }
```

Repeated field names become arrays. Field capture is emitted only for node subtrees
that contain a `field()`.

### `node`

The tree-building rule: captures terminals and trivia and hands them to a `build`
callback. See [CST / AST nodes](./ast) for the full model.

```ts
// [verify]
import { node, sequence, literal, regex, parse } from 'parseman'

const Decl = node('Decl', sequence(regex(/[a-z-]+/), literal(':'), regex(/[a-z0-9]+/)),
  children => ({ type: 'Decl', prop: children[0], value: children[2] }))

// Note what a `build` callback actually receives: CST LEAVES, with spans — not the
// bare strings `transform` would hand you. That capture is the whole difference.
parse(Decl, 'color:red').value
// → { type: 'Decl', prop: { _tag: 'leaf', value: 'color', span: { start: 0, end: 5 } }, value: { _tag: 'leaf', value: 'red', span: { start: 6, end: 9 } } }
```

## Recursion and grammars

### `ref`

A low-level forward-declaration slot, for when a combinator must reference itself
before it exists. Prefer `rules()`, which does this for you.

```ts
// [verify]
import { ref, choice, sequence, literal, regex, parse } from 'parseman'
import type { Combinator } from 'parseman'

const expr = ref<unknown>()
expr.define(choice(sequence(literal('('), expr as Combinator<unknown>, literal(')')), regex(/[0-9]+/)))

parse(expr, '((7))').value
// → ['(', ['(', '7', ')'], ')']

// The instructive failure: using a ref before define() throws, rather than
// silently matching nothing.
const undeclared = ref<unknown>()
parse(undeclared, 'x')
// → throws: ref<T>() used before .define() was called
```

### `rules`

Named, mutually-recursive rules. The factory receives a proxy — reference any rule as
`g.Name`, declared or not.

```ts
// [verify]
import { rules, choice, sequence, literal, regex, parse } from 'parseman'
import type { Combinator } from 'parseman'

const g = rules(g => ({
  Value: choice(g.Paren as Combinator<unknown>, regex(/[0-9]+/)),
  Paren: sequence(literal('('), g.Value as Combinator<unknown>, literal(')')),
}))

parse(g.Value, '((7))').value
// → ['(', ['(', '7', ')'], ')']
```

`rules({ trivia, scanSkip }, factory)` sets grammar-wide options — note the options
go **first** here, because they configure a scope rather than one combinator.

### `parser`, `noTrivia` and `trivia`

`trivia(c)` marks a combinator as skippable filler; `parser({ trivia }, root)` turns
on auto-skipping between sequence terms; `noTrivia(c)` turns it back off locally.

```ts
// [verify]
import { parser, noTrivia, trivia, sequence, literal, regex } from 'parseman'

const ws = trivia(regex(/\s+/))
const spaced = parser({ trivia: ws }, sequence(literal('a'), literal('b')))

spaced.parse('a   b').ok
// → true

// Inside noTrivia, the terms must be contiguous.
const tight = parser({ trivia: ws }, noTrivia(sequence(literal('a'), literal('b'))))
tight.parse('a   b').ok
// → false
tight.parse('ab').ok
// → true
```

### `parse` and `compile`

`parse(c, input, opts?)` runs a combinator once through the interpreter.
`compile(c)` lowers it to JavaScript with the same semantics.

```ts
// [verify]
import { compile, parse, choice, literal } from 'parseman'

const g = choice(literal('a'), literal('b'))
const compiled = compile(g, undefined, { gating: 'off' })

parse(g, 'b').value
// → 'b'
compiled.parse('b').value
// → 'b'
```

`compile()` also runs the [gating diagnostic](./first-char-gating) by default.

## Context and assertions

### `gate` and `withCtx`

`gate(predicate)` is a zero-width ASSERT on `ctx.state`; `withCtx(extra, c)` merges
values into that state for the duration of `c`. See [Context](./context).

```ts
// [verify]
import { gate, withCtx, sequence, literal, parse } from 'parseman'

const depth = (s: unknown) => (s as { depth?: number } | undefined)?.depth ?? 0
const inBlock = sequence(literal('@'), gate(s => depth(s) > 0), literal('x'))

// `withCtx` is how state gets in — `parse()` itself takes no state option, so a
// bare gate on absent state simply fails.
parse(inBlock, '@x').ok
// → false

parse(withCtx({ depth: 1 }, inBlock), '@x').ok
// → true

// The instructive failure: the predicate is an ASSERT, so a false verdict fails
// the sequence rather than selecting a different branch.
parse(withCtx({ depth: 0 }, inBlock), '@x').ok
// → false
```

**Gating:** `gate()`'s first-set is `any`. Use it only *after* a concrete leading
terminal inside a `sequence` — never as a leading arm term. To pick a branch by
state, use the gated-arm **field** instead:
[gated arm vs `gate()`](#selecting-vs-asserting-on-context-gated-arm-vs-gate).

### `expect` and `isParseError`

`expect(c, label?)` makes a token required: on failure it records a `ParseError` in
place and keeps parsing. See [Error recovery](./error-recovery).

```ts
// [verify]
import { expect, isParseError, sequence, literal, regex, parse } from 'parseman'

const decl = sequence(regex(/[a-z]+/), expect(literal(':'), 'colon'), regex(/[a-z]*/))
const r = parse(decl, 'color red', { recover: true })

r.ok
// → true
isParseError(r.ok && r.value[1])
// → true
```

## Scanning

### `scanTo` and `balanced`

`scanTo(sentinel)` walks forward until `sentinel` matches (without consuming it),
returning the skipped text; `balanced('(', ')')` matches a single balanced region
including its delimiters, counting nested pairs.

```ts
// [verify]
import { scanTo, balanced, regex, parse } from 'parseman'

parse(scanTo(regex(/[;}]/)), 'a b c; rest').value
// → 'a b c'

parse(balanced('(', ')'), '(a (b) c) rest').value
// → '(a (b) c)'

// The instructive failure: without a sentinel the scan fails, rather than
// silently consuming everything — unless you ask for `orEOF`.
parse(scanTo(regex(/;/)), 'no terminator').ok
// → false
parse(scanTo(regex(/;/), { orEOF: true }), 'no terminator').value
// → 'no terminator'
```

Both are "scanning" combinators — they look for a delimiter across arbitrary text.
The classic hazard is a delimiter that appears **inside a string or a comment**: a
naïve scan for `)` stops at the `)` inside `"a)b"`. To close that hazard, they skip
opaque regions by default — `scanTo` two kinds, `balanced` one:

- **Ambient trivia** *(`scanTo` only)*. Whatever `trivia` the grammar declares
  (whitespace, comments) is skipped during the scan, so a sentinel hidden in a
  comment is never matched. `balanced` deliberately does **not** consult trivia —
  its delimiters are structural, and a bracket is a bracket whether or not a
  comment sits beside it.
- **Ambient `scanSkip`.** Opaque *non-trivia* units — strings, `balanced` brackets —
  declared once at the grammar level:

  ```ts
  const dq = sequence(literal('"'), regex(/[^"\\]|\\./), literal('"'))

  const g = rules({ trivia: ws, scanSkip: [dq] }, g => ({
    // no per-call skip — the ambient `scanSkip` protects the scan
    arg:  scanTo(regex(/[,;)]/)),
    call: balanced('(', ')'),
  }))
  // scanTo/balanced now treat a quoted string as one atomic unit:
  // a `)` or `,` inside "…" never ends the scan or closes the balance.
  ```

  `scanSkip` is the scan-time analogue of `trivia`: declared once on `rules({ … })`
  (or threaded through `parser`/`compose`), inherited by every `scanTo`/`balanced`
  in the grammar. Keep the two categories distinct — `trivia` is *insignificant
  everywhere*; `scanSkip` is *significant but atomic during a scan*.

**Per-call options** (`scanTo(sentinel, opts)` / `balanced(open, close, opts)`):

| Option | Effect |
| --- | --- |
| `skip: [...]` | Extra opaque units for THIS call. **Extends** (does not replace) what the combinator already skips ambiently — trivia + `scanSkip` for `scanTo`, `scanSkip` alone for `balanced`. |
| `raw: true` | Hard opt-out: skip nothing ambiently — the pre-ambient raw byte walk. |
| `orEOF: true` | *(scanTo only)* Reaching end-of-input without the sentinel succeeds, returning everything consumed. |

The sentinel is always checked **before** any skipper, so a sentinel that also
starts a skip region still wins. `balanced` consults ambient `scanSkip` only (not
trivia) — its delimiters are structural.

**Gating:** both have an `any` first-set by nature, so a choice arm leading with
either won't first-char-gate. That is often fine for an error-recovery fallback arm;
if it is intentional, accept that choice in the
[gating snapshot allowlist](./first-char-gating).

## IDE and composition helpers

### `completionsAt`

What tokens could legally come next at a cursor offset.

```ts
// [verify]
import { completionsAt, choice, sequence, literal } from 'parseman'

const g = sequence(literal('@'), choice(literal('media'), literal('supports')))
completionsAt(g, '@media', 1)
// → ['"media"', '"supports"']
```

### `compose` and `composeLeaf`

Fuse independently-compiled grammars into one scope, so a dialect can override a
base grammar's rules. `composeLeaf` is the terminal form — its result cannot be
composed again. See [Composing grammars](../reference/api#composing-grammars).

### `cstBuildHost`

A ready-made `build` host producing the default CST shape, for when you want the
generic tree rather than a hand-written builder. See [CST / AST nodes](./ast).

## Choosing between similar combinators

A few combinators overlap in what they can match. The wrong pick usually still
*works* (the grammar is correct), but silently loses first-char dispatch — the
[gating diagnostic](./first-char-gating) will flag it.

### Recognizing a keyword — `word` vs `literal` vs `regex`

| Use | When | First-set | Gating |
| --- | --- | --- | --- |
| `word('kw', boundary)` | a keyword that must not match inside a longer word (`if` not `ifdef`) | exact | ✅ dispatches |
| `keywords([...], opts)` | one of many keywords (colors, units, at-rules) | exact (union) | ✅ dispatches |
| `literal('kw')` | a fixed token with **no** word-boundary requirement (punctuation, operators) | exact | ✅ dispatches |
| `regex(/kw/)` | **avoid for keywords** — use only for genuine patterns (numbers, identifiers) | often `any` | ⚠️ may not dispatch |

The discriminating case:

```ts
// [verify]
import { word, literal, regex, parse } from 'parseman'

const all = (input: string) => [parse(word('if'), input).ok, parse(literal('if'), input).ok, parse(regex(/if/), input).ok]

// All three match `if` at the start…
all('if x')
// → [true, true, true]

// …but only `word` refuses the keyword inside a longer word.
all('ifdef')
// → [false, true, true]
```

### Repeating — `many` vs `oneOrMore` vs `sepBy` vs `oneOrMoreSep`

| Use | Separator | Empty input |
| --- | --- | --- |
| `many(item)` | none | ✅ succeeds with `[]` (nullable) |
| `oneOrMore(item)` | none | ❌ fails |
| `sepBy(item, sep)` | yes | ✅ succeeds with `[]` (nullable) |
| `oneOrMoreSep(item, sep)` | yes | ❌ fails |

```ts
// [verify]
import { many, oneOrMore, sepBy, oneOrMoreSep, regex, literal, parse } from 'parseman'
import type { Combinator } from 'parseman'

const item = regex(/[a-z]+/)
const comma = literal(',')

// The discriminating case is the EMPTY input — the nullable pair succeed.
const onEmpty = (c: Combinator<unknown>) => parse(c, '').ok

[onEmpty(many(item)), onEmpty(oneOrMore(item)), onEmpty(sepBy(item, comma)), onEmpty(oneOrMoreSep(item, comma))]
// → [true, false, true, false]
```

Pick the non-empty form whenever the list cannot actually be empty: it is
non-nullable, so an arm led by it keeps first-char dispatch.

### Looking ahead — `not` vs `peek`

| Use | Succeeds when | First-set | Position |
| --- | --- | --- | --- |
| `not(X)` | X does **not** match | `any` | trailing only |
| `peek(X)` | X **does** match | X's | leading is fine |

```ts
// [verify]
import { not, peek, literal, parse } from 'parseman'

const at = literal('@')

// Opposite verdicts on the same input…
[parse(not(at), '@x').ok, parse(peek(at), '@x').ok]
// → [false, true]

// …and both consume nothing.
[parse(not(at), 'x').span.end, parse(peek(at), '@x').span.end]
// → [0, 0]
```

### Committing vs looking — `attempt` vs `peek`

| Use | Consumes on success | Rolls back on failure |
| --- | --- | --- |
| `attempt(X)` | yes — X's full match | every framework side effect |
| `peek(X)` | **no** — zero-width | n/a (nothing was committed) |

`attempt` is for an arm you want to *take* atomically; `peek` is for deciding
*whether* to take one. They are not alternatives to each other.

```ts
// [verify]
import { attempt, peek, literal, parse } from 'parseman'

[parse(attempt(literal('ab')), 'abc').span.end, parse(peek(literal('ab')), 'abc').span.end]
// → [2, 0]
```

### Selecting vs asserting on context — gated arm vs `gate()`

| Use | Role | Dispatch |
| --- | --- | --- |
| `choice({ gate, combinator }, …)` | **SELECT** a branch by a cheap state predicate | ✅ preserved (arm keeps its own first-set) |
| `gate(predicate)` inside `sequence` | **ASSERT** a state predicate mid-sequence | ⚠️ poisons dispatch if used as a leading arm term (first-set `any`) |

Both read `ctx.state`. The arm **field** keeps the choice gating; the **combinator**
is a zero-width assertion for use after a concrete leading terminal. See
[Context](./context).

### Mapping vs building — `transform` vs `node`

| Use | Produces | Captures children/trivia |
| --- | --- | --- |
| `transform(c, fn)` | whatever `fn` returns | no |
| `node(c, build?)` | a tree node | yes — terminals, trivia, `field()`s |

```ts
// [verify]
import { transform, node, sequence, literal, regex, parse } from 'parseman'

const inner = () => sequence(regex(/[a-z]+/), literal(':'), regex(/[a-z]+/))

// transform sees the raw tuple…
parse(transform(inner(), v => v.length), 'a:b').value
// → 3

// …node sees CAPTURED children, and can name the node type.
parse(node('Pair', inner(), children => ({ type: 'Pair', n: children.length })), 'a:b').value
// → { type: 'Pair', n: 3 }
```

### Skipping to a delimiter — `scanTo` vs `balanced`

| Use | Matches | Nesting |
| --- | --- | --- |
| `scanTo(sentinel, opts?)` | forward until `sentinel` (sentinel **not** consumed) | flat; pass `skip: [balanced(...)]` to skip nested regions |
| `balanced(open, close, opts?)` | a single balanced region **including** the delimiters | tracks nested `open`/`close` pairs |

```ts
// [verify]
import { scanTo, balanced, literal, parse } from 'parseman'

// The discriminating case is a NESTED delimiter.
parse(scanTo(literal(')')), '(a (b) c)').value
// → '(a (b'
parse(balanced('(', ')'), '(a (b) c)').value
// → '(a (b) c)'
```

## What's next

- Put terms together with automatic whitespace handling in
  [Whitespace & trivia](./trivia).
- Disambiguate keywords and shared prefixes in [Ordered choice & keywords](./keywords).
- Let rules reference each other in [Recursive rules](./recursive-rules).
- Build a typed tree with [CST / AST nodes](./ast).
- Keep every hot `choice` dispatching with [First-char gating](./first-char-gating).
