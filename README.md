<p align="center">
  <img src="assets/parseman.png" alt="Parmésan — 100% Pure Parsing" width="220" />
</p>

# Parmésan (PAR-zə-mahn)

Write parsers with combinators, then let the bundler plugin compile them to optimized inline functions at build time — `charCodeAt` dispatch, `while` loops, zero allocation on failure paths. No generated boilerplate, no codegen step, no separate schema files.

The same code runs without the plugin: the interpreter produces identical results. Use the macro build for production; skip it in tests and anywhere a bundler isn't in the picture.

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

Pure combinator trees — `literal`, `regex`, `sequence`, `choice`, `many`, `oneOrMore`, `optional`, `sepBy`, `transform`, `skip`. Parsers using `ref()` for recursion or that close over external variables stay as-is. The plugin compiles what it can and quietly leaves the rest alone.

---

## Combinators

| Combinator | Description |
|---|---|
| `literal(s, opts?)` | Exact string match. `opts.caseInsensitive` for locale-aware comparison. |
| `regex(pattern)` | Match a regex at the current position. Patterns are optimized via `regexp-tree`. |
| `sequence(...parsers)` | Match all in order; returns a tuple `[v1, v2, ...]`. Skips trivia between terms when trivia is set. |
| `choice(...parsers)` | Ordered alternatives (PEG — first match wins). Disjoint first chars → O(1) dispatch. |
| `many(parser)` | Zero or more; compiles to a `while` loop. |
| `oneOrMore(parser)` | One or more; fails if nothing matches. |
| `optional(parser)` | Zero or one; returns `null` on no match. |
| `sepBy(parser, sep)` | Zero or more `parser` separated by `sep`. |
| `transform(parser, fn)` | Map the result: `fn(value, span) → newValue`. |
| `skip(main, skipped)` | Match `main` then `skipped`; return `main`'s value. |
| `parser(factory)` | Mutually recursive grammar rules — no forward declarations needed. |
| `ref<T>()` | Low-level forward declaration slot (use `parser()` in most cases). |
| `not(parser)` | Negative lookahead — succeeds (consuming nothing) when `parser` fails. |
| `guard(predicate)` | Succeeds only when `predicate(ctx)` returns true; used for context-sensitive rules. |
| `withCtx(extra, parser)` | Merge `extra` into the user context for the duration of `parser`. |
| `recover(parser, sentinel)` | On failure, skip input until `sentinel` matches; returns a `CSTError` node. |
| `scanTo(sentinel, skips?, opts?)` | Consume input up to (and including) `sentinel`, optionally skipping balanced pairs. |
| `balanced(open, close)` | Match a balanced pair (e.g. `(…)`, `[…]`). Used as a `skip` argument to `scanTo`. |

---

## Whitespace and comment skipping

Pass `trivia` to `parse()` and `sequence()` will automatically skip it between terms:

```ts
import { regex, sepBy, literal, parse } from 'parseman'

const ws   = regex(/\s*/)
const word = regex(/[a-z]+/)
const list = sepBy(word, literal(','))

parse(list, 'foo ,  bar , baz', { trivia: ws })
// { ok: true, value: ['foo', 'bar', 'baz'], ... }
```

Multiple trivia types — whitespace and comments — combine with `choice()` and `many()`:

```ts
const lineComment  = sequence(literal('//'), regex(/[^\n]*/))
const blockComment = sequence(literal('/*'), scanTo(literal('*/'), []))
const trivia       = many(choice(regex(/\s+/), lineComment, blockComment))
```

Use `grammar(opts, root)` instead of the `parse()` trivia option when you want trivia only for a subtree within a larger parse:

```ts
import { grammar } from 'parseman'

const jsonValue = grammar({ trivia: ws }, choice(object, array, str, num, bool, nil))
```

---

## Ordered choice and keyword disambiguation

`choice()` uses PEG ordered-choice semantics: first match wins. **Order matters.**

For keywords — where `if` should not match the prefix of `ifdef` — use `not()`:

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

## Recursive grammars

Use `parser()` for mutually recursive rules. Pass a factory that receives all rule names as ready-to-use references and returns the definitions:

```ts
import { parser, choice, sequence, literal, sepBy, transform, regex } from 'parseman'
import type { Combinator } from 'parseman'

type JSON = null | boolean | number | string | JSON[] | Record<string, JSON>

const ws = regex(/[ \t\n\r]*/)

const { value } = parser<{ value: Combinator<JSON> }>(g => {
  const comma = sequence(ws, literal(','), ws)

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
    value: grammar(
      { trivia: ws },
      choice(object, array, jsonString, jsonNumber, jsonBool, jsonNull)
    ) as Combinator<JSON>,
  }
})
```

