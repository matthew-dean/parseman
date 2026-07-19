# Changelog

All notable changes to **Parseman** are documented here, grouped by minor version
(newest first). This project is pre-1.0, so minor bumps may carry breaking changes.

## 0.27.1 — 2026-07-18

- **New: document-root terminal trivia ownership.** `node(..., {
  trailingTrivia: true })` commits one final run of active grammar trivia into
  that node's own CST log after its body succeeds. It is deliberately opt-in for
  a repeating document root: regular sibling gaps and block trivia before a real
  closing delimiter retain their existing owners. Interpreter, `compile()`,
  macro output, and composed grammar IR preserve the option and its insertion
  index/kind metadata.

- **Fix: retain direct `node(..., build)` semantics when re-lowering composed
  grammar IR.** Rehydration restored `buildSrc` but recreated the node as
  structural, so generated composed grammars routed it through `ctx.build` or a
  default CST instead of its grammar-owned builder. Rehydrated direct nodes now
  retain a direct builder marker while preserving their serialized callback source,
  so compiled, macro-built, and downstream-composed grammars agree. Raw IR
  interpretation rejects direct builders rather than evaluating captured source.
  A direct builder carried through grammar composition must therefore be a
  **macro-static** arrow-expression: identifier parameters plus a self-contained expression
  using only those parameters and a small set of standard globals. It may not use
  lexical helpers, imported factories, statement bodies, or destructuring. Parseman
  verifies that subset with Oxc AST analysis during macro lowering, carries its
  result as inert artifact metadata, and rejects any unsupported builder before
  composition emits a parser that could later fail with
  `ReferenceError`. Typed `guard()` predicates and `withCtx()` state expressions
  now use the same TypeScript-stripped source path before macro codegen or IR
  re-lowering, so composed artifacts stay valid generated JavaScript. Oxc remains
  confined to the macro/plugin entry; public runtime bundles carry only the
  validation result, never the parser or its native bindings.

- **New: scoped `node(..., { captureTrivia: true })`.** A grammar can now retain
  trivia for one CST node without enabling document-wide capture. The option is
  scoped to that node, preserves inherited capture when it is already enabled,
  and macro-compiled grammars use the same behavior.

- **Fix: preserve runtime `compose()` when a composition cannot be resolved at macro
  build time.** Previously the macro could lower reachable local combinators before
  discovering an unresolved imported grammar. It then left `compose()` at runtime but
  fed it lowered parser functions instead of combinator objects, breaking grammars before
  selector execution. An unresolved composition now leaves the module's combinators and
  Parseman import intact; fully resolvable compositions remain statically fused.

- **Fix: macro-compile `skip(main, trailing)` combinators.** The runtime, code generator,
  and IR already supported `skip`, but the macro evaluator omitted it, causing an otherwise
  static grammar to fall back to interpreter output. Macro evaluation now preserves the
  combinator and compiles both delimiter-present and delimiter-absent inputs normally.

- **Fix: preserve direct node source in enclosing raw CSTs.** A `node(..., build)`
  callback returning an application object previously became an empty raw leaf in its
  structural parent, losing its matched source span's text. Opaque direct values now
  retain `input.slice(span.start, span.end)` in that raw leaf. `cstBuildHost()` also
  keeps its positioned-CST contract when such a direct node is nested: it emits the
  grammar node as CST instead of placing the application object in `children`.

- **Fix: retain direct node-builder ownership after linking grammars.** An ordinary
  `BuildHost` no longer replaces a direct `node(..., build)` callback merely because
  its grammar was passed through `compose()`. Direct AST factories now produce the
  same result in interpreted, compiled, and linkable modes; `cstBuildHost()` remains
  the explicit positioned-CST exception.

## 0.27.0 — 2026-07-16

- **New: compiled-parser profiling boundary (`run(entry, input, { profile: true })`).**
  Runs three compiled-parser-only measurement passes over the same input — an outputless
  **recognizer** (no `ch`/`raw`/`tl` capture, generalizing the `voidOf(transform(…, () => undefined))`
  semantics to compiled structural nodes), a **structural-capture** pass (children/raw/trivia/fields
  captured but node construction suppressed), and the ordinary **host-construction** path — and
  returns per-pass `RunProfilePass` measurements on `RunResult.profile` (`{ ms, nodes, childSlots,
  rawSlots, triviaSlots, fieldSlots, hostCalls }`). This is a measurement boundary, not a
  parser mode: ordinary `run()` output is byte-identical when `profile` is omitted. Lets a host
  attribute parse time across recognition vs. capture-bookkeeping vs. host-building without an
  external profiler. See `src/functional/run.ts`, `src/types.ts` (`RunProfile`/`RunProfilePass`),
  `test/unit/run.test.ts`.

- **Perf: elide the per-node trivia frame for bare-terminal nodes.** A `node()` whose parser
  subtree has no trivia-skip site (a bare terminal — `regex`/`literal`/`keywords`/`token`, or a
  `choice`/`transform`/`optional` over them) can never log trivia into its own `_cstTriviaLog`, so
  its `captureTrivia`/`_cstTriviaLog`/`_triviaCaptureMask` save+install+restore is dead work. A new
  conservative `parserHasTriviaSite` walker (returns `false` only when provably no site) gates it,
  removing those property writes from the many bare value/token leaf nodes (Num, Color, Quoted, …).
  **Neutral-or-faster by construction:** the generated code is *remove-or-byte-identical* — verified
  across all example grammars (0 additions; non-bare nodes unchanged; interpreter untouched). CST
  byte-identity parity preserved. Integrated Jess bench (macro-compiled `parseCssFn`, min-of-N):
  **CSS ~2–4% faster**, Less neutral. See `src/compiler/fields.ts` (`parserHasTriviaSite`),
  `src/compiler/codegen.ts` (`emitNode`).

