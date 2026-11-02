# Performance attempts

Every performance idea tried or queued for the Jess grammars, with what it measured and
what became of it. Read this before you start a perf change, so you don't re-run a
rejected idea or lose a parked one.

## The target

Jess has four grammars: CSS, Less, SCSS and `.jess`. Each should parse faster than it did
in the previous Parseman release, compile to no more than 5× its source size, and build
the same tree. The long-run bar for Less is to parse faster than `lessc` 4.x.

Where that stands, with Less on `benchmark.less` and the same method on both sides:

| | 0.55.2 | 0.57.0 | 0.58.0 | `lessc` 4.9.1 |
| --- | --- | --- | --- | --- |
| Less `ast.js`, × source | 2.85× | 3.37× | 2.50× | n/a |
| Less JIT instructions per parse | 465.6M | 384.8M | 380.4M | 160.7M |
| Less `--jitless` instructions per parse | 2960.4M | 2490.8M | 2304.3M | 832.8M |

(From the 0.58.0 release PR, [#170](https://github.com/matthew-dean/parseman/pull/170).
Parseman's Less parse still costs about 2.4× `lessc`'s instructions.)

## How numbers are measured

- **Marginal instructions per parse.** Hardware-counted instructions, taken as a
  difference so JIT warm-up cancels: with the JIT, `(I(N2) − I(N1)) / (N2 − N1)` over two
  parse counts; with `--jitless`, `I(2) − I(1)` or `(I(3) − I(1)) / 2` as the PR states. A
  short window from zero counts warm-up, not the parser.
- **Both modes.** The JIT number is what users see. The `--jitless` number is steadier
  and shows whether a change removed work or only moved it into something V8 inlines.
- **Interleaved, median of 5.** Builds under comparison run alternately in one session.
  Each side uses its own parser libs and runtime. Wall time and cold start (import plus
  first parse) are reported too, but they are noisy: differences under about 3–5% are
  not evidence.
- **Same tree.** A change is not a win unless the ASTs (and CSTs) are byte-identical on
  the fixtures: `benchmark.css`, `benchmark.less` and a generated SCSS workload.
- **x64 CI gates.** The `grammar-perf`, `workload-perf` and `macro-perf` jobs run on
  GitHub's x64 runners. The grammar and workload gates take five passes each against a null
  control. The macro gate times Jess's shipping macro parsers (8 rounds of 2 runs by
  default) and compares a ratio to a reference build against a ceiling. Apple-silicon
  results have repeatedly disagreed with x64 ones. See [Perf gates](../design/perf-gates.md).

- **Previous release = the newest `v*` tag.** The grammar and workload gates resolve their
  reference to the newest release tag HEAD contains, at run time, since every merge to
  `main` publishes. "Against the previous release" in an entry here means that tag. The
  macro gate stays pinned in `bench/jess/macro-optimize-config.json`.

