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

### `makeWord(boundary?, opts?)` · `makeWord(opts)` <Badge type="tip" text="helper" />

Returns a `(str) => Combinator` factory with a fixed boundary class and keyword
options. Equivalent to `(s) => keywords([s], { boundary, ...opts })`.

```ts
const kw = makeWord()
const cssKw = makeWord('A-Za-z0-9_-', { caseInsensitive: true })
const caseless = makeWord({ caseInsensitive: true })
```

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

Use `choice(...)` for literal-to-literal alternatives and other branches whose first
sets are naturally disjoint. Those are already the compiler's fast path.

When several arms first parse the same broad token family and then branch by the
string that token returned, use [`dispatch`](#dispatchcombinator-when-otherwise)
instead. It avoids backtracking through the same opener shape and makes the
shared lexical decision explicit.

### `dispatch(combinator, when(...), otherwise(...))`

Parse the combinator once, look at the string it returned, then choose what
comes next. Use this when one broad token is valid generally, but selected
values have specialized continuation grammars: command names, contextual
keywords, name-or-call openers, at-keywords, pseudo heads, and similar families.
`when(key, tail, opts?)` matches one key; `when([keyA, keyB], tail, opts?)`
shares a tail across keys. Matcher keys such as `startsWith(prefix)`,
`endsWith(suffix)`, and `matches(pattern)` test the returned string instead of
parsing input again. `otherwise(tail)` handles values that no earlier arm
matched. `opts.caseInsensitive` folds ASCII case for comparison only; the parse
value stays authored. Use [`routed()`](#routed) inside a selected branch when
that branch's node should own the already-consumed head value/span.

This is the preferred shape when branches share a broad opener and then diverge by
the opener's value or by the next structural marker. A hand-written `choice(...)`
can recognize the same language, but late and generic arms recheck the shared
opener. `dispatch` makes the lexical decision once and leaves the branch table to
the grammar.

This is not a blanket replacement for `choice(...)`: if the arms are exact literals,
first-set-disjoint, a closed set with no broad generic fallback, or first-arm-dominant
with cheap rejected tails, `choice(...)` is already simple and fast.

```ts
const command = regex(/[A-Za-z_][A-Za-z0-9_]*/)

const statement = dispatch(
  command,
  when('set', setTail),
  when(['print', 'trace'], oneArgumentTail),
  otherwise(extensionCommandTail),
)

const commandCase = makeWhen({ caseInsensitive: true })
const commandTable = dispatch(
  command,
  commandCase('set', setTail),
  commandCase('print', oneArgumentTail),
  otherwise(extensionCommandTail),
)
```

Name-or-call positions use the same idea. One combinator consumes either the bare
name or the source-shaped glued call opener:

```ts
const callCase = makeWhen({ caseInsensitive: true })
const nameOrCallOpen = token(sequence(name, optional(literal('('))))

const Term = dispatch(
  nameOrCallOpen,
  callCase('include(', includeTail),
  callCase('env(', environmentTail),
  when(endsWith('('), genericCallTail),
  otherwise(nameTail),
)
```

Here `INCLUDE(` routes to the `include(` arm and remains `INCLUDE(` in the
returned tuple. `include` without `(` routes to the name tail without first trying
a call parser. `include (` does not produce a glued opener and can parse as a name
followed by a paren only in contexts that allow that shape.

The routing head can include the structural marker that decides the branch. For
example, a parenthesized feature can route `name >=` differently from `name:`:

```ts
const featureHead = token(sequence(
  literal('('),
  name,
  regex(/[ \t]*/),
  regex(/>=|<=|[><=:]/),
))

const Feature = dispatch(
  featureHead,
  when(matches(/(?:>=|<=|>|<|=)$/), rangeFeatureTail),
  when(matches(/:$/), declarationFeatureTail),
)
```

The same pattern is useful in real CSS-family grammars for at-rules, function
values, media features, and pseudo selectors, but the mechanism is not tied to
CSS: it is simply "read the shared head once, then choose the continuation that
owns it."

If the combinator fails, `dispatch` fails normally and an enclosing
`choice()` may try a later arm. If a key matches and its tail fails, the failure
is committed: `otherwise(...)` and outer fallback arms are not tried. Duplicate
keys are rejected at grammar construction time.

The case strings are exact full returned values, not prefixes and not terminals
parsed after the combinator. Matchers operate on the returned string; the
combinator owns trivia policy. Put generic matcher continuations before
`otherwise(...)`.

Use `routed()` inside a branch when the value consumed by `dispatch` belongs to
that branch node:

```ts
const Call = node('Call',
  sequence(routed(), argumentsTail, literal(')')),
  children => ({
    type: 'Call',
    name: children[0].value.slice(0, -1),
    args: children[1],
  }),
)

const Name = node('Name',
  routed(),
  children => ({ type: 'Name', name: children[0].value }),
)

const Value = dispatch(
  nameOrCallOpen,
  when(endsWith('('), Call),
  otherwise(Name),
)
```

`dispatch` still consumes the first combinator once. Branches that use
`routed()` start from the original dispatch position, and `routed()` places the
already-consumed value/span there. Branches without `routed()` start after the
first combinator, which is the right shape for tail-only continuations. This
keeps lexical routing, fallback behavior, and CST/AST ownership in the grammar
expression.

Coverage and trace treat each `when(...)`, matcher, and `otherwise(...)` arm as
its own dispatch arm. Excluded arms are not attempted or backtracked in the
trace; the selected route emits attempt/selected/success, or attempt/failure if
its committed tail fails. Grammar specs and railroad diagrams render the
language shape and elide `routed()` itself.

### `makeWhen(opts?)`

Return a `(key, tail) => when(key, tail, opts)` factory for dispatch tables with
shared arm options.

```ts
const keywordCase = makeWhen({ caseInsensitive: true })

dispatch(
  keyword,
  keywordCase('only', onlyTail),
  keywordCase('not', notTail),
  otherwise(genericTail),
)
```

Dispatch arms can be named like other local grammar pieces:

```ts
const set = when('set', setTail)
const generic = otherwise(genericTail)
return { Statement: dispatch(command, set, generic) }
```

Macro lowering expects explicit arm arguments.

### `attempt(combinator)`

Make a composite parser transactional. If its parser fails after consuming input,
Parseman restores its structural capture, trivia, field, and recovery diagnostic
sinks before returning a zero-width failure at the attempt entry. The inner
expectation is preserved, so diagnostics still name the token that actually
failed. `attempt()` does not clone or roll back `ctx.state`.

Ordinary `choice`, `many`, `optional`, and `sepBy` already roll back their own
rejected speculative paths. Use `attempt()` when you want to expose a larger
parser as one all-or-nothing unit, or when custom composition should not let
callers observe partial progress.

The user-visible capability other combinators do not provide is failure
re-anchoring for a composite parser: the failure reports at the composite's entry
while preserving the inner `expected` token.

```ts
const value = sequence(literal('x'), attempt(sequence(literal('a'), literal('b'))))
// On input `xa`, failure is reported at offset 1 with expected `'"b"'`.
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

Options-first form `rules({ trivia, scanSkip, trackLines, hostMode }, factory)` sets
grammar-wide defaults: `trivia` — ambient filler skipped between terms; `scanSkip` —
ambient opaque units (strings/brackets) that `scanTo`/`balanced` treat as atomic while
scanning; `trackLines` — populate line/column fields on spans produced by this grammar.
These are inherited by every rule. See [Whitespace & trivia](../guide/trivia) and
[Line/column spans](../guide/ast#linecolumn-spans).

`hostMode: 'ast' | 'cst'` (default `'ast'`) is the compile-time host mode — the same
option `compile(g, { hostMode })` and `compose(items, { hostMode })` take. `'ast'` emits
each direct builder's own result and no positioned-CST branch; `'cst'` builds every node
through the `ctx.build` host and captures unconditionally.

Declaring it here is what lets **one grammar source serve both consumers** under the
macro, which has no other way to receive a compile option:

```ts
const factory = (g) => ({ /* … the whole grammar, written once … */ })

export const grammar    = rules({ trivia: rw }, factory)
export const lines      = rules({ trivia: rw, trackLines: true }, factory)
export const cstGrammar = rules({ trivia: rw, trackLines: true, hostMode: 'cst' }, factory)
```

Three call sites over one shared factory (a factory may be passed by name, as here). The
macro emits independent top-level artifacts, so each bundle tree-shakes away the one
it does not import — your compiler ships the AST image, your language service ships the
CST image, and neither pays the other's cost.

This is deliberately two compilations rather than one switchable artifact. `hostMode`
does not only choose a build expression; it decides what each node CAPTURES. A per-parse
choice would keep every collector live on both paths, so an AST parse would pay CST
capture cost it can never use.

An artifact and its host must agree, and a mismatch throws once per parse rather than
producing a degraded tree — an `'ast'` artifact given a positioned-CST host would
otherwise hand back its own AST objects where a CST was asked for, and a CST child filter
would silently drop them.

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
`collapse`.

`opts.project` returns one captured semantic child by index while preserving the complete
node frame for positioned-CST hosts. It is for punctuation wrappers and similar rules where
the AST value is a fixed child, but tools still need the full CST:

```ts
const Paren = node('Paren',
  sequence(literal('('), Expr, literal(')')),
  { project: 1 },
)
```

In AST mode, `Paren` returns child `1`. A projected leaf is unwrapped to its string value;
a projected sub-node is returned as-is. In `hostMode: 'cst'`, the same rule builds through
the CST host with all children, raw children, spans, fields, and trivia intact. `project`
cannot be combined with `build`, `unwrap`, or `collapse`; use a normal `build` callback for
dynamic selection, filtering, or reconstructing values from several tokens.

`opts.captureTrivia` makes this node the explicit owner of its per-node trivia log;
`parser({ captureTrivia: true })` merely activates recording for a grammar scope, and
plain combinators own no log. A direct build that declares the fifth `triviaLog` parameter
keeps the established arity-based capture behavior. See [CST / AST nodes](../guide/ast).
`opts.trailingTrivia` is a document-boundary opt-in: after a successful node body it commits
the active trivia once into that node's log (and therefore forces this node's trivia capture).
Use it for a repeating document root at EOF, not for blocks with a closing delimiter; their
ordinary following `}` already owns the preceding trivia.

`opts.tags` declares CST categories for this node type. Tags are grammar metadata used by
[`createVisitor(grammar, spec)`](#createvisitorgrammar-spec). They are not copied onto
every CST node by default; pass `cstBuildHost({ tags: true })` when you want the produced
CST nodes to carry the same static tag array:

```ts
const AtRuleWithBlock = node('AtRuleWithBlock', body, { tags: ['AtRule', 'Statement'] })

run(AtRuleWithBlock, input, { build: cstBuildHost({ tags: true }) })
// => { _tag: 'node', type: 'AtRuleWithBlock', tags: ['AtRule', 'Statement'], ... }
```

Use tags for categories that cut across concrete node types. For example,
`AtRuleWithBlock` and `AtRuleStatement` can both carry `AtRule`, while declarations and
at-rules can all carry `Statement`. Tags do not replace the node `type`; they are additional
visitor keys.

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
`cstBuildHost({ tags: true })` materializes `node(..., { tags })` metadata as a `tags`
property on tagged CST nodes. The default leaves tags in grammar reflection only, so untagged
and tag-unaware CST builds keep the lean node shape.

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

### `buildRootTriviaIndex(rows, select)`

Build the same sparse root trivia-gap view that `run()` exposes as
`result.rootTrivia.index`. Each row is
`[ownedRangeStart, ownedRangeEnd, markerStart, markerEnd, selectedLabelIndex]`.
The view is lazy: maps are built on first lookup and values are entry indices into
`view.entries` rather than materialized strings.

Use `view.entryIndicesBefore(offset)` for trivia ending at a following token/node start, and
`view.entryIndicesAfter(offset)` for trivia starting at a preceding token/node end.
Use `view.gapBefore(offset)` / `view.gapAfter(offset)` when you want the grouped gap object
itself, and `view.gapsWithKind(kind)` when a serializer or AST integration needs every
source-ordered gap containing a labeled trivia kind such as `blockComment`.

### `triviaEntries(log, labels?, opts?)`

An indexed, allocation-free view over a flat trivia log: `.start(i)`, `.end(i)`,
`.insertIndex(i)` (per-node logs only), `.kind(i)`, `.text(i, input)`. Pass `{ nodeLog: true }`
for per-node logs (stride 3/4).

### `triviaKindMask(labels, keep)`

Build the bitmask used by `run(entry, input, { triviaCaptureMask })` and
`parser({ captureTriviaKinds })` to restrict per-node CST trivia capture to selected
labeled trivia kinds. Unknown names are ignored; without a label table the helper returns
`undefined`, which preserves the default "capture every kind" behavior.

## Tree traversal

The tree a grammar produces is plain objects, so you can recurse it yourself. For
typed CST traversal, use `createVisitor(grammar, spec)`. The grammar may be an
interpreted `rules()` result or a compiled/macro/`compose()` grammar; Parseman reads
the same reflection metadata either way. See [Walking the tree](../guide/ast#walking-the-tree).

### `createVisitor(grammar, spec)`

Build a depth-first visitor for a grammar. `type` handlers are keyed by concrete CST node
type; `tag` handlers are keyed by tags declared on `node(..., { tags })`. `enter` runs
before handlers and children; `leave` runs after children. Return `false` from `enter` to
skip a node's children.

```ts
const visit = createVisitor(grammar, {
  type: {
    AtRuleWithBlock(node) {},
    Declaration(node) {},
  },
  tag: {
    AtRule(node) {},
    Statement(node) {},
  },
  enter(node) {},
  leave(node) {},
})

visit(tree)
```

Handler order for each node is:

1. `enter(node, parent, ctx)`
2. matching `type[node.type]`
3. matching `tag[...]` handlers in the node type's declared tag order
4. child traversal, unless `enter` returned `false`
5. `leave(node, parent, ctx)`

A node with several tags may therefore run several tag handlers. The visitor gets those tags
from grammar reflection, so CST nodes do not need a `tags` property. Use
[`cstBuildHost({ tags: true })`](#cstbuildhost) only when a consumer wants tags physically
present on each produced CST node.

`createVisitor` is grammar-aware, not CST-host-specific. The same call accepts:

- an interpreted `rules()` registry;
- a macro-compiled `rules()` artifact;
- a normal compiled rule map;
- a `compose()` result whose reflection was merged from its winning rules.

TypeScript checks `type` handler keys against node types inferred from the grammar and `tag`
handler keys against declared `node(..., { tags })` values. Unknown keys are type errors when
the grammar carries static type metadata.

## Whitespace

### `trivia(combinator)` <Badge type="tip" text="helper" />

Mark a combinator as skippable filler (sets `isTrivia`). Does not skip until installed via
`parser({ trivia })`.

### `classifiedTrivia({ name: combinator, ... })` <Badge type="tip" text="helper" />

Build labeled trivia for `run(..., { rootTrivia: { select } })`. Each property
becomes one separate labeled grammar arm, so a broad whitespace matcher cannot
silently consume a selected comment category. Overlapping arms retain ordinary
ordered-choice semantics (for example, `//…` and `/*…*/` may both begin with
`/`); the category is the arm that actually matched. Selected capture rejects local
`parser({ trivia })` scopes that are not also classified. A deliberately opaque
local scope must say
`parser({ trivia, rootCapture: 'opaque' }, ...)`.