`g.value` is a parser reference that works anywhere inside the factory regardless of order. Local helpers (`comma`, `pair`, `object`) that don't need to be cross-referenced can be plain `const`. Only put a rule in the returned object if other rules need to reach it as `g.xxx`.

> **Macro note:** Recursive parsers can't be inlined as a single expression, so the plugin leaves them as-is — but you can still call `compile()` at runtime for the same speedups. The codegen emits mutually recursive named functions and handles cycles just fine. Non-recursive leaf parsers in the same file still get inlined.

### `ref<T>()` — low-level forward declaration

`parser()` is the right tool for most recursive grammars. `ref<T>()` is the lower-level primitive it uses internally, exposed for cases where you need a single forward slot outside of a `parser()` call:

```ts
const value = ref<JSON>()
// ... build parsers that use value ...
value.define(grammar({ trivia: ws }, choice(object, array, str, num, bool, nil)))
```

---

## Class-based grammars

For grammars that need automatic CST construction, incremental re-parsing, or custom AST nodes, extend `Parser`. Capital-letter rules produce named CST nodes; lowercase rules are transparent helpers whose terminals surface as leaves of the nearest enclosing rule.

```ts
import { Parser, parse, regex, literal, choice, sequence, many, sepBy } from 'parseman'
import type { Refs } from 'parseman'

class ExprParser extends Parser {
  ws     = regex(/\s*/)
  digits = regex(/[0-9]+/)
  ident  = regex(/[a-zA-Z_]\w*/)

  // Plain initializer when no cross-reference needed
  Str    = sequence(literal('"'), regex(/[^"]*/), literal('"'))

  // Thunk form for forward / mutual references
  Num    = (g: Refs<ExprParser>) => g.digits
  Id     = (g: Refs<ExprParser>) => g.ident
  Add    = (g: Refs<ExprParser>) => sequence(g.Num, many(sequence(literal('+'), g.Num)))
  Expr   = (g: Refs<ExprParser>) => choice(g.Add, g.Num, g.Id)
}

const expr = new ExprParser()
const r = parse(expr.rule('Expr'), '1+2+3')
// r.value is a CSTNode { _tag: 'node', type: 'Expr', span, children, savedContext }
```

### Inheritance

Override any rule by redeclaring it in a subclass — subclass initializers run after the parent's, so the override wins automatically:

```ts
class JSXParser extends ExprParser {
  // replace just the ident rule; everything else stays
  ident = regex(/[a-zA-Z_$][\w$]*/)
}
```

### Custom AST nodes (`buildNode`)

Override `buildNode` to return your own node type instead of the default `CSTNode`:

```ts
import type { CSTLeaf, CSTError, CSTRawChild, Span } from 'parseman'

type MyNode = { _tag: 'node'; type: string; span: Span; savedContext: unknown; children: MyNode[]; text: string }

class MyParser extends Parser<MyNode> {
  // ... rules ...

  protected buildNode(
    type: string,
    span: Span,
    children: ReadonlyArray<MyNode | CSTLeaf | CSTError>,
    savedContext: unknown,
    rawChildren: ReadonlyArray<CSTRawChild>,
  ): MyNode {
    return { _tag: 'node', type, span, savedContext, children: children as MyNode[], text: '...' }
  }
}
```

`children` contains the structural children (sub-nodes and leaf tokens, no trivia). `rawChildren` contains everything in parse order including trivia tokens — useful for whitespace-sensitive grammars.

### Whitespace-sensitive rules with `rawChildren`

When whitespace is semantically meaningful (e.g. CSS where `div p` is a descendant combinator but `div+p` is adjacent), inspect `rawChildren` inside `buildNode`:

```ts
import type { CSTTrivia } from 'parseman'

class CssParser extends Parser<SelectorNode> {
  ident     = regex(/[a-zA-Z-]+/)
  Selector  = (g: Refs<CssParser>) => sequence(g.ident, g.ident)

  protected buildNode(type, span, children, savedContext, rawChildren) {
    if (type === 'Selector') {
      // rawChildren: [Ident("div"), CSTTrivia(" "), Ident("p")]
      const hasDescendant = rawChildren.some(c => c._tag === 'trivia')
    }
    return ...
  }
}

// Trivia is set on parse() — the whitespace skip happens globally
parse(css.rule('Stylesheet'), src, { trivia: many(choice(regex(/\s+/), comment)) })
```

