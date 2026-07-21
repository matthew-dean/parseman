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

|  | **Parséman** | [Peggy](https://peggyjs.org/) | [Parsimmon](https://github.com/jneen/parsimmon) | [Chevrotain](https://chevrotain.io/) | [Nearley](https://nearley.js.org/) | [Jison](https://github.com/zaach/jison) | [Lezer](https://lezer.codemirror.net/) | [tree-sitter](https://tree-sitter.github.io/tree-sitter/) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Grammar style** | JS/TS combinators | PEG text DSL | JS combinators | JS imperative DSL | BNF text DSL | Yacc/BNF text DSL | LR text DSL | JS DSL → generated C |
| **Algorithm** | PEG-style ordered choice | PEG (packrat opt-in) | PEG-style ordered choice | LL(k) + backtracking | Earley (general CFG) | LALR(1) | LR (opt-in GLR) | GLR |
| **Delivery** | library · `compile()` · build macro | codegen | runtime library | runtime library | codegen (`nearleyc`) | codegen | codegen (`@lezer/generator`) | codegen → C / WASM |
| **Output** | object CST/AST **+ spans + trivia**, or plain JS values | whatever your actions return | whatever you build | automatic CST, or visitor output | postprocessor output (may be ambiguous) | whatever your actions return | compact buffer `Tree` | buffer CST (via bindings) |

## Capabilities

|  | **Parséman** | [Peggy](https://peggyjs.org/) | [Parsimmon](https://github.com/jneen/parsimmon) | [Chevrotain](https://chevrotain.io/) | [Nearley](https://nearley.js.org/) | [Jison](https://github.com/zaach/jison) | [Lezer](https://lezer.codemirror.net/) | [tree-sitter](https://tree-sitter.github.io/tree-sitter/) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Author in JS/TS** | ✅ | ❌ text DSL | ✅ | ✅ | ❌ text DSL | ❌ text DSL | ❌ text DSL | ⚠️ JS → C |
| **Debuggable grammar** | ✅ | ⚠️ generated JS + trace | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Grammar coverage / trace** | ✅ opt-in structural coverage + bounded trace | — | — | — | — | — | — | — |
| **Context-sensitive grammar** | ✅ in-grammar | ✅ in-grammar | ✅ in-grammar | ✅ in-grammar | ❌ CFG only | ⚠️ lexer states | ⚠️ external only | ⚠️ external only |
| **Grammar composition** | ✅ `compose()` | ❌ | ⚠️ values | ✅ inheritance | ❌ | ❌ | ⚠️ `@dialect` | ❌ |
| **Incremental re-parse** | ✅ `parseDoc` | ❌ | ❌ | ⚠️ DIY, no engine | ❌ | ❌ | ✅✅ core strength | ✅✅ core strength |
| **Error recovery** | ✅ auto lists, interp **+ compiled** | ⚠️ location only | ❌ | ✅ strong (automatic) | ❌ | ⚠️ error token | ✅ | ✅ |
| **Trivia capture** | ✅ built-in `triviaLog` | ❌ manual | ❌ manual | ⚠️ tokens, manual | ❌ manual | ❌ manual | ✅ contextual skip | ⚠️ `extras` |
| **Diagrams / EBNF** | ✅ railroad + EBNF (`parseman/spec`) | ⚠️ railroad (`peggy-tracks`, separate pkg) | ❌ | ✅ railroad | ✅ railroad (`nearley-railroad`) | ❌ | ❌ | ❌ |

**Legend:**

- **Author in JS/TS** — the grammar is written in JavaScript/TypeScript, not a separate
  text-DSL file compiled by a generator. tree-sitter's `grammar.js` is JS, but it
  *generates a C parser* (with C scanners), hence ⚠️.
- **Debuggable grammar** — you can step the parse in your language's ordinary debugger
  (breakpoints, real stack traces) and read the parser *as code*, rather than debugging a
  generated state table or a parser in another language. Runtime combinator/DSL libraries
  qualify; generators mostly don't — Peggy emits JS you *can* trace, hence ⚠️.
- **Grammar coverage / trace** — Parséman can record successful named rules,
  choice arms, and labels plus a bounded semantic lifecycle trace. This row is
  intentionally not a claim that the other tools lack test-runner coverage,
  debugger support, or separate observability integrations; it compares the
  built-in Parseman grammar-level API documented in
  [Grammar observability](./grammar-observability).
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
- **Error recovery** — Parséman recovers at resync points that are **inferred from the
  enclosing combinator** (a list's separator / its enclosing delimiter) under a `tolerant`
  flag, plus explicit `expect` for required tokens — and it runs on **both** the
  interpreter and the **compiled/macro fast path** (`compile(g, { recovery: true })`), so
  an editor gets recovery on the same artifact it ships. The grammar itself carries **no**
  recovery annotation; editor policy (completions, diagnostics) lives in an external
  [`languageService`](./editor-integration) layer. Chevrotain's recovery is
  **automatic/heuristic across the whole grammar** (single-token insert/delete, resync).
  Both report every error, not just the first.
- **Diagrams / EBNF** — can the tool emit a human-readable grammar artifact *from the
  grammar itself*? (Any grammar can be hand-translated to EBNF and pasted into a generic
  online generator; that doesn't count.) **✅**: Parséman's
  [`parseman/spec`](./spec-generation) generates both W3C-style **EBNF** text and
  self-contained **railroad diagrams**; Chevrotain (`createSyntaxDiagramsCode`) and Nearley
  (`nearley-railroad`) ship railroad generators that read the grammar directly. **⚠️**:
  Peggy has `peggy-tracks` (maintained under the peggyjs org, but a separate package).
  **❌**: no first-class generator — Parsimmon has no grammar artifact to walk in the
  first place, and Jison, Lezer, and tree-sitter reach diagrams only by converting to EBNF
  and feeding an external tool.

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
([`parseDoc`](./incremental)) and stays competitive: its plain object tree stores
**parent-relative** spans, so **in-place value edits** (overtyping, extending a token — the
common keystroke) are close to free and well ahead of Lezer, and **structural edits** in a
large collection reuse the untouched tail elements by identity (opt-in `structuralReuse`),
landing within a small factor of Lezer/tree-sitter fragment reuse rather than at
full-reparse cost. The [incremental benchmark](./benchmarks#incremental-re-parse) has the
numbers and the tradeoff.

The other parsers don't ship an incremental **engine**. Chevrotain is the closest: it has
no built-in edit-reuse (its incremental-parser tracking issues,
[#843](https://github.com/Chevrotain/chevrotain/issues/843) /
[#844](https://github.com/Chevrotain/chevrotain/issues/844), were closed unimplemented),
but its stateful parser instance — individually invokable rules, `reset()`, and partial
CSTs from error recovery — gives you the building blocks to hand-roll reuse externally.
Peggy, Parsimmon, Nearley, and Jison offer nothing here and re-parse from scratch. Note
that Chevrotain's real edit-time strength is a *different* axis — fault-tolerant error
recovery in a single pass, covered below — not incremental re-parse.

## The editor-backend axis

Powering an editor is more than parsing: a language server has to survive a broken
keystroke (recovery), answer *what can go here* (completions), flag problems
(diagnostics), and do all of it fast enough to run on every edit. The editor-first
generators own this by being context-*free* and generating a buffer tree in a separate
artifact. Parséman gets there from its own pieces, with three properties they don't have:

- **It runs on the fast path.** Recovery and the completions probe are emitted into the
  **compiled/macro** parser (`compile(g, { recovery: true })`), not just the interpreter —
  so the artifact an editor ships recovers and answers completions itself. Strict compiles
  stay byte-identical (recovery is a dormant, opt-in branch).
- **Recovery and incremental re-parse are one pipeline.** The
  [`languageService`](./editor-integration) opens an **incremental document**: an edit
  re-parses only the changed span, the tree survives a broken keystroke, and — because a
  recovered error is a `parseError` node *in the CST* — diagnostics ride the reused
  subtrees instead of being recomputed from scratch.
- **The grammar stays pure; editor behaviour hooks on from outside.** That
  `languageService(grammar, config)` layer — a tree-shakeable `parseman/language-service`
  subpath — supplies semantic completions and lint diagnostics **keyed by node type**,
  over a grammar that never learns the editor exists. The same grammar file serves a batch
  value-parse and an LSP, unedited. Contrast Chevrotain, whose recovery and content-assist
  are capable but live *inside* the parser class, and Lezer/tree-sitter, whose context and
  tokenizer hooks live in a separate module but are still coupled to the generated grammar.

Where the generators still lead: Lezer/tree-sitter win **structural-edit** incremental and
the reuse of an existing grammar (below). The task Parséman covers end to end is
*authoring a new language's editor support* — recover, complete, diagnose, on a fast
compiled parser, with in-grammar context and JS values out.

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

- **Fuller grammar serialization** — Chevrotain's self-analysis emits a complete,
  stable serialized grammar AST (`getSerializedGastProductions()`), carrying token
  metadata and positioned as a public format tooling can round-trip. Parséman isn't
  empty here — [`buildSpecModel`](./spec-generation) returns a public, serializable,
  notation-agnostic grammar tree (`{ productions: { name, expr }[] }`, a full recursive
  `SpecNode` for each rule), and the raw `_def` tree the interpreter and compiler walk is
  reachable too — but that model is normalized for spec/diagram emission (semantic
  wrappers collapsed, trivia elided), not billed as a round-trippable grammar format.
- A **separate, configurable lexer** with stack-based **modes**, **token categories**
  (polymorphic tokens), and `longer_alt` — Parséman is scannerless, so none of this
  applies (a simplification, but also a missing capability if you want it).
- **Per-rule-typed CST visitor base classes** (`getBaseCstVisitor…`) generated from the
  grammar. Parséman's [`walk` / `createVisitor`](./ast#walking-the-tree) cover the same
  traversal at runtime, dispatching on a node's `type`, but don't hand you a class typed
  per rule.
- **Configurable LL(k) lookahead** and opt-in `BACKTRACK`.
- **Grammar-wide automatic error recovery** (heuristic single-token insert/delete +
  resync, with no annotation anywhere). Parséman recovers via
  [tolerant lists](./error-recovery#tolerant-lists) whose sync point is inferred from the
  enclosing combinator, plus explicit `expect` for required tokens; it doesn't recover
  across arbitrary rules on its own. (Where Parséman pulls even or ahead: its recovery runs
  on the **compiled** parser too, and its editor completions/diagnostics live in an
  external, grammar-pure [`languageService`](./editor-integration) layer rather than inside
  the parser class.)

**[Lezer](https://lezer.codemirror.net/) / [tree-sitter](https://tree-sitter.github.io/tree-sitter/)**
win on **structural-edit incremental** (buffer-tree fragment reuse), **GLR / ambiguity**,
and — especially tree-sitter — an enormous library of **existing, battle-tested grammars**
reused across editors (Neovim, GitHub, and more). If a maintained grammar for your
language already exists there, that's hard to beat, and for **editor tooling over an
existing language** — highlighting, folding, incremental re-highlight — they're the right
default.

It's worth being deliberate about *when* that default applies, though. These two have
become a reflexive go-to for parsing in general ("just grab a tree-sitter grammar"), but
that reflex is earned for **reusing an existing grammar inside an editor**, which isn't the
same task as **authoring a new language's parser + editor support** — turning text into
your own values or AST, *and* backing an LSP with recovery, completions, and diagnostics.
Parséman covers that second task end to end (see [the editor-backend
axis](#the-editor-backend-axis)); reaching past it to an editor-first generator is really
only warranted when you're reusing a grammar that already exists. Point them at the latter and three editor-first tradeoffs come along: the grammar
is context-*free*, so any real context sensitivity (indentation, heredocs, a construct
legal only *here*) drops you into a hand-written external scanner — **C** for tree-sitter —
*outside* the grammar; the artifact you actually run is generated, so you debug a state
table or C rather than the rules you wrote; and the output is a compact **buffer tree**
tuned for an editor's cursor, not the ergonomic JS objects and arrays a parse-to-values job
wants. None of that is a knock on them — it's a sign they were built for a different job
than the one a from-scratch value grammar is. That job (in-grammar context, debug-in-TS,
JS values out) is exactly the middle of Parséman's target.

**[Nearley](https://nearley.js.org/)** does **true ambiguous parsing** (returns *every*
valid parse), which ordered-choice parsers (Parséman, Peggy, Parsimmon) structurally
cannot.

If you need that breadth, reach for the tool that has it. Parséman optimizes for a
different point: fewest moving parts, authored and debugged in TypeScript, fast, with a
rich CST and context sensitivity.

## Which to reach for

- **Parséman** — you want the **fastest** JS value parser *and* an editor-grade CST with
  spans and trivia, with **context-sensitive rules**, incremental re-parse, and a full
  **editor backend** (recovery + completions + diagnostics on the compiled parser, via an
  external grammar-pure language service) — authored and **debugged in TypeScript** (no
  separate grammar file, no generated artifact to step through), with no build step
  required and generator-class speed when you want it.
- **[Peggy](https://peggyjs.org/)** — a quick, readable PEG DSL for a config language or
  small DSL where a text grammar file is the deliverable.
- **[Parsimmon](https://github.com/jneen/parsimmon)** — a tiny combinator parser with no
  build step and modest performance needs.
- **[Chevrotain](https://chevrotain.io/)** — a batteries-included toolkit (grammar
  introspection, lexer modes, grammar-wide automatic error recovery)
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
