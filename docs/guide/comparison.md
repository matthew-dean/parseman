# How Parséman compares

There are a lot of JavaScript parsing tools, and they optimize for different things. This
page is an honest side-by-side of the ones Parséman is most often weighed against, across
the axes that actually decide which one fits your project. For raw speed numbers, see
[Benchmarks](./benchmarks); this page is about **capabilities**.

Two questions sort most of the field:

1. **What do you get out?** Plain JS values (objects, rows, AST nodes), or a full
   **syntax tree** (every token and its span) for an editor / formatter / linter.
2. **How do you express the grammar, and what can it express?** In particular, can the
   grammar itself be **context-sensitive** — where what parses depends on where you are —
   or is that only reachable by dropping to hand-written tokenizer code?

## The parsers

- **[Parséman](https://github.com/matthew-dean/parseman)** — parser combinators in JS/TS
  that compile to flat JS (as a library, at runtime with `.compile()`, or build-time via
  the [macro](./macro-mode)).
- **[Peggy](https://peggyjs.org/)** — the maintained successor to PEG.js; a PEG grammar
  DSL that generates a parser.
- **[Parsimmon](https://github.com/jneen/parsimmon)** — small parser-combinator library,
  interpreted at runtime.
- **[Chevrotain](https://chevrotain.io/)** — fast LL(k) parsing toolkit with a JS DSL,
  automatic CST, and strong error recovery.
- **[Nearley](https://nearley.js.org/)** — Earley parser (handles ambiguous / general
  context-free grammars) with a BNF-style DSL.
- **[Jison](https://github.com/zaach/jison)** — Bison/Yacc-style LALR(1) generator.
- **[Lezer](https://lezer.codemirror.net/)** — the incremental LR parser behind
  [CodeMirror 6](https://codemirror.net/); emits a compact buffer tree.
- **[tree-sitter](https://tree-sitter.github.io/tree-sitter/)** — GLR parser generator
  (C core, WASM/native bindings) built for editor tooling; incremental by design.

## Authoring & output

| Parser | Grammar style | Algorithm | Delivery | Output |
| --- | --- | --- | --- | --- |
| **Parséman** | JS/TS combinators | PEG-style ordered choice | library · `.compile()` · build macro | object CST/AST **+ spans + trivia**, or plain JS values |
| [Peggy](https://peggyjs.org/) | PEG text DSL | PEG (packrat opt-in) | codegen | whatever your actions return |
| [Parsimmon](https://github.com/jneen/parsimmon) | JS combinators | PEG-style ordered choice | runtime library | whatever you build |
| [Chevrotain](https://chevrotain.io/) | JS imperative DSL | LL(k) + backtracking | runtime library | automatic CST, or visitor output |
| [Nearley](https://nearley.js.org/) | BNF text DSL | Earley (general CFG) | codegen (`nearleyc`) | postprocessor output (may be ambiguous) |
| [Jison](https://github.com/zaach/jison) | Yacc/BNF text DSL | LALR(1) | codegen | whatever your actions return |
| [Lezer](https://lezer.codemirror.net/) | LR text DSL | LR (opt-in GLR) | codegen (`@lezer/generator`) | compact buffer `Tree` |
| [tree-sitter](https://tree-sitter.github.io/tree-sitter/) | JS DSL → generated C | GLR | codegen → C / WASM | buffer CST (via bindings) |

## Capabilities

| Parser | Context-sensitive grammar | Incremental re-parse | Error recovery | Trivia capture | Ambiguity |
| --- | --- | --- | --- | --- | --- |
| **Parséman** | ✅ in-grammar | ✅ `makeFunctionalDoc` | ✅ `recover` | ✅ built-in `triviaLog` | ordered choice |
| [Peggy](https://peggyjs.org/) | ✅ in-grammar | ❌ | ⚠️ location only | ❌ manual | ordered choice |
| [Parsimmon](https://github.com/jneen/parsimmon) | ✅ in-grammar | ❌ | ❌ | ❌ manual | ordered choice |
| [Chevrotain](https://chevrotain.io/) | ✅ in-grammar | ❌ | ✅ strong | ⚠️ tokens, manual | LL(k) |
| [Nearley](https://nearley.js.org/) | ❌ CFG only | ❌ | ❌ | ❌ manual | ✅ returns all parses |
| [Jison](https://github.com/zaach/jison) | ⚠️ lexer states | ❌ | ⚠️ error token | ❌ manual | LALR(1) |
| [Lezer](https://lezer.codemirror.net/) | ⚠️ external only | ✅✅ core strength | ✅ | ✅ contextual skip | opt-in GLR |
| [tree-sitter](https://tree-sitter.github.io/tree-sitter/) | ⚠️ external only | ✅✅ core strength | ✅ | ⚠️ `extras` | GLR |

**Legend — context-sensitive grammar:**

- **✅ in-grammar** — you express context directly in the grammar: semantic predicates or
  arbitrary parse-time state, no escape hatch required.
- **⚠️ external only** — possible, but *only* by dropping to a hand-written tokenizer /
  scanner (token-level state), or lexer start-conditions. Not expressible in the grammar
  rules themselves.
- **❌** — context-free grammars only.

## The context-sensitivity axis

This is the axis that's easy to miss and hard to retrofit, so it's worth spelling out.

Real languages aren't purely context-free: `return` is only legal inside a function body,
a here-doc's terminator depends on its opening line, indentation changes meaning, a CSS
`&` means something different inside a nesting block, an `@extend` target only resolves in
a matching scope. Parsers split into three camps on how they handle this.

### In-grammar (Parséman, Peggy, Parsimmon, Chevrotain)

The grammar can consult and thread state as it parses:

- **Parséman** — [`withCtx`](./context) merges state for a sub-parse, [`guard`](./context)
  gates a rule on a predicate, and `choice` arms can be **gated** on context. Crucially,
  each node records the `ctx.state` snapshot it parsed under, so
  [incremental re-parsing](./incremental) can replay the *exact* context a rule saw the
  first time — context sensitivity and incremental re-parse coexist.
- **Peggy** — semantic predicates (`&{ … }` / `!{ … }`) run JS mid-parse against labeled
  values.
- **Parsimmon** — `.chain(fn)` picks the next parser from what was already matched
  (monadic context).
- **Chevrotain** — `GATE` predicates enable/disable alternatives based on runtime state.

### External only (Lezer, tree-sitter)

Both are LR/GLR generators tuned for incremental editors, and both are deliberately
context-*free* at the grammar level. When a language genuinely needs state, you leave the
grammar and write code:

- **tree-sitter** — an [external scanner in **C**](https://tree-sitter.github.io/tree-sitter/creating-parsers/4-external-scanners.html):
  five C functions that keep custom state (e.g. an indentation stack) and hand-roll
  token recognition. It's the documented, only path for context-sensitive tokens — there
  are no semantic predicates in the grammar.
- **Lezer** — an
  [`ExternalTokenizer`](https://lezer.codemirror.net/docs/guide/#external-tokens) plus a
  `@context` **ContextTracker** (immutable state updated on shift/reduce). It's more
  ergonomic than C, but it's still token-level state living *outside* the grammar rules,
  and the context has to expose a `hash` so incremental reuse stays correct.

So the intuition holds: **neither tree-sitter nor Lezer lets you write a context-sensitive
*grammar*.** They let you write a context-sensitive *tokenizer* in a separate language
(C) or module (JS), which is a different and lower-level tool. For token-level needs
(indentation, heredocs) that's fine; for rule-level context (this construct is only legal
*here*) it's a poor fit.

### Context-free only (Nearley, Jison)

Nearley is a pure Earley parser — great when you *want* ambiguity (natural language,
exploratory grammars), but with no in-grammar context mechanism. Jison offers lexer
**start conditions** (a stateful lexer), which cover some tokenizer-level cases but not
general rule-level context.

## The incremental re-parse axis

Editors re-parse on every keystroke, and here the buffer-tree generators shine — this is
what Lezer and tree-sitter were built for. Parséman also re-parses incrementally
([`makeFunctionalDoc`](./incremental)), but with a different cost profile: its plain
object tree with absolute spans makes **in-place value edits** (overtyping, extending a
token — the common keystroke) close to free and ahead of Lezer, while **structural
edits** in a large collection favor Lezer/tree-sitter fragment reuse. The
[incremental benchmark](./benchmarks#incremental-re-parse) has the numbers and the
tradeoff. None of the pure value/DSL parsers (Peggy, Parsimmon, Chevrotain, Nearley,
Jison) re-parse incrementally at all.

## Which to reach for

- **Parséman** — you want the **fastest** JS value parser *and* an editor-grade CST with
  spans and trivia, with **context-sensitive rules** and incremental re-parse, all in
  plain TypeScript with no build step required.
- **[Peggy](https://peggyjs.org/)** — a quick, readable PEG DSL for a config language or
  small DSL where a text grammar file is the deliverable.
- **[Parsimmon](https://github.com/jneen/parsimmon)** — a tiny combinator parser with no
  build step and modest performance needs.
- **[Chevrotain](https://chevrotain.io/)** — a hand-tunable parser with best-in-class
  error recovery and you don't need incremental re-parse.
- **[Nearley](https://nearley.js.org/)** — genuinely **ambiguous** or natural-language
  grammars where you want every valid parse.
- **[Jison](https://github.com/zaach/jison)** — porting an existing Yacc/Bison LALR
  grammar.
- **[Lezer](https://lezer.codemirror.net/)** — you're building a **CodeMirror 6**
  language; it's the native, best-fit choice for that editor.
- **[tree-sitter](https://tree-sitter.github.io/tree-sitter/)** — you need one grammar
  reused across many editors and languages (Neovim, GitHub, etc.), and you're willing to
  ship a C scanner for the context-sensitive parts.

> The matrix reflects each tool's documented, first-class capabilities as of writing;
> most can be pushed further with enough custom code. If something's out of date or unfair,
> [open an issue](https://github.com/matthew-dean/parseman/issues) — corrections welcome.