`CSTTrivia` nodes only appear in `rawChildren`, never in `children`. Zero-length trivia matches (e.g. `\s*` at a non-whitespace position) are not emitted.

### IncrementalParser

Wraps a `Parser` class with incremental re-parsing. On first `parse()` a full parse runs. Subsequent `edit()` calls find the smallest containing node, re-parse just that subtree using its saved context, and stop early when the reparsed node ends at the same position as before (adjusted for the edit delta). O(changed region) amortized for typical edits.

```ts
import { IncrementalParser } from 'parseman'

const ip = new IncrementalParser(new ExprParser(), 'Expr')

let tree = ip.parse('1+2+3')
tree = ip.edit('1+20+3', 2, 3)   // only the Num node at offset 2 is re-parsed
tree = ip.edit('1+20+30', 5, 6)  // only the Num node at offset 5 is re-parsed

ip.currentTree   // the current tree
ip.currentInput  // the input string that produced it
```

Context-sensitive grammars work correctly: each CST node records a `ctx.user` snapshot at parse time (`savedContext`), so re-parsing resumes from the exact same state. Solid enough for a language server.

---

## Context-sensitive parsing

`withCtx` and `guard` implement context-sensitive rules without mutating shared state.

`withCtx(extra, parser)` merges `extra` into the user context for the duration of `parser`. `guard(predicate)` succeeds only when `predicate(ctx)` returns true, effectively gating a rule behind runtime context.

```ts
import { withCtx, guard, many, sequence, choice, literal, regex } from 'parseman'

class LangParser extends Parser {
  ws = regex(/\s*/)

  Expr    = regex(/[a-z]+/)
  Return  = (g: Refs<LangParser>) => sequence(
    guard((ctx: { inFn?: boolean }) => ctx.inFn === true),
    literal('return'),
  )
  Stmt    = (g: Refs<LangParser>) => choice(g.Return, g.Expr)
  Body    = (g: Refs<LangParser>) => withCtx({ inFn: true }, many(sequence(g.Stmt, g.ws)))
  Program = (g: Refs<LangParser>) => many(g.Body)
}
```

`Return` is only reachable inside a `Body` because `guard` rejects it when `inFn` is not set. `IncrementalParser` replays the correct context on incremental edits because `savedContext` captures the `inFn: true` snapshot at the node that originally set it.

---

## Error recovery

`recover(parser, sentinel)` wraps a parser so that on failure it skips forward until `sentinel` matches, then returns a `CSTError` node instead of bailing on the whole parse. Error recovery is never pretty, but at least you can keep going.

```ts
import { recover, scanTo, balanced, literal } from 'parseman'

// Skip to ';' if a statement fails to parse
const stmt = recover(g.Stmt, literal(';'))

// Consume everything up to '}', skipping balanced () and [] pairs
const block = scanTo(literal('}'), [balanced(literal('('), literal(')')), balanced(literal('['), literal(']'))])
```

`scanTo(sentinel, skips?, opts?)` consumes input character-by-character until `sentinel` matches. Pass `skips` to skip over balanced pairs that might contain the sentinel character. Pass `opts.orEOF: true` to succeed at end-of-input if the sentinel is never found.

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

### CST types

```ts
type CSTNode  = { _tag: 'node';  type: string; span: Span; children: CSTChild[]; savedContext: unknown }
type CSTLeaf  = { _tag: 'leaf';  value: string; span: Span }
type CSTError = { _tag: 'error'; type: string; span: Span; expected: string[]; children: CSTChild[]; savedContext: unknown }
type CSTTrivia = { _tag: 'trivia'; value: string; span: Span }  // only in rawChildren

type CSTChild    = CSTNode | CSTLeaf | CSTError
type CSTRawChild = CSTNode | CSTLeaf | CSTTrivia | CSTError
```

---

## Benchmarks

Measured on Apple M2 Pro. Bars show µs per parse — shorter is faster.

![JSON parsing benchmarks](assets/bench-json.svg)

![CSV parsing benchmarks](assets/bench-csv.svg)

Parmésan compiled edges out Peggy on small and medium JSON. At 12 kB Peggy pulls ahead by ~10% — it's been doing this a while. On CSV, where the grammar is non-recursive and fully inlines, Parmésan compiled wins going away.

---

## Developing

```bash
pnpm install
pnpm test       # Vitest — interpreter + compiler parity + ordered-choice semantics
pnpm typecheck  # TypeScript 7
pnpm build      # ESM + CJS + .d.ts → dist/
pnpm bench      # Parmésan vs Peggy vs Parsimmon vs Chevrotain
```

## License

MIT © [Matthew Dean](https://github.com/matthew-dean)
