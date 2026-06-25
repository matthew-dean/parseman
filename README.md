<p align="center">
  <img src="https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/parseman.png" alt="Parséman — 100% Pure Parsing" width="220" />
</p>

# Parséman (PAR-zə-mahn)

Write parsers in TypeScript — fast enough to run as-is, and blazing fast when the bundler macro kicks in. Same code either way; no grammar files, no generated output to check in. Drop the plugin in tests or anywhere a bundler isn't around and everything still works.

## Benchmarks

Measured on Apple M2 Pro. Bars show µs per parse — shorter is faster. Refresh: `pnpm bench`, then `pnpm bench:svg` (updates `assets/bench-*.svg`).

Compared parsers: **Parséman**, Peggy, Parsimmon, Chevrotain, Nearley, and Jison (plus `JSON.parse` on JSON). Each implements the same parsing work on the bench fixtures — building JS values / row arrays / GraphQL AST nodes, not syntax-only validation. Peggy grammars in `bench/*.pegjs` are the reference; Nearley JSON uses [kach/nearley `examples/json.ne`](https://github.com/kach/nearley/blob/master/examples/json.ne); other Nearley and Jison grammars are ports of those Peggy files (`bench/vendor/`).

![JSON parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-json.svg)

![CSV parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-csv.svg)

![GraphQL parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-graphql.svg)

Parséman has three modes — **interpreter** (zero setup, works anywhere), **macro build** (compiled by the bundler plugin at build time, zero runtime cost), and **`.compile()`** (optional runtime JIT). Most production use lands on one of the first two. The initialization section only shows parsers with a nonzero setup cost: `.compile()` costs 75–650 µs depending on grammar size; Chevrotain always costs 840–1,400 µs. Parsers not listed there start for free. (Init numbers are pinned on the charts — they're noisy run-to-run; warm-parse bars are the meaningful comparison.)

On JSON, CSV, and GraphQL, Parséman macro beats Peggy at every fixture size in the charts above (e.g. GraphQL large: **142 µs** vs Peggy **400 µs**). For CST-building grammars (`node()` rules with trivia capture), the interpreter runs ~2× faster than Chevrotain on the JSON CST fixture while building an equivalent tree.

---

## Install

```bash
npm install parseman
# pnpm add parseman
```

---

## Quick start

```ts
import { literal, sequence, choice, regex, transform, parse } from 'parseman'

const method  = choice(literal('GET'), literal('POST'), literal('PUT'), literal('DELETE'))
const target  = regex(/[^\s]+/)
const version = regex(/1\.[01]/)

const requestLine = transform(
  sequence(method, literal(' '), target, literal(' HTTP/'), version),
  ([verb, , path, , ver]) => ({ verb, path, version: `HTTP/${ver}` })
)

parse(requestLine, 'GET /api/v1 HTTP/1.1')
// { ok: true, value: { verb: 'GET', path: '/api/v1', version: 'HTTP/1.1' }, span: ... }
```

---

## Macro mode

Add the plugin once — your parser imports are evaluated and compiled at build time. The `parseman` import disappears from the bundle entirely.

### 1. Register the plugin

```ts
// vite.config.ts
import parseman from 'parseman/plugin'
export default { plugins: [parseman()] }
```

```js
// rollup.config.js
import parseman from 'parseman/plugin'
export default { plugins: [parseman.rollup()] }
```

```js
// webpack.config.js
const parseman = require('parseman/plugin')
module.exports = { plugins: [parseman.webpack()] }
```

### 2. Import with `with { type: 'macro' }`

```ts
import { literal, sequence, choice, regex, transform } from 'parseman' with { type: 'macro' }
```

Same combinators, no other changes. The plugin walks the initializer, evaluates it at build time, and replaces it with an inline function.

### What gets emitted

```js
// Before (source):
const method = choice(literal('GET'), literal('POST'), literal('PUT'), literal('DELETE'))

// After (bundle output):
const method = function(input, _pos, _ctx) {
  const _code = _pos < input.length ? input.codePointAt(_pos) : -1
  if      (_code === 71) { /* G-E-T  */ }
  else if (_code === 80) { /* P-O-S-T */ }
  else if (_code === 68) { /* D-E-L-E-T-E */ }
  else return { ok: false, expected: ['"GET"', '"POST"', ...], span: { start: _pos, end: _pos } }
  ...
}
```

Disjoint first characters → single `codePointAt` dispatch. Regex parsers → sticky `/pattern/y` hoisted to closure scope. No objects allocated on failure paths.

### Debugging still works

The plugin emits a precise source map via [magic-string](https://github.com/Rich-Harris/magic-string). Breakpoints set on the original `choice(...)` lines are hit when the compiled function runs; step-through shows original combinator source, not emitted charCode checks.

If `with { type: 'macro' }` is stripped (older bundlers, test runners), the attribute is silently ignored and the interpreter runs instead — identical results, no errors.

### What gets compiled

Combinator trees — `literal`, `regex`, `sequence`, `choice`, `many`, `oneOrMore`, `optional`, `sepBy`, `transform`, `skip`, `not`, `scanTo`, `balanced` — plus `rules()` factories (including mutually recursive ones), `parser({ trivia })` wrappers, and `node()` rules (CST capture and all). A full grammar built as a `rules()` factory of `node()` rules compiles end to end: each rule becomes an independently-callable function, terminal/trivia capture is emitted inline, and every `build`/`transform` callback is inlined with its source span. Grammars with no `node()` emit zero capture code, so they compile byte-identically. Parsers that close over external variables the evaluator can't resolve stay as-is — the plugin compiles what it can and quietly leaves the rest alone.

---

## Combinators

**Terminology:** In this README, **combinator** means any building block that matches input (`literal`, `choice`, `sequence`, …). The `parser()` **function** is different — it wraps a root combinator with document-level options (trivia, line tracking) and gives you `.parse(input)`. Same word family, two roles: combinators compose the grammar; `parser()` configures how you run it.

A combinator reads from the input at the current position and succeeds or fails (returning a value on success). Composing combinators with `sequence`, `choice`, `many`, etc. is how you express parsing decisions.

`makeWord`, `rules`, and `parser` are **helpers**: definition-time factories or wrappers that *produce* combinators. They never match input themselves.

| Combinator | Description |
|---|---|
| `literal(s, opts?)` | Exact string match. `opts.caseInsensitive` for locale-aware comparison. |
| `word(s, boundary?)` | Single keyword with automatic word-boundary guard. |
| `keywords(words, opts?)` | Match one of many keywords (longest-first), with optional boundary and case folding. |
| `regex(pattern)` | Match a regex at the current position. Patterns are optimized via `regexp-tree`. |
| `sequence(...combinators)` | Match all in order; returns a tuple `[v1, v2, ...]`. Skips trivia between terms when trivia is set. |
| `choice(...combinators)` | Ordered alternatives (PEG — first match wins). Disjoint first chars → O(1) dispatch. |
| `many(combinator)` | Zero or more; compiles to a `while` loop. |
| `oneOrMore(combinator)` | One or more; fails if nothing matches. |
| `optional(combinator)` | Zero or one; returns `null` on no match. |
| `sepBy(combinator, sep)` | Zero or more combinator matches separated by `sep`. |
| `transform(combinator, fn)` | Map the result: `fn(value, span) → newValue`. |
| `skip(main, skipped)` | Match `main` then `skipped`; return `main`'s value. |
| `label(name, combinator)` | Attach a string label to a combinator arm (metadata). Used on trivia `choice` branches for per-chunk kind capture — see [Whitespace and comment skipping](#whitespace-and-comment-skipping). |
| `node(type, combinator, build)` | CST/AST rule: captures the combinator's terminals into `children`/`rawChildren` and trivia offsets into a flat `triviaLog`, then calls `build(children, rawChildren, span, triviaLog)`. |
| `ref<T>()` | Low-level forward declaration slot (use `rules()` in most cases). |
| `not(combinator)` | Negative lookahead — succeeds (consuming nothing) when the combinator fails. |
| `guard(predicate)` | Succeeds only when `predicate(ctx)` returns true; used for context-sensitive rules. |
| `withCtx(extra, combinator)` | Merge `extra` into the user context for the duration of the combinator. |
| `recover(combinator, sentinel)` | On failure, skip input until `sentinel` matches; returns a `CSTError` node. |
| `scanTo(sentinel, opts?)` | Scan forward until `sentinel` matches (sentinel not consumed). Pass `opts.skip` to treat certain patterns as opaque blobs that may contain the sentinel character. Pass `opts.orEOF: true` to succeed at end-of-input. |
| `balanced(open, close, opts?)` | Match a single balanced delimited region — e.g. `(…)` or `[…]` — including the delimiters. Primarily used as an element of `scanTo`'s `opts.skip` list. |

### Helpers (produce combinators at definition time)

| Helper | Description |
|---|---|
| `trivia(combinator)` | Label a combinator as skippable filler (whitespace, comments). Does not skip by itself — pass the result to `parser({ trivia })` to turn on auto-skipping between tokens. |
| `makeWord(boundary?)` | Returns `(str) => Combinator` with a fixed word-boundary class. Not a combinator — see [keyword disambiguation](#ordered-choice-and-keyword-disambiguation). |
| `rules(factory)` | Named, mutually-recursive rule bundle. See [Named and recursive rules](#named-and-recursive-rules). |
| `parser({ trivia }, combinator)` | Wrap a root combinator with document-level trivia skipping. See [Whitespace and comment skipping](#whitespace-and-comment-skipping). |
| `triviaEntries(log, labels?, opts?)` | View over a flat trivia log: `.kind(i)`, `.text(i, input)`, `.start(i)`, `.end(i)`. Stride is 2/3 for root `_triviaLog`, 3/4 for per-node `triviaLog` when kinds are enabled. |

---

## Performance: collapse opaque shapes into one regex

The single biggest grammar-level perf lever is **the number of combinator boundaries on the hot path**. Every `sequence` / `regex` / `oneOrMore` step is a function call plus a result-object allocation plus — in a `node()` rule — a leaf push. Fewer, fatter combinators beat many thin ones.

Measured on a repeated 3-shape group (`name1 1px #111 …`, ~29 KB), parsing the same content three ways:

| Approach | Interpreted | Compiled |
|---|---|---|
| `oneOrMore(sequence(ident, sp, num, sp, hex, sp))` | 0.289 ms | 0.167 ms |
| same, with **inline** `regex(…)` instead of shared refs | 0.281 ms | 0.183 ms |
| **one** `regex(/…ident…num…hex…/)` per group | **0.055 ms** | **0.042 ms** |

Two takeaways:

- **Shared combinator ref vs inline `regex(…)` literal makes no difference.** Both produce the identical runtime structure (one `regex` combinator either way), and the compiler inlines a `regex` test at every use site regardless of sharing — there's no function-call indirection to eliminate (that only exists for `ref()` / `rules()` entries). Factor out shared terminals for readability; it costs nothing.
- **Collapsing a fixed multi-token shape into a single `regex` is 4–5× faster** in both the interpreter and compiled output, because it erases the per-step call + allocation overhead. `compile()` is a real but smaller win (~1.7×) and **stacks** with collapsing.

**When to collapse:** only where the CST treats the group as opaque text — a dimension `\d+px`, a hex color, an `nth` expression, a simple ident-run. A single regex yields **one leaf**, not structured sub-nodes.

**When NOT to collapse:** keep the parts as separate combinators wherever the builder needs them as distinct CST children — for per-field source spans (`fieldSpans`/`valueSpans`), for trivia recovered *between* the parts, or for distinct typed nodes. Correctness first; collapse only the genuinely opaque runs.

For library-level codegen and macro optimizations (not grammar authoring), see [PERF_IDEAS.md](./PERF_IDEAS.md).

---

## Whitespace and comment skipping

Skipping filler between tokens is a two-step setup:

1. **Define** what counts as filler — usually `regex(/\s+/)`, comments, or both — and wrap it with `trivia()`. This only sets a metadata flag (`isTrivia`); it does not change when the parser runs.
2. **Activate** skipping by passing that combinator to `parser({ trivia }, combinator)`. That installs it on the parse context so `sequence`, `sepBy`, `choice`, etc. consume matching filler automatically between terms.

```ts
import { parser, regex, trivia, sepBy, literal } from 'parseman'

const ws   = trivia(regex(/\s*/))   // "this pattern is filler" — not skipped yet
const word = regex(/[a-z]+/)
const list = parser({ trivia: ws }, sepBy(word, literal(',')))  // skipping on

list.parse('foo ,  bar , baz')
// { ok: true, value: ['foo', 'bar', 'baz'], ... }
```

Multiple trivia types — whitespace and comments — combine with `choice()` and `many()`:

```ts
const lineComment  = sequence(literal('//'), regex(/[^\n]*/))
const blockComment = sequence(literal('/*'), scanTo(literal('*/'), []))
const ws           = trivia(many(choice(regex(/\s+/), lineComment, blockComment)))
```

Label trivia arms so each captured chunk records its kind in `_triviaLog` / per-node `triviaLog`:

```ts
const rw = trivia(oneOrMore(choice(
  label('whitespace', regex(/[ \t\n\r\f]+/)),
  label('blockComment', regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)),
)))

// After parse, resolve kinds lazily:
import { triviaEntries } from 'parseman'
const entries = triviaEntries(triviaLog, rw._meta.triviaKindLabels)
entries.kind(0)  // 'whitespace'
entries.text(0, input)  // slice on demand
```

`label(name, parser)` names a trivia arm; `node('Ruleset', …)` names a CST node — different namespaces, no conflict.

When all trivia arms are labeled, each captured chunk appends a **kind index** to the log (stride +1). Root `_triviaLog` entries are `[start, end, kind]`; per-node `triviaLog` entries are `[start, end, insertIdx, kind]`. Without labels, strides are 2 and 3 respectively.

---

## Ordered choice and keyword disambiguation

`choice()` uses PEG ordered-choice semantics: first match wins. **Order matters.**

For keywords — where `if` should not match the prefix of `ifdef` — use the `word` combinator. Pass a custom **boundary** (the character class that must *not* follow the match) per call, or use `makeWord` to bake one boundary into a small factory:

```ts
import { word, makeWord, choice, regex } from 'parseman'

word('true')                       // combinator — default boundary
word('color', 'A-Za-z0-9_-')       // combinator — one-off custom boundary

// Helper — returns a function that produces combinators (not a combinator itself)
const kw = makeWord()
const cssKw = makeWord('A-Za-z0-9_-')

const token = choice(
  kw('if'),                        // each call yields a combinator
  kw('else'),
  cssKw('color'),
  regex(/[a-zA-Z_]\w*/),           // ident fallback
)
```

`makeWord` is optional — `(s) => word(s, 'A-Za-z0-9_-')` is equivalent.

Or build the boundary guard by hand with `not()`:

```ts
const wordChar = regex(/\w/)
const keyword  = (s: string) => transform(sequence(literal(s), not(wordChar)), ([kw]) => kw)
const ident    = regex(/[a-zA-Z_]\w*/)

const token = choice(
  keyword('if'),
  keyword('else'),
  keyword('return'),
  ident,
)
```

When alternatives share a prefix, put the longer one first:

```ts
// Wrong: choice(literal('in'), literal('instanceof')) — 'instanceof' never reached
const op = choice(literal('instanceof'), literal('in'), literal('if'))
```

---

## Named and recursive rules

Use `rules()` when your combinators need to reference each other by name. Pass a factory that receives all rule names as ready-to-use references and returns the definitions:

```ts
import { rules, parser, choice, sequence, literal, sepBy, transform, trivia, regex } from 'parseman'
import type { Combinator } from 'parseman'

type JSON = null | boolean | number | string | JSON[] | Record<string, JSON>

const ws = trivia(regex(/[ \t\n\r]*/))

const { value } = rules<{ value: Combinator<JSON> }>(g => {
  const comma = literal(',')

  const array = transform(
    sequence(literal('['), sepBy(g.value, comma), literal(']')),
    ([, items]) => items as JSON[]
  )
  const pair = transform(
    sequence(jsonString, literal(':'), g.value),
    ([key,, val]) => [key, val] as [string, JSON]
  )
  const object = transform(
    sequence(literal('{'), sepBy(pair, comma), literal('}')),
    ([, pairs]) => Object.fromEntries(pairs) as Record<string, JSON>
  )

  return {
    value: choice(object, array, jsonString, jsonNumber, jsonBool, jsonNull) as Combinator<JSON>,
  }
})

export const jsonParser = parser({ trivia: ws }, value)
jsonParser.parse('{ "a": 1 }')
```

`g.value` is a reference that works anywhere inside the factory regardless of order. Local helpers (`comma`, `pair`, `object`) that don't need to be cross-referenced can be plain `const`. Only put a rule in the returned object if other rules need to reach it as `g.xxx`.

> **Macro and `rules()`:** The plugin fully compiles `rules()` factories, including recursive ones. It emits mutually recursive named functions (`_pf0` etc.) so the cycle is broken. Add `with { type: 'macro' }` to your import and the entire grammar — recursive rules included — is inlined at build time. Both binding forms compile: `const { value } = rules(...)` (each rule becomes a top-level function) and `const grammar = rules(...)` (an object literal of compiled rules, so `grammar.value(...)` works).
>
> If the plugin meets a macro-imported declaration it can't compile statically (it closes over a runtime value, or isn't a recognized combinator shape), it leaves that declaration for the interpreter, strips the `with { type: 'macro' }` attribute so the import stays valid, and emits a build **warning** (`[parseman] file:line — …`) pointing at it — so a silent fallback never goes unnoticed.

### `ref<T>()` — low-level forward declaration

`rules()` handles forward references automatically. `ref<T>()` is the lower-level primitive it uses internally, exposed for cases where you need a single forward slot outside of a `rules()` call:

```ts
const value = ref<JSON>()
// ... build parsers that use value ...
value.define(choice(object, array, str, num, bool, nil))
```

---

## Grammars that build an AST

For grammars that produce a typed CST/AST, support incremental re-parsing, or care about trivia, wrap each rule in `node(type, combinator, build)`. parseman captures the rule's terminals into `children` / `rawChildren` and records trivia as flat `[start, end, insertIdx, …]` **entries** in `triviaLog` (three numbers per whitespace/comment chunk), then hands all four to `build(children, rawChildren, span, triviaLog)`. **Capture is the library's job:** you don't wrap terminals to recover their spans, and you don't reconstruct trivia — it's collected as the parser runs, in both the interpreter and the compiled build. Use `buildTriviaIndex(tree, input)` to turn `triviaLog` into a before/after lookup table.

```ts
import { rules, parser, node, regex, literal, sequence, many, trivia } from 'parseman'
import type { Combinator } from 'parseman'

// Any node shape works as long as it satisfies NodeLike (see below).
type N = { _tag: 'node'; type: string; span: { start: number; end: number }; state: unknown; children: unknown[] }
const ws = trivia(regex(/\s+/))

export const { Expr, Num } = rules<{ Expr: Combinator<N>; Num: Combinator<N> }>(g => {
  const num = node('Num', regex(/[0-9]+/),
    (children, raw, span, _triviaLog) => ({ _tag: 'node', type: 'Num', span, state: null, children: [...children] }))
  const expr = node('Expr', parser({ trivia: ws }, sequence(g.Num, many(sequence(literal('+'), g.Num)))),
    (children, raw, span, _triviaLog) => ({ _tag: 'node', type: 'Expr', span, state: null, children: [...children] }))
  return { Expr: expr, Num: num }
})

Expr.parse('1 + 2 + 3', 0, { trackLines: false })
// value is a Node whose children are the captured Num sub-nodes and '+' leaves
```

- **`children`** — structural items in source order: spanned `CSTLeaf` terminals (`{ _tag:'leaf', value, span }`) and sub-nodes (whatever a nested `node()`'s `build` returned). A `build` that returns a bare string is recorded by the parent as a spanned leaf, so single-item "collapsing" rules keep their source span.
- **`rawChildren`** — structural children only (same items as `children`, without trivia tokens).
- **`triviaLog`** — flat `[start, end, insertIdx, …]` entries for whitespace/comments consumed between terms. `insertIdx` is the `rawChildren` index before which the trivia was consumed. Pass the tree to `buildTriviaIndex(tree, input)` for a `before`/`after` map of trivia tokens — useful for whitespace-sensitive syntax (e.g. CSS `div p` vs `div.p`).

Each rule returned from the factory is independently callable — `Expr`, `Num` above are the **rule registry** incremental re-parsing needs. Wrap a rule's inner combinator in `parser({ trivia }, combinator)` so trivia-skipping is baked in regardless of which rule you start from; the macro compiles the wrapper (and all capture) away to flat JS.

> `transform(p, fn)` is still the tool for plain value-mapping (no children/trivia). `node()` is for CST/AST rules — it adds the capture `transform` doesn't. Both compile under the macro.

### Incremental re-parsing

`makeFunctionalDoc(registry, rootRule, input, opts?)` wraps a parse in a document that re-parses incrementally on edits. The `registry` is the object `rules()` returns (rule name → parser fn); the parser functions stay stateless, all incremental state lives in the doc.

```ts
import { makeFunctionalDoc } from 'parseman'

const registry = { Expr, Num }              // straight from rules()
let doc = makeFunctionalDoc(registry, 'Expr', src)
doc.tree    // your Node root, or null on failure
doc.errors  // ParseFail[], empty on success
doc.input   // the source string

// edit(from, to, replacement) — two byte offsets into the OLD text + the
// replacement. "Select from→to, type replacement" — the three things every
// editor knows on each keystroke. Returns a new doc; the old one is untouched.
doc = doc.edit(changeStart, changeStart + changeLength, newText)
```

`edit()` finds the smallest node containing the change, re-parses just that rule from its start offset using the node's saved `state`, and grafts the result back in when the new span end lands where the edit's delta predicts. Nodes unaffected by the edit are shared by reference between old and new docs. For class-instance ASTs that can't be shallow-spread, pass `opts.rebuild(node, children)` to control how a parent is reconstructed when a child is replaced.

**In an IDE extension**, keep one registry per language and one doc per open document. Each keystroke gives you the changed range as byte offsets — pass them straight to `edit()`:

```ts
const docs = new Map<string, ReturnType<typeof makeFunctionalDoc<Node>>>()

vscode.workspace.onDidOpenTextDocument(d => {
  docs.set(d.uri.toString(), makeFunctionalDoc(registry, 'Stylesheet', d.getText()))
})

vscode.workspace.onDidChangeTextDocument(event => {
  const uri = event.document.uri.toString()
  let doc = docs.get(uri)!
  for (const change of event.contentChanges) {
    doc = doc.edit(change.rangeOffset, change.rangeOffset + change.rangeLength, change.text)
  }
  docs.set(uri, doc)
  // walk doc.tree for diagnostics, folding ranges, semantic tokens, etc.
})
```

### Extending grammars

Don't copy a `rules()` factory to make a variant — export what stays the same and pass in (or wrap) what changes. `examples/json/` is the template:

| File | What changes |
|------|----------------|
| `parser.ts` | Base grammar + `makeJSONParser(customWs)` |
| `jsonc.ts` | Trivia only — `makeJSONParser(jsoncWs)` |
| `jsonl.ts` | Document shape — `sepBy(jsonValue, '\n')` with tighter trivia |

```ts
// jsonc.ts — same recursive grammar, different trivia
export const jsoncValue = makeJSONParser(jsoncWs)

// jsonl.ts — reuse jsonValue, wrap at the top
export const jsonl = parser({ trivia: lineWs }, sepBy(jsonValue, literal('\n')))
```

`makeJSONParser` in `parser.ts` is the knob: one `rules()` body, trivia passed in, `parser({ trivia }, value)` returned. Unchanged core → parameterize; unchanged rule, different document → wrap the export.

---

## Context-sensitive parsing

`withCtx` and `guard` implement context-sensitive rules without mutating shared state, and they compose into `rules()` like any other combinator.

`withCtx(extra, combinator)` merges `extra` into the user context for the duration of the combinator. `guard(predicate)` succeeds only when `predicate(ctx)` returns true, gating a rule behind runtime context.

```ts
import { rules, withCtx, guard, many, sequence, choice, literal, regex, trivia, parser } from 'parseman'
import type { Combinator } from 'parseman'

const ws = trivia(regex(/\s*/))

export const { Program } = rules<{ Program: Combinator<unknown> }>(g => {
  const expr   = regex(/[a-z]+/)
  const ret    = sequence(guard((ctx: { inFn?: boolean }) => ctx.inFn === true), literal('return'))
  const stmt   = choice(ret, expr)
  const body   = withCtx({ inFn: true }, many(sequence(stmt, ws)))
  return { Program: parser({ trivia: ws }, many(body)) }
})
```

`return` is only reachable inside a body because `guard` rejects it when `inFn` is not set. Incremental `edit()` replays the correct context because each node records the `ctx.state` snapshot (`node.state`) active when it was parsed.

---

## Error recovery

`recover(combinator, sentinel)` wraps a combinator so that on failure it skips forward until `sentinel` matches, then returns a `CSTError` node instead of bailing on the whole parse. Error recovery is never pretty, but at least you can keep going.

```ts
import { recover, scanTo, balanced, literal } from 'parseman'

// Skip to ';' if a statement fails to parse
const stmt = recover(g.Stmt, literal(';'))

// Consume everything up to '}', skipping balanced () and [] pairs
const block = scanTo(literal('}'), [balanced(literal('('), literal(')')), balanced(literal('['), literal(']'))])
```

### `scanTo` vs `balanced` — when to use each

Both are **position arithmetic**: pure cursor-advance with zero CST allocation. Neither pushes terminals into the enclosing `node()`'s child list; only the final scanned span appears as a single leaf.

**`scanTo(sentinel, opts?)`** — use when you need to consume an open-ended region whose boundary is a specific token. It scans character-by-character, stopping the moment `sentinel` matches. Pass `opts.skip` to declare patterns that should be treated as opaque blobs so their content never accidentally looks like the sentinel:

```ts
// Consume a CSS at-rule prelude up to '{' or ';',
// but don't stop inside parentheses or strings.
const prelude = scanTo(choice(literal('{'), literal(';')), {
  skip: [balanced('(', ')'), singleStr, doubleStr],
})
```

**`balanced(open, close, opts?)`** — use when you want to match a single self-contained delimited region and get its full text back (delimiters included). This is the natural building block for `scanTo`'s `skip` list:

```ts
const parenGroup  = balanced('(', ')')   // matches (a + b) including the parens
const bracketExpr = balanced('[', ']')   // matches [0] including the brackets
```

`balanced` can itself accept a `skip` list for deeply nested structures:

```ts
// Match (…) allowing strings inside to contain unbalanced parens
const parenWithStrings = balanced('(', ')', { skip: [singleStr, doubleStr] })
```

**The key difference**: `scanTo` scans *until* a boundary; `balanced` matches *across* a known delimited region. Use `balanced` inside `scanTo`'s `skip` to prevent the scanner from stopping at a sentinel that appears inside a nested structure.

---

## Line / column tracking

```ts
const r = parse(myParser, 'hello\nworld', { trackLines: true })

if (r.ok) {
  r.span.startLine   // 1
  r.span.startColumn // 1
  r.span.endLine     // 2
  r.span.endColumn   // 6
}
```

Line lookup is O(log n) via binary search on a precomputed newline index built once per input string. When `trackLines` is false (the default), no index is built and spans carry only byte offsets.

---

## `compile()` — runtime compilation

`compile()` runs the same optimizer as the plugin, but at runtime — handy when you're assembling a grammar dynamically, or just want the speed without a build step:

```ts
import { choice, literal, compile } from 'parseman'

const compiled = compile(choice(literal('yes'), literal('no')))
compiled.parse('yes', 0, { trackLines: false })  // { ok: true, value: 'yes', ... }
compiled.source                                   // generated JS source string
compiled.inlineExpression                         // self-contained expression (what the plugin inlines)
```

> **CSP:** `compile()` uses `new Function` under the hood, so it cannot run in environments with a strict [Content Security Policy](https://www.greadme.com/blog/security/what-is-content-security-policy-complete-guide) that blocks `'unsafe-eval'`. Use the interpreter or the macro build plugin instead.

---

## ParseResult types

```ts
type ParseOk<T>  = { ok: true;  value: T;   span: Span }
type ParseFail   = { ok: false; expected: string[]; span: Span }
type ParseResult<T> = ParseOk<T> | ParseFail

type Span = {
  start: number         // byte offset, inclusive
  end: number           // byte offset, exclusive
  startLine?: number    // 1-based; only when trackLines: true
  startColumn?: number
  endLine?: number
  endColumn?: number
}
```

### Node and document types

Any AST your `transform` callbacks produce participates in incremental re-parsing as long as it satisfies `NodeLike` — that's the whole contract:

```ts
type NodeLike = {
  readonly _tag: 'node'
  readonly type: string          // the rule name — used as the registry key on re-parse
  readonly span: Span
  readonly state: unknown        // ctx.state snapshot at parse time; replayed on edit
  readonly children: ReadonlyArray<{ readonly _tag: string }>
}

// makeFunctionalDoc<N>(registry, rootRule, input, opts?) → FunctionalDoc<N>
type Registry<N>    = Record<string, (input: string, pos: number, ctx: ParseContext) => ParseResult<N>>
interface FunctionalDoc<N extends NodeLike> {
  readonly tree: N | null
  readonly errors: ParseFail[]
  readonly input: string
  edit(from: number, to: number, replacement: string): FunctionalDoc<N>
}
type FunctionalDocOptions<N> = {
  state?: unknown                                                  // initial ctx.state for the root parse
  rebuild?: (node: N, children: ReadonlyArray<unknown>) => N       // override for class-instance ASTs
}
```

`children` only needs items carrying a `_tag` so traversal can tell sub-nodes (`_tag: 'node'`) from anything else. The `type` string must match the rule name in the registry so `edit()` can re-parse the right rule.

---

## Developing

```bash
pnpm install
pnpm test       # Vitest — interpreter + compiler parity + ordered-choice semantics
pnpm typecheck  # TypeScript 7
pnpm build      # ESM + CJS + .d.ts → dist/
pnpm bench                  # Parséman vs Peggy, Parsimmon, Chevrotain, Nearley, Jison
pnpm bench:svg              # refresh assets/bench-*.svg after bench
pnpm bench:compile-grammars # regenerate Peggy / Nearley / Jison parser output in bench/
```

## License

MIT © [Matthew Dean](https://github.com/matthew-dean)
