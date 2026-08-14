# Macro mode

Add the plugin once and your parser imports are evaluated and compiled at build time.
The combinator import you mark `with { type: 'macro' }` disappears entirely, leaving flat,
allocation-light JavaScript in its place — the compiled grammar has no parseman import in
it at all.

You still call `run()` / `parse()` to execute that grammar, so parseman remains an ordinary
runtime import in your code. What the macro removes is the grammar-construction machinery
(every combinator, the whole compiler), not the small driver that runs the result.

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
const parseman = require('parseman/plugin').default

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

Compiling trades **bundle size for speed**: a compact combinator grammar expands into
flat, inlined JavaScript, and that generated code ships in your bundle.

**Measure in bytes, not lines.** Generated lines get *longer* as well as more numerous,
so a line multiplier understates growth — GraphQL once moved +15.6% in bytes while its
generated LOC moved only +3.4%. The number that matters is **raw generated bytes per
byte of grammar source**, because raw bytes are what V8 parses at import.

### The budget

**The ceiling is 10× raw bytes.** This is enforced on every PR by the `size-gate` CI
job (`pnpm size:guard`) against a committed baseline in `bench/size-baseline.json`.
It cannot be waived by rebaselining.

> **An earlier version of this page promised "roughly 4–8× the source lines".** That
> figure was measured only on the three smallest example grammars and was never
> enforced by CI. On real grammars it is wrong by close to an order of magnitude. The
> numbers below are the measured range, and several of them are **over budget today**
> — the gate is red on purpose until the emitted size comes down. Do not read this
> table as a promise; read it as the current state.

### Measured

Every size figure on this page describes the **JS-codegen lowering** — the flat
JavaScript `compile()` and the macro build emit — and is taken from the committed
baseline `bench/size-baseline.json` (recorded at `2344460`, 2026-08-01, on the 0.47.0
line). Byte counts are deterministic, so `pnpm size:probe` / `pnpm size:guard` reproduce
them on any machine. Re-read them from that file rather than trusting this page if the
two ever disagree.

Small self-contained grammars — the ones the old table showed:

| Grammar | Source | Generated | **Bytes** | Gzip | Line mult. |
| --- | --- | --- | --- | --- | --- |
| JSON | 5.8 kB | 15.1 kB | **2.6×** | 3.3 kB | 2.7× |
| CSV | 2.0 kB | 7.7 kB | **3.9×** | 1.9 kB | 4.0× |
| toml-ish | 3.3 kB | 13.2 kB | **4.0×** | 2.9 kB | 3.3× |
| GraphQL | 10.3 kB | 69.9 kB | **6.8×** | 12.8 kB | 6.3× |

Larger, denser, or derived grammars — none of which the old table measured:

| Grammar | Source | Generated | **Bytes** | Gzip | Line mult. |
| --- | --- | --- | --- | --- | --- |
| lang | 4.9 kB | 41.8 kB | **8.5×** | 7.6 kB | 8.6× |
| jsonc *(variant)* | 1.1 kB | 18.0 kB | **15.9×** | 3.8 kB | 14.3× |
| jsonl *(variant)* | 0.8 kB | 16.0 kB | **19.4×** | 3.4 kB | 18.8× |
| css | 9.7 kB | 224.1 kB | **23.1×** | 36.6 kB | 21.1× |

