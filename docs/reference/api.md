# API reference

Every value exported from `parseman`. Types are listed separately in
[Types](./types). Import anything from the package root:

```ts
import { literal, choice, sequence, node, parse /* … */ } from 'parseman'
```

[[toc]]

## Terminals

### `literal(value, opts?)`

Exact string match. `opts.caseInsensitive` compares with a locale-aware `Intl.Collator`.

```ts
literal('const')
literal('SELECT', { caseInsensitive: true })
```

### `regex(pattern, flags?)`

Match a regular expression at the current position. Patterns are compiled to sticky
(`/…/y`) regexes and optimized via `regexp-tree`; the first-set is derived for O(1)
`choice` dispatch.

```ts
regex(/[0-9]+/)
regex(/[a-z]+/i)
```

### `word(str, boundary?, opts?)` · `word(str, opts)`

A single keyword with a trailing word-boundary guard, so `word('if')` won't match the
`if` in `ifdef`. `boundary` is the character class that must *not* follow (default
`_0-9A-Za-z`). `opts` takes the same `caseInsensitive` flag as
[`keywords`](#keywords-words-opts).

```ts
word('if')
word('color', 'A-Za-z-')
word('media', 'A-Za-z0-9_-', { caseInsensitive: true })  // CSS at-keywords
word('true', { caseInsensitive: true })                  // default boundary
```

Case-insensitive matching is ASCII-only, and the first-set is ASCII case-**folded**
(`{m, M}`), so a case-insensitive keyword still first-char-dispatches. Prefer this
over `regex(/media/i)`, which the gating diagnostic flags as `keyword-regex`.

### `keywords(words, opts?)`

Match one of many keywords, longest-first, compiled to a single sticky regex.
`opts.boundary` and `opts.caseInsensitive` apply to the whole set.

```ts
keywords(['GET', 'POST', 'PUT'])
keywords(['media', 'supports'], { boundary: 'A-Za-z0-9_-' })
```

### `makeWord(boundary?)` <Badge type="tip" text="helper" />

Returns a `(str) => Combinator` factory with a fixed boundary class. Equivalent to
`(s) => keywords([s], { boundary })`.

## Composition

### `sequence(...combinators)`

Match all in order; returns a tuple of their values. Skips trivia between terms when
trivia is active.

### `choice(...args)`

Ordered PEG alternatives — first match wins. Arms may be plain combinators or
[gated arms](#gated-arms). When every arm's first-set is disjoint and non-nullable, the
choice compiles to an O(1) first-char dispatch — gated arms included, so gating a
rare-token alternative (like `&`) stays O(1) rather than dropping the whole choice to a
linear scan. (A nullable or overlapping arm forces the linear path.)

### `attempt(combinator)`

Make one ordered-choice arm transactional. If its parser fails after consuming
input, Parseman restores its structural capture, trivia, field, and recovery
diagnostic sinks before returning a zero-width failure at the attempt entry.
The inner expectation is preserved, so diagnostics still name the token that
actually failed. `attempt()` does not clone or roll back `ctx.state`.

```ts
const value = choice(
  attempt(sequence(literal('a'), literal('b'))),
  literal('a'),
)
// `a` selects the fallback; no partial `a` capture leaks from the first arm.
```

### `many(c, opts?)` · `oneOrMore(c, opts?)` · `sepBy(c, sep, opts?)` · `oneOrMoreSep(c, sep, opts?)` · `optional(c)`

Repetition and optionality. The named combinators are sugar for the common option
combinations — `oneOrMore(x)` **is** `many(x, { min: 1 })`, and `oneOrMoreSep(i, s)`
**is** `sepBy(i, s, { min: 1 })`.

| | nullable (min 0) | non-empty (min 1) |
|---|---|---|
| plain | `many` | `oneOrMore` |
| separated | `sepBy` | `oneOrMoreSep` |

- `min` / `max` count **items**, not separators. Defaults: `min: 0`, `max` unbounded.
- `trailing: 'forbid' | 'allow'` (separated forms only, default `'forbid'`) decides
  what happens to a separator with no item after it: leave it for the enclosing rule,
  or consume it. A list that *requires* a separator after every item is not a
  separated list — it has n separators for n items, not n-1 — so spell that one
  `many(sequence(item, term))`.
- `optional(c)` returns `null` on no match and takes no options.

```ts
many(decl)                                  // zero or more
many(hexDigit, { min: 3, max: 8 })
oneOrMoreSep(selector, literal(','))        // a selector list is never empty
sepBy(decl, literal(';'), { trailing: 'allow' })
```

::: warning Nullability is a gating property
Plain `sepBy` is `(item (sep item)*)?` — it **matches the empty string**. A nullable
arm matches at every position, so it disables its `choice`'s first-char dispatch. Use
`oneOrMoreSep` (or `{ min: 1 }`) for any list that cannot actually be empty. Same for
`many` vs `oneOrMore`. `max` never affects nullability.
:::

### `transform(combinator, fn)`

Map a successful value (and span) through `fn(value, span)`. For plain value-mapping only;
use [`node`](#node-type-combinator-build-opts) for tree building.

### `skip(main, skipped)`

Match `main` then `skipped`; return `main`'s value, with the span extended across both.

### `token(combinator)`

Run `combinator` with active trivia cleared and return the matched source text as a
single token. Inside a `node()`, the wrapped parser contributes one CST leaf for the full
span instead of exposing its internal terminal leaves.

```ts
token(sequence(literal('!'), regex(/important/i)))
```

The compiler may lower safe nullable terminal runs inside `token()` — `many`,
`optional`, and `sepBy` forms whose pieces are literals/regexes — to one regex while
preserving the one-token value/CST shape. Use it for source-text regions that should be
semantically opaque; keep ordinary combinators when builders need the internal leaves.

### `leaf(combinator, reducer)`

Treat a structural grammar as one semantic leaf. `reducer(value, span)` chooses the
value exposed to the parent and, inside `node()`, Parseman captures exactly one CST
leaf with that value and the complete matched span. Unlike `token()`, `leaf()` does
not alter trivia; make the structural grammar's local spacing explicit with
`noTrivia()` or `parser({ trivia })`.

```ts
const operator = leaf(
  noTrivia(sequence(optional(gap), choice(literal('*'), literal('/')), optional(gap))),
  parts => parts[1],
)
```

This is useful when a parent reducer needs a flat terminal (here `'*'` or `'/'`)
but the language accepts structured comments or spacing around it. Static `leaf()`
calls macro-compile and retain the inner grammar's normal coverage and trace IDs.

### `not(combinator)` · `peek(combinator)`

The two lookaheads. Both are zero-width — they assert and consume nothing.

- `not(c)` — **negative** (PEG `!c`). Succeeds when `c` does *not* match.
- `peek(c)` — **positive** (PEG `&c`). Succeeds when `c` *does* match.

```ts
sequence(literal('true'), not(regex(/\w/)))   // keyword boundary
sequence(peek(regex(/[.#]/)), mixinCall)      // "only try this on . or #"
```

`not()`'s first-set is `any` (it cannot know what it forbids), so keep it as a
**trailing** boundary — leading an arm with it poisons the choice's dispatch.
`peek()` is the opposite: it carries its body's first-set, so a **leading** `peek()`
narrows the arm's first chars and keeps dispatch. That is why `peek(X)` exists rather
than `not(not(X))`, which the gating diagnostic flags as `double-not`. (A nullable
body constrains no first character, so `peek()` reports `any` in that case.)

### `label(name, combinator)`

Attach a metadata label (used for per-chunk trivia kinds; see
[Whitespace & trivia](../guide/trivia#capturing-trivia-kinds)). Parse behavior is
unchanged.

### `field(name, combinator)`

Capture the wrapped parser's value and span for the nearest enclosing `node()` build
callback. Parse behavior and the normal returned value are unchanged.

```ts
const AttributeSelector = node(sequence(
  literal('['),
  field('name', ident),
  field('op', attrOp),
  field('value', ident),
  literal(']'),
), (_children, fields) => fields)
```

`fields.name` is `{ value, span }`; repeated field names become arrays. Field capture is
emitted only for node subtrees containing `field()` and only when the callback/host can
read fields.

## Recursion

### `rules(factory)` / `rules(options, factory)` <Badge type="tip" text="helper" />

Named, mutually-recursive rule bundle. The factory receives a proxy of all rule names and
returns the definitions. See [Recursive rules](../guide/recursive-rules).

Options-first form `rules({ trivia, scanSkip }, factory)` sets grammar-wide defaults:
`trivia` — ambient filler skipped between terms; `scanSkip` — ambient opaque units
(strings/brackets) that `scanTo`/`balanced` treat as atomic while scanning. Both are
inherited by every rule. See [Whitespace & trivia](../guide/trivia).

### `ref<T>()`

Low-level forward-declaration slot. `ref()` returns a combinator with a `.define(p)`
method. Prefer `rules()`.

### `composeLeaf([...recognition, localRules])` <Badge type="warning" text="macro only" />

Fuse imported, explicitly recognition-only grammar pieces with one final local
`rules()` map. Use this when shared syntax must stay reusable, while the final
dialect owns direct AST construction. The macro emits one parser with the local
builders inlined; Parseman does not create a runtime composition or builder-host
fallback.

```ts
import { composeLeaf, node, rules } from 'parseman' with { type: 'macro' }
import { cssRecognition } from './css-recognition.js'

export const grammar = composeLeaf([
  cssRecognition,
  rules(g => ({
    Stylesheet: node('Stylesheet', g.Document, children => ({ type: 'Stylesheet', children })),
  })),
])
```

Every item before the final local map must prove recognition-only. `composeLeaf`
is terminal: it cannot be fed into another `compose()`/`composeLeaf()` call. It
is publicly exported so macro source can import it, but an unlowered runtime
call throws rather than silently changing construction semantics.

## Trees

### `node(combinator, build?, opts?)`
### `node(type, combinator, build?, opts?)`

CST/AST rule. Captures the combinator's terminals into `children` / `rawChildren` and trivia
into `triviaLog`. With a `build` callback it calls `build(children, fields, span,
rawChildren, triviaLog, state)` to construct the node; **omit `build`** to make it a *structural* node
that builds through the injected [`ctx.build`](#cstbuildhost) host instead — so one grammar
serves its own AST (host unset) and a positioned CST / language-service tree (host set).
Inside [`rules()`](#rulesfactory), `node(combinator, ...)` infers its node type from the
containing rule key. Use `node(type, combinator, ...)` for an explicit public type or for
local/manual nodes outside `rules()`.

`opts.unwrap` skips `build` for one-child AST/value matches and returns the single child
in value form: a captured leaf becomes its string value; a sub-node is returned as-is.
`opts.collapse` also skips `build` for one-child matches, but returns the captured child
exactly, so a leaf remains a `CSTLeaf` with its span. Set at most one of `unwrap` and
`collapse`. `opts.captureTrivia` makes this node the explicit owner of its per-node trivia
log; `parser({ captureTrivia: true })` merely activates recording for a grammar scope, and
plain combinators own no log. A direct build that declares the fifth `triviaLog` parameter
keeps the established arity-based capture behavior. See [CST / AST nodes](../guide/ast).
`opts.trailingTrivia` is a document-boundary opt-in: after a successful node body it commits
the active trivia once into that node's log (and therefore forces this node's trivia capture).
Use it for a repeating document root at EOF, not for blocks with a closing delimiter; their
ordinary following `}` already owns the preceding trivia.

### `cstBuildHost(opts?)` {#cstbuildhost}

Generic CST host for structural `node()` grammars. Pass the default host directly:

```ts
run(rule, input, { build: cstBuildHost })
```

or create a configured host:

```ts
run(rule, input, { build: cstBuildHost({ collapse: ['SelectorList'] }) })
```

The default host returns uniform positioned CST nodes:
`{ _tag: 'node', type, span, state, children }`, with terminals as `CSTLeaf` objects.
`cstBuildHost({ collapse })` removes transparent one-child wrappers while the CST is being
built, so public syntax trees do not need a second normalization walk.

`collapse` accepts:

- `true` — collapse any one-child wrapper whose raw child list also has one item.
- `readonly string[]` — collapse only those named grammar node types.
- `CstCollapsePredicate` — decide from `(type, child, children, rawChildren)`.

Like `node(..., { collapse: true })`, CST host collapse preserves the child object exactly.
The difference is scope: `node(..., { collapse: true })` is a grammar-local rule decision,
while `cstBuildHost({ collapse })` is a caller-selected public CST policy.

### `buildTriviaIndex(root, input?, opts?)` {#buildtriviaindex}

Walk a CST and build `before` / `after` maps of trivia tokens keyed by node — turning the
flat `triviaLog` into a lookup table for whitespace-sensitive analysis.

### `triviaEntries(log, labels?, opts?)`

An indexed, allocation-free view over a flat trivia log: `.start(i)`, `.end(i)`,
`.insertIndex(i)` (per-node logs only), `.kind(i)`, `.text(i, input)`. Pass `{ nodeLog: true }`
for per-node logs (stride 3/4).

## Tree traversal

The tree a grammar produces is plain objects, so you can recurse it yourself — these two
helpers save writing the same traversal. Both default to the CST shape ([`CSTChild`](./types#cst-types))
and accept a generic for custom AST shapes. See [Walking the tree](../guide/ast#walking-the-tree).

### `walk(root, visitor, ctx?)`

Depth-first traversal. Calls `visitor.enter(node, parent, ctx)` before a node's children and
`visitor.leave(node, parent, ctx)` after. Return `false` from `enter` to skip that node's
subtree (`leave` still runs). `ctx` is threaded to both hooks unchanged (use it as an
accumulator). Override the node type with `walk<MyNode>(root, …)`.

```ts
const leaves: string[] = []
walk(tree, {
  enter(node) {
    if (node._tag === 'leaf') leaves.push(node.value)
  },
})
```

### `createVisitor(handlers)`

Build a visitor that dispatches on each node's `type` — the runtime analog of a generated
CST-visitor base class. Handlers are keyed by rule name and receive an
[`api`](./types#walk-types) with `visit` / `visitChildren` to recurse; a node whose `type`
has no handler falls through to its children,
so partial visitors work. Override the return and node types with
`createVisitor<R, MyNode>({ … })`.

```ts
const evalExpr = createVisitor<number>({
  Num: (n) => Number((n.children[0] as CSTLeaf).value),
  Add: (n, api) => api.visitChildren(n).reduce((a, b) => a + b, 0),
})

const total = evalExpr(tree)
```

## Whitespace

### `trivia(combinator)` <Badge type="tip" text="helper" />

Mark a combinator as skippable filler (sets `isTrivia`). Does not skip until installed via
`parser({ trivia })`.

### `parser(opts, root)` <Badge type="tip" text="helper" />

Wrap a root combinator with document-level options — `trivia`, `trackLines`,
`captureTrivia` — and add a `.parse(input)` convenience method.

### `noTrivia(root)` <Badge type="tip" text="helper" />

Shorthand for `parser({ trivia: null }, root)` — run `root` with active trivia cleared, so
its terms must be contiguous.

## Running a parse

### `parse(combinator, input, opts?)`

Run a combinator against `input` from offset 0. Returns a [`ParseResult`](./types#parseresult).

```ts
parse(myParser, 'hello world', { trackLines: true, recover: true })
```

`ParseOptions`:

| Option | Default | Effect |
| --- | --- | --- |
| `trackLines` | `false` | Populate `startLine`/`startColumn`/`endLine`/`endColumn` on spans |
| `recover` | `false` | Collect recovered errors into `result.errors` and record `result.furthestFail` |

#### Line / column tracking

```ts
const r = parse(myParser, 'hello\nworld', { trackLines: true })

if (r.ok) {
  r.span.startLine   // 1
  r.span.startColumn // 1
  r.span.endLine     // 2
  r.span.endColumn   // 6
}
```

Line lookup is O(log n) via binary search on a newline index built once per input string.
When `trackLines` is false (the default), no index is built and spans carry only byte
offsets.

### `run(entry, input, opts?)`

Run a grammar **entry** — a rule function from a `compose()` / `compile()` map, or an
interpreter combinator — against `input`, threading the standard ctx (trivia log,
`recover`/`expect` errors, the `ctx.build` host, grammar state) so a tool doesn't hand-build
it or branch on function-vs-combinator. Returns a [`RunResult`](./types#runresult):
`{ ok, value, span, expected, errors, triviaLog, unconsumedFrom }`. Pass `opts.build` for a
[CST host](#cstbuildhost), `opts.state` for initial grammar state, and `opts.trivia`
(the grammar's trivia rule) to skip trailing whitespace/comments before reporting
`unconsumedFrom` — so the dialect's own trivia decides what counts as leftover input.

```ts
const g = compose([base])
run(g.Value, '12  ', { trivia: g.rw })  // { ok: true, …, unconsumedFrom: null }
run(g.Value, '12 x', { trivia: g.rw })  // unconsumedFrom → offset of 'x'
```

## Compilation

### `compile(combinator, mapFnSources?)`

JIT-compile a combinator tree to an optimized JS function at runtime. Returns a
[`CompiledParser`](./types#compiledparser) exposing `.parse()`, `.parseWithContext()`,
`.parseWithErrors()`, plus the generated `.source` and `.inlineExpression` strings.
Requires `new Function` (won't run under a strict CSP). See
[The three modes](../guide/modes#compile-runtime-jit).

## Spec generation

Generate a formal grammar spec (EBNF + railroad diagrams) from a `rules()` grammar. Imported
from the `parseman/spec` subpath. See [Grammar spec generation](../guide/spec-generation).

### `toEBNF(grammar, options?)`

Render W3C-style EBNF text — one production per named rule. `grammar` is a `rules()` record
(or a single combinator). Options: `sort` (`'source'` — declaration order, default — or
`'reachable'` — top-down from the entry rule), `root`, `order`, `includeTrivia`, `terminals`,
`regexDisplay`.

### `toRailroadHtml(grammar, options?)`

Render a self-contained HTML page of SVG railroad diagrams, one per production. Accepts every
`toEBNF` option plus `title` and `showEbnf`. No external dependencies — the diagram library
(tabatkins/railroad-diagrams, CC0) and CSS are inlined.

### `buildSpecModel(grammar, options?)`

Return the notation-agnostic model (`{ productions: { name, expr }[] }`) that `toEBNF` and
`toRailroadHtml` consume — walk it to emit a custom notation. `renderEBNF` / `renderExpr` are
also exported for rendering a model or a single `SpecNode`.

## Composing grammars

Fuse grammars into one parser, with override, à la carte selection, and no base-grammar
source required. See [Extending grammars](../guide/extending).

### `compose(items)`

`compose([base, ext, …])` fuses grammars/artifacts into one runnable map of parse
functions. Later entries **override** earlier ones by rule name, and because fusion
re-binds every rule reference in one shared scope, an override reroutes the base's *own*
calls too (open recursion). Each item is a grammar (a `rules()` result) or an
already-compiled artifact.

- **With the macro (build time):** `compose([...])` is fused into **static source** — a
  plain closure of direct calls. **No `new Function`, no eval** in the emitted code.
- **Without the macro (runtime):** `compose([...])` fuses when it runs, via `new Function`
  — the same JIT `compile()` uses (so, like `compile()`, it needs `'unsafe-eval'` under a
  strict CSP). Parsing is never eval; only the one-time fuse is.

## Error recovery

### Tolerant lists (`run(entry, input, { tolerant: true })`)

Activates list recovery. With `tolerant` set, `many` / `oneOrMore` / `sepBy` recover from a
failed element — skip to a sync point, emit a [`ParseError`](./types#parseerror) over the
skipped span (collected in `errors`), and keep parsing the list — instead of stopping at
the first bad element. The sync point is **inferred from grammar structure** (a `sepBy`'s
separator; a list's enclosing `sequence(open, …, close)` delimiter) — the grammar carries
**no** recovery annotation. Omit `tolerant` for the strict "one clean error and stop"
behavior, byte-identical to a parser with no recovery. See
[Tolerant lists](../guide/error-recovery#tolerant-lists).

```ts
const block = sequence(literal('{'), sepBy(decl, literal(';')), literal('}'))
run(block, '{a:1;$$;b:2}', { tolerant: true }) // list → [decl, ParseError, decl]
```

Recovery is a *policy* the caller turns on, not a fact baked into the grammar. To override
the inferred sync point for a rule, or add semantic completions/diagnostics, wrap the
grammar in [`languageService`](../guide/editor-integration) — the config is keyed by rule
name and the grammar file stays untouched. The compiled/macro fast path recovers too, when
compiled with `{ recovery: true }`.

### `expect(combinator, label?)`

Required token. On failure, record a zero-width `ParseError` and recover in place.
`label` overrides the derived `expected` message. See
[Error recovery](../guide/error-recovery#expect-required-tokens).

### `isParseError(value)`

Type guard: `value is ParseError` (`_tag === 'parseError'`).

### `scanTo(sentinel, opts?)`

Consume text up to (not including) `sentinel`; return it. Skips the grammar's ambient
`trivia` **and** `scanSkip` opaque units (strings/brackets) by default, so a sentinel
hidden in a string or comment is never matched. `opts.skip` declares EXTRA opaque
regions for this call (extends the ambient set); `opts.raw` opts out of all ambient
skipping (raw byte walk); `opts.orEOF` makes EOF a success.

### `balanced(open, close, opts?)`

Match one balanced delimited region — **string** delimiters — including the delimiters,
counting nested same-type pairs. Skips the grammar's ambient `scanSkip` opaque units in
its interior, so a delimiter hidden inside a string doesn't close the balance early.
`opts.skip` declares EXTRA regions (extends the ambient set); `opts.raw` opts out.

Declare the ambient set once with `rules({ scanSkip: [...] }, factory)` (see
[Whitespace & trivia](/guide/trivia#grammar-level-scanskip-opaque-units-for-scans)).

## Context

### `gate(predicate)`

Zero-width success only when `predicate(ctx.state)` is true. The name matches the `gate:`
field on a gated `choice` arm: the arm field SELECTS a branch, the combinator ASSERTS
mid-sequence. `guard` is a deprecated alias (`guard === gate`).

### `guard(predicate)` <Badge type="warning" text="deprecated" />

Alias of `gate(predicate)` (documented just above). Prefer `gate()`.

### `withCtx(extra, combinator)`

Run `combinator` with `extra` merged into `ctx.state`, restored on exit.

### `analyzeGating(entry, opts?)` → `GatingReport`

Static first-char gating diagnostic over a combinator tree. For every reachable `choice`
reports a stable `id`, whether it gates (`yes` / `recoverable` / `no`), the offending arm
and cause for ungated ones, and API anti-patterns (`not(not(...))`, keyword `regex`).
`opts.accept` is the snapshot allowlist — choice `id`s that are intentionally ungated: those
move to `report.accepted` (their UNGATED-gating finding is suppressed — anti-pattern lints on
the same choice still fire), the rest stay in `report.ungated` (warned + gate-failing), and
`report.acceptedUnused` flags stale entries. This allowlist is the SINGLE per-choice suppression
mechanism for gating findings (there is no `cold()` marker). `compile()` runs the diagnostic by
default and warns on genuinely-ungated hot choices; see
[First-char gating](../guide/first-char-gating). `formatGatingWarnings(report)` renders the
findings as printable lines.

`report.deferred` holds choices whose verdict is not this artifact's to make: every `any`
arm is an unresolved NAMED cross-artifact hole (`g.Value` in a
[shared shape](../guide/extending#shared-shapes-one-shape-many-bindings)). They are silent and do not fail the
`'error'` gate — the question is re-asked, with the hole bound, when the shape is
`compose()`d. See
[Shared shapes and the fuse](../guide/first-char-gating#shared-shapes-the-verdict-belongs-to-the-fuse).

## IDE support

### `completionsAt(target, input, offset, options?)`

Return the set of expected tokens at a cursor `offset` — the raw material for
autocomplete. Probes the grammar at that position via a truncated parse.

- `target` — an interpreter combinator **or** a `compile(g, { recovery: true })`
  grammar. A recovery-compiled grammar records the furthest-failure probe on its
  fast path, so completions work on the **published compiled artifact** — no
  separate interpreter needed.
- `options.tolerant` — when `true`, list recovery keeps parsing past a bad element
  before the cursor, so completions are returned even when a permissive top rule
  would otherwise "succeed" with an unconsumed tail. Default `false`.

For semantic completions (mapping these structural labels to domain suggestions),
use [`languageService`](../guide/editor-integration) rather than calling this directly.

## Incremental re-parsing

### `parseDoc(registry, rootRule, input, opts?)`

::: warning Experimental
Incremental re-parsing is **experimental** and its API may still change. Pin your version.
:::

Wrap a parse in an immutable document that re-parses incrementally via `.edit(from, to,
replacement)`. `registry` is the object `rules()` returns. See
[Incremental re-parsing](../guide/incremental).

## Line index (low-level)

Usually you just pass `trackLines: true` to `parse`. These are the primitives behind it:

### `buildLineIndex(input)`

Precompute newline offsets → a `LineIndex` for O(log n) lookups.

### `offsetToLineCol(index, offset)`

Map a byte offset to `{ line, col }` (1-based).

### `annotateSpan(span, index)`

Return a copy of `span` with `startLine`/`startColumn`/`endLine`/`endColumn` filled in.

## Gated arms

`choice` accepts `{ gate, combinator }` objects in place of a bare combinator; the arm is
only attempted when `gate(ctx.state)` returns true. See
[Ordered choice & keywords](../guide/keywords#gated-alternatives).

When **every** arm's first-set is non-nullable and pairwise-disjoint, a gated arm keeps the
choice's O(1) first-char dispatch — the gate is evaluated only when the input sits at that
arm's first character. On this dispatch path, a gate that returns false **fails the choice**
right there; it does **not** fall through to a later arm, because disjoint first-sets mean
no other arm could match that character. If any arm is nullable or first-sets overlap, the
choice uses the linear first-match scan instead — and there a false gate *does* skip to
the next arm.
