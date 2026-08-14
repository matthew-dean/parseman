# Macro mode

Add the plugin once and your parser imports are evaluated and compiled at build time.
The combinator import you mark `with { type: 'macro' }` disappears entirely, leaving an
optimized `TableProgram` artifact in its place. The artifact imports the shared
`parseman/table` runtime; it does not ship the combinator tree or compiler.

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

The bundle receives a version-stamped `TableProgram`: compact numeric rows, constant and
callback pools, and bindings to the shared table runtime. The runtime links those rows to
closure bodies once. Proven hot shapes—such as disjoint literal choices, scalar terminals,
and selected lexical programs—receive direct bodies without introducing a second semantic
parser.

- **Disjoint first characters** → an indexed character dispatch instead of trying each arm.
- **Composed grammars dispatch too.** When you [`compose([...])`](./extending) separately
  compiled grammars, a `choice` arm that references a rule in *another* artifact keeps its
  first-char dispatch. Because each artifact is compiled on its own, the referenced rule's
  first-set isn't known yet — so the guard is emitted as a placeholder and resolved at
  **fuse time** against the *final* rule's first-set. That stays correct even when a later
  artifact **overrides** a rule with a different first-set (open recursion). The dispatch
  therefore survives the artifact boundary rather than degrading to an arm-by-arm scan.
- **Regex parsers** → use a scalar recognizer where provably equivalent, otherwise a sticky
  `/pattern/y` stored in the artifact pool.
- **Failure paths** allocate no objects.

For a deep dive on which regex shapes become scan loops, into what, and why some stay on the
engine, see [Under the hood: regex lowering](./regex-lowering).

## What gets compiled

The plugin compiles combinator trees end to end:

- All the core combinators — `literal`, `regex`, `sequence`, `choice`, `many`,
  `oneOrMore`, `optional`, `sepBy`, `transform`, `skip`, `token`, `not`, `scanTo`,
  `balanced`.
- `rules()` factories, **including mutually recursive ones** — encoded as named table rules
  whose links are resolved after the complete rule map is known.
- `parser({ trivia })` / `noTrivia()` wrappers.
- `node()` rules — CST capture, named `field()` capture, trivia logging, `unwrap` /
  `collapse`, and all — with `build` / `transform` callbacks retained in the artifact pool.

A full grammar built as a `rules()` factory of `node()` rules compiles end to end. Each
rule remains independently callable, while static site labels let the linker omit capture,
trivia, line, or recovery machinery where the final graph proves it unnecessary.

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

Compiling trades **bundle size for speed**: a combinator grammar becomes a serialized
table plus any assembly bodies selected for proven shapes, and that artifact ships in
your bundle with the shared table runtime.

**Measure in bytes, not lines.** Generated lines get *longer* as well as more numerous,
so a line multiplier understates growth — GraphQL once moved +15.6% in bytes while its
generated LOC moved only +3.4%. The number that matters is **raw generated bytes per
byte of grammar source**, because raw bytes are what V8 parses at import.

### The budget

**The ceiling is 10× raw bytes.** This is enforced on every PR by the `size-gate` CI
job (`pnpm size:guard`) against a committed baseline in `bench/size-baseline.json`.
It cannot be waived by rebaselining.

### Measured

The current 0.48 probe measures the artifact users actually ship. Byte counts are
deterministic, so `pnpm size:probe` / `pnpm size:guard` reproduce them on any machine.
Representative rows are:

| Shape | Source | Generated | Ratio | Gzip |
| --- | ---: | ---: | ---: | ---: |
| 5 `node()` sites | 735 B | 2,011 B | 2.7× | 850 B |
| 17 `node()` sites | 2,127 B | 5,924 B | 2.8× | 1,614 B |
| 33 `node()` sites | 4,015 B | 11,092 B | 2.8× | 2,584 B |
| 3-level composition | 1,984 B | 2,144 B | 1.1× | 971 B |
| trivia-enabled | 559 B | 1,668 B | 3.0× | 790 B |

### How it scales

**Generated size is linear in `node()` call sites, not superlinear.** The 0.48 probe's
4-to-32-site series adds about **324 bytes per additional `node()` site**, with roughly
391 bytes of fixed overhead. This replaces the obsolete direct-source-codegen estimate
of about 4.2 kB per site.

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
| 1 | 1,289 B | 1.00× |
| 2 | 2,106 B | **1.63×** |
| 4 | 3,732 B | **2.90×** |

Variant growth remains sublinear but is not free. Measure the variants you actually ship;
the selected strict assembly applies only to the large terminal default AST/no-lines leaf,
while tracked and CST siblings remain compact.

Other measured axes, same probe and same baseline:

- trivia enabled vs disabled: **1.18×**
- `hostMode: 'cst'` vs `'ast'`: effectively equal in the probe (1,886 vs 1,881 bytes)
- composition amortises fixed structure: the three-level case is 2,144 generated bytes

Two things still keep this in perspective:

- **The combinator library and compiler do not ship in the artifact.** Macro output imports
  the shared table runtime, so you're shipping the serialized parser plus that runtime,
  not the combinator tree and compiler.

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
- **Compression is not the only budget.** Gzip approximates transfer cost, while raw bytes
  still affect module parse and memory. The size gate records both.

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
