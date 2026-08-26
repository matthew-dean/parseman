# Grammar spec generation

Parséman grammars have no grammar file — the grammar *is* the TypeScript. That's great for
building parsers, but it removes the artifact people traditionally read to learn a
language: a grammar reference. `parseman/spec` regenerates that artifact straight from a
`rules()` grammar, so the spec is produced *from the parser itself* and can never drift
from what it actually parses.

It walks the same combinator tree (`_def`) that the interpreter and macro compiler
consume, so one emitter covers every grammar — interpreted or compiled — with no
mode-specific work.

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
| `word("@import")` / `keywords([…])` | the keyword(s), quoted — `"@import"` |
| `regex(/…/)` | terminal (see [readable terminals](#readable-terminals)) |
| `not(x)` | negation annotation `!x` |
| `node("T", …)`, `transform`, `token`, `field`, `label`, `withCtx`, `expect` | transparent — the inner syntax |
| `trivia(…)`, `gate(…)` | elided by default |

Precedence is handled for you: alternation binds loosest, then concatenation, then the
postfix operators. The renderer only adds parentheses where a looser construct sits inside
a tighter one.

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

```text
expr ::= call | list | /[a-zA-Z_][a-zA-Z0-9_]*/ | /[0-9]+/
call ::= /[a-zA-Z_][a-zA-Z0-9_]*/ "(" (expr ("," expr)*)? ")"
list ::= "[" expr ("," expr)* "]"
```

## Readable terminals

A spec reader's vocabulary is the language's own. MDN and the CSS specs write `@import`,
`<url>`, `<media-query-list>` — never the regex that recognizes them — and a generated
spec is held to that same bar.

Keywords render as keywords, automatically. `word('@import')` and `keywords([…])` are
keyword *sets*, so they emit the words themselves; a one-word set renders as a plain
terminal, not a one-arm alternation. The word-boundary guard that `word()` compiles in is
an implementation detail of recognition, not part of the language, so it's left out of the
diagram.

The same holds for a `regex()` that *is* really just a fixed string — including the
hand-written, boundary-guarded spelling of a keyword, which shows up a lot in ported
grammars:

```ts
regex(/@import(?![-_a-zA-Z0-9\u0080-\uFFFF])/i)  // → "@import"
regex(/\bin\b/)                                  // → "in"
regex(/>=|<=|>|<|=/)                             // → ">=" | "<=" | ">" | "<" | "="
```

This is more faithful, not a simplification — nothing gets collapsed, hidden, or elided,
and the terminal shows as the text it actually matches. Real regex structure still prints
raw: a character class, a quantifier, an interior group, or a positive lookahead (one that
constrains what follows, rather than just marking a word boundary). A diagram exists to
make grammar complexity visible, not hide it:

```ts
regex(/[-+]/)                       // → /[-+]/
regex(/,[ \t\n\r\f]*/)              // → /,[ \t\n\r\f]*/
regex(/nth-(?:last-)?child(?=\()/)  // → /nth-(?:last-)?child(?=\()/
```

For a genuine pattern with no fixed form, you have two ways to make it readable.

`regexDisplay(source, flags)` lets you supply per-regex prose — it returns a display
string, or `undefined` to fall back to `/source/`:

```ts
toEBNF(g, {
  regexDisplay: src =>
    src === '[0-9]+' ? 'INTEGER'
    : src.startsWith('[a-zA-Z_]') ? 'IDENT'
    : undefined,
})
// expr ::= call | list | IDENT | INTEGER
```

Or pin a whole rule to a name: when a rule *is* a terminal, the `terminals` option renders
it as that name instead of expanding it:

```ts
toEBNF(g, { terminals: { Ident: 'identifier' } })
```

## Choosing what to emit

| Option | Effect |
|---|---|
| `sort` | Ordering when neither `order` nor `root` is set. `'source'` (default) or `'reachable'`. |
| `root` | Start rule(s). Only these and the rules they reach are emitted. |
| `order` | Explicit rule order (and subset). |
| `includeTrivia` | Include trivia (whitespace/comment) rules. Default: elided. |

Reachability is a full closure — any rule referenced via `g.name` gets its own production,
even internal helpers that weren't returned from the factory.

```ts
buildSpecModel(g, { root: 'expr' })   // only expr, call, list
```

### Ordering

By default, productions are emitted in declaration order — the order you wrote the rules
in your `rules()` factory. It's the most predictable ordering, it includes every rule, and
it leads with your entry rule, since you write that first. This matters because a
`rules()` grammar internally returns its rules in *reference-creation* order, not the
order you declared them — the spec recovers your original order for you.

Pass `sort: 'reachable'` for a top-down "grammar reference" ordering instead: the entry
rule (whichever you declared first) leads, each rule is introduced the first time
something references it, and any rules unreachable from the entry trail at the end.

```ts
// rules declared as [expr, zzz, term], where expr references term:
toEBNF(g)                      // expr, zzz, term   (declaration order)
toEBNF(g, { sort: 'reachable' })  // expr, term, zzz   (term introduced at first use)
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

### Embedding a single diagram

`toRailroadHtml` gives you a whole page. To drop a diagram into an existing page — a docs
site, a README, an MDX component — use `toRailroadSvg` instead. It returns one static,
self-contained SVG string per production, with no client script and no DOM:

```ts
import { toRailroadSvg, RAILROAD_CSS } from 'parseman/spec'

for (const { name, svg } of toRailroadSvg(grammar)) {
  // `svg` is ready to inline; style it with RAILROAD_CSS (scope it to a wrapper).
}
```

Here's one rule from a small JSON grammar — `Array = "[" (Value ("," Value)*)? "]"` —
rendered exactly this way and inlined below. The loop is the `sepBy(Value, ",")`; the
bypass around it is the `optional(…)`:

<!--@include: ./_railroad-example.md-->

That's just one production — a real grammar gets one diagram per rule. See the
[full JSON example](../railroad-example.html){target="_self"} for every rule (`Value`,
`Object`, `Member`, `Array`) with its EBNF caption, generated by `toRailroadHtml` and
served as a standalone page. Since both come from the same `rules()` grammar, neither can
drift from what actually parses.

## Scope

**Syntax only, not semantics.** A grammar defines *what parses*, not *what it means*.
Scoping, evaluation, guards, and the like stay hand-authored — but they can reference the
generated productions by name, so the syntax half stays honest automatically.

## Building a custom emitter

`buildSpecModel` returns a small tree (`SpecNode`) you can walk to emit any notation:

```ts
import { buildSpecModel } from 'parseman/spec'

const { productions } = buildSpecModel(grammar)
for (const { name, expr } of productions) {
  // expr is a SpecNode: seq | choice | star | plus | opt | sepBy | ref | terminal | not | …
}
```
