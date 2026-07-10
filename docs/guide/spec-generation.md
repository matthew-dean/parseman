# Grammar spec generation

Parséman grammars have no grammar file — the grammar *is* the TypeScript. That's great for
building parsers, but it removes the artifact people traditionally read to learn a language:
a **grammar reference**. `parseman/spec` regenerates that artifact directly from a `rules()`
grammar, so the spec is produced *from the parser itself* and can never drift from what
actually parses.

It walks the same combinator tree (`_def`) the interpreter and macro compiler consume, so
one emitter covers every grammar — interpreted or compiled — with no mode-specific work.

```ts
import { toEBNF, toRailroadHtml } from 'parseman/spec'

const grammar = rules(g => ({ /* … */ }))   // your grammar

const ebnf = toEBNF(grammar)                 // W3C-style EBNF text
const html = toRailroadHtml(grammar)         // self-contained syntax diagrams
```

## What it produces

- **EBNF text** — one production per named rule.
- **Railroad (syntax) diagrams** — a self-contained HTML page of SVG diagrams, one per rule,
  each with its EBNF caption. No CDN, no runtime dependency: the diagram library
  ([tabatkins/railroad-diagrams](https://github.com/tabatkins/railroad-diagrams), CC0) and
  its CSS are inlined, so the page renders offline and drops straight into a docs site.
- **A notation-agnostic model** (`buildSpecModel`) if you want to emit some other format.

## Combinator → EBNF

The emitter maps each combinator to an EBNF construct:

| `rules()` combinator | EBNF |
|---|---|
| `sequence(a, b, …)` | concatenation `a b …` |
| `choice(a, b, …)` | alternation <code>a &#124; b &#124; …</code> |
| `many(x)` / `optional(x)` / `oneOrMore(x)` | `x*` / `x?` / `x+` |
| `sepBy(x, sep)` | `x (sep x)*` |
| a reference to another rule (`g.name`) | non-terminal `name` |
| `literal("(")` | quoted terminal `"("` |
| `regex(/…/)` / `keywords([…])` | terminal (see [readable terminals](#readable-terminals)) |
| `not(x)` | negation annotation `!x` |
| `node("T", …)`, `transform`, `token`, `field`, `label`, `withCtx`, `expect` | transparent — the inner syntax |
| `trivia(…)`, `guard(…)` | elided by default |

Precedence is handled automatically: alternation binds loosest, then concatenation, then the
postfix operators — the renderer parenthesizes only where a looser construct sits inside a
tighter one.

### Example

```ts
const g = rules(self => {
  const ident = regex(/[a-zA-Z_][a-zA-Z0-9_]*/)
  const number = regex(/[0-9]+/)
  return {
    expr: choice(self.call, self.list, ident, number),
    call: sequence(ident, literal('('), optional(sepBy(self.expr, literal(','))), literal(')')),
    list: sequence(literal('['), sepBy(self.expr, literal(',')), literal(']')),
  }
})

toEBNF(g)
```

```ebnf
expr ::= call | list | /[a-zA-Z_][a-zA-Z0-9_]*/ | /[0-9]+/
call ::= /[a-zA-Z_][a-zA-Z0-9_]*/ "(" (expr ("," expr)*)? ")"
list ::= "[" expr ("," expr)* "]"
```

## Readable terminals

A raw `/[-\w]+/` isn't spec-grade. Two options make terminals readable:

**Per-regex prose** — `regexDisplay(source, flags)` returns a display string (or `undefined`
to fall back to `/source/`):

```ts
toEBNF(g, {
  regexDisplay: src =>
    src === '[0-9]+' ? 'INTEGER'
    : src.startsWith('[a-zA-Z_]') ? 'IDENT'
    : undefined,
})
// expr ::= call | list | IDENT | INTEGER
```

**Pin a whole rule to a name** — when a rule *is* a terminal, `terminals` renders it as that
name instead of expanding it:

```ts
toEBNF(g, { terminals: { Ident: 'identifier' } })
```

## Choosing what to emit

| Option | Effect |
|---|---|
| `root` | Start rule(s). Only these and the rules they reach are emitted. |
| `order` | Explicit rule order (and subset). |
| `includeTrivia` | Include trivia (whitespace/comment) rules. Default: elided. |

Reachability is a full closure: any rule referenced via `g.name` gets its own production,
even internal helpers that weren't returned from the factory.

```ts
buildSpecModel(g, { root: 'expr' })   // only expr, call, list
```

## Railroad diagrams

`toRailroadHtml(grammar, options)` returns a complete HTML document. Write it to a file and
open it, or serve it as a docs page:

```ts
import { writeFileSync } from 'node:fs'
import { toRailroadHtml } from 'parseman/spec'

writeFileSync('grammar.html', toRailroadHtml(grammar, { title: 'My language' }))
```

Every `SpecOptions` field (`root`, `order`, `terminals`, `regexDisplay`, `includeTrivia`) is
accepted here too, plus:

| Option | Effect |
|---|---|
| `title` | Page `<title>` and heading. Default: `"Grammar"`. |
| `showEbnf` | Show the EBNF production under each diagram. Default: `true`. |

## Scope

**Syntax only, not semantics.** A grammar defines *what parses*, not *what it means*. Scoping,
evaluation, guards, and the like remain hand-authored — but they can reference the generated
productions by name, and the syntax half stays honest automatically.

## Building a custom emitter

`buildSpecModel` returns a small tree (`SpecNode`) you can walk to emit any notation:

```ts
import { buildSpecModel } from 'parseman/spec'

const { productions } = buildSpecModel(grammar)
for (const { name, expr } of productions) {
  // expr is a SpecNode: seq | choice | star | plus | opt | sepBy | ref | terminal | not | …
}
```
