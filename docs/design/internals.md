# How Parséman works inside

A map of the code for someone who has never read it. It says what each stage does, where it lives and why it is shaped that way, and points at the file that holds the detail. Owner rulings that constrain all of this (no runtime code generation outside `compile()`, the 5× size budget, no speed regressions) are in [the runtime and size contract](./runtime-and-size-contract.md); where this page and that one disagree, that one is right.

## The pipeline

```
combinators ──► rule map ──► encode ──► TableProgram ──► wire form ──► resolve ──► assemble ──► run()
 (src/combinators)   (rules)    (table/encode.ts)  (table/program.ts)   (CompactProgram)    (resolveTable)  (assemble.ts / emit-assembly.ts)
```

There are three ways a grammar runs. The two table modes follow this whole pipeline; the interpreter stops at the first box.

| mode | what runs the parse | built when | entry |
|---|---|---|---|
| **interpreter** | each combinator's own `.parse()` | never: the combinator graph is the parser | `parse()` (`combinators/grammar.ts`), `run()` (`functional/run.ts`), runtime `compose()` |
| **runtime `compile()`** | the table, linked into generated functions (`new Function`), or into closures under a CSP | at the first parse of each option set | `compile()` (`table/compile.ts`) |
| **macro build** | the table, linked into closures, plus generated code for the hottest sites, chosen within a byte budget | in the bundler | `parseman/plugin` (`plugin/index.ts`) |

A macro-built module imports only `parseman/table` (`src/table/index.ts`): `tableRules`, the shared driver. A table grammar contributes data (the program) and its author callbacks; all recognition logic is in the runtime, once.

## 1. Combinators

`src/combinators/*`. Each constructor (`literal`, `regex`, `sequence`, `choice`, `dispatch`, `many`, `sepBy`, `node`, `field`, `scanTo`, …) returns a `Combinator` (`src/types.ts`):

- `_def`: what it is, a tagged `ParserDef`. Every later stage reads this, never the closure.
- `_meta`: what it knows about itself: first set, nullability, trivia, value usage.
- `parse(input, pos, ctx)`: the interpreter.

First sets (`combinators/first-set.ts`, `regex/first-set.ts` for regex bodies) decide whether a `choice` can dispatch on one character; [first-char gating](../guide/first-char-gating.md) is the author-facing rule. `compiler/value-usage.ts` marks results nobody reads, so the encoder can drop their tuples (`SEQV`, `REPV`). `compiler/build-arity.ts` and `compiler/fields.ts` describe what a `node()` builder receives.

`rules(opts, g => ({ … }))` (`combinators/parser.ts`) makes a rule map: named rules, referenced lazily as `g.Name`, with grammar-wide trivia and `scanSkip`.

## 2. Linking and composition

`compose([pieceA, pieceB])` merges rule maps; a later piece's rule wins everywhere, including inside the earlier piece (open recursion).

- **At run time** it only links (`compiler/linker.ts`, `linkRules` in `combinators/parser.ts`): no table, no code, no mutation of a shared rule. The result runs on the interpreter.
- **At build time** the macro re-lowers each piece from its carried IR (below) and encodes the merged map once.

`compiler/borrowed-rules.ts` rejects a rule map that reaches a rule it does not own.

## 3. Encoding: combinators to a `TableProgram`

`table/encode.ts` (`encodeTable`, `encodeTableProgram`) walks the rule map once and writes a flat array of integers, `code`, plus side pools. Settings (`TableSettings`) choose the *contents* of the table, not a runtime branch:

- `trackLines` selects the `*_TRACK` opcodes;
- `hostMode` (`'ast'` or `'cst'`) selects how nodes are built;
- `coverage` adds `COV` counter rows.

So two option sets are two tables, and the driver never asks which one it is running.

What the encoder decides while writing rows:

