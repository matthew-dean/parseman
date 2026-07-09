---
pageClass: comparison-page
---

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
  that compile to flat JS (as a library, at runtime with `compile()`, or build-time via
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
| **Parséman** | JS/TS combinators | PEG-style ordered choice | library · `compile()` · build macro | object CST/AST **+ spans + trivia**, or plain JS values |
| [Peggy](https://peggyjs.org/) | PEG text DSL | PEG (packrat opt-in) | codegen | whatever your actions return |
| [Parsimmon](https://github.com/jneen/parsimmon) | JS combinators | PEG-style ordered choice | runtime library | whatever you build |
| [Chevrotain](https://chevrotain.io/) | JS imperative DSL | LL(k) + backtracking | runtime library | automatic CST, or visitor output |
| [Nearley](https://nearley.js.org/) | BNF text DSL | Earley (general CFG) | codegen (`nearleyc`) | postprocessor output (may be ambiguous) |
| [Jison](https://github.com/zaach/jison) | Yacc/BNF text DSL | LALR(1) | codegen | whatever your actions return |
| [Lezer](https://lezer.codemirror.net/) | LR text DSL | LR (opt-in GLR) | codegen (`@lezer/generator`) | compact buffer `Tree` |
| [tree-sitter](https://tree-sitter.github.io/tree-sitter/) | JS DSL → generated C | GLR | codegen → C / WASM | buffer CST (via bindings) |

## Capabilities

| Parser | Author in JS/TS | Debuggable grammar | Context-sensitive grammar | Grammar composition | Incremental re-parse | Error recovery | Trivia capture |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Parséman** | ✅ | ✅ | ✅ in-grammar | ✅ `compose()` | ✅ `parseDoc` | ✅ `recover` + auto lists | ✅ built-in `triviaLog` |
| [Peggy](https://peggyjs.org/) | ❌ text DSL | ⚠️ generated JS + trace | ✅ in-grammar | ❌ | ❌ | ⚠️ location only | ❌ manual |
| [Parsimmon](https://github.com/jneen/parsimmon) | ✅ | ✅ | ✅ in-grammar | ⚠️ values | ❌ | ❌ | ❌ manual |
| [Chevrotain](https://chevrotain.io/) | ✅ | ✅ | ✅ in-grammar | ✅ inheritance | ⚠️ DIY, no engine | ✅ strong (automatic) | ⚠️ tokens, manual |
| [Nearley](https://nearley.js.org/) | ❌ text DSL | ❌ | ❌ CFG only | ❌ | ❌ | ❌ | ❌ manual |
| [Jison](https://github.com/zaach/jison) | ❌ text DSL | ❌ | ⚠️ lexer states | ❌ | ❌ | ⚠️ error token | ❌ manual |
| [Lezer](https://lezer.codemirror.net/) | ❌ text DSL | ❌ | ⚠️ external only | ⚠️ `@dialect` | ✅✅ core strength | ✅ | ✅ contextual skip |
| [tree-sitter](https://tree-sitter.github.io/tree-sitter/) | ⚠️ JS → C | ❌ | ⚠️ external only | ❌ | ✅✅ core strength | ✅ | ⚠️ `extras` |

**Legend:**

- **Author in JS/TS** — the grammar is written in JavaScript/TypeScript, not a separate
  text-DSL file compiled by a generator. tree-sitter's `grammar.js` is JS, but it
  *generates a C parser* (with C scanners), hence ⚠️.
- **Debuggable grammar** — you can step the parse in your language's ordinary debugger
  (breakpoints, real stack traces) and read the parser *as code*, rather than debugging a
  generated state table or a parser in another language. Runtime combinator/DSL libraries
  qualify; generators mostly don't — Peggy emits JS you *can* trace, hence ⚠️.
- **Context-sensitive grammar** — **✅ in-grammar**: express context directly (semantic
  predicates or arbitrary parse-time state), no escape hatch. **⚠️ external only**:
  possible, but *only* via a hand-written tokenizer/scanner (token-level state) or lexer
  start-conditions — not the grammar rules themselves. **❌**: context-free only.
- **Grammar composition** — build a grammar by extending/overriding another's rules.
  **✅** first-class: Parséman [`compose([base, delta])`](./extending) overrides rules by
  name — across packages, with no base source needed; Chevrotain subclasses a grammar and
  `OVERRIDE_RULE`. **⚠️**: Parsimmon parsers are values you can combine, but there's no
  named-rule override; Lezer `@dialect` toggles token sets, not rule composition. **❌**:
  no mechanism — each grammar stands alone.
- **Incremental re-parse** — **✅✅** built for it (buffer-tree fragment reuse); **✅**
  first-class API; **⚠️ DIY, no engine**: no built-in edit-reuse, but the pieces exist to
  roll your own; **❌**: re-parses from scratch.
- **Error recovery** — Parséman recovers at resync points you **mark explicitly**
  (`recover` / `expect`), plus automatic tolerant lists (`sepByRecover` / `manyRecover`);
  Chevrotain's is **automatic/heuristic across the whole grammar** (single-token
  insert/delete, resync). Both report every error, not just the first.

## The context-sensitivity axis

This axis is easy to miss and hard to retrofit.

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

**Neither tree-sitter nor Lezer lets you write a context-sensitive *grammar*.** Both let
you write a context-sensitive *tokenizer* in a separate language (C) or module (JS) — a
different and lower-level tool. For token-level needs (indentation, heredocs) that's fine;
for rule-level context (a construct that's only legal *here*) it's a poor fit.

### Context-free only (Nearley, Jison)

Nearley is a pure Earley parser — great when you *want* ambiguity (natural language,
exploratory grammars), but with no in-grammar context mechanism. Jison offers lexer
**start conditions** (a stateful lexer), which cover some tokenizer-level cases but not
general rule-level context.

## The incremental re-parse axis

Editors re-parse on every keystroke, and here the buffer-tree generators shine — this is
what Lezer and tree-sitter were built for. Parséman also re-parses incrementally
([`parseDoc`](./incremental)), but with a different cost profile: its plain
object tree with absolute spans makes **in-place value edits** (overtyping, extending a
token — the common keystroke) close to free and ahead of Lezer, while **structural
edits** in a large collection favor Lezer/tree-sitter fragment reuse. The
[incremental benchmark](./benchmarks#incremental-re-parse) has the numbers and the
tradeoff.

The other parsers don't ship an incremental **engine**. Chevrotain is the closest: it has
no built-in edit-reuse (its incremental-parser tracking issues,
[#843](https://github.com/Chevrotain/chevrotain/issues/843) /
[#844](https://github.com/Chevrotain/chevrotain/issues/844), were closed unimplemented),
but its stateful parser instance — individually invokable rules, `reset()`, and partial
CSTs from error recovery — gives you the building blocks to hand-roll reuse externally.
Peggy, Parsimmon, Nearley, and Jison offer nothing here and re-parse from scratch. Note
that Chevrotain's real edit-time strength is a *different* axis — fault-tolerant error
recovery in a single pass, covered below — not incremental re-parse.

## The developer-experience axis

Two related axes decide how a grammar *feels* to build and maintain: what language you
write it in, and whether you can debug it with the tools you already have.

Parser **generators** — Peggy, Nearley, Jison, Lezer, tree-sitter — take a grammar in a
dedicated text DSL and emit a parser: JS for most, C for tree-sitter. That buys them
speed and (for Lezer/tree-sitter) incremental buffer trees, but the artifact you run isn't
the grammar you wrote. When something goes wrong you're reading a generated state table or
stepping through code in another language; a breakpoint in the output rarely maps back to a
grammar rule.

Parser **libraries** authored in JS/TS — Parséman, Parsimmon, Chevrotain — keep the
grammar *as code you run directly*. You set breakpoints in your own rules, read real stack
traces, and print values inline, with no generator in the loop.

Parséman sits in a spot of its own: it's authored and debugged in TypeScript **like a
library**, but its [`compile()` / macro build](./modes) reaches generator-class speed —
and, unusually, the **compiled output stays readable JS you can still breakpoint**, so you
don't trade away debuggability to go fast. See
[Debugging compiled grammars](./modes#debugging-compiled-grammars). (tree-sitter's
`grammar.js` is JavaScript, but it *describes* a parser that's generated in C — authoring
in JS isn't the same as debugging in JS, which is why it's ⚠️/❌ on those two columns.)

## Where other tools go further

Parséman's bet is a small, JS-native core aimed at speed, an editor-grade CST, in-grammar
context, and first-class incremental re-parse for value edits. That means it deliberately
skips a lot of surface area other tools have.

**[Chevrotain](https://chevrotain.io/)** is the most feature-dense toolkit here, with
several things Parséman doesn't offer:

- **Railroad / syntax-diagram generation** straight from the grammar.
- **Grammar introspection** — a serializable grammar AST (from its self-analysis phase)
  that tooling can consume; Parséman has no equivalent reflection API.
- A **separate, configurable lexer** with stack-based **modes**, **token categories**
  (polymorphic tokens), and `longer_alt` — Parséman is scannerless, so none of this
  applies (a simplification, but also a missing capability if you want it).
- **Per-rule-typed CST visitor base classes** (`getBaseCstVisitor…`) generated from the
  grammar. Parséman's [`walk` / `createVisitor`](./ast#walking-the-tree) cover the same
  traversal at runtime, dispatching on a node's `type`, but don't hand you a class typed
  per rule.
- **Configurable LL(k) lookahead** and opt-in `BACKTRACK`.
- **Grammar-wide automatic error recovery** (heuristic single-token insert/delete +
  resync, with no annotation anywhere). Parséman recovers at resync points you mark
  explicitly (`recover` / `expect`), plus automatic tolerant lists
  ([`sepByRecover` / `manyRecover`](./error-recovery#tolerant-lists)); it doesn't recover
  across arbitrary rules on its own.

**[Lezer](https://lezer.codemirror.net/) / [tree-sitter](https://tree-sitter.github.io/tree-sitter/)**
win on **structural-edit incremental** (buffer-tree fragment reuse), **GLR / ambiguity**,
and — especially tree-sitter — an enormous library of **existing, battle-tested grammars**
reused across editors (Neovim, GitHub, and more). If a maintained grammar for your
language already exists there, that's hard to beat.

**[Nearley](https://nearley.js.org/)** does **true ambiguous parsing** (returns *every*
valid parse), which ordered-choice parsers (Parséman, Peggy, Parsimmon) structurally
cannot.

If you need that breadth, reach for the tool that has it. Parséman optimizes for a
different point: fewest moving parts, authored and debugged in TypeScript, fast, with a
rich CST and context sensitivity.

## Which to reach for

- **Parséman** — you want the **fastest** JS value parser *and* an editor-grade CST with
  spans and trivia, with **context-sensitive rules** and incremental re-parse — authored
  and **debugged in TypeScript** (no separate grammar file, no generated artifact to step
  through), with no build step required and generator-class speed when you want it.
- **[Peggy](https://peggyjs.org/)** — a quick, readable PEG DSL for a config language or
  small DSL where a text grammar file is the deliverable.
- **[Parsimmon](https://github.com/jneen/parsimmon)** — a tiny combinator parser with no
  build step and modest performance needs.
- **[Chevrotain](https://chevrotain.io/)** — a batteries-included toolkit (railroad
  diagrams, grammar introspection, lexer modes, grammar-wide automatic error recovery)
  with best-in-class fault tolerance, when you want breadth and don't need incremental
  re-parse or full-fidelity trivia.
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