Real-world grammars are further out still: the four parsers in
[jess](https://github.com/matthewdean/jess) measured 35–79× and roughly 45 MB of ESM
between them. That reading predates the 0.46.0 module-level hoist described below and has
not been retaken.

### How it scales

**Generated size is linear in `node()` call sites, not superlinear.** The canonical size
probe (`pnpm size:probe`) holds a grammar's shape constant and varies only its node
count:

| `node()` sites | Generated | Bytes per node |
| --- | --- | --- |
| 5 | 20.1 kB | 4,011 B |
| 9 | 36.8 kB | 4,091 B |
| 17 | 70.4 kB | 4,141 B |
| 33 | 137.5 kB | 4,165 B |

Marginal cost is **≈4.2 kB per added `node()` site** across an 8× range, with an implied
fixed overhead of about zero. So `generated bytes ≈ 4.2 kB × node sites` — for the
JS-codegen lowering, at the baseline named above. (Earlier revisions of this page and of
[Benchmarks](./benchmarks) quoted 5.2 kB and 5.8 kB; both predate the 0.46.0
module-level hoist.)

That is why the source-relative multiplier looks like it explodes while the per-node cost
stays flat: **the multiplier is a denominator artifact.** A dense real grammar packs many
more `node()` sites into each source byte than a toy fixture does. It also means the
source-relative ratio is **not comparable between grammars that compose** — a composing
grammar's source does not contain the node sites it emits. Compare a grammar to its own
baseline, not to another grammar.

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

In 0.48 a sufficiently large terminal default AST/no-lines leaf is the deliberate speed
variant: it embeds one precompiled TableProgram assembly. Small leaves stay compact; the
line-tracking and CST leaves keep the
compact closure representation, so four public variants do not duplicate four large
assemblies. This is still one TableProgram semantic implementation—the embedded function
is a build-time materialization of the same table, not the removed direct-source parser.

**Each extra variant costs real bytes, but no longer a full copy.** Measured by
`pnpm size:probe`, holding the grammar constant and varying only the number of variants:

| Variants | Generated | vs 1 variant |
| --- | --- | --- |
| 1 | 20.1 kB | 1.00× |
| 2 | 30.7 kB | **1.53×** |
| 4 | 51.6 kB | **2.57×** |

**0.46.0 changed this.** Before it, codegen emitted every rule function once per
variant — 1.98× for two and 3.92× for four, near-perfect linear duplication with nothing
shared. 0.46.0 added a module-level hoist of byte-identical fused declarations, so
variants now share their identical rule functions and only the differing parts are
re-emitted. Growth is sublinear but not free: four variants still cost ~2.6× one.

A useful tell remains: the compression ratio climbs with variant count (5.2:1 → 6.9:1 →
9.2:1). Output that gzips unusually well is output that still repeats itself.

**If you ship one grammar in several configurations, budget roughly 0.5× a full copy per
extra variant** on top of the first, and measure your own grammar — how much is shared
depends on how much the variants actually differ. Deriving a variant at run time is still
cheaper in bytes when you can do it, but it is no longer the near-2× saving it was before
0.46.0.

> An earlier reading of jess's shipped artifact found `function _r_Stylesheet(` exactly
> **four** times in a 13.1 MB `css-parser/lib/grammar.js`, as four ~3.2 MB blocks. That
> was measured before 0.46.0 and has not been retaken.

Other measured axes, same probe and same baseline:

- `trivia()` adds **1.26×**
- `hostMode: 'cst'` adds **1.13×** over `'ast'`
- composition *amortises*: bytes-per-node falls from 3,197 to 2,504 going from one
  `compose()` level to three

Two things still keep this in perspective:

- **The combinator library does not ship.** Macro output has no external references, so
  you're not shipping the combinator trees, the compiler, and the codegen *and* the
  generated parser — just the parser, plus the small driver that executes it.

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
  so it cannot quietly grow.
- **Generated JS is repetitive, so it gzips hard.** GraphQL's 69.9 kB compresses to
  12.8 kB — the number your users actually download.

  But do not use that to excuse a raw-size failure. Raw bytes are what V8 must parse at
  import; gzip is only what crosses the wire. And the compression ratio is itself a
  **duplication detector**: real grammars compress at ~7.6–7.9:1 versus ~5.4:1 for the
  small fixtures here, which is what you would expect if the extra bulk is largely
  repeated structure. A *rising* compression ratio at flat raw size means the output is
  getting more repetitive, so the size gate baselines gzip too.

If bundle size matters more than raw throughput for a given grammar, use the
**interpreter** (zero generated code, zero setup) or reach for `compile()` at runtime
instead of the macro. See [the three modes](./modes).

Source maps and per-mode debugging are covered in [Debugging compiled grammars](./modes#debugging-compiled-grammars).

## When the plugin can't compile something

If the plugin meets a macro-imported declaration it can't compile statically — it closes
over a runtime value, or isn't a recognized combinator shape — it:

1. leaves that declaration for the interpreter,
2. strips the `with { type: 'macro' }` attribute so the import stays valid, and
3. emits a build **warning** (`[parseman] file:line — …`) pointing at it.

So a silent fallback never goes unnoticed — you'll see exactly which rule dropped to the
interpreter and why.