- **Dispatch.** A `choice` whose arms have disjoint first sets gets a dispatch table (`disp`): one character picks the arm.
- **Shared ends** (`table/factor-choice.ts`). Arms that differ in one term become one sequence around a choice of that term.
- **Shared prefixes.** An arm whose next sibling is its own prefix parses the prefix once.
- **Gates.** These are the rows that let a failing attempt fail on one character instead of opening frames. Where each one is computed is listed under [Gates](#gates).
- **Fail-clean sites** (`table/fail-clean.ts`). Rows whose failure writes nothing, so their callers skip the rollback mark.
- **Held gaps** (`table/hold-gap.ts`). A lookahead after trivia keeps the scanned gap for the next term instead of rescanning it.
- **Lexical bodies** (`table/lex-body.ts`, `table/lex-program.ts`, planned by `compiler/token-alphabet.ts` and `token-capability.ts`). A token-shaped subtree with no children becomes one recognizer row (`LEX_BODY`, `LEX_PROGRAM`) instead of a tree of rows.

`table/compile.ts` (`compile()`) and `table/compile-rule-map.ts` (`compileRuleMap()`, the macro's entry) wrap the encoder with source capture, refusals and emission.

### Gates

| row | asks | before | computed in |
|---|---|---|---|
| `GATE cc c` | is the next character in class `cc`? | entering `c` | `encode.ts` (`lookaheadGate`) |
| `CHOICE` dispatch table | which arm can start with this character? | trying arms in order | `encode.ts` |
| `REP` item class / separator sentinel | can another item (or separator) start here? | entering the item | `encode.ts` (`sepBy`, `many` cases) |
| `ARMGATE f c e` | does the author's state predicate hold? | entering one arm | `encode.ts` |
| `GUARD f e` | does `gate(predicate)` hold? (zero-width) | the next term | `encode.ts` |
| `RGATE` / `RGATE2` | can the character(s) after the token `dispatch()` already read continue this arm? | entering a routed arm | `encode.ts` |
| `GAPGATE c p cls other` | after the item's leading gap, is the next character one the item can continue with? | entering an optional repeat item that opens with a gap | `table/gap-gate.ts` |

`GAPGATE` exists for SCSS-style operators written as `sequence(pad, '*', pad)`. It fires only where a value is followed by whitespace inside an operator chain.

## 4. Rows and the wire form

The instruction format (every opcode's operands) is documented on each constant in `table/ops.ts`; [Opcodes](#opcodes) below lists them. `table/child-slots.ts` is the single statement of which operands are child offsets; `table/inspect.ts` (`reachableOps`, `opHistogram`) walks only reachable rows, because operands collide with opcode numbers.

`TableProgram` (`table/program.ts`) holds:

| field | wire key | what |
|---|---|---|
| `code` | `c` | the instruction stream |
| `k` | `k` | constant pool: strings, sticky `RegExp`s, names |
| `cc` | `x` | character classes, referenced by gates |
| `fx` | `e` | expected sets for error messages |
| `disp` | `d` | choice dispatch tables |
| `dsp` | `p` | `dispatch()` key tables |
| `rules` | `r` | rule name → entry offset |
| `fns` | `f` | author callbacks: builders, transforms, predicates |
| `lines` | `l` | 1 when built for `trackLines` |
| `lex`, `lexPrograms` | `lx`, `lp` | lexical-body and lexical-program specs |
| `labels`, `classified` | `lb`, `rc` | trivia labels, and whether the trivia is classified |
| `triviaSpecs` | `tv` | trivia scanners, rebuilt at load as data |
| `scans` | `sc` | `scanTo`/`balanced`/`lines` specs (`OP_SCAN`) |
| `scanSkip`, `scanSkipOf` | `ss`, `so` | per-rule ambient skip sets |
| `hostMode` | `h` | the host mode it was built for |
| `rec` | `rv` | always 1: recovery operands are laid down in every table |
| `cov` | `cv` | coverage counter definitions |
| `asm` | `a` | build-time compiled assemblies (`PrecompiledAssembly`), keyed by `cfgKey(RunCfg)` |

`table/emit.ts` (`emitTableModule`, `emitTableExpression`) prints a program under the short keys, `expandCompact` reads them back, and `resolveTable` turns the pools into runtime objects (`ResolvedTable`). `foldPrograms` / `tableVariants` (`program.ts`, `table/fold.ts`) carry several option-set variants as one base table plus row deltas.

## 5. The engines

All engines implement the same row semantics and share the protocol in `table/cell.ts`: one process-wide `FAIL` symbol and one per-assembly end-position cell. `table/stamp.ts` is the envelope around them (entry metadata, host-mode stamps, `scanSkip`, failure → `ParseResult`).

| engine | file | ships? | role |
|---|---|---|---|
| closure assembler | `table/assemble.ts` | **yes**: `tableRules` | links each reachable row once into a closure with its operands captured as constants and its children as direct references. No opcode is read at parse time. |
| emitted assembly | `table/emit-assembly.ts` (+ `scan-shapes.ts`, `plugin/entry-supercompiler.ts`) | **yes**, as text | the same sites printed as JavaScript: whole-grammar under runtime `compile()`, selected hot sites in a macro build |
| reference driver | `table/exec.ts` (`execRules`) | no | a `switch` over rows. Kept as an independent oracle; nothing in `src/` imports it |
| interpreter | `src/combinators/*` | yes | the combinators themselves |

Why closures and not the `switch`: the `switch` was one basic block with ~30 merge edges that TurboFan deoptimized repeatedly. Each closure has one shape at its call sites, so V8 can inline them (`assemble.ts` header).

`assemble()` is one large function on purpose: every piece captures per-assembly constants, so they cannot be lifted to module scope without changing what V8 sees.

**Option sets.** `RunCfg` (`assemble.ts`) holds the per-parse options: `hostCst`, `trackLines`, `tolerant`, `coverage`, `probe` and `hostReadsChildren`. `AssemblyCache.forCtx` keys assemblies by `cfgKey(RunCfg)` and builds each set's assembly on first use, reaching only the rows that set needs. `table/site-labels.ts` labels sites so per-term checks (trivia, CST capture) are decided at assembly, not per parse.

**Emitted vs closure, per site.** In a hybrid assembly, emitted sites call closure sites and back, through the shared `FAIL` and end cell. An emitter that cannot lower a construct throws `Unemittable`. The closure engine then runs that assembly, and `Assembly.emitRefusal` records why. Under a strict CSP, `compile()` catches `EvalError` and uses closures.

**Shared helpers and the hot path.** Pure helpers that touch no assembly state are shared (`table/run-support.ts`, `table/trivia-gap.ts`, `table/scalar-terminal.ts`). Emitted code shares a helper only when it takes no piece as an argument (`emit-assembly.ts` header). Routing the mark/undo paths through shared helpers was measured 13–25% slower and reverted.

The reference driver keeps its own copies of protocol logic (line tracking, rollback, recovery sentinels) on purpose: a bug in a shared copy would be invisible to the identity sweep that compares it with the shipped engines.

## 6. Selection: which sites a macro build emits

Generated code is fast, but its bytes load in every process, so a macro build emits only a budget's worth.

- **Budget** (`plugin/index.ts`, `DEFAULT_ASSEMBLY_BUDGET = 0.25`): assembly bytes per module may not exceed 0.25 × the module's source length (`assemblyBudget` option). Only the AST, no-line-tracking table carries an assembly; the other variants run on closures.
- **Ranking** (`table/select-hot.ts`). Every rule entry starts at weight 1; a repeat multiplies its body by `LOOP` (8); a choice or dispatch splits its weight across its arms. Weights propagate `ROUNDS` (60) times, with recursive cycles capped at `CAP`. Sites are then taken greedily by weight per emitted byte. With `assemblyProfile` (a corpus), measured site visits (`countSiteVisits` in `assemble.ts`) replace the estimate.
- **Pricing and fitting** (`compile-rule-map.ts`, `selectAssembly`). Site bytes are priced with gap gates lowered as their item ("gate-neutral"), so adding a gate does not move selection. The emitted source is then measured for real and the target narrowed (up to 16 tries) until it fits, allowing 5% for the supercompiler pass (`plugin/entry-supercompiler.ts`).
- **Known instability:** near the budget line the choice comes down to emitted size, so comment-only grammar edits can move it ([#179](https://github.com/matthew-dean/parseman/issues/179)).

## 7. Trivia, CST capture, lines

- **Trivia.** `trivia()` and `classifiedTrivia()` (`combinators/map.ts`) are scanned by `combinators/trivia-skip.ts`, which compiles regex arms into character-loop scanners. `cst/trivia-charscan.ts` is the labelled variant.
- **CST capture.** Capture writes into sinks (`cst/capture-buffer.ts`) that a failed attempt rolls back to a mark; `cst/host-mode.ts` is the artifact/host contract.
- **Lines.** With `trackLines`, the `*_TRACK` rows record line starts (`table/line-scan.ts`, `combinators/lines.ts`). Without it, no row pays for lines.

See the [trivia guide](../guide/trivia.md).

## 8. Recovery and completions

Recovery operands (follow-set classes, item expected sets) are in every table (`rec: 1`). They are used only when a parse runs `tolerant`, which selects a different assembly, so a strict parse never reaches a recovery piece. The resync logic is `src/recovery/scan.ts`, shared by every engine. Completions run a `probe` assembly (`combinators/probe.ts`).

## 9. The macro plugin

`src/plugin/index.ts` (unplugin: Vite, Rollup, esbuild, …), for `import … from 'parseman' with { type: 'macro' }`:

1. **Evaluate.** It finds declarations whose right-hand side is a combinator expression and evaluates them at build time (`plugin/evaluator.ts`, `reducer-resolver.ts`, `free-identifiers.ts`), capturing each callback's source.
2. **Compile.** `compileRuleMap()` encodes the table, and `selectAssembly` picks the emitted sites (section 6).
3. **Splice.** It replaces the declaration with the printed table and prepends `import { tableRules } from 'parseman/table'`.
4. **Carry IR.** A composable piece also carries its combinator IR (`compiler/ir-serialize.ts`, re-evaluated by `plugin/ir-eval.ts`), so a downstream build can re-lower it. Under a Rollup-family bundler that IR goes into a `<chunk>.parseman.json` sidecar instead of the artifact; nothing at run time reads it.

Artifacts are stamped with the Parséman version (`src/version.ts`); nothing reads the stamp back yet.

## 10. Gates that keep this honest

| gate | command | catches |
|---|---|---|
| identity sweep | `test/unit/table-identity.test.ts` (`bench/table-lowering-identity.ts`) | an engine whose output differs from the interpreter's |
| invariants | `pnpm check:invariants` ([doc](./invariant-gate.md)) | source rules no type sees: unreachable modules, unread options, duplicated bodies, renamed engine exports, … |
| differentials | `pnpm check:differentials` ([doc](./differential-gates.md)) | a harness that cannot fail: each one must catch a defect planted in `src/` |
| coverage | `pnpm test:coverage && pnpm coverage:guard` | untested new code |
| size | `pnpm size:guard`, `pnpm size:guard:jess` | any artifact growth; Jess grammars over 5× their source |
| perf | see below | slower parsing |

## How performance is measured

[Performance gates](./perf-gates.md) is the method of record. In short:

- **`perf:guard`** (pre-commit): two tiny CSS microbenchmarks, in µs.
- **`perf:guard:grammars`** (CI): `bench/grammar-density/`. Sweeps two axes, speculative-rollback density (`not()` per KB) and expected-set width, A/B against a pinned commit in one process.
- **`perf:workloads`** and **`:peak`** (CI): realistic grammars and inputs in `bench/workloads/` (Less, CSS, GraphQL, JSON), A/B against the pinned release and against the fastest recorded release.
- **`bench:macro-optimize`** (CI): Jess's CSS and Less grammars, macro-built in a pinned Jess checkout. This is the only CI gate on a Jess grammar, and it covers neither SCSS nor `.jess`.
- **Jess's own harness** (marginal instructions per parse with and without the JIT, on all four grammars) is described in the Jess repository's `docs/perf/BENCHMARKS.md`.

**Which features each bench exercises.** Parséman's own workloads run through runtime `compile()`, which emits the *whole* grammar as generated code. Jess's grammars are macro builds, which emit only the selected sites and run the rest on closures. So a change to the closure engine, or to selection, can move Jess and not move Parséman's benches.

The rows a workload executes also decide what it can see. These are site visits per parse, measured with `countSiteVisits` over `encodeTable` of each workload grammar, at `acb421e2`:

| workload | input | rows visited | `GAPGATE` | `RGATE`/`RGATE2` | `ARMGATE` | `DISPATCH` | `LEX_BODY`/`LEX_PROGRAM` | `SCAN` | `GATE` | `NOT` |
|---|---|---|---|---|---|---|---|---|---|---|
| less/stylesheet | 52 KB | 199,557 | 0 | 0 | 0 | 0 | 0 | 0 | 15,615 | 26,061 |
| less/mixins | 59 KB | 212,284 | 0 | 0 | 0 | 0 | 0 | 0 | 16,308 | 28,092 |
| css/stylesheet | 64 KB | 89,329 | 0 | 0 | 0 | 0 | 0 / 2,274 | 700 | 9,820 | 0 |
| graphql/document | 49 KB | 40,378 | 0 | 0 | 0 | 0 | 0 | 0 | 3,360 | 0 |
| json/document | 59 KB | 45,341 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

None of them reaches the gap gate, the routed-arm gates, per-arm state gates or `dispatch()`. Work on those rows (most of the 0.58–0.59 Less/SCSS work) is measured only on Jess's grammars, and for SCSS and `.jess` only by Jess's harness. `bench/workloads/less.ts` is a hand-written Less grammar, not Jess's.

## Glossary

- **row / site**: one instruction in `code`, identified by its offset (`ip`).
- **piece**: the closure (or emitted function) a site is linked into.
- **assembly**: all pieces for one table and one `RunCfg`.
- **variant**: one option set's table (AST/CST × lines/no lines). Jess builds four per grammar.
- **fold**: several variants as one base table plus deltas.
- **host mode**: who builds nodes, the grammar (`'ast'`) or a CST host (`'cst'`).
- **carried IR**: the combinator expression a composable artifact carries for downstream builds.
- **`G4`, `G5`, `G14`, `G19`, `U4`** in comments: rows of Jess's design ledger (`jess/docs/architecture/core/DESIGN-DECISIONS.md`) that drove this design. G5 is "link the table at run start" (the closure assembler), G4 the variant fold, U4 the emitted assembly. G14 is the predictive token-cursor direction and G19 the ruling that it always has a builder. The dormant `compiler/token-scanner.ts` and the test-only half of `compiler/token-alphabet.ts` are that groundwork, kept on purpose.

## Opcodes

Operands follow the opcode in `code`. Full layouts and the reasons behind each are on the constants in `src/table/ops.ts`. `test/unit/internals-doc.test.ts` fails if an opcode is missing here.

| # | opcode | operands | meaning |
|---|---|---|---|
| 1 | `LIT` | `k` | match the constant string `k` |
| 2 | `RX` | `k` | match the sticky regex `k` |
| 3 | `SEQ` | `n c1…cn f1…fn` | children in order; value is their tuple. `f` are recovery follow classes |
| 4 | `SEQV` | as `SEQ` | `SEQ` whose value is unused: no tuple |
| 5 | `CHOICE` | `d n fx c1…cn e1…en` | ordered choice; `d` a dispatch table or −1; `fx`/`e` expected sets |
| 6 | `REP` | `c min max sep flags fx cls` | repeat or separated list; `cls` the item/separator class that gates continuation |
| 7 | `REPV` | as `REP` | `REP` whose value is unused |
| 8 | `OPT` | `c` | child, or `null` |
| 9 | `XFORM` | `f c` | `transform()`: call `fns[f](value, span)` |
| 10 | `NODE` | `b c flags proj type tags` | `node()`: open a frame, run `c`, build |
| 11 | `RULE` | `r` | call rule `r` |
| 12 | `GATE` | `cc c` | first-character gate, then `c` |
| 13 | `NOT` | `c` | negative lookahead |
| 14 | `PEEK` | `c fx` | positive lookahead |
| 15 | `LEAF` | `f c` | `leaf()`: reduce, record one spanned leaf |
| 16 | `EMPTY` | | match the empty string |
| 17 | `LIT_TRACK` | as `LIT` | line-tracking twin |
| 18 | `RX_TRACK` | as `RX` | line-tracking twin |
| 19 | `NODE_TRACK` | as `NODE` | line-tracking twin |
| 20 | `SCOPE` | `k c policy` | `parser({ trivia })` scope with a policy |
| 21 | `EXPECT` | `c e` | `expect()`: never fails; yields a `ParseError` value |
| 22 | `SEQX` | `f n c1…cn f1…fn` | `transform()` over a `sequence()`, fused; `f < 0` is a direct projection |
| 23 | `SCAN` | `s` | `scanTo` / `balanced` / `lines` / `columns`, spec `s` |
| 24 | `FIELD` | `k c` | `field(name, c)` |
| 25 | `DISPATCH` | `sel d other otherRouted n a1…an` | `dispatch()`: read once, route by value |
| 26 | `ROUTED` | `fallback` | `routed()`: the token `dispatch()` read |
| 27 | `LIT_CI` | `k fx` | case-insensitive literal |
| 28 | `LIT_CI_TRACK` | `k fx` | line-tracking twin |
| 29 | `TOKEN` | `c` | `token()`: no trivia inside, one leaf for the match |
| 30 | `SCOPE_CAP` | `k c` | trivia scope that also captures trivia |
| 31 | `WITHCTX` | `k c` | `withCtx()`: save/replace/restore `ctx.state` |
| 32 | `GUARD` | `f e` | `gate(predicate)`, zero-width |
| 33 | `ADJ` | `neg kinds fx` | `adjacent()` / `notAdjacent()` boundary test |
| 34 | `GREEDY` | `sup n w1 a1…` | identifier-vs-keyword classify choice |
| 35 | `REJECT` | `c n t1 o1…` | choice arm with its `autoNot` checks |
| 36 | `ARMGATE` | `f c e` | choice arm behind a state predicate |
| 37 | `LIVE` | `f` | run a hand-written combinator's own `.parse` |
| 38 | `ATTEMPT` | `c k` | `attempt()`; `k` = `{ contain: true }` |
| 39 | `LABEL` | `c fx` | `label()`: replaces the child's expected set |
| 40 | `COV` | `c id on` | grammar-coverage counter (coverage tables only) |
| 41 | `SCOPE_PLAIN` | `k c` | ambient trivia scope with no policy |
| 42 | `LEX_BODY` | `body fx suffixFx lineFlags` | one-row lexical recognizer |
| 43 | `LEX_PROGRAM` | `p` | composite lexical program |
| 44 | `SOURCE_LEAF` | `f c` | `sourceLeaf()`: reduce, keep source text |
| 45 | `RGATE` | `cls child fx` | routed arm gated on the character after the routed token |
| 46 | `GAPGATE` | `c p cls other` | optional repeat item that opens with a gap |
| 47 | `RGATE2` | `cls child fx first second` | `RGATE` on two characters |

Which engine handles which: `assemble.ts` and `exec.ts` handle all of them. `emit-assembly.ts` lowers all but `GUARD`, `GREEDY`, `REJECT`, `LIVE` and `COV`, and refuses those (the closure engine runs that assembly). It follows `RULE` and `GAPGATE` as aliases of their child (a repeat reads its gap gate itself) and inlines `ADJ` into its sequence.
