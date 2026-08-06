# Macro mode

Add the plugin once and your parser imports are evaluated and compiled at build time.
The combinator import you mark `with { type: 'macro' }` disappears entirely, leaving a
compact **table** describing your grammar in its place, plus your own reducers.

In its stead the plugin writes one line:

```js
import { tableRules } from 'parseman/table'
```

That is the shared recogniser — one copy for every grammar in your bundle and every variant
of each. You still call `run()` / `parse()` to execute the grammar, so parseman remains an
ordinary runtime import in your code. What the macro removes is the grammar-construction
machinery (every combinator, the whole compiler), not the recogniser that runs the result.

If you are **shipping a package** that contains a compiled parser, import the driver from
[`parseman/run`](#shipping-a-compiled-parser) rather than the main entry — it is three
modules instead of the whole library.

## 1. Register the plugin

Parséman ships an [unplugin](https://github.com/unjs/unplugin)-based plugin, so the same
export adapts to every major bundler.

::: code-group

```ts [vite.config.ts]
import parseman from 'parseman/plugin'

export default {
  plugins: [parseman()],
}
```

```js [rollup.config.js]
import parseman from 'parseman/plugin'

export default {
  plugins: [parseman.rollup()],
}
```

```js [webpack.config.js]
const parseman = require('parseman/plugin')

module.exports = {
  plugins: [parseman.webpack()],
}
```

:::

## 2. Import with `with { type: 'macro' }`

```ts
import { literal, sequence, choice, regex, transform } from 'parseman' with { type: 'macro' }
```

Same combinators, no other changes. The plugin walks each initializer, evaluates it at
build time, and replaces it with an inline function.

### Import attributes

The `with { … }` suffix is [**import attributes**](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import/with) —
standard JavaScript syntax from the [TC39 import-attributes
proposal](https://github.com/tc39/proposal-import-attributes). It attaches metadata to an
`import` (or `export … from`) statement. The canonical standardized use is JSON modules:

```ts
import data from './config.json' with { type: 'json' }
```

`type: 'macro'` is **not** a TC39-defined module type. It's a **bundler convention** —
the attribute tells the build tool to evaluate the import at compile time and inline the
result, rather than bundling it for runtime. The same `with { type: 'macro' }` pattern is
used by [Bun](https://bun.com/docs/bundler/macros),
[Parcel](https://parceljs.org/features/macros/), and
[unplugin-macros](https://github.com/unplugin/unplugin-macros). Parséman's plugin keys off
it the same way: see the attribute, compile the combinator tree, strip the attribute so
the import stays valid for the interpreter fallback.

Older runtimes may still accept the earlier `assert { type: 'macro' }` spelling (import
*assertions*, the predecessor syntax). TypeScript has parsed `with { … }` on imports since
5.3.

### TypeScript config

TypeScript only accepts import-attribute syntax when
[`module`](https://www.typescriptlang.org/tsconfig/#module) is set to `esnext`,
`nodenext`, or `preserve`. With anything else you'll get:

```text
TS2823: Import attributes are only supported when the --module option is set to
esnext, nodenext, or preserve.
```

For a bundler-based project the usual pairing is:

```json
{
  "compilerOptions": {
    "module": "preserve",
    "moduleResolution": "bundler"
  }
}
```

## What gets emitted

A `choice` over string literals with disjoint first characters compiles to a single
`codePointAt` dispatch:

```js
// Before (source):
const method = choice(literal('GET'), literal('POST'), literal('PUT'), literal('DELETE'))

// After (bundle output):
const method = function (input, _pos, _ctx) {
  const _code = _pos < input.length ? input.codePointAt(_pos) : -1
  if      (_code === 71) { /* G-E-T    */ }
  else if (_code === 80) { /* P-O-S-T  */ }
  else if (_code === 68) { /* D-E-L-E-T-E */ }
  else return { ok: false, expected: ['"GET"', '"POST"', …], span: { start: _pos, end: _pos } }
  …
}
```

- **Disjoint first characters** → a single `codePointAt` dispatch instead of trying each
  arm.
- **Composed grammars dispatch too.** When you [`compose([...])`](./extending) separately
  compiled grammars, a `choice` arm that references a rule in *another* artifact keeps its
  first-char dispatch. Because each artifact is compiled on its own, the referenced rule's
  first-set isn't known yet — so the guard is emitted as a placeholder and resolved at
  **fuse time** against the *final* rule's first-set. That stays correct even when a later
  artifact **overrides** a rule with a different first-set (open recursion). The dispatch
  therefore survives the artifact boundary rather than degrading to an arm-by-arm scan.
- **Regex parsers** → lowered to a `charCodeAt` scan loop where provably equivalent,
  otherwise a sticky `/pattern/y` hoisted to closure scope.
- **Failure paths** allocate no objects.

For a deep dive on which regex shapes become scan loops, into what, and why some stay on the
engine, see [Under the hood: regex lowering](./regex-lowering).

## What gets compiled

The plugin compiles combinator trees end to end:

- All the core combinators — `literal`, `regex`, `sequence`, `choice`, `many`,
  `oneOrMore`, `optional`, `sepBy`, `transform`, `skip`, `token`, `not`, `scanTo`,
  `balanced`.
- `rules()` factories, **including mutually recursive ones** — emitted as mutually
  recursive named functions (`_pf0`, …) so the cycle is broken.
- `parser({ trivia })` / `noTrivia()` wrappers.
- `node()` rules — CST capture, named `field()` capture, trivia logging, `unwrap` /
  `collapse`, and all — with every `build` / `transform` callback inlined at its source span.

A full grammar built as a `rules()` factory of `node()` rules compiles end to end: each
rule becomes an independently-callable function, terminal/trivia capture is emitted
inline, and grammars with no `node()` emit zero capture code (so they compile
byte-identically to the non-CST version).

Both binding forms compile:

```ts
const { value } = rules(…)   // each rule becomes a top-level function
const grammar   = rules(…)   // an object literal of compiled rules; grammar.value(…) works
```

Grammar-wide `rules(...)` settings are read at the call site. That means one authored
factory can produce several standalone macro artifacts:

```ts
import { rules } from 'parseman' with { type: 'macro' }
import { grammarFactory } from './grammar.js'

export const grammar = rules({ trivia: rw }, grammarFactory)
export const grammarWithLines = rules({ trivia: rw, trackLines: true }, grammarFactory)
export const cstGrammar = rules({ trivia: rw, trackLines: true, hostMode: 'cst' }, grammarFactory)
```

`trackLines` fills line/column fields on spans as CST nodes are created; `hostMode: 'cst'`
builds through the CST host even when the grammar has direct AST builders. The macro emits
each call site independently, so importing `grammar` does not drag in the line-aware or CST
artifact. See [One factory, several macro artifacts](./recursive-rules#one-factory-several-macro-artifacts)
and [Line/column spans](./ast#linecolumn-spans).

Parsers that close over external variables the evaluator can't resolve are left as-is —
the plugin compiles what it can and quietly leaves the rest to the interpreter.

## Code size — what to expect

Compiling used to trade **bundle size for speed**. Since 0.47.0 it mostly does not: the
emitted module is a table describing your grammar plus your own reducers, and the
recogniser that runs it is imported from `parseman/table` rather than emitted once per
grammar. On every example grammar in the size baseline the emitted module is now *smaller
than the grammar source that produced it*.

**Measure in bytes, not lines.** The number that matters is **raw emitted bytes per byte of
grammar source**, because raw bytes are what V8 parses at import. (A line multiplier is
close to meaningless for a table artifact — the emitted lines are long data literals, so the
line figures below are reported only for continuity with earlier baselines.)

### The budget

**The ceiling is 10× raw bytes.** This is enforced on every PR by the `size-gate` CI
job (`pnpm size:guard`) against a committed baseline in `bench/size-baseline.json`.
It cannot be waived by rebaselining. **Every fixture is now inside it, with the worst
case at 4.15×** — the gate had been red on purpose for several releases and is green.

### Measured

Every size figure on this page describes the **table lowering** — what `compile()` and the
macro build emit — and is taken from the committed baseline `bench/size-baseline.json`
(recorded at `f4d2099`, 2026-08-05, on the 0.47.0 line). Byte counts are deterministic, so
`pnpm size:probe` / `pnpm size:guard` reproduce them on any machine. Re-read them from that
file rather than trusting this page if the two ever disagree.

Small self-contained grammars:

| Grammar | Source | Emitted | **Bytes** | Gzip |
| --- | --- | --- | --- | --- |
| JSON | 5.8 kB | 1,336 B | **0.23×** | 691 B |
| CSV | 2.0 kB | 788 B | **0.40×** | 432 B |
| toml-ish | 3.3 kB | 1,414 B | **0.43×** | 712 B |
| GraphQL | 10.3 kB | 4,682 B | **0.45×** | 1,844 B |

Larger, denser, or derived grammars:

| Grammar | Source | Emitted | **Bytes** | Gzip |
| --- | --- | --- | --- | --- |
| lang | 4.9 kB | 3,565 B | **0.73×** | 1,202 B |
| css | 9.7 kB | 9,229 B | **0.95×** | 2,517 B |
| jsonc *(variant)* | 1.1 kB | 1,382 B | **1.22×** | 717 B |
| jsonl *(variant)* | 0.8 kB | 1,384 B | **1.68×** | 707 B |

For scale against the previous lowering: `css` emitted 224.1 kB at the 0.46 baseline and
emits 9.2 kB here; `GraphQL` went 69.9 kB → 4.7 kB. The four parsers in
[jess](https://github.com/matthewdean/jess) measured 35–79× and roughly 45 MB of ESM between
them on the old baseline; that reading predates this lowering and has not been retaken.

### How it scales

**Emitted size is linear in `node()` call sites, not superlinear.** The canonical size
probe (`pnpm size:probe`) holds a grammar's shape constant and varies only its node
count:

| `node()` sites | Emitted | vs source |
| --- | --- | --- |
| 5 | 2,622 B | 3.57× |
| 9 | 3,911 B | 3.28× |
| 17 | 6,559 B | 3.08× |
| 33 | 11,747 B | 2.93× |

Marginal cost across that 8× range is **≈326 B per added `node()` site**, with about 1 kB
of fixed overhead — down from ≈4.2 kB per site on the previous lowering. (Earlier revisions
of this page and of [Benchmarks](./benchmarks) quoted 4.2 kB, 5.2 kB and 5.8 kB; all three
predate this lowering.)

The source-relative ratio is **not comparable between grammars that compose** — a composing
grammar's source does not contain the node sites it emits. Compare a grammar to its own
baseline, not to another grammar. Note also that the `probe/*` fixtures above run higher
ratios than the `example/*` grammars: they are tiny synthetic modules where the table's
fixed overhead dominates, which is exactly why the size gate keeps both families.

### The biggest cost: emitting the same grammar more than once

A grammar factory is usually compiled **more than once**. jess's css parser calls
`composeLeaf` four times over the same recognition pieces, differing only in
`trackLines` and `hostMode`:

```ts
export const cssGrammar              = composeLeaf([...pieces, rules({ trivia }, f)])
export const cssLineGrammar          = composeLeaf([...pieces, rules({ trivia, trackLines: true }, f)])
export const cssCstGrammar           = composeLeaf([...pieces, rules({ trivia, hostMode: 'cst' }, f)])
export const cssDiagnosticCstGrammar = composeLeaf([...pieces, rules({ trivia, hostMode: 'cst', trackLines: true }, f)])
```

**Each extra variant costs real bytes.** Measured by `pnpm size:probe`, holding the grammar
constant and varying only the number of variants:

| Variants | Emitted | vs 1 variant |
| --- | --- | --- |
| 1 | 1,730 B | 1.00× |
| 2 | 2,994 B | **1.73×** |
| 4 | 5,518 B | **3.19×** |

Absolutely these are tiny — `variants-4` emitted 50,174 B on the previous baseline and emits
5,518 B here. But **the ratio got worse, not better**: the previous lowering's module-level
hoist shared byte-identical rule functions across variants and held four variants at ~2.6×,
where the table currently repeats more per variant and reaches ~3.2×. That is a known
regression in the size ratchet, recorded rather than smoothed over.

A useful tell remains: the compression ratio climbs with variant count (2.2:1 → 3.5:1 →
6.1:1). Output that gzips unusually well is output that still repeats itself.

**If you ship one grammar in several configurations, budget roughly 0.7× a full copy per
extra variant** on top of the first, and measure your own grammar — how much is shared
depends on how much the variants actually differ.

Other measured axes, same probe and same baseline:

- `trivia()` adds **1.12×** (2,292 B vs 2,046 B)
- `hostMode: 'cst'` adds **1.003×** over `'ast'` (2,510 B vs 2,503 B) — the table barely
  specialises on host mode, where the previous lowering paid 1.13×
- composition *amortises*: the source-relative ratio falls from 2.01× to 1.22× going from
  one `compose()` level to three

Two things still keep this in perspective:

- **The combinator library does not ship.** Macro output is a table literal plus your own
  reducers, so you are not shipping the combinator trees, the compiler, or the analysis
  passes — just your grammar's data, plus the shared recogniser that runs it.

  It is **not** free of external references. The emitted module opens with

  ```js
  import { tableRules } from 'parseman/table'
  ```

  That is deliberate, and it is the reason the numbers above are what they are: one
  recogniser for every grammar in your bundle and every variant of each, instead of one per
  artifact. `parseman/table` is a normal package export; your bundler dedupes it like any
  other module.

  ### Shipping a compiled parser

  For a library whose published package contains a compiled grammar, import the driver
  from the dedicated entry:

  ```ts
  import { run } from 'parseman/run'
  ```

  Its whole module closure is three files — the driver, the recovery helpers it hands to
  tolerant parses, and the capture buffer those use. The main entry pulls the combinator
  set, `compile()`, the first-set analysis and the CST builders, none of which a compiled
  parser touches. `test/unit/run-entry-closure.test.ts` pins that closure by module list,
  so it cannot quietly grow. The emitted grammar module brings in `parseman/table`
  alongside it.

- **The emitted module gzips hard.** GraphQL's 4,682 B compresses to 1,844 B — the number
  your users actually download.

  But do not use that to excuse a raw-size failure. Raw bytes are what V8 must parse at
  import; gzip is only what crosses the wire. And the compression ratio is itself a
  **duplication detector**: a *rising* compression ratio at flat raw size means the output
  is getting more repetitive, so the size gate baselines gzip too. The variant table above
  is exactly that signal firing.

If bundle size matters more than raw throughput for a given grammar, use the
**interpreter** (nothing emitted, zero setup) or reach for `compile()` at runtime instead
of the macro. See [the three modes](./modes).

Source maps and per-mode debugging are covered in [Debugging compiled grammars](./modes#debugging-compiled-grammars).

## When the plugin can't compile something

If the plugin meets a macro-imported declaration it can't compile statically — it closes
over a runtime value, or isn't a recognized combinator shape — it:

1. leaves that declaration for the interpreter,
2. strips the `with { type: 'macro' }` attribute so the import stays valid, and
3. emits a build **warning** (`[parseman] file:line — …`) pointing at it.

So a silent fallback never goes unnoticed — you'll see exactly which rule dropped to the
interpreter and why.