- **Perf: hoist the per-node profiling-phase reads.** The profiling boundary inlined
  `_ctx._pmProfile?.phase === X` ~8× per structural node across the capture alloc/install lines;
  hoisted to one `_ctx._pmProfile` read plus two boolean locals reused everywhere, so the normal
  (non-profiling) path pays one read + two short-circuiting compares instead of eight optional-chain
  reads. See `src/compiler/codegen.ts`.

## 0.26.3 — 2026-07-12

- **Fix: a `withCtx` whose inner parser is multiply-reachable self-aliased into infinite
  recursion.** `withCtx` codegen wraps its inner parser in a named function (`_wcfN`) so
  the inner can run against a modified context, pre-registering `inner → _wcfN` first so
  any *other* reference to that same inner reuses the one named fn. It then emitted the
  inner body through the hoist wrapper `emit()` — which re-found that very pre-registration
  and emitted a **self-call** (`_wcfN` calls `_wcfN`) whenever the inner was hoistable and
  referenced ≥2× (e.g. a shared `declarationList` reached from several rules). The `_wcfN`
  body became a call to itself → stack overflow on *any* input. Codegen now emits the inner
  body directly (`emitDispatch`, never re-entering the hoist wrapper on the just-registered
  parser), mirroring `emit()`'s own register-then-`emitDispatch` pattern. A shared `withCtx`
  inner now hoists correctly, so the grammar-side `label(...)` workaround (a transparent,
  non-hoistable wrapper) is no longer needed. Grammars without this pattern are byte-identical.
- **Fix: `compose()` over a compiled base whose grammar contains a `withCtx`.** Like the
  0.26.2 gated-`choice` fix, `serializeRuleMap` bailed (`Unserializable`) on *any* `withCtx`,
  so a grammar using it silently shipped **full lowered pieces** instead of re-lowerable IR.
  Those baked pieces were lowered at the base package's build (its own CST/build helpers,
  e.g. a `cst()` closure) and spliced verbatim into the composing grammar's fused closure —
  which references build helpers absent from the fused scope (`cst is not defined`) and
  corrupts sibling dispatch. Standalone the base parsed fine; only compose-of-the-compiled-
  base broke. The serializer now round-trips `withCtx` through a dedicated `_wc` helper that
  rebuilds it **and re-attaches its `extraSrc`** (the source of the `extra`/state value) —
  load-bearing for static fusion, the same way `_gch` re-attaches `gateSrcs`. A plain
  `withCtx(value, inner)` would leave `extraSrc` unset → codegen emits a *source-less runtime
  closure* (a non-static callback) → the macro's build-time `emitFusedSource` fails and a
  downstream `compose()` silently falls back to a *runtime* fuse. Preserving `extraSrc` keeps
  the re-lowered state getter inlined from source, so the multi-layer compose stays statically
  fused. Grammars without `withCtx` serialize byte-for-byte as before.

## 0.26.2 — 2026-07-12

- **Fix: `compose()` over a compiled base whose grammar has a gated `choice`.** A
  macro-compiled, exported `rules()` grammar carries a compact, re-lowerable **IR**
  form so a downstream package can `compose([base, delta])` and re-lower the base
  under its own composing trivia. `serializeRuleMap` produced that IR — but it bailed
  (`Unserializable`) on *any* `choice` containing a `{ gate, combinator }` arm, so the
  grammar silently shipped **full lowered pieces** instead. Those baked pieces were
  lowered at the base package's build (its own trivia and first-set bookkeeping) and
  spliced verbatim into the composing grammar's fused closure — corrupting a **sibling**
  rule's first-char dispatch (e.g. after 0.26.1 let a gated arm keep O(1) dispatch,
  gating CSS's `simpleSelector` `&` arm broke `Declaration` dispatch inside a *composed*
  ruleset body, even though the standalone compiled grammar parsed fine). The serializer
  now round-trips gated arms through their captured gate sources, so a gated grammar
  carries IR like any other. Ungated choices serialize byte-for-byte as before.
- The gated choice round-trips through a dedicated `_gch` helper that rebuilds the choice
  **and re-attaches its `gateSrcs`** — load-bearing for static fusion. A plain
  `choice({ gate, … })` reconstructed the predicate as a *source-less runtime closure*, a
  non-static callback that made the macro's build-time `emitFusedSource` fail — so a
  downstream `compose()` (e.g. Jess composing the compiled CSS) silently fell back to a
  *runtime* fuse, whose combinator consts then crashed `rules()` at grammar construction
  (`Cannot read properties of undefined (reading 'tag')`). Preserving `gateSrcs` keeps the
  re-lowered gate inlined from source, so the multi-layer compose stays statically fused.
- A captured gate source is sliced from the grammar's TypeScript and may carry a type
  annotation (`(s: any) => …`, unavoidable for a gate under a `g: any` factory with
  `noImplicitAny`). Inlined gate sources are transpiled downstream, but the IR string is
  re-lowered with `new Function` verbatim, where TS syntax is a hard parse error — so the
  macro now strips TS-only syntax from a captured gate source (using the spans the parser
  already produced; no extra transpiler dependency). Sources that are already valid JS
  (every existing untyped callback) are kept byte-for-byte, so standalone codegen output
  is unchanged.

## 0.26.1 — 2026-07-12