The property names are opaque application categories, not Parseman semantics:
the library never assigns meaning from a name such as `comment` or `whitespace`.
Recognition and its fast paths come from the supplied combinator structure;
classification controls only selected-root retention.

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
`{ ok, value, span, expected, errors, rootTrivia?, unconsumedFrom }`.
Pass `opts.build` for a
[CST host](#cstbuildhost), `opts.state` for initial grammar state, and `opts.trivia`
(the grammar's trivia rule) to skip trailing whitespace/comments before reporting
`unconsumedFrom` — so the dialect's own trivia decides what counts as leftover input.
Pass `opts.triviaCaptureMask` to filter per-node CST trivia capture by labeled kind.

Pass `opts.rootTrivia: { select: [...] }` when only a few labeled markers
need root-level preservation. This stores a compact row per selected marker and its
complete owning trivia range; it does not record ordinary whitespace runs. Labels
are grammar-defined policy, so a formatter may select `significantNewline` while a
serializer selects comments. Root capture is otherwise absent: ordinary `run()`
retains no global trivia log. `result.rootTrivia.index` provides the gap-query API,
and raw rows are in `result.rootTrivia.rows`. Their label index is into `select`,
which remains stable when a composed grammar changes its local trivia-label order.

Use `classifiedTrivia()` for this grammar. Selected capture rejects a broad
local matcher that would classify a selected category under another label; use `rootCapture:
'opaque'` only where that loss is intentional.

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

## Identity oracle

Prove a grammar refactor did not move the output. Imported from the `parseman/oracle`
subpath; Node-only. See [The identity oracle](../guide/identity-oracle).

### `digestInto(target, value, prefix?, options?)` · `digestValue(value, prefix?, options?)`

Deterministic serialization of **one** parse result — the part only parseman can supply,
because it is parseman's node shapes that decide which distinctions are semantically
meaningful.

`digestInto` streams the canonical token projection at a caller-supplied hash. The caller
brings the algorithm and keeps the result:

```ts
const sha = createHash('sha256')
digestInto(sha, tree)
const digest = sha.digest('hex')
```

Nothing is accumulated, so there is no maximum-string-length ceiling and no tree size at
which the digest stops being takeable. `digestValue` is the sha256-hex convenience wrapper.

`prefix` is written ahead of the first token with no separator, for callers that need two
disjoint digest spaces — write `OK:` for a parse that succeeded and `ERR:` for one that
threw, so a surface returning exactly your projected error shape cannot hash the same as one
that threw it.

`options.maxVisits` bounds the walk, raising `CanonicalBudgetError` past the limit — see
`DEFAULT_MAX_VISITS`. A walk that finishes under budget produces byte-identical output, so
the budget can never move a recorded digest.

### `canonicalize(value, options?)`

The key-sorted, cycle-safe token projection the digests are taken over — diff two of them to
see *what* moved. It **materialises** the projection, so it is bounded by the maximum JS
string length; it is a debugging aid, and `digestInto` is what a gate should run on.
`sha256(prefix + canonicalize(v))` and `digestValue(v, prefix)` are the same number for every
value the former can survive.

### What is NOT here

Walking a corpus, folding per-entry digests into an aggregate, three-way verdicts and report
formatting — once `loadCorpus`, `digestCorpus`, `compareReports` and `formatComparison` —
are a consumer's regression-suite plumbing, not something that helps anyone build or diagnose
a grammar, so they live with the suite that needs them. jess's is
`packages/syntax/less/less-parser/test/identity-oracle/` and is a reasonable model to copy.
Keep the `OK:`/`ERR:` prefixes, and keep "the grammar rejected this input" and "the digest
could not be computed" on separate channels: the second is a fact about the tool, and
reporting it as the first is how a gate lies.

> **Sharing is exponential.** The projection writes a shared subtree once per *path* that
> reaches it, deliberately (see "Sharing is not a cycle"), so a node referenced from two
> places at each of `d` levels is written `2^d` times. Streaming removes the memory ceiling
> but not that work. If your trees share structure, dedupe it before digesting — or expect
> `CanonicalBudgetError` to tell you so by name.

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

`report.unanalysable` lists rules the walk could NOT introspect. **A non-empty
`unanalysable` means the report is PARTIAL**: `ungated` being empty does not then mean
the grammar is clean. `formatGatingWarnings` always emits a banner for it, and the
`'error'` gate fails on it. Treating "no findings" as a pass without checking this field
is the mistake the field exists to prevent.

### `analyzeGrammarGating(grammar, opts?)` → `GatingReport`

Analyze a WHOLE grammar — a `rules()` map **or** a `compose()` result.

`analyzeGating` / `analyzeGatingRules` walk combinators. A `compose()` result contains
none: fusion lowers every rule to an executable function, so its map holds rule
FUNCTIONS and walking it yields nothing. `analyzeGrammarGating` recovers the combinator
graph from the composition's carried IR first, then analyzes the override-winner map
with cross-artifact holes bound — so a choice that is `deferred` when you analyze the
contributing `rules()` map alone resolves here to a real `yes` / `recoverable` / `no`.

Use it when you want a composed grammar's gating verdict programmatically. (`compose()`
already runs the fuse-time diagnostic and warns; this is the API for asking directly.)

A contributing piece that is an opaque precompiled artifact — one carrying compiled rule
functions rather than re-lowerable IR — cannot be introspected. Its rules are reported
in `report.unanalysable` rather than silently omitted.

### `analyzeDuplication(entry, opts?)` / `analyzeDuplicationRules(ruleMap, opts?)` → `DuplicationReport`

Static structural-duplication diagnostic over a combinator tree. Reports eight families:
`rewrites` (mechanical algebra — `choice(sequence(A, B), B)` → `sequence(optional(A), B)`, a
hand-rolled `sepBy`, idempotent nesting, and the two dead-arm BUGS `duplicate-arm` /
`shadowed-arm`), `structureLoss` (a BUG: an earlier `choice` arm that FLATTENS the node a
later arm structures — same `node()` type, overlapping first-sets, and the earlier body
contains no `node()` at all, so on the inputs both accept the tree silently loses the named
child types while the parse still succeeds), `divergentNodes` (one `node()` type built by several productions),
`nearDuplicates` (subtrees identical except at one slot), `duplicates` (identical subtrees in
≥2 places, ranked by nodes saved), `regexFragments` (an alternation run re-spelled across
several `regex()` terminals), `regexClasses` (character classes re-spelled — and, more
usefully, near-identical ones, with the drift shown side by side), `keywordRegexes`
(hand-rolled keywords that should be `word()`/`keywords()`, flagged for the `/i`-without-`/u`
case-fold bug, plus large literal ALTERNATIONS — a regex enumerating a fixed vocabulary is a
keyword set written the hard way, and `hazards`/`longestFirst` report whether its
hand-maintained order lets a shorter alternative shadow a longer one), and `overlaps` (`choice` arms whose first-sets intersect, with the shared
prefix named and whether the `sharedPrefix` strategy already handles it).

A `keywordRegexes` finding with an UNRESCUED prefix hazard is a further bug class: regex
alternation is first-match, so with no boundary guard to force a backtrack the longer
alternative can never match. A GATED earlier arm is never reported as `structureLoss` — a
runtime predicate is a deliberate branch, not a shadow. Only the two dead-arm rewrite findings and unwrapping a one-arm `choice` are `astNeutral`. Everything else changes the child array the
site produces and is reported as a CANDIDATE to verify, never as a fix. `hand-rolled-sepby`
carries a per-site `sepByVerdict` — `convertible`, `blocked-by-capture` (the repetition
`field()`s its separator, which `sepBy` cannot express) or `reducer-stride-review`.

The input is the **rules map**, not the value `compose()`/`composeLeaf()` returns — that is a
fused compiled artifact with no `_def` to walk, and passing one **throws** rather than
reporting an empty result. `opts.accept` is the allowlist of finding `id`s, with
`report.acceptedUnused` flagging stale entries. `formatDuplicationFindings(report)` renders
printable lines. Wiring is OPT-IN on all three lowering paths via the `duplication` option
(or `PARSEMAN_DUPLICATION`); default `'off'`. See
[Grammar duplication](../guide/grammar-duplication).

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