Two readings that look like regressions and aren't: the grammar gate's `expected/none`
case leans about +1% on the head side whenever the two trees differ at all
([#175](https://github.com/matthew-dean/parseman/issues/175), queued below), and the macro
gate's CSS row swings between 0.97 and 1.04 on an unchanged tree.

## Shipped

### 0.57.0 (published)

Against 0.55.2, with the budgets Jess ships, ASTs byte-identical
([#164](https://github.com/matthew-dean/parseman/pull/164)):

| Grammar | Size | JIT | `--jitless` |
| --- | --- | --- | --- |
| Less | 3.38× | −15.7% | −14.6% |
| SCSS | 2.94× | −14.5% | −10.1% |
| `.jess` | 2.52× | −10.4% | −24.6% |
| CSS | 2.36× (was 11.78×) | −0.4% (inside spread) | −1.8% |

- **Selective assembly within a budget.** Generate code for a grammar's hottest sites
  only, and let the closure engine run the rest. `assemblyBudget` is a multiple of the
  module's source length, `0.25` by default. Before, a large `composeLeaf()` generated
  every site: Jess's CSS grammar was 11.78× its source and now 2.36×. Less measured
  −4.1% instructions at budget 0.25 against 0.55.2 on the way. Shipped because it fixes
  size and speeds up three of four grammars. `ac33bd8d`, 0.57.0.
- **`optional`, `not` and `peek` gates.** Decide on the child's first character without
  taking a rollback mark or entering the child. Whole-grammar emitted Less measured −4.3%
  marginal instructions. The gate rows grow tables (example/graphql +3.7%), so the size
  ceilings were raised, and each grown example grammar measures no slower. `446d4e4a`,
  0.57.0.
- **Static `choiceFx`.** A choice that enters no arm reports the pooled expected set the
  table already holds, instead of rebuilding it arm by arm. No separate measurement was
  recorded; it is counted in the 0.57.0 table above. `ca653e9e`, 0.57.0.
- **Merged first sets for node, attempt and repeat-item gates.** A `compose()` body's first
  set resolves through the merged winners, so Jess's `CompoundSelector` is no longer
  entered at `{`. `fcad506f`, 0.57.0.
- **Comment-arm trivia scanner.** The trivia scanner lowers an alternation whose arms share
  a literal prefix, such as `\/(?:\*…\*\/|\/[^\n\r]*)`, which had no unlabelled scanner.
  `f4a0aef4`, 0.57.0.
- **`skipDeferredTrivia`.** A gap in which no character can start a root-selected arm is
  answered by the scanner's end, not scanned chunk by chunk. `4480c814`, 0.57.0.
- **Gap-scan reuse.** A gap asked for again at the same position in the same parse, after a
  zero-width term, is answered from the last scan that recorded nothing. Not used with
  `trackLines`, CST capture or a full trivia log. `31589f0d`, 0.57.0.
- **Live `ctx.state` (breaking).** A builder's `state` is the active state object, not a
  shallow copy. The copy cost one allocation per node that read state: 11,285 per parse of
  Jess's `benchmark.less`. A caller that mutates its own state in place afterwards now sees
  the change. `aaf26457`, 0.57.0.
- **Code-unit gate reads on x64.** The first gates read a character class through two calls
  (`classHas(cls, lead(input, pos))`) in `compile()` output. That read `rollback/sparse`
  +0.6% to +3.9% and `expected/none` up to +5.2% on x64 while arm64 was 4–7% faster. The
  fix tests an ASCII-only class by `CLS.ascii[input.charCodeAt(pos)]`, as macro output
  already did. Against its parent on x64: `rollback/sparse` −3.7% to +0.6%, `rollback/none`
  −0.8% to −4.9%. `2d59ad38`, 0.57.0.

### 0.58.0 (merged; [#170](https://github.com/matthew-dean/parseman/pull/170))

Against 0.57.0 per [#170](https://github.com/matthew-dean/parseman/pull/170): Less −1.2% JIT
and −7.5% `--jitless`, SCSS −1.8% and −2.9%, `.jess` +0.4% (inside spread) and −4.6%, CSS
−1.7% and −1.1%. Sizes drop mostly from the sidecar below.

- **Carried pieces in a build-only sidecar (lean artifacts).** The composable form a
  downstream `compose()` build reads was inline IR: 23–31% of each Jess grammar artifact,
  and it kept every ancestor's module in the import graph. It now ships beside the chunk as
  `<chunk>.parseman.json`; nothing reads it at runtime. `ast.js`: Less 910,838 → 675,537 B,
  SCSS 586,782 → 427,103 B, `.jess` 573,045 → 381,309 B. Breaking for packages that ship
  composable grammars. `8fbb68c7`, 0.58.0; a sidecar without `exports` threw, fixed in
  `a5a630b2`.
- **One-node collapse with no frame.** A `collapse: true` node whose body is one node runs
  as that node, with no capture frame. `b9700870`, 0.58.0. The general frameless collapse
  was rejected (below).
- **Shared-ends choice factoring.** Arms that differ in one term become that term's choice,
  so the shared terms run once. A review found it could change the winning arm when the arms
  carried their own lookaheads; fixed in `f1d011e6`. `10aa857f`, 0.58.0.
- **`peek()` as a scalar.** `peek()` of a direct literal or regex is one recognizer call, as
  `not()` already was. `b50090e3`, 0.58.0.
- **Scanner handoff only where needed.** A selective assembly passes the installed trivia
  scanner across an engine boundary only if the code on the far side reads it. `83682f9f`,
  0.58.0.
- **MathUnary pass-through.** A collapse over `optional` terms and a node passes through when
  the character it starts at opens none of those terms. `5600fbe5`, 0.58.0.
- **PURE class pools.** A printed char-class pool (`"…".split("|")`) is marked
  `/* @__PURE__ */` so a bundler drops the pool of a variant it shook out: CSS −8.4 KB, SCSS
  −8.0 KB, `.jess` −14.1 KB. The size ceilings rose 16 B per module. `dc859e68`, 0.58.0.
  Those four items together measured Less −2.5% JIT and −2.2% `--jitless` (434.0M → 423.0M
  JIT).
- **Hold the gap across a lookahead.** A gap scanned before a `not()`/`peek()` is kept for
  the next term instead of being scanned again. `0c4b4c1f`, 0.58.0. With the next item,
  Less −3.3% JIT and −4.4% `--jitless`.
- **ASCII-fold key.** A case-insensitive dispatch on a key with no capital looks the key up
  as it is, without building its folded copy. `6bc77801`, 0.58.0.
- **Fail-clean, no mark.** The closure engine takes no rollback mark for a child whose
  failure writes nothing (an `optional`, a choice or a repeat item over a terminal, or a
  sequence that can only fail in its first term). `484a5271`, 0.58.0. With the next item,
  `--jitless` −1.2% to −3.1% on every grammar and JIT flat to −1.1%.
- **Scalar dispatch marks.** The closure engine's `dispatch()` keeps its rollback mark in
  scalars, not five objects. `38d264c2`, 0.58.0.
- **No-trivia scope alias.** A scope with no trivia, under no trivia, runs as its child:
  four fewer pieces per declaration. Less −0.5% `--jitless`, others flat. `1aaea74d`,
  0.58.0.
- **Lookahead-led node frame.** A node that opens with `not()`/`peek()` decides the
  lookahead before it opens its frame. A Less `color: red;` drops 342 instructions (about
  42.7k per declaration), the rest is flat. `879d0f38`, 0.58.0.
- **Lexical bodies, capability closure.** A `token()` whose body is a choice of any arity, a
  separator-less repeat, or contains a no-trivia scope or a nested `balanced()` becomes one
  lexical recognizer. All four Jess grammars close lexical capability, with five bugs fixed
  on the way (lookahead completions, the lexical choice's expected set, `withCtx` and
  `balanced()` records). The gain is small: Less −0.6% JIT, SCSS −0.5% and `.jess` −1.1%
  `--jitless`; a Less declaration goes from 42.6k to 40.4k instructions and from 65 to 53
  pieces. A lexical body calls a sticky regex through closures, while the emitted character
  path already scans straight-line. Shipped because the design record
  (`docs/design/derived-tokenization.md`) requires complete capability closure before
  per-site selection. `0ab9e9f7` (11 commits on `879d0f38`), 0.58.0.
- **Routed-arm gate, `OP_RGATE`.** A choice arm led by a `routed()` token gates on its next
  term's first character, so a name read once by `dispatch()` is followed by a first-character
  decision. Neutral on the grammars Jess ships today; it makes name-once dispatch possible.
  A review fix limits it to scalar next terms (`95bc9040`). `0ab9e9f7`, 0.58.0.
- **Assembly selection says why it ships nothing.** Two silent "no assembly" returns left an
  artifact on the closure engine with no warning. Narrowing now continues until the selection
  fits or empties, and an empty one is a build warning. No speed number. `b13fe235`, 0.58.0.

### Landed on the 0.59.0 line (unreleased)

Branch `perf/rgate-depth2` @ `ea11cca6`, which contains `perf/precedence-loop`,
`perf/loop-followups` and `perf/gap-handoff`. The CHANGELOG's 0.59.0 section is open.

- **Nullable-regex first sets.** A `regex()` that may match empty still reports `any`, but
  also carries the first characters of its non-empty matches. A sequence led by an optional
  pad such as `ws* '*' ws*` gets a finite first set, so operator repeats get item classes
  and operator nodes get gates. SCSS −10.8% JIT, −9.1% `--jitless` (wall 62.7 → 56.8 ms);
  Less, CSS and `.jess` flat or slightly better; trees identical. `91fa8d87`.
- **Separator gate.** A `sepBy()` past its minimum ends on a character its separator cannot
  start, without entering the separator. `fc5ea520`.
- **`x:(1;` expected-set fix.** A `sepBy` of `min: 1` whose first item fails reported what the
  failed item left (`")"`); the table readers now report the item's derived set at the list's
  start, as `repeat.ts` specifies. `d77b449a`.
- **`otherwise(p, { commit: false })`.** A `dispatch()` committed whenever a selected branch
  failed. The option keeps that on the `when()` cases and lets the fallback fail uncommitted,
  so a statement read once by its name ends the statement list instead of stopping the parse.
  It exists so Jess's Less name-once dispatch
  ([jess#515](https://github.com/jesscss/jess/pull/515)) can keep its error recovery. Carried by
  the interpreter, all table engines, the IR printer and the macro evaluator. `1b4ef862`.
- **Gate dedup.** An optional repeat item no longer tests its lead gate twice, and with no
  separator or gap in front, tests its item class once per iteration. This removed the SCSS
  keyword (+2.9%) and `@if` (+2.7%) regressions the first-set work introduced. `30c5a279`,
  `3aae1d3c`.
- **Exact shared-prefix arm.** `choice(sequence(X, a), X)` with the value unused is encoded as
  `sequence(X, optional(a))`, so `X` is not parsed again. Jess's SCSS mixin argument has this
  shape. `6e1a1d0a`. Together with the three items above, SCSS is −15.3% JIT and −12.3%
  `--jitless` against 0.58.0 (1098.2M and 9116.9M instructions; cold 149.8 → 137.9 ms),
  Less −1.1% JIT, CSS and `.jess` flat or faster.
- **Gap op, `OP_GAPGATE`.** An optional repeat whose item opens with a gap reads the gap
  once, then enters the item with the gap's end in a slot. SCSS keyword 33.4k → 24.7k
  instructions (−26%), `@if` guard −12%, a 10-item space list −23%. Whole-file SCSS only
  −0.6% `--jitless`, since the generated workload has few space lists. Not under tolerant
  recovery or a completions probe. `10577629`, branch `perf/gap-handoff` @ `4602ca84`.
- **Two-character routed gate, `OP_RGATE2`.** Where the next term states its first two
  characters, the gate reads both. On the grammar of jess#515, nested `div:hover{}` goes
  from 45.7k to 42.8k JIT instructions (`lessc`: 41.3k) and glued `color:red;` improves 3%.
  No Jess grammar on `dev` has such a site yet. `7462efe8`, with emitter and closure
  follow-ups `3351fec7`, `867613fe`. On jess#515's grammar it is −6% JIT and −5.3%
  `--jitless` on nested `div:hover{}`; `color: red;` is flat.
- **Gate-neutral selection pricing.** The emitted-site budget prices every `OP_GAPGATE` as
  the item it guards, so adding gap gates no longer moves which sites get emitted. CSS, SCSS
  and `.jess` now emit the same sites as a build without gap gates (76 / 63 / 131, 0
  differing; each differed by 2 before). CSS `--jitless` 1917.4M without gates → 1916.1M
  with them, so the earlier CSS lean is gone. SCSS 9115.5M → 8989.4M with gates. `b058918f`,
  branch `perf/less-gap`.
- **Jess side: SCSS `MapOrGroup`.** SCSS parsed `(` through a value-atom path that was 14% of
  SCSS pieces and that Parseman cannot factor exactly. The
  grammar now reads the first operand once and branches on `:` or `)`. SCSS −11.7%
  `--jitless`, −13.9% JIT; maps −0.4%. Groups containing `/` and lists keep the old path.
  [jess#523](https://github.com/jesscss/jess/pull/523), merged.

## Rejected (measured)

- **Shared emitted helpers for marks and undo.** Route every emitted rollback mark and
  scanned-term undo through shared helpers. It shrank whole-grammar emitted code 28–30%
  with identical trees and unchanged marginal instructions, but made Parseman's own
  benchmarks slower. Alone against its parent: `json/document` +24.5%, `rollback/medium`
  +21.6%, `rollback/sparse` +15.7%, `expected/none` +13.2%, `expected/wide` +11.0%.
  Reverted: no speed for size. `c70b72e7`, reverted by `bc11a9ca` before 0.57.0.
- **Static stable selection.** Quantize the static site rank so selection holds still under
  small edits, and buy a prefix of the order. SCSS +0.4% `--jitless`. Reverted before
  0.58.0. `f4294abd`, reverted by `cf7d344f`. The instability it targeted is still open
  ([#179](https://github.com/matthew-dean/parseman/issues/179), queued below).
- **Profile-driven selection (`assemblyProfile`) for Jess's builds.** Train the profile on
  Less's unit tests, measure on the held-out `benchmark.less`. No grammar was better on every
  measure. Less: whole file −0.3% to −2.9% JIT but cold start +4.7%; SCSS +4.2% JIT; CSS +1.5%
  JIT; `.jess` −1% `--jitless`, otherwise flat. An earlier −5.5% for Less did not reproduce.
  Static ranking stays. The option still ships in 0.57.0 for grammars that want it.
- **Inline-emitted lexical bodies.** Write a lexical body out as straight-line code in an
  emitted assembly. Static selection never picks lexical sites; they were 1.6% of profiled
  calls, so the result cannot show up. Not shipping; the branch is kept. `8fb0d336`,
  `perf/lex-inline`, [#171](https://github.com/matthew-dean/parseman/pull/171) (CI only).
- **Per-site cost model for lexical bodies.** Choose lexical lowering site by site by cost.
  No site was shown slower with a lexical body, so a model had nothing to choose between.
- **Single-child wrapper fusion.** Fuse pass-through pairs of pieces. Adding one call per
  piece costs only +1.9% JIT (SCSS) and +3.5% `--jitless` (CSS), so fusing every pair would
  win about 0–0.8% JIT and 2–3% `--jitless`. Single-child wrappers are 42–56% of pieces, but
  the cost is the work inside frames, scopes and gates, not the boundary between them.
  Measured on the `perf/precedence-loop` lane; no code kept.
- **Full precedence-frame loop.** Detect an operator-precedence chain (value, math sum,
  math unary, …) and run it as one loop: atom once, then a first-character operator switch.
  Ceilings were measured before building: about 4% on an SCSS declaration and about 1% on a
  Less one, once nullable first sets and gap gates exist. The Less cost left is the gap
  re-scanned by the operator pads. Not built. Comparisons (`A (cmp A)?`) are not chains. Measured on `perf/precedence-loop`.
- **Resumable gap op as a pre-scan variant.** Resume a gap scan inside the guard. The ceiling
  was −11% per Less keyword and 2.7% of pieces, and a guard version is a pre-scan, which
  ruled out. The shipped
  `OP_GAPGATE` above is the form that reads the gap once and keeps it. Skipped on
  `perf/value-chain-fusion` (head `6bc77801` at the time); no code kept.
- **Lazy raw entries.** Compute a node's raw entries only when asked. Raw entries are 1.4%
  of a Less `color: red;`'s cost, so the ceiling is about 1.4%. Not worth it. From the protocol census on
  `perf/value-chain-fusion` @ `6bc77801`; no code kept.
- **Lazy single-child collector slot.** Allocate a collector's slot only when a second child
  arrives. It lost under `--jitless`. No branch kept.
- **Lazily computed fail-clean answers.** Compute "does this child's failure write nothing"
  on first use instead of once when the assembly links. CSS +0.45%. The answer is derived
  once from the table. No branch kept.
- **Frameless general collapse.** Run any `collapse` node as its child with no frame. +3%.
  The one-child case and the optional-terms case shipped in 0.58.0 (above). No branch kept for the general form.
- **Whitespace-only minification of artifacts.** Strip whitespace from the printed grammar.
  The minifier (oxc) rewrote string literals as template literals, so `.jess` was +2.4%
  `--jitless`. Not shipped; no branch kept.
- **A `quiet()` lookahead primitive.** A quiet variant of `peek()` for guards. Rejected
  because it would entrench pre-scans. Never built.

- **Subtracting gap-gate bytes from site prices.** Price a site without its gate's own bytes.
  It still moved one site per grammar, because hoisted constants and the slot-test estimate
  are not exact. Superseded by gate-neutral selection pricing (above). No code kept.
- **Gap op for Less's classified-trivia gap.** Inside a `leaf` or `token`, accept
  `optional(<trivia of regex arms>)` as a gap and hand its value and end through the slot,
  keyed on the trivia scope. Exact, with three planted defects caught, but it did not pay:
  Less keyword 19.99k → 19.87k instructions, `width: 1px + 2px * 3` 61.3k → 62.3k (+1.7%),
  whole file `--jitless` +0.3%. Running the composite gap under the leaf's sink save, clear
  and restore costs about what the skipped operator attempt cost. SCSS gains because its
  gap is one regex. `b4f684c5`, reverted by `fdea063f` on `perf/less-gap`.
- **Direct values: node children as locals, not context collectors.** The emitted assembly
  passes a node's children and raw entries to each piece as two arguments; a frame binds
  fresh arrays and a leaf is a push. Trees identical on 461 Less files; the failing-input
  differential (span, expected set, unconsumed offset) caught four planted defects. In a
  selective assembly every crossing pays an adapter (Jess's shipped Less build: +9.4% JIT),
  so it was limited to assemblies with no closure pieces, which leaves the shipped build
  unchanged (`color: red;` 37.7k → 37.3k, A/A 37.3k). With every site emitted, `color: red;`
  is 24.1k (base 24.5k) against 11.2k for the hand-written recognizer the plan was priced
  on. Removing every remaining frame item (`_fields`, `captureTrivia`, trivia-log stores)
  reached 22.1–22.6k, inlining small shared regions changed nothing, and a first-character
  gate before the labelled trivia skip saved 0.6k. The earlier frame and push costs were
  priced as additions to the hand-written code, not as shares of the generated code. A
  profile of the generated code puts it, per declaration, at: calls between pieces ~5.8k
  (53 functions, 13 inlined regions, against ~12); reducers ~4.7k (hand-written 3.7k);
  labelled-trivia scanning ~3.4k (`skipDeferredTrivia`, its gap memo, `scanWithLabels`, six
  log reads per sequence term); GC ~3.0k (hand-written 1.0k: expected-set arrays of failed
  arms, `_routed` objects, capturing frames' arrays); pushes 1.1k, marks 0.7k, frames 0.45k.
  Every-site artifact 4.68 MB (~17×). Rejected: still about 2× the hand-written code with
  frames and pushes gone. Branch `perf/direct-values` @ `d5d98460`, unmerged.
- **Allocation-free expected-set merges on failed arms.** On Jess's shipped Less build, a
  declaration makes 3 expected-set merges in the closure engine, 2 of which copy an array
  (18 strings), plus one routed-token object: about 300 B of the 5.4 KB a declaration
  allocates (the hand-written recognizer: 2.2 KB). The extra allocation is frames and
  spans. With merges made free (a probe valid on accepted input only), `color: red;` and
  the keyword list stayed inside the A/A and the whole file moved −0.8%. Not built; the
  probe was a dist edit, no branch kept.
- **Left-corner routing, first form: one shared walk, no gap routing.** Every level from a
  node down to the first node a character reaches starts at the same position with the
  same piece. So route on that character (gates, dispatching choices, lead masks, trivia
  labels), call the deepest node once, and complete each enclosing level as its reducer
  on the lone child. A level whose continuation can start runs a freshly linked copy of
  itself with its left corner seeded, so nothing is read twice. Census for Less
  `color: red;` (closure engine, `assemblyBudget` 0): the levels above `Value` cost 9.9k of
  the declaration's 39.8k JIT instructions (25%) and ~100k of 332k `--jitless` (30%).
  About 4.7k of the 9.9k is reducers, so the ceiling is ~13%. Trees identical on 11.4k
  inputs × 4 variants, with planted defects caught. Less `color: red;` −11% JIT, but
  every value followed by a space resumed at each level, and one runtime walker made the
  call sites megamorphic: CSS +3.7% / +9.8%, SCSS +5.1% / +8.5% (JIT / `--jitless`),
  space runs up to +17% `--jitless`. Measured against `main` @ `44c9d269`. Branch
  `perf/left-corner-routing` @ `2844597c`, closure engine only, behind `PM_LC=1`. The
  second form, below under Queued, replaces it.
## Parked

- **Test the decisive first term before opening frames.** Failed attempts the first term
  decided (nothing consumed) leave removable pieces of 4.4% (CSS), 6.0% (Less), 10.0% (SCSS)
  and 9.6% (`.jess`) of all pieces, with 2.5k–31k node frames per fixture. At about 0–20
  instructions per pass-through boundary and a few hundred per node frame, the JIT ceiling is
  about 0.2–0.6% per grammar; `--jitless` about 3–5× that. Generalizing `FIRST_DECIDED`
  through node, scope and sequence in both engines is a large build for that. The largest
  CSS and `.jess` sites are one-character gates that admit too much, which the two-character
  gate family addresses more cheaply. Census on `perf/less-gap`; not built.

- **`.jess` `ExpressionLogical` capture replay.** `and`/`or` in `.jess` are choice arms that
  reparse their left operand up to three times. Fixing it in the engine needs capture
  replay, for about 2% of the `.jess` parse. Reshape the grammar later instead.

## Queued and in progress

- **Left-corner routing (accepted direction, prototype).** Every level from a node down
  to the first node a character reaches starts at the same position with the same piece.
  Each route is its own chain of closures, so wrappers that only route cost nothing. The
  route calls the deepest node once and completes each enclosing level as its reducer on
  the lone child. A continuation is routed on the next token: a captured token, or a
  skipped one. Which one it is comes from the scope's trivia definition, never from the
  character, so whitespace routes as a captured token in a `noTrivia` scope or as an
  `optional(<regex>)` gap, and as skipped where the trivia skips it. A skipped gap, the
  `OP_GAPGATE` gap and the `optional` gap are each read once, and the read's end is
  handed to the term that reads it next. Literal separators are routed too, and no route
  is installed whose top always resumes. Census for Less `color: red;` (closure engine,
  `assemblyBudget` 0): the levels above `Value` are 9.9k of the declaration's 39.8k JIT
  instructions (25%) and ~100k of 332k `--jitless` (30%); about 4.7k of the 9.9k is
  reducers, so the ceiling is ~13%. Trees identical on 11.5k inputs × 4 variants, and on
  Less with `mathMode` `always` and `parens`. Planted defects caught: a wrong reducer
  state on 44 and 50 rows, a dropped lone child on 249–5241 rows per dialect, a skipped
  choice failure on 1 (Less) and 13 (SCSS), a skipped repeat report on 47 (Less). The
  mirrored separator and gate-failure writes never run on these grammars, because the
  separator gate decides every list. The `optional`-gap write runs 2.8k times on CSS, but a
  later write always replaces it. Interleaved marginal instructions against the same tree
  with the switch off (`release/0.59.0` @ `52326958`), A/A null within ±1.2% (±2.3% on
  one `--jitless` file):
  - Less `color: red;` −12.3% JIT / −16.3% `--jitless`; SCSS −9.0% / −10.4%; `.jess`
    −7.0% / −12.9%; CSS −5.7% / −8.1%.
  - Whole files, all faster in both modes: `benchmark.less` −4.7% / −9.6%,
    `bootstrap-less-port` (90 files, 240 KB) −3.9% / −6.2%, `benchmark.css` −4.7% / −3.9%,
    `gen-workload.scss` −2.9% / −2.5%, a 36 KB `.jess` workload −3.6% / −3.8%.
  - Open: a value that continues at every level loses. `font: 12px/1.5 a, b;` (a slash,
    then a space, then a comma) is +7.9% / +5.3% on CSS and +5.5% / +5.6% on `.jess`.
    Branch @ `b9bfdc8e`.
  - Resume fix, first attempt (@ `6a5f776e`): a level that resumes opens only the frame it
    skipped, with the value in hand, and runs from its left corner; it is no longer a
    seeded copy of the level. That case is now +5.2% / +4.2% on CSS and +6.1% / +5.0% on
    `.jess`. `grid-area: 1 / 2 / 3;` and `border-radius: a / b;` are faster in every
    dialect in both modes, and every whole file stays faster.
  - Turning off each of that case's three routes in turn removes about 1% each; with all
    three off, the switch still costs +0.8%. So what is left is a fixed cost per route
    (entry, the collector save and restore, the final publish) plus the driver every
    node call passes through, not the resume.
  The build-out derives the routes into table rows at encode time for every engine, on
  `main` after 0.59.0. The next large piece is `Value`'s 17-arm choice (~8.5k of
  `color: red;`), the across-arms case `factor-choice.ts` handles. Branch
  `perf/left-corner-routing`, raw samples under `scratchpad/left-corner/results/`.
- **Comment-sensitive selection
  ([#179](https://github.com/matthew-dean/parseman/issues/179)).** Comment-only edits to
  Jess's SCSS grammar moved the emitted function count from 61 to 55: the build measured
  −13.9% JIT at 61 and −11% at 55. Cause: the budget is a fraction of source length, and the
  static ranker caps recursive-cycle weights, so near the line the choice comes down to
  emitted size. Done when comment edits leave the artifact byte-identical.
- **Gate head-side bias
  ([#175](https://github.com/matthew-dean/parseman/issues/175)).** `expected/none` reads about
  +1% slower on the head side whenever the compared trees differ, even for plugin-only or
  selection-only changes, so a real 1% regression would hide inside it. Done when an A/B of two
  trees differing only in an unloaded file reads within the null.
- **Less name-once dispatch
  ([jess#515](https://github.com/jesscss/jess/pull/515), draft).** Read a statement's
  leading identifier once and delete the regex pre-scan guards. Whole file −1.6% / −1.25%
  `--jitless`, −2% JIT, hashes identical to `dev` on 461 inputs × 4 variants. Held: before
  `OP_RGATE2`, nested `div:hover{}` was +5% `--jitless` and +15% JIT and glued `color:red;`
  +3.4%, because a one-character gate admits `:` and a failed routed arm costs about 22k.
  Waits for 0.59.0 to publish.
- **One compiled file per grammar.** Each Jess grammar exports four `compose()` grammars
  (AST, AST with positions, CST, CST with positions), so the build writes four near-identical
  files of about 775 KB for Less that differ by about 4 KB. Parseman's one-table linker can
  fold them. A process loads one variant, so this mostly cuts install size. Keep it only if
  cold start and parse are equal or better.

## How to add an entry

Every perf lane appends its idea, numbers and verdict to this file in the same PR as the
change. A rejected idea has no change to ship with, so record it in a docs PR instead.

- Put it under the status heading. Move it when its status changes; don't delete it.
- Use three to six lines: what it is, the measured result with the key numbers, why it
  shipped, was rejected or was parked, and where it lives (version, branch and short SHA,
  PR or issue).
- Measure the way the section above says: marginal instructions, JIT and `--jitless`,
  interleaved, and an x64 gate for anything on the hot path. Say what the numbers were
  measured against.
- Give the number you got, including a number that is inside the spread. If you could not
  measure it, say so instead of estimating.