- **Gated `choice` arms keep O(1) first-char dispatch.** Previously, gating any arm of a
  `choice` (a `{ gate, combinator }` arm) dropped the entire choice from its disjoint
  first-char dispatch to the linear `firstMatch` loop — a real regression on hot paths
  (e.g. a `&` arm gated on nesting context in a CSS selector). Now a gated arm whose
  first-set is **non-nullable and disjoint** from every other arm keeps its dispatch slot:
  the parser dispatches on the arm's unique first char and evaluates the gate only inside
  that branch, so every other input char never touches the gate. This is sound for ordered
  PEG precisely because a disjoint first-set means no later arm could match that char, so
  "skip the gate and retry" is equivalent to "dispatch and fail the choice." Both the
  interpreter and the compiled/macro paths emit it; a gated arm with a nullable or
  overlapping first-set still uses `firstMatch`. Byte-identical for choices with no gates.
  Measured ~2× faster on a gated-disjoint selector choice (back to within ~8% of ungated).
- As a side effect, the disjoint-dispatch soundness check now also excludes nullable arms
  on the **ungated** path, closing a latent edge case (no existing grammar was affected —
  codegen snapshots are unchanged).

## 0.26.0 — 2026-07-11

- **Bounded counted-repeat regex lowering (`{n}` / `{n,}` / `{n,m}`).** A terminal
  `regex()` whose shape includes a counted class/shorthand run now compiles to a
  `charCodeAt` scan loop instead of `RegExp.exec`, the same as `+`/`*`/`?` already did.
  The compiler generalizes its internal run model to real `min`/`max` bounds and only
  lowers when a greedy one-pass scan provably equals the backtracking engine — a run has
  exploitable "wiggle" exactly when `max > min`, so a fixed `{n}` run lowers even before
  an overlapping continuation, while a variable `{n,m}` lowers only when its class is
  disjoint from what follows (`[0-9]{2,4}[0-9]` correctly stays on `exec`). The headline
  beneficiary is CSS `colorHex` (`#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])`), which now fully
  lowers — bounded run plus its trailing boundary lookahead. Purely additive: every
  previously-lowered pattern is byte-identical. Verified with compiled-scan-vs-native
  differentials (0 diffs over ~2M inputs, including adversarial decline cases).
