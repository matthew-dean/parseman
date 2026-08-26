---
pageClass: comparison-page
---

# How Parséman compares

JavaScript has a lot of parsing tools, and they're not really competing — they were built
for different jobs. This page is an honest side-by-side of the ones Parséman gets weighed
against, so you can figure out which job is yours. For speed numbers, see
[Benchmarks](./benchmarks); this page is about what each tool *can do*.

Two questions sort most of the field:

1. **What comes out the other end?** Plain JS values — objects, rows, an AST — or a full
   syntax tree with every token and its span, the kind an editor or formatter needs.
2. **Can the grammar itself care where it is?** Real languages are full of "this is only
   legal *here*." Some tools let you say that in the grammar. Others make you drop down to
   hand-written tokenizer code.

## The contenders

- **[Parséman](https://github.com/matthew-dean/parseman)** — parser combinators in JS/TS
  that compile to optimized table artifacts (as a library, at runtime with `compile()`, or
  at build time via the [macro](./macro-mode)).
- **[Peggy](https://peggyjs.org/)** — the maintained successor to PEG.js. A PEG grammar
  file in, a parser out.
- **[Parsimmon](https://github.com/jneen/parsimmon)** — a small, friendly combinator
  library, interpreted at runtime.
- **[Chevrotain](https://chevrotain.io/)** — a fast LL(k) toolkit with a JS DSL, automatic
  CST, and error recovery that outclasses most of the field.
- **[Nearley](https://nearley.js.org/)** — an Earley parser, which means it handles
  ambiguous grammars and hands you *every* valid parse.
- **[Jison](https://github.com/zaach/jison)** — Bison/Yacc-style LALR(1), for when you
  have a Yacc grammar already.
- **[Lezer](https://lezer.codemirror.net/)** — the incremental LR parser inside
  [CodeMirror 6](https://codemirror.net/).
- **[tree-sitter](https://tree-sitter.github.io/tree-sitter/)** — a GLR generator with a C
  core, built for editors, incremental from the ground up.

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

::: details What the rows mean

- **Author in JS/TS** — the grammar is JavaScript you import, not a text file a generator
  chews on. tree-sitter's `grammar.js` *is* JS, but it describes a parser generated in C —
  hence ⚠️.
- **Debuggable grammar** — can you set a breakpoint in a rule and step it in your normal
  debugger? Runtime libraries can. Generators mostly can't; Peggy emits JS you *can* trace,
  hence ⚠️. Parséman's compiled artifacts stay readable JS, and macro output source-maps
  back to your combinators.
- **Grammar coverage / trace** — Parséman can record which named rules, choice arms, and
  labels actually fired, plus a bounded lifecycle trace. This isn't a claim that other
  tools lack test coverage or debugger support — it's specifically the built-in grammar-level
  API described in [Grammar observability](./grammar-observability).
- **Context-sensitive grammar** — ✅ means you can express context in the grammar itself.
  ⚠️ means it's possible, but only from a hand-written scanner or a stateful lexer. ❌ means
  context-free, full stop.
- **Grammar composition** — extend someone else's grammar by overriding rules. Parséman's
  [`compose([base, delta])`](./extending) overrides by name, across packages, without the
  base source; Chevrotain subclasses and uses `OVERRIDE_RULE`. Parsimmon parsers are values
  you can recombine but not override by name; Lezer's `@dialect` toggles token sets.
- **Incremental re-parse** — ✅✅ built for it; ✅ first-class API; ⚠️ no engine, but the
  pieces are there to roll your own; ❌ re-parses from scratch.
- **Error recovery** — Parséman resyncs at points inferred from the enclosing combinator (a
  list's separator, its closing delimiter) under a `tolerant` flag, plus `expect` for
  required tokens — and it works on the compiled parser, not just the interpreter.
  Chevrotain's is automatic and heuristic across the whole grammar. Both report every error,
  not just the first.
- **Diagrams / EBNF** — can the tool generate a readable grammar artifact *from the grammar*?
  Hand-translating to EBNF and pasting it into an online tool doesn't count.

:::

## Can the grammar know where it is?

This is the axis people skip past, and it's the one that's miserable to retrofit.

Real languages aren't context-free. `return` is only legal inside a function. A heredoc's
terminator depends on the line that opened it. In Python, indentation *is* syntax. In
nested CSS, `&` means something different inside a block than outside one. Tools split
into three camps on how they cope.

### In-grammar: Parséman, Peggy, Parsimmon, Chevrotain

The grammar can read and thread state as it parses.

- **Parséman** — [`withCtx`](./context) merges state for a sub-parse, [`gate`](./context)
  gates a rule on a predicate, and `choice` arms can be gated too. Each node also records
  the context snapshot it parsed under, so [incremental re-parsing](./incremental) can
  replay the exact context a rule saw the first time. Context sensitivity and incremental
  re-parse get to coexist, which is rarer than it should be.
- **Peggy** — semantic predicates (`&{ … }` / `!{ … }`) run JS mid-parse.
- **Parsimmon** — `.chain(fn)` picks the next parser from what you just matched.
- **Chevrotain** — `GATE` predicates switch alternatives on and off at runtime.

### External only: Lezer, tree-sitter

Both are LR/GLR generators tuned for editors, and both are context-*free* on purpose.
When a language needs state, you leave the grammar and write code:

- **tree-sitter** — an [external scanner in C](https://tree-sitter.github.io/tree-sitter/creating-parsers/4-external-scanners.html):
  five C functions holding your own state (an indentation stack, say) and recognizing
  tokens by hand. There are no semantic predicates in the grammar; this is the documented
  path.
- **Lezer** — an [`ExternalTokenizer`](https://lezer.codemirror.net/docs/guide/#external-tokens)
  plus a `@context` tracker. Friendlier than C, but it's still token-level state living
  outside the rules, and it has to expose a hash so incremental reuse stays correct.

Neither one lets you write a context-sensitive *grammar*. They let you write a
context-sensitive *tokenizer*, in a separate language or module. For token-level problems
— indentation, heredocs — that's fine. For "this construct is only legal inside that one"
it's an awkward fit.

### Context-free only: Nearley, Jison

Nearley is pure Earley: wonderful when you *want* ambiguity, with no in-grammar context
mechanism at all. Jison gives you lexer start conditions, which covers some tokenizer-level
cases but not rule-level context.

### Routing without a lexer

Being scannerless usually means giving up token-style routing. Parséman doesn't, and
[`dispatch()`](./combinators#dispatch) is why: parse a shared head once, then branch on the
value you actually read.

CSS is the easy example. `url(` and `calc(` and `rgb(` all start life as
identifier-then-paren; a media query's `(width >= 600px)` and `(min-width: 600px)` share
`(` and an identifier before they diverge into range syntax or declaration syntax. A
`choice(...)` of siblings *works*, but it describes a pile of overlapping guesses.
`dispatch(...)` describes the actual decision: read the head, then pick the continuation
that owns it — and `routed()` hands that same value and span to the branch's CST node, so
nothing gets re-parsed or re-stitched.

## Re-parsing on every keystroke

Editors re-parse constantly, and this is exactly what Lezer and tree-sitter were built for.
Their buffer trees make fragment reuse cheap, and they win the general case.

Parséman re-parses incrementally too, via [`parseDoc`](./incremental), and holds up better
than you'd expect for a plain object tree. Because spans are stored **parent-relative**,
in-place value edits — overtyping a word, extending a token, the thing you actually do
while typing — barely cost anything, and beat Lezer. Structural edits (adding an item to a
big list) reuse the untouched tail by identity with opt-in `structuralReuse`, landing
within a small factor of Lezer and tree-sitter rather than at full-reparse cost. The
[incremental benchmark](./benchmarks#incremental-re-parse) has the numbers and the honest
tradeoff.

Everyone else re-parses from scratch. Chevrotain comes closest to an exception: there's no
built-in edit reuse, but its stateful parser instance — individually invokable rules,
`reset()`, partial CSTs from recovery — gives you enough to build your own. Its real
edit-time strength is a different axis anyway: fault-tolerant recovery in a single pass.

## Backing an editor

A language server has to do more than parse. It has to survive a half-typed line, answer
"what can go here," flag what's wrong, and do all of it between keystrokes. The
editor-first generators own this by being context-free and emitting a buffer tree.

Parséman gets there differently, with three properties they don't have:

- **Recovery runs on the fast path.** Recovery and the completions probe are compiled into
  the artifact (`compile(g, { recovery: true })`), not bolted onto the interpreter — so the
  parser your editor ships is the one that recovers. Strict compiles stay byte-identical;
  recovery is a dormant branch.
- **Recovery and incremental re-parse are one pipeline.** The
  [`languageService`](./editor-integration) opens an incremental document: an edit
  re-parses only the changed span, the tree survives a broken keystroke, and because a
  recovered error is a `parseError` node *in the tree*, diagnostics ride along on reused
  subtrees instead of being recomputed.
- **The grammar never learns the editor exists.** `languageService(grammar, config)` is a
  separate, tree-shakeable layer that supplies completions and diagnostics keyed by node
  type. The same grammar file backs a batch value-parse and an LSP, unedited. Chevrotain's
  recovery and content-assist live *inside* the parser class; Lezer and tree-sitter's hooks
  live outside the grammar but stay coupled to the generated one.

Where the generators still lead: structural-edit incremental, and the enormous library of
grammars that already exist. The job Parséman covers end to end is *authoring a new
language's editor support* — recover, complete, diagnose, on a fast compiled parser, with
in-grammar context and JS values out.

## How it feels to build one

Parser **generators** — Peggy, Nearley, Jison, Lezer, tree-sitter — take a grammar in a
dedicated text DSL and emit a parser. That buys speed, and for Lezer and tree-sitter it
buys incremental buffer trees. What it costs is that the thing you run isn't the thing you
wrote. When something breaks you're reading a generated state table, or C, and a
breakpoint in the output rarely maps back to a rule.

Parser **libraries** in JS/TS — Parséman, Parsimmon, Chevrotain — keep the grammar as code
you run directly. Breakpoints in your own rules, real stack traces, `console.log` wherever
you like.

Parséman tries to sit in both chairs: authored and debugged in TypeScript like a library,
but its [`compile()` / macro build](./modes) reaches generator-class speed — and the
compiled output stays readable JS you can still breakpoint. See
[Debugging compiled grammars](./modes#debugging-compiled-grammars). (tree-sitter's
`grammar.js` is JavaScript, but authoring in JS isn't the same as debugging in JS, which is
why it's ⚠️/❌ on those rows.)

## Where the others go further

Parséman's bet is a small JS-native core: speed, an editor-grade CST, in-grammar context,
incremental re-parse. That bet means skipping surface area other tools have — and some of
it is surface area you might want.

**[Chevrotain](https://chevrotain.io/)** is the most feature-dense toolkit here. It has a
separate configurable lexer with modes and token categories (Parséman is scannerless, so
that's a simplification *and* a missing capability), configurable LL(k) lookahead, typed
CST visitor classes generated per rule, a fully round-trippable serialized grammar, and
automatic error recovery across every rule with no annotations anywhere. Parséman answers
some of that differently — [`createVisitor`](./ast#walking-the-tree) dispatches at runtime,
[`buildSpecModel`](./spec-generation) emits a grammar tree normalized for specs and
diagrams rather than for round-tripping, and recovery goes through
[tolerant lists](./error-recovery#tolerant-lists) and explicit `expect` rather than
guessing across arbitrary rules.

**[Lezer](https://lezer.codemirror.net/)** and
**[tree-sitter](https://tree-sitter.github.io/tree-sitter/)** win structural-edit
incremental, GLR ambiguity, and — especially tree-sitter — a huge library of battle-tested
grammars reused across editors. If a maintained grammar for your language already exists
there, that's very hard to beat.

It's worth noticing *when* that applies, though. "Just grab a tree-sitter grammar" has
become a reflex, and the reflex is earned for **reusing a grammar inside an editor** — a
different job from **writing a new language's parser**, where you want your own values out
and an LSP behind them. Reach for an editor-first generator for that second job and three
tradeoffs come along: the grammar is context-free, so real context sensitivity drops you
into an external scanner (C, for tree-sitter); the artifact you run is generated, so you
debug a state table; and the output is a compact buffer tree tuned for a cursor, not the
objects and arrays a parse-to-values job wants. None of that is a knock — it's a sign they
were built for a different job.

**[Nearley](https://nearley.js.org/)** does true ambiguous parsing, returning *every* valid
parse. Ordered-choice parsers — Parséman, Peggy, Parsimmon — structurally cannot.

## Which to reach for

- **Parséman** — you want the fastest JS value parser here (the macro build; see
  [Benchmarks](./benchmarks)) *and* an editor-grade CST with spans and trivia,
  context-sensitive rules, incremental re-parse, and a real editor backend — all authored
  and debugged in TypeScript, with no grammar file to maintain and no build step required.
- **[Peggy](https://peggyjs.org/)** — a quick, readable PEG file for a config language or
  small DSL, where the grammar file *is* the deliverable.
- **[Parsimmon](https://github.com/jneen/parsimmon)** — a tiny combinator parser, no build
  step, modest performance needs.
- **[Chevrotain](https://chevrotain.io/)** — batteries included: grammar introspection,
  lexer modes, automatic recovery, the toughest fault tolerance around. Reach for it when
  you want that breadth and don't need incremental re-parse or full-fidelity trivia.
- **[Nearley](https://nearley.js.org/)** — genuinely ambiguous or natural-language grammars
  where you want every parse.
- **[Jison](https://github.com/zaach/jison)** — you have a Yacc/Bison grammar to port.
- **[Lezer](https://lezer.codemirror.net/)** — you're building a CodeMirror 6 language.
  It's the native choice, and that's that.
- **[tree-sitter](https://tree-sitter.github.io/tree-sitter/)** — one grammar reused across
  many editors, and you don't mind shipping a C scanner for the context-sensitive parts.

> This matrix reflects each tool's documented, first-class capabilities as of writing; most
> can be pushed further with enough custom code. If something's out of date or unfair,
> [open an issue](https://github.com/matthew-dean/parseman/issues) — corrections welcome.
