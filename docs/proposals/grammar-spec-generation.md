# Proposal: Grammar spec generation

**Status:** proposal · **Author:** (drafted for discussion) · **Scope:** new tooling capability, no breaking changes

Generate a formal, human-readable **grammar specification** (EBNF + optional railroad
diagrams + a reference page) directly from a Parséman `rules()` grammar — so a language's
syntax spec is produced *from the parser itself* and can never drift from the implementation.

## Motivation

Parséman's pitch is "no grammar files, no generated output to check in" — the grammar *is*
the TypeScript. That's great for building parsers, but it removes the artifact people
traditionally read to learn a language: a grammar reference. Today you either read the
parser source or hand-write a spec that immediately starts drifting.

Because a `rules()` grammar is **structured, machine-readable data** — named rules composed
from a small, fixed set of combinators — we can walk it and emit a formal spec. The payoff is
**single source of truth**: the spec is generated from the same rule tree the interpreter and
macro compiler consume, so it cannot disagree with what actually parses.

### Concrete driver: a formal `.jess` language spec

The Jess language (a Less/SCSS superset with its own strict rules — e.g. media-query-style
condition grouping, where mixing `and`/`or` requires explicit parentheses) needs a canonical
syntax reference. Hand-maintaining it against an evolving grammar is exactly the drift problem
above. Generating it from `jess-parser`'s `rules()` keeps the spec honest — and because the
`.jess` grammar is deliberately still growing, a generated spec *accurately reflects what is
implemented today* and expands as the grammar does, rather than promising syntax that doesn't
parse yet.

## What it produces

1. **EBNF (or W3C-style) grammar text** — one production per named rule.
2. **A rendered reference page** — each rule, its production, and cross-links to referenced
   rules. Drops straight into a docs site.
3. **(Optional) railroad diagrams** — EBNF feeds existing railroad generators.
4. **(Optional) a drift check** — diff the generated spec against a hand-written language doc
   in CI, so doc-vs-grammar divergence fails the build.

## Sketch

A pure function over the grammar structure — no parsing, no runtime:

```ts
import { toEBNF } from 'parseman/spec' // or spec(grammar, { format, includeTrivia })

const ebnf = toEBNF(lessGrammar)      // string of EBNF productions
```

The emitter walks the same rule structure the interpreter/compiler already consume; each
combinator maps to an EBNF construct:

| `rules()` combinator | EBNF |
|---|---|
| `sequence(a, b, …)` | concatenation `a b …` |
| `choice(a, b, …)` | alternation `a \| b \| …` |
| `star(x)` / `opt(x)` / `plus(x)` | `x*` / `x?` / `x+` |
| named rule reference | non-terminal by name |
| `token` / `regex` / literal | terminal (see "readable terminals" below) |
| `node(…)` | named production (the node's rule name) |
| trivia establishers (`rules({trivia})`, `parser({trivia})`) | annotation, or elided (see below) |

## Scope & caveats (name these up front)

- **Syntax only, not semantics.** A grammar defines *what parses*, not *what it means*.
  A full language spec still needs hand-authored semantics (scoping, evaluation, guards,
  extend, etc.). The generator produces the syntax half cleanly; semantics live elsewhere and
  can reference the generated productions.
- **Readable terminals.** Regex/token terminals need a readable rendering — a raw
  `/[-\w]+/` isn't spec-grade. Options: a caller-supplied display name per token, or a
  best-effort regex→prose lowering (Parséman already reasons about regex shapes for
  macro-compilation; some of that could be reused).
- **Trivia & precedence.** Trivia establishers are implementation detail, not language
  syntax — default to eliding them (with an `includeTrivia` opt-in). Precedence expressed via
  rule layering (e.g. `Or → And → Not → comparison → operand`) emits faithfully as nested
  productions; whether to *collapse* those into precedence annotations is a formatting choice.
- **Error-recovery** constructs should be elided or annotated, not shown as language syntax.
- **One emitter, both modes.** The interpreted and macro-compiled paths share the same
  `rules()` structure, so a single emitter covers every grammar with no mode-specific work.

## Open questions

- Notation: EBNF vs W3C-railroad-EBNF vs a custom Parséman notation?
- Terminal rendering: caller-named tokens (simplest, most readable) vs automatic regex prose?
- Include trivia by default, or opt-in only?
- Emit precedence as nested productions (faithful) or collapse to annotations (readable)?
- Ship as `parseman/spec` subpath, a CLI (`parseman spec grammar.ts`), or both?

## Relationship to existing docs

The current `docs/guide` + `docs/reference` document **Parséman itself**. This proposal is
orthogonal: tooling to generate specs for the **user grammars** built *with* Parséman
(CSS/Less/SCSS/Jess, and anyone else's). It would likely live as a new guide page
(`guide/spec-generation.md`) once implemented, plus the `parseman/spec` entry in the API
reference.