- **Automatic error recovery (`tolerant`) — interpreter *and* compiled.** A run-level
  `tolerant` flag makes `many` / `oneOrMore` / `sepBy` recover from a malformed element:
  skip to a **sync point**, record a `ParseError`, and keep parsing the rest of the list
  instead of truncating at the first bad element. The sync point is **inferred from grammar
  structure** — a `sepBy` resyncs to its separator; a list inside `sequence(open, …, close)`
  resyncs to the enclosing delimiter (the `sequence` publishes its following-terms' first set
  as each term's sync). There is **no inline annotation**: recovery is a caller policy the
  `tolerant` flag turns on, never a fact baked into the combinators. Recovery runs on
  **both** the interpreter and the **compiled/macro** fast path — opt in with
  `compile(g, { recovery: true })` or the `parseman({ recovery: true })` plugin option, which
  emit a `_ctx._tolerant`-gated branch that reuses the exact interpreter recovery functions
  via `ctx._rec` (byte-for-byte parity); a default compile emits **zero** recovery code
  (byte-identical, macro-inlinable). Recovered errors are also **embedded as `parseError`
  CST nodes** at the recovery point when a CST host is active, so a tree walk finds every
  diagnostic. Strict (no `tolerant`) is a cold path: byte-identical to a parser with no
  recovery.
- **`parseman/language-service` — new tree-shakeable subpath.** `languageService(grammar,
  config)` layers editor behaviour onto a grammar from the outside, keyed by node type =
  rule name, over a grammar that carries **zero** IDE concerns: `parse` (tolerant CST +
  errors), `diagnostics` (recovered errors + your per-node-type lint rules), `completionsAt`
  (structural expected-set mapped through your semantic handlers), and `openDocument(src)` —
  a live incremental editor document (`.edit()`, recovered tree, diagnostics) backed by a
  tolerant `parseDoc`. The same grammar file serves a batch value-parse and an LSP, unedited.
- **`completionsAt(target, input, offset, { tolerant })`.** `target` may now be a
  `compile(g, { recovery: true })` grammar (it records the completions probe on its fast
  path), not just an interpreter combinator; `tolerant: true` keeps the enclosing node
  parsing to the cursor so completions are returned even past a permissive top rule.
- **`RunOptions.tolerant`** is additive — no existing signature changes; the grammar is
  untouched.
- **Ambient-trivia `.edit()` oracle tests.** `parseDoc().edit()`'s `edit() ≡ full-reparse`
  fuzz now also covers grammars that declare ambient trivia via `rules({ trivia })` (a
  CSS-ish block / declaration-list / value-list grammar with whitespace + block-comment
  trivia), asserting trivia attribution and positions round-trip through incremental edits.

### Fixes

- **Tolerant recovery no longer swallows trailing trivia into a spurious `ParseError`.**
  `many` / `oneOrMore` checked the inferred sync token at the pre-trivia cursor, so ambient
  whitespace between the last good element and the list's closer (e.g. `{ 1 2 }`) tripped
  recovery and produced a bogus error over the space. The guard now checks — and starts the
  recovery scan from — the post-trivia position where the element actually failed (matching
  `sepBy`). Also: a recovery sentinel no longer inherits `_tolerant` / `_sync` during its
  lookahead probe, so a sentinel composing `many` / `sepBy` can't recurse into recovery.
- **Compiled/interpreter span parity for trailing empty-match trivia.** The non-capturing
  `compile()` codegen for a `sequence` advanced the cursor over inter-term trivia
  unconditionally, so a trailing `optional` / `many` that matched empty folded the
  preceding whitespace into the sequence's span — a compiled node's `span.end` then ran
  past where the interpreter (which rolls the trivia back) ends it (e.g. the `a*b` node on
  `'a * b + c'` ended at `6` vs `5`). The non-capturing branch now mirrors the interpreter
  and the capturing branch: it scans trivia to a temp position and only commits the advance
  when the following term consumes content past it. Adds an interpreter-vs-`compile()`
  span-parity test.

### Breaking

- **Removed the bespoke recovery combinators `recover`, `manyRecover`, and `sepByRecover`**
  (and their exports). List recovery is now the automatic `tolerant`-mode mechanism above —
  inferred sync points, no inline `{ recover }` hint (recovery policy is external, via
  `tolerant` and the `parseman/language-service` layer, never an argument on the combinators).
  `expect`, `scanTo`, `balanced`, `isParseError`, and the `{ recover: true }` error channel
  are unchanged. The `CSTError` tree-node type is now the recovered `ParseError` shape
  (`_tag: 'parseError'`), matching what recovery embeds in the CST.

## 0.25.0 — 2026-07-10

- **Incremental re-parse stores parent-relative spans (`parseDoc`).** An incremental document's
  tree now stores each node's `span` relative to its parent's start instead of as an absolute
  offset. A length-changing edit no longer rewrites the offsets of every node after it — a subtree
  that slides as a unit with its parent keeps its parent-relative offsets and is **shared by
  identity**, so an inserted character costs the same as an overtype. On the 12 kB nested-JSON
  incremental benchmark, inserting a character drops from **~68 µs to ~8 µs** (and is now ~13×
  ahead of Lezer's ~108 µs), while an overtype stays ~4.6 µs. Absolute positions are recovered on
  demand: `doc.spanAt(path)` is an O(depth) cursor, and `absolutizeCST(tree)` materializes the
  whole absolute tree. A fresh, non-incremental `node().parse()` result is unchanged — still
  absolute. `relativizeCST` / `absolutizeCST` / `absoluteSpanCST` are exported for working with the
  representation directly. See [Incremental re-parse](https://github.com/matthew-dean/parseman).
- **Opt-in structural list-reuse (`parseDoc({ structuralReuse: true })`).** A structural edit —
  adding or removing a whole element in a collection — used to re-parse the entire containing rule,
  landing near full-reparse cost (the "insert a line at the top of a large array" case). With
  `structuralReuse` on, `edit()` re-parses only the disturbed span and reuses the collection's
  untouched tail elements by identity, taking a front-of-200-element-array insert from
  **~590 µs to ~29 µs** — within a few × of Lezer's fragment reuse. It stays **sound
  automatically**: parseDoc inspects the grammar and only ever splices a rule it can prove is a
  genuine repetition (`many`/`sepBy`/`oneOrMore`). A fixed-arity sequence of same-typed tokens
  (e.g. `Triple = Num ',' Num ',' Num`) has CST children indistinguishable from a list but a
  non-repetition grammar, so it's never spliced — it falls back to a full, correct reparse. This
  requires passing the `rules()` **combinators** as the registry (so `Registry` now accepts
  combinators alongside bare functions); a bare-function registry carries no grammar to inspect, so
  structural reuse simply doesn't engage. Off by default only as a newer opt-in optimization, not
  for safety. Every splice is additionally guarded (exact tiling, lookahead probe, stateless-tail
  check); `edit()` is always structurally identical to a fresh parse (verified by the incremental
  oracle fuzz, including a fixed-arity grammar that must decline to splice).
- **Static railroad SVGs for embedding (`parseman/spec`).** `toRailroadSvg(grammar)` /
  `renderRailroadSvg(model)` render each production to a self-contained **static SVG string** —
  built headlessly (no DOM, no client script) — so a single diagram drops straight into an existing
  page, README, or MDX, unlike `toRailroadHtml` which returns a whole page that builds its diagrams
  client-side. `RAILROAD_CSS` is exported for styling the embedded SVGs. The
  [Grammar spec generation](https://github.com/matthew-dean/parseman) guide now embeds a live
  diagram this way and links to a full generated page.
- **`buildSpecModel` validates `root`/`order` rule names.** An unknown rule name in `root`/`order`
  (or a stray string like `order: 'source'` where a `string[]` is meant) used to seed a phase that
  reached nothing and silently return an **empty** model. It now throws a clear error naming the
  offending name(s) and listing the known rules.

## 0.24.0 — 2026-07-10

- **Grammar spec generation (`parseman/spec`).** Generate a formal grammar spec directly from a
  `rules()` grammar — `toEBNF(grammar)` for W3C-style EBNF text, and `toRailroadHtml(grammar)`
  for a self-contained HTML page of SVG railroad (syntax) diagrams, one per production, each with
  its EBNF caption. The emitter walks the SAME `_def` combinator tree the interpreter and macro
  compiler consume, so a generated spec is a single source of truth: it cannot disagree with what
  actually parses. Every combinator maps to an EBNF construct (`sequence`→concatenation,
  `choice`→alternation, `many`/`optional`/`oneOrMore`→`* ? +`, `sepBy`→`x (sep x)*`, rule
  references→non-terminals), with precedence-correct parenthesization. Productions emit in
  **declaration order** by default (the order rules were written in the factory, so the entry
  rule leads); `sort: 'reachable'` switches to top-down order (each rule introduced at its first
  reference). Options: `sort`, `root`/`order` (reachability + emission order),
  `terminals`/`regexDisplay` (readable terminals),
  `includeTrivia`, and `title`/`showEbnf` for the HTML page. Semantic-only wrappers (`transform`,
  `node`, `token`, `field`, …) are transparent; trivia and guards are elided by default. The
  railroad HTML has no external dependencies — the diagram library
  ([tabatkins/railroad-diagrams](https://github.com/tabatkins/railroad-diagrams), CC0) and its CSS
  are inlined. `buildSpecModel` exposes the notation-agnostic model for custom emitters. See the
  [Grammar spec generation](https://github.com/matthew-dean/parseman) guide and `examples/spec-gen.ts`.
- **Faster interpreted parsing of punctuation- and trivia-heavy grammars.** The runtime combinators
  gained two allocation-free fast paths, both interpreter-only (the `compile()` output was already
  lowering these). Single-character case-sensitive `literal()` now matches with a `charCodeAt`
  compare instead of the generic `startsWith` builtin — the bulk of grammars like GraphQL
  (`{ } ( ) : $ @ [ ] ! =`), JSON, and CSS. And the fast trivia scanner now recognizes any positive
  char-class run (not just ` \t\n\r\f`) and `(?:[class]|C[^\n\r]*)*` line-comment trivia, so
  comma/`#`-comment trivia (GraphQL, TOML-style configs) skips in a tight `charCodeAt` loop instead
  of falling back to `RegExp.exec` at every token boundary. Arm classification is order-independent
  and compiles to one fused loop; a comment marker that also sits inside a class falls back to an
  ordered scan. Measured (`bench:parseman`, interpreted): GraphQL large **~537→354µs**, medium
  **~20.5→15.0µs**, small **~3.4→2.2µs** — the interpreter now edges out Peggy on all three
  (Peggy 377 / 16.1 / 2.4µs); CSV large ~347→253µs and lang medium ~20.8→16.2µs also improved. No
  API or behavior change; differential-tested against the `RegExp` oracle.
- **Fairer cross-library benchmarks (`bench/`).** Prompted by
  [Chevrotain#2189](https://github.com/Chevrotain/chevrotain/pull/2189): the
  Chevrotain JSON/GraphQL benches built a CST (JSON then traversed it to a value)
  while every other parser built the value in one pass — not apples-to-apples.
  Both are now `EmbeddedActionsParser`s that build the same value directly, and
  every bench parser's output is pinned to a shared reference by a new parity
  test (`test/parity/bench-parsers.test.ts`). Measured effect on Chevrotain: JSON
  large ~1820→270µs (dropping the CST traversal) and GraphQL large ~815→460µs
  (caching the `OR`-alternatives arrays — the dominant cost once the CST was
  gone). Methodology is documented in `bench/PARITY.md`. Library code unchanged.

## 0.23.0 — 2026-07-09

- **Grammar-level trivia carries through `compose()`.** A grammar's ambient trivia
  (declared once via `rules({ trivia }, …)`, 0.22.0) now flows across composition boundaries. When
  you `compose([base, delta])`, the **composing** grammar's trivia governs every fused rule —
  including rules inherited from `base` — the way an overriding method wins over the one it shadows:
  the composing grammar's trivia applies even inside inherited rules. The trivia rides with each
  grammar's own `rules({ trivia })`. A delta that declares no trivia of its own inherits the base
  grammar's; multi-level composition adopts the outermost grammar's trivia all the way down.
  `noTrivia` / `parser({ trivia })` remain local overrides and survive fusion.
- **Identical on the interpreter, `compile()`, and the macro.** The composing-wins behavior is
  byte-for-byte identical across all three, at every composition depth. A parity harness fuses each
  shape both ways from a single source and asserts the *executed* parse results match, so the
  interpreter and the macro can't silently diverge.
- **`pick()` is withdrawn from the public API.** Build-inlining a `pick()` of an *imported* grammar
  can't yet carry that grammar's ambient trivia across the module boundary, so the macro would
  diverge from the interpreter. `compose()` is the composition primitive: author reusable bits as
  small `rules({ trivia })` grammars and compose them — a piece references shared rules by name, so
  it adopts the composing grammar's versions (and its trivia) automatically. `pick()` stays internal
  for later exploration of that lowering and may return once it lowers identically on both paths.

## 0.22.0 — 2026-07-09

- **Grammar-level trivia — `rules({ trivia }, factory)`.** Declare a grammar's ambient trivia
  ONCE, on the grammar, instead of wrapping individual rules in `parser({ trivia }, …)`. It is
  installed at the parse entry and inherited by every rule — including incremental parsing of a
  single rule — identically across the interpreter, `compile()`, and the macro. `parser({ trivia })`
  / `noTrivia` remain **local overrides** for a sub-region. Options-first mirrors
  `parser({ opts }, combinator)`: same options object, same position, so "set once on the grammar"
  and "scope it locally" read the same way — you don't need both. The bare `rules(factory)` form is
  unchanged. A `trivia()` rule returned from the factory (e.g. `g.rw`) is automatically excluded from
  the grammar trivia, so it never recursively skips filler within itself.
- **Trivia docs rewritten** around "set once, override when needed": `rules({ trivia })` for the
  whole grammar, `parser({ trivia })` / `noTrivia` as sparing local overrides (glue static tokens
  with one `regex`/`literal`, not `noTrivia`). Documents the one compiled limitation — a single
  **shared** rule can't be both trivia-skipping and contiguous, since the compiler bakes one trivia
  decision per rule (the interpreter reads it per call).

## 0.21.0 — 2026-07-09

- **Per-node trivia capture kind-filter.** A node's captured `triviaLog` can now be
  filtered by trivia kind, so a host that only consumes (say) comments no longer pays to
  log every whitespace run. `ctx._triviaCaptureMask` is a bitmask over the trivia's
  `triviaKindLabels` (bit `k` = keep kind `k`; unset = keep every kind) and gates only the
  per-node CST log — the global `_triviaLog` stays complete, so a downstream trivia map is
  unaffected. Set it per parse via `parser({ captureTriviaKinds: ['comment'] })` (interpreter,
  resolves names→mask) or `run(entry, input, { triviaCaptureMask })` (compiled host), or
  **per node type** via the new `_parsemanTriviaKinds(type)` build-host hook — so a host can
  ask `Ruleset`/`Stylesheet` for comments-only while `CompoundSelector` still captures the
  whitespace that marks a descendant combinator. Build a mask with the exported
  `triviaKindMask(labels, keep)`. Interpreter and compiled output honor the mask identically
  (parity-tested), with zero overhead when a parse sets no mask. This lets a grammar host read
  comment runs straight from parseman's trivia instead of re-scanning source, without the
  whitespace-capture cost that made that a regression before. General by design (any kind
  set, not comment-specific), so a future erasable-but-meaningful trivia kind is one more
  label, not a new capture path.

## 0.20.0 — 2026-07-08

- **Dropped the `regexp-tree` dependency.** A regex terminal's first-set — used
  only to drive `choice()` first-char dispatch, never to decide a match — is now
  computed by a small, dependency-free hand-rolled analyzer instead of
  `regexp-tree` (~264 KB). The interpreter bundle drops ~82% (324 KB → 55 KB) and
  ships with no runtime dependencies pulled in by the library entry. Parse
  results and compiled output are byte-identical; interpreter speed is unchanged
  (the win is bundle size, not throughput). The analyzer over-approximates
  soundly — a nullable pattern widens to "any" so dispatch never skips an
  empty-matching arm — and is fuzz-checked against the real `RegExp` engine.
- **Shared regex primitives.** Char-class parsing (`parseClassRanges`, shorthand
  ranges, …) is now one module shared by the interpreter analyzer, codegen's
  scannable lowering, and `regex()`'s scan fast path, replacing three copies.
- **Docs.** `compile()` is written as the free function it is (not a `.compile()`
  method) throughout.

## 0.19.0 — 2026-07-08

- **Clearer wrapper-node DX.** `node(..., { unwrap: true })` is now the preferred
  spelling for AST/value wrappers whose one-child match should return the child
  value directly; the old `collapse` option remains as a compatibility alias.
- **CST host collapse.** `cstBuildHost({ collapse })` now collapses transparent
  one-child CST wrappers during node construction while preserving CST leaf
  objects and spans.
- **Named node captures.** `field(name, parser)` captures named values and spans
  for the nearest `node()` builder or structural build host without forcing
  trivia/state capture.
- **Macro/codegen parity.** `unwrap` and CST-host collapse work across the
  interpreter, compiled parsers, and macro output.

## 0.18.2 — 2026-07-08

- **Interpreter hot-path pass.** Faster regex/literal matching, choice dispatch,
  trivia skipping, wrapper combinators, and optional misses improve interpreted
  parser timings across the example grammars.
- **Benchmark guard cleanup.** The perf guard now checks actual median speed
  regressions instead of treating a smaller compiled-vs-interpreted ratio as a
  failure when the interpreter gets faster.
- **Benchmark refresh.** Updated README/docs and SVG charts for the refreshed
  parser and CST comparison numbers.

## 0.18.1 — 2026-07-07

- **Friendlier labeled failures.** `label()` now controls the expected text for
  normal parse failures in both interpreter and compiled modes, so user-facing
  errors can say `string` or `number` instead of leaking raw regex source.
- **Diagnostics parity coverage.** Added interpreter-vs-compiled tests for
  expected sets, literal quoting, custom `expect()` labels, and `recover()`
  parse-error spans.

## 0.18.0 — 2026-07-07

- **`token()` combinator.** Treat a contiguous parser region as one source-text token:
  internal trivia is disabled, the value is the matched source string, and `node()`
  captures one CST leaf for the full span. The macro compiler can collapse safe
  nullable terminal runs inside `token()` (`many`, `optional`, `sepBy` over
  literals/regexes) to one regex, while keeping the one-token value/CST contract.
- **`expect()` derives literal labels.** `expect(literal('}'))` now derives the same
  expected text you would have written by hand; custom labels remain unquoted
  user-facing labels. The old `staticExpected` export was removed from the public API;
  expected-label derivation is internal.

## 0.17.0 — 2026-07-06

Theme: **macro-compiled parser size reduction.** Reference target is the Jess
`less-parser`, which fell from **5.30 MB to 1.07 MB (−79.8%)** across this line of
work — the fused `rules()` source it compiles is only ~32 KB, so this closes most of
the gap between compiled artifact and grammar source. Parse speed sits ~12% under the
pre-hoist baseline (the accepted hoist trade) and is still 6–7× the interpreter; the
full Jess CSS parse measured **~24% faster than 0.16.0** on a 220-file / 492 KB
corpus.

- **Identity-hoist shared combinators.** A compound combinator referenced from many
  places is now emitted once as a shared `_pf` fn and referenced, instead of pasted
  inline at every reference — killing the worst inlining explosions (e.g. the 786 KB
  `calcBody` blowup in Less). less-parser 5.30 → 2.50 MB. Costs a one-time ~11% parse
  hit (the hoisted call); gated by `test/unit/hoist-shared-explosion.test.ts`, which
  trips if expansion regresses from ~2× back toward the old ~19×.
- **Carry compact IR, re-lower at fuse.** `compose()`d artifacts now carry the
  compact `rules(g => …)` combinator expression as `{ ns, ir }` and re-lower it at
  fuse time, instead of carrying ~1 MB of already-lowered `_r_<Name>` source. Two
  supporting pieces: an IR serializer for rule maps, and emitting shared consts
  *inside* the `rules()` factory scope so the round-trip is self-contained
  (`test/unit/ir-serialize.test.ts`). less-parser 1.98 → 1.22 MB — build-time only,
  no runtime cost.
- **Live-spread ancestor pieces.** An imported grammar's compose-pieces are now
  referenced off its live binding (`[...cssGrammar[Sym], delta]`) rather than
  re-serialized into the deriving grammar; works in both interpreted and macro mode.
  less-parser 2.29 → 1.98 MB, free.
- **Strip carried-pieces indentation.** Dead pretty-printer whitespace in the
  machine-consumed carried source is dropped. less-parser 2.50 → 2.29 MB, free.
- **Drop `_pfok` flag from named-fn wrappers.** A named-fn wrapper now returns the
  value directly on success and falls through to `_pfFail` on failure, instead of
  threading a `_pfok` success flag. Neutral perf.
- **Intern identical `_mf` map closures.** `balanced()` merge closures with
  byte-identical source now share one `_mf` slot (40 → 2 in Less) instead of emitting
  one per call site. Free.
- **fix: recover first-char dispatch from a deep, ref-resolving first-set.** A
  `choice` arm whose first-set is only knowable after resolving through a chain of
  rule references used to fall back to an `any` first-set (every token tried). The
  compiler now resolves through the reference chain and recovers the dispatch guard.
  Correctness + dispatch fix; +2 tests.

## 0.16.0 — 2026-07-06

- **Case-insensitive (`/i`) regex lowering.** The scannable fast path (regexes that
  compile to a `charCodeAt` scan instead of `RegExp.exec`) now covers `/i`. Two
  extensions: (1) keyword-plus-boundary regexes under `/i` — e.g. an
  `/(if|else)(?!\w)/i` keyword set — now lower to a scan, where previously only a
  pure case-insensitive *literal* (`litFold`, e.g. CSS `url(`) did. (2) the case-fold
  itself is now a branch-free ASCII bit-OR (`c | 0x20`) rather than `toLowerCase` /
  `Intl.Collator` — **`Intl.Collator` is removed from the codegen path entirely**.
  ~1.75× on `litFold` scans. (`/i` on char *classes* — folding `[a-z]`↔`[A-Z]`
  ranges — still declines to `exec`; that's the remaining `/i` gap, tracked as §8d.)
- **Switch-dispatch for scannable alternations.** A `choice`/alternation whose arms
  are all scannable now compiles to a `switch` (jump table) on the first code point
  instead of trying each arm in sequence: disjoint scannable alts dispatch straight
  to the one matching arm, and an alt-of-`litFold` (case-insensitive keyword set)
  folds each arm's first char before the switch. ~2.4× on alt-of-`litFold`.
- **Codegen: arity-gated CST/trivia bookkeeping in structural `node()`.** The
  `_cstTriviaLog` append and parse-state capture inside a structural `node()` are now
  emitted only when the node's arity actually needs them — a node that can't carry
  trivia or child state no longer pays for the bookkeeping.
- **Plugin: opt-in un-lowered-regex warning.** The bundler plugin can now warn when a
  `regex()` in your grammar falls back to `RegExp.exec` instead of lowering to a
  `charCodeAt` scan — a diagnostic for finding fallback hot spots (e.g. a pattern
  that would lower if respelled). **Default off**; enable it via the plugin option.

## 0.15.0 — 2026-07-05

- **Grammar rule names must be valid JS identifiers.** They compile to `_r_<Name>`
  functions and dispatch guards, so a non-identifier key (e.g. `'my-rule'`) is now
  rejected at compile time with a clear error instead of being silently mangled to
  `_r_my_rule` (which could collide with a real `my_rule` rule). Only affects
  grammars that used non-identifier rule names — none in practice.
- **First-char dispatch for composed grammars.** A `choice` arm that references a
  rule in another `compose()`d artifact used to carry an `any` first-set, so every
  arm was tried per token (a value/selector rule walked all its alternatives). The
  compiler now emits a fuse-time-resolved dispatch guard for such arms — resolved
  against the **winning** rule's first-set, so it stays correct even when a later
  artifact **overrides** a rule with a different first-set (open recursion). Each
  linkable artifact carries a per-rule first-set table; `fusedBody` substitutes the
  guards at fuse time. Measured ~30% faster parse on a macro-compiled Less grammar
  (15-arm value rule + many selector choices); see `bench/compose-dispatch.ts`.
- **fix: sound sequence first-set.** `sequence()` computed its first-set from the
  first term alone, ignoring that a **nullable leading term** (`optional(…)` /
  `many(…)`) lets a later term's first char start the whole sequence. That
  under-approximated the first-set, so first-char dispatch could silently drop a
  valid parse (e.g. a Less `@{x}{}` interpolated selector). Now unions through the
  nullable prefix (`matchesEmpty` + `sequenceFirstSet`), a sound over-approximation.
- **perf: dead-value elision.** A `many` / `oneOrMore` / `sequence` whose aggregate
  value is only discarded under a `node()` (which builds from captured children) no
  longer builds that array/tuple — on both the interpreter and the compiled path
  (shared `markUnusedValues` analysis). Trees are identical; ~7% less transient
  allocation on a real Less parse. (`optional` builds no aggregate, so it's a
  no-op there — but a `many`/`sequence` *inside* an `optional` under a node still
  elides.)

## 0.14.1 — 2026-07-05

- `run()` throws a clear `TypeError` when the start production isn't a rule
  (e.g. a missing grammar rule name resolves to `undefined`), instead of the
  opaque "Cannot read properties of undefined (reading 'parse')".

## 0.14.0 — 2026-07-04

- **`compose()` is the one composition API — no base source needed.** A grammar
  carries its compiled, composable "pieces" **on the exported value** (under a
  well-known symbol), so `import { grammar }` is all a downstream package needs.
  The macro fuses `compose([...])` at build time into static, `eval`-free source
  (open-recursive override, `pick()` à la carte); chains are re-composable.
- **Removed fragment-spread composition** (added in 0.13.0). `...frag(g)` spreads
  and the build-time **source resolver** that read a fragment's `.ts` are gone —
  `compose()` replaces both. `linkable()` is internal, not a public API.
- **Rule ABI / build-time linker.** Rule-map rules compile to canonical
  `_r_<Name>` functions with a dependency manifest, fused into one closure of
  direct calls. All hoisted names (incl. trivia fns) are namespaced per piece so
  two composed grammars can't collide.
- **`run(entry, input, opts?)`** — a generic driver: invoke a compiled-fn or
  combinator entry, thread the framework ctx, and report unconsumed input after
  the grammar's own trivia. Closes the "run a rule + require full input" gap.
- **Structural `node()`** — the `build` callback is optional; omit it to build via
  the injected `ctx.build` host (one grammar → its own AST or a positioned CST).
  `pick()` now accepts grammars.
- **Sound incremental re-parsing.** `parseDoc().edit()` re-enters at rule
  boundaries with a lookahead guard and is capped at roughly one full reparse
  (near-whole-document edits skip re-entry). Backed by a new
  trivia-offset-inference model that uses the positioned tree as its index.
  Still marked **experimental**.
- **Modes** via a `ctx.build` host with runtime callback injection; `parseDoc`
  threads the build host through three CST drivers.
- `regexp-tree` isolated behind a first-set analyzer seam.
- perf: lower trailing non-disjoint-alt groups (§8h).

## 0.13.0 — 2026-07-03

- **Grammar composition in the macro** — inline fragment spreads.
- Renamed `makeFunctionalDoc` → `parseDoc`.
- Unit coverage ratcheted to ~97% with a CI guard.
- CI/build hardening: build `dist` via `prepare` on install, build before
  typecheck, pin pnpm via `packageManager`, add MIT `LICENSE`.

## 0.12.0 — 2026-07-03

- **codegen:** lookahead boundaries, alt/choice dispatch optimization, and a
  keywords fast path.
- Failure-diagnostics parity between interpreted and compiled paths.
- Generalized regex lowering to `seq` chains (with CI); raised the literal
  `charCodeAt` chain threshold to 16 chars.
- docs: Chevrotain comparison page, pronunciation guide, import-attributes note.

## 0.11.0 — 2026-07-02

- **CST walk & list-recovery combinators.**
- Benchmarks: incremental re-parse vs Lezer, macro output-size docs.
- Node arity elision now sees through TS parameter annotations.
- Favicons, parser-comparison page.

## 0.10.0 — 2026-07-02

- VitePress documentation site and refreshed benchmarks.
- **Node arity elision** — a wrapper rule collapses to its single child.
- Optimized trivia choice paths.

## 0.9.0 — 2026-07-01 → 0.8.1

- Fast char-scan trivia path generalized to derive from regex *structure*
  rather than hardcoded shapes, extended to any scannable-shape set.
- codegen: share one codegen pass across a `rules()` map; inline single-use refs.
- Restored tight compiled trivia/CST output (reverted a ~2.3× regression).

## 0.8.0 — 2026-06-26

- **`expect()`** required-token combinator with derived expected labels and
  furthest-fail reporting.
- **`balanced()`** is now predictive: it cuts after the open delimiter and
  reports an unmatched close instead of char-walking via `scanTo`.
- Machine-independent perf-ratio guard, enforced as a pre-commit hook.

## 0.7.0 — 2026-06-25

- **`noTrivia()`** combinator; fixed CST-capture rollback on failed parses.
- Fixed nested balanced braces (0.7.1).

## 0.6.0 — 2026-06-25

- **Breaking:** removed the class-based `Parser` API in favor of
  macro-compilable grammars.
- Documented `compile()` CSP limits; expanded Chevrotain benchmark output.

## 0.5.0 — 2026-06-24

- Large API cleanup and removal of the class pattern.
- Compiled node builds: inline `transform()` callbacks and `mk()` node
  construction at compile time; specialize compiled trivia to `charCodeAt` scan
  loops for the CSS read-write shape.
- Interpreted/compiled `_triviaLog` parity; CSS perf harness;
  parseman-wide perf tracking with a baseline and history.

## 0.4.0 — 2026-06-24

- Reworked `word()` API and cleaned up docs.
- String-optimization tuning to beat Peggy; Chevrotain JSON comparison benchmark.

## 0.3.0 — 2026-06-23

- Flat-array trivia log with `word()`/`wordContext()` helpers.
- CST-capture bug fixes; `node()` save/restore context instead of spreading.

## 0.2.0 — 2026-06-23

- Macro plugin inlines `transform()` callbacks.
- Honest benchmark modes (macro build / with `.compile()` / no compile), with
  stacked bars showing parse vs compile overhead; performance parity with Peggy.
- GraphQL parsing examples.

## 0.1.0 — 2026-06-21

- Initial implementation: parser-combinator runtime, compiler, line/column
  tracking, and the unplugin-based build pipeline.
- Macro plugin with `sepBy` inlining and `oxc-parser` migration.
- CST `rawChildren`/trivia and a benchmark suite. Renamed to **Parséman**.
