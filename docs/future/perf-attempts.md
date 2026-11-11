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

- **Constructor-built tree objects (Node 26 pretenuring flip).** V8 pretenures object
  literals per allocation site, decided during warm-up from where scavenges fall, so
  identical processes split into a fast and a slow mode and any bundle-layout change
  re-rolls it. Leaves, spans, default nodes, field captures and capture buffers are now
  built by `new` calls (`src/cst/plain.js`), which have no allocation site, and the bench
  fixtures' node builders do the same. With dead code of 0–15,000 bytes appended to
  `dist/index.js`, every process of the gate cases and of four runtime-kept trees (a CST
  host, builder-less default nodes with and without line tracking, a builder that keeps
  its span) ran in the fast mode on Node 24 and 26 (1–2 mark-compacts, against up to 61).
  JIT marginal instructions against a slow-mode main: `css/stylesheet` −31% (Node 24) and
  −34% (Node 26), `expected/narrow` −14% / −37%, `rollback/medium` −11% / −32%. Against
  main's fast mode, `rollback/medium` on Node 26 reads about +4% (12.36M → 12.84M): a tree
  that is never pretenured is copied by the scavenger. `--jitless` reads +1% to +5%: an
  interpreter cannot see the mechanism.
  The constructors must exist ONCE per process. A first build bundled a copy into each
  entry, so a process that loads `parseman` and `parseman/table` (Jess) built every shape
  under two maps; Jess's SCSS parse ran +3.1% (Node 24) and +6.7% (Node 26) from the
  polymorphic reads. The build now emits `dist/cst/plain.js` once and every entry
  imports it; that SCSS row reads −0.3% on both. Investigation in
  [#224](https://github.com/matthew-dean/parseman/pull/224).
- **The cost of never pretenuring: one synthetic case.** With Jess's AST nodes constructor-built
  too (jess `perf/ast-ctor`), Jess's SCSS `gen-workload` reads +3.6% JIT on Node 26 (998.0M
  → 1034.2M per parse; −0.3% on Node 24). It is a single file of about 1G instructions per
  parse, and its tree survives several scavenges. Node 26 pretenured that tree in every
  process, so it was never copied. Constructors cannot be pretenured, so the scavenger copies
  it instead: scavenge time over 40 parses is 65 ms on main against 114 ms, with the same
  scavenge count. Real SCSS is not slower. JIT marginal instructions on Node 26 / Node 24:
  Bootstrap 5 (92 files) −2.1% / −0.2%, Foundation (106 files) −0.9% / −1.0%, the accepted
  sass-spec fixtures (1,961 files) −1.6% / −1.7%. Mark-compacts are 1–2 per process in every
  case, and scavenge time is within noise. Accepted: the synthetic case pays for copying
  that consistent pretenuring avoided. The way to win it back is less short-lived
  allocation, so a tree survives fewer scavenges. A literal site would bring the per-process
  split back.

- **Watched literal sites (not converted).** These are still object literals, and none splits
  a process today. A tree does not keep them, or they are rare:
  - field-map entries (`src/compiler/fields.ts` `buildFieldMap`);
  - the interpreter's `annotateSpanFromLineContext`;
  - parse-error objects;
  - the public `annotateTreeSpans`.

  `pnpm perf:pretenure` would show it if one began to.

- **`graphql/document`'s nodes are constructor-built too (0.60.0 line).** The required
  cross-process gate on #243 (CI, Node 26, against v0.59.1) failed one case:
  `graphql/document` median +5.4% (p 4.7e-43), mean +5.6%, head slower in 157/160 rounds.
  Every other case read within ±0.5%. It was the same flip as 0.59.0's, in the workload's
  OWN nodes: `examples/graphql/parser.ts` built them with object literals in its
  `transform()` reducers. Constructor-built tree objects covered Parseman's objects and
  `examples/css`, but not this grammar. Measured per process on Node 26.13, macOS, with
  12 processes per side and the gate's worker:
  - Default runtime: the head pretenured in 12 of 12 processes (17–18 mark-compacts,
    0.514 ms, 49.55G instructions). v0.59.1 pretenured in none (1 mark-compact, 0.501 ms,
    47.20G).
  - `--no-allocation-site-pretenuring` (diagnostic only): 0.491 ms / 47.59G against
    0.486 ms / 47.69G. So the parse work is the same.
  - `--trace-pretenuring`: the head tenures three adjacent allocation sites (found/created
    264, 271 and 243, ratio 1.0); v0.59.1 tenures none. Building only the field node with a
    constructor takes the head to 1 mark-compact in every process (0.489 ms against
    0.492 ms for v0.59.1 on the same worker). Converting only its `?? []` defaults leaves
    13 mark-compacts.
  - Fix: every node the example keeps is a `new` call on `examples/graphql/graphql-node.js`
    (prototype `Object.prototype`), as `examples/css/css-node.js`. With never-called code
    appended to the head's `dist/index.js`, every process stays at 1 mark-compact.
  - Local gate, `graphql/document` only, against v0.59.1, Node 26.13: before +4.8%
    (p 4.3e-7, 28/30 rounds slower); after +0.3% (p 0.21, 23/40), ok.

  - `examples/lang`'s AST and `examples/toml-ish`'s lines were kept literal-built nodes
    too, and `examples/css`'s `nilNode()` a literal; all three are constructor-built in
    the same series. `examples/json` keeps none: its objects come from
    `Object.fromEntries`, and its `[key, value]` pairs die inside the reducer.
  - `pnpm perf:pretenure` runs `graphql/document` (1 mark-compact per process at every
    pad, Node 26.13). A plant that turns every graphql node back into a literal in that
    check's worker does NOT fail it: 1 mark-compact in every process at pads 0, 100, 500,
    970, 2,000, 4,000, 8,000, 15,000 and 30,000, and at 1,500, 4,000 and 8,000 parses. The
    same literals tenured in 12 of 12 processes under the cross-process gate's worker on
    #243's bundle, and in 0 of 12 on v0.59.1's. The flip needs a layout that check does
    not reach, so the plant would be blind and was not landed.

  A user grammar whose reducers build object literals can still flip the same way: the
  site is in the grammar, so no change in Parseman reaches it. The CHANGELOG's advice
  (build kept nodes with a constructor) is the remedy.

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

### Unreleased on `main`

- **Connected selection for `assemblyProfile`.** A site's worth now counts the wrapper
  crossings it removes, so a profile no longer leaves islands of generated code. Jess's Less
  build on `benchmark.less` at `0.5`, on a loaded machine with no `--jitless` or x64 run, against
  `main` static: -11.19% instructions and -2.86% calls (`main` profiled: -6.95% and +8.95%).
  Rows in [#271](https://github.com/matthew-dean/parseman/pull/271), `61b9f562`. Weight 4 beats
  no weight but isn't tuned: 2 and 8 are untried.

- **One function for functions that read the same.** `optional(x)` written in 25 places was
  25 functions, and connected selection took more of them. Merging them after the entry join,
  comparing identifiers only, makes the same calls: `call-count` passes against v0.61.4.
  Duplicate functions on Jess's builds, with `main` static in brackets: Less at `0.5` 48 (48),
  SCSS at `0.612` 47 (51), CSS at `2.72` 15 (46).
  [#271](https://github.com/matthew-dean/parseman/pull/271), `61b9f562`.

- **A budget that comments cannot move, and a selection that only grows.** The budget was a
  share of the module's raw text, so a comment edit could buy or lose functions: 61 against
  56 on Jess's SCSS, about 1% of parse speed. Selection also shrank its target by at least 1%
  and retried when the source overshot, so a little more budget could lose sites: across 40
  budget steps per grammar it lost css 33, less 30, scss 41 (11 in one step), `.jess` 13. Now
  a selection is a prefix of the ranking, the budget is a share of the code without comments
  or whitespace, and the default share is `0.5`. Sweep: 0 sites lost. Skipping a site that
  does not fit cannot give that property, because a budget that admits a big site then
  loses the small ones a smaller budget took after skipping it. Sizes at the budgets Jess
  moves to, against `main`: Less 696,315 B (698,114), SCSS at `0.61` 442,881 B (444,036),
  CSS at `2.72` 421,972 B (422,073). Identity 0 diffs, AST and CST, all four grammars.
  Issues [#179](https://github.com/matthew-dean/parseman/issues/179),
  [#255](https://github.com/matthew-dean/parseman/issues/255).
- **Trivia lead gate.** A trivia skip at a character no trivia can start returns `cur`
  without the runtime scan, in both table engines (the closure engine per trivia slot,
  the emitted assembly in its skips and sequence terms), and the term takes no trivia
  marks there.
  - Jess's shipped Less build, against `main`, JIT st (A/A inside 1%):
    | Input | `main` | Gate | Change | lessc 4.9.1 |
    | --- | --- | --- | --- | --- |
    | `color: red;` | 37.9k | 36.1k | −4.5% | 6.8k |
    | `.r { }` | 33.3k | 29.8k | −10.5% | 26.4k |
    | `.a .b > .c { }` | 53.5k | 50.8k | −5.0% | 36.7k |
    | keyword list | 26.3k | 25.7k | inside spread | — |
    | whole file (`--jitless`) | 357.8M (2295M) | 344.0M (2094M) | −3.9% (−8.8%) | 153.9M (780M) |
  - Other Jess grammars, whole file, JIT / `--jitless`: CSS −3.7% / −5.7%; SCSS −1.4%
    (A/A spread 3%) / −6.6%; `.jess` −7.6% (±2.9%) / −11.5%. Cold start is inside the A/A
    for all four.
  - Identity: ASTs and CSTs identical on 461 Less files; `compare:less:builds --corpus`
    byte-identical in all six modes; both checks go red with a narrowed lead table.
  - The two other trivia parts did not land. Marks are already skipped wherever the gate
    fires, and taking them only when a log is live changes nothing for Jess, which always
    parses with a live root trivia log. Dropping the gap memo is rejected (below).
  - Branch `perf/shipped-alloc-trivia`.

- **Delete three trivia slots no engine read back, and build a raw entry only where a buffer
  takes it.** `ParseContext._triviaLog`, `_cstTriviaLog` and `_cstRawChildren` were saved,
  cleared and tested around every attempt, token and node on all four engines. A node also
  built `rawEntry()` (a leaf, a span and a slice for a non-node value) and then dropped it when
  no `_cstBuf` was open. Call count against v0.61.9: branch tests fall 2.6% to 10.2% on every
  row and calls up to 3.7% (Less `app.less` AST −8.15% branches, −3.62% calls); no row rises.
  Time not measured: the x64 machine is with the cold-start lane. Breaking for printed
  factories (two helper signatures), so it declares 0.62.0 with an `abi` lock on the record.

## Rejected (measured)

- **Merging same-text functions before the entry join.** Two earlier places for the merge
  above. Interning `optional` rows in the encoder moved the static selection and raised calls
  by up to +0.15% (`macro/less/ast/site.css`). Merging at emission left the selection alone
  but raised calls by up to +0.12% (`macro/scss/ast/site.css`), because a merged function has
  several callers and the entry join only takes a function with one. No branch kept.

- **One generated function per shape.** The ceiling is small: identical shapes would save at
  most 4,064 B on Less and 5,929 B on SCSS, most of it `_px` wrappers. Tried as one wrapper
  per scanner with the callee passed as an argument. After the freed budget buys sites, that
  saves 890 B on Less and 976 B on SCSS, with no gain in instructions: worse on 4 of 8 rows
  (`benchmark.less` -10.3% to -10.0%, generated SCSS -4.1% to -3.0%), better on 3 and level on
  1. Calls on `benchmark.less` rise to 2,250,635
  against `main`'s 2,247,253. Numbers are from the prototype harness on a loaded machine. No
  branch kept.

- **Dropping the trivia gap memo.** Remove `skipDeferredTrivia`'s repeat-scan memo, on
  top of the lead gate. Jess's Less build: `color: red;` 36.1k → 37.0k (A/A 36.4k), whole
  file 348.1M → 343.3M (A/A 347.5M, spread 1.8%). The memo still answers repeats where
  trivia does start, and no site was found where a label proves it cannot hit. Probe was
  a dist edit; no branch kept.

- **Shared emitted helpers for marks and undo.** Route every emitted rollback mark and
  scanned-term undo through shared helpers. It shrank whole-grammar emitted code 28–30%
  with identical trees and unchanged marginal instructions, but made Parseman's own
  benchmarks slower. Alone against its parent: `json/document` +24.5%, `rollback/medium`
  +21.6%, `rollback/sparse` +15.7%, `expected/none` +13.2%, `expected/wide` +11.0%.
  Reverted: no speed for size. `c70b72e7`, reverted by `bc11a9ca` before 0.57.0.
- **Static stable selection.** Quantize the static site rank so selection holds still under
  small edits, and buy a prefix of the order. SCSS +0.4% `--jitless`. Reverted before
  0.58.0. `f4294abd`, reverted by `cf7d344f`. A plain prefix of the ranking, without the
  quantizing, shipped later: see "A budget that comments cannot move".
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
- **Partitioned factoring of Less `Value`'s 17-arm choice.** This would generalize
  `factor-choice.ts` to composite-`ref` corners and to factoring only the arms that share
  a corner. Not built: the choice already routes to its arm in O(1). For every letter,
  digit, `#`, `"`, `[`, `` ` `` and `+`, the first-character mask selects one arm, so `red`
  goes straight to `IdentifierOrFunction`. Only `@ - . $ % ( ~ \` have two or three
  candidates, and for `@` the existing literal pretests already rule out `@{` and `@@`
  (0 visits). Site visits on the closure engine:

  | File | `Value` entries | Failed arm entries |
  | --- | --- | --- |
  | `benchmark.less` | 5172 | 164 (3%) |
  | `bootstrap-less-port` (90 files, 240 KB) | 4627 | 292 (6%) |

  Most failures are `(`, where `QueryColonFeature` is tried before `Paren`, and `.`/`#`,
  where `MixinReference` is tried before `Dimension`. At about 2k JIT instructions per
  failed arm, that is 0.07–0.1% of a whole file, which is the ceiling for any
  partitioning of these arms. What `Value` does cost is per entry: its frame, the choice,
  and the `dispatch()` behind an identifier. On Less `red` that is 3.9k JIT / 28k
  `--jitless` above a bare keyword node; on `@x`, 2.4k / 23k above the variable reference
  node. That cost is the left-corner routing's to remove: through the choice, and through
  the `dispatch()` (Queued, above). Census on `perf/left-corner-routing` @ `99ebc7e4`
  (`scratchpad/left-corner/visits.ts`).

- **ASCII fast paths for `lead()` and `classHas()` in the closure engine.** Test an ASCII
  character against the class's table inline, as the emitted engine already does, instead of
  calling the two helpers. Counted calls on Jess's Less AST row (`site.css`, closure sites):
  `lead` 20.3k and `classHas` 14.3k of 323.1k, so the cut is 6–10% of calls. A wall-clock CPU
  profile of the same parse (mini PC, `benchmark.less` and an 83-file Bootstrap 4
  concatenation, Jess `d476f75fc` on parseman 0.61.5) shows neither as a frame: TurboFan
  inlines both into the pieces, so the calls cost about no time. Not built.

- **Deciding a repeat's next item after a pure gap read.** Read the gap in front of an
  optional item with the installed fast scanner before marking, test the item's class on the
  character after it, and reuse the end. Closure-engine prototype, calls / branches per parse
  against `main` @ `f521215e`. A value ladder (`List > Space > Term > Value`): `ids` 2,858 /
  14,280 → 2,735 / 12,099 (−4.3% / −15%), `nested` −6.4% / −23%. Jess's AST rows: Less
  `site.css` −0.4% / −2.5%, CSS +0.24% calls. Every Jess grammar uses `classifiedTrivia`,
  whose labels keep the fast scanner from being installed (`triviaLabelled`), so its gaps
  cannot be read without recording, and the read only adds a call. Not shipped; no branch
  kept. Making it reach Jess means a pure scanner slot for labelled trivia.

- **A larger assembly budget for Less.** Emit more of Jess's Less AST grammar as code and
  leave fewer sites to the closure engine. Mini PC (x64, Node 24.11.1), parseman `main` @
  `f521215e`. Marginal ms per parse on `benchmark.less` / an 83-file Bootstrap 4
  concatenation, interleaved, median of 3–5 fresh processes:
  - default (0.5): 30.6 / 30.2, with an A/A arm 30.9 / 29.8; 0.61.5 measures the same,
    30.6 / 29.6
  - budget 1: 31.3 / 30.0
  - budget 3: 29.3 / 29.3
  - budget 10: 28.6 / 29.1
  - every site emitted: 21.6 / 23.1 (−29% / −23%), the same in 8 fresh processes

  Emitting every site costs a lot at load. First parse rises from 163 to 215 ms
  (benchmark.less) and from 177 to 239 ms (Bootstrap). Module load rises from 43 to 105 ms.
  The shipped bundle grows from 592,167 B (115,656 gz) to 5,291,835 B (534,666 gz). Not
  shipped: no budget fits the size contract with a real gain, and every-site's first-parse
  and load costs rule it out. The curve is a selection-coverage effect, not a crossing tax.
  Crossings per parse on `benchmark.less` are 48.6k at the default budget, 65.4k at budget
  10 and none when every site is emitted. Their wrappers are 2.1–2.4% of a CPU profile,
  ≤ ~1 ms a parse. In the same profile the closure engine runs 22.1 ms a parse at the default budget and
  still 11.0 ms at budget 10. The sites the static ranking takes last carry that half and
  gain most from emitting: their 11.0 ms becomes 5.5 ms emitted.

## Parked

- **Dropping the SCSS nested-property pre-scan by reordering arms.** Try `Declaration` first.
  Instructions and calls against the fixture on `main`: `gen-workload` -0.7% and -0.4%, Foundation
  -1.9% and -1.6%, Bootstrap -0.6% and -0.6%, `spec-all` -5.3% and -6.2%. A file of only nested
  properties reads +41% and +39%, since the value parses twice; real files barely use the form.
  Not shipped: that rise breaks the calls bar. #265 landed with no `continues` option, so a retry
  needs a factored prefix of its own. The experiment changed only `fixtures/jess-grammars/scss/grammar.ts`.

- **Test the decisive first term before opening frames.** Failed attempts the first term
  decided (nothing consumed) leave removable pieces of 4.4% (CSS), 6.0% (Less), 10.0% (SCSS)
  and 9.6% (`.jess`) of all pieces, with 2.5k–31k node frames per fixture. At about 0–20
  instructions per pass-through boundary and a few hundred per node frame, the JIT ceiling is
  about 0.2–0.6% per grammar; `--jitless` about 3–5× that. Generalizing `FIRST_DECIDED`
  through node, scope and sequence in both engines is a large build for that. The largest
  CSS and `.jess` sites are one-character gates that admit too much, which the two-character
  gate family addresses more cheaply. Census on `perf/less-gap`; not built.

- **0.59.0 against 0.58.1 on Node 26: whole-family vs partial pretenuring.** (Measured on #212, then declared 0.59.0; the 0.59.0 that shipped is main's, without it, and #212 is the 0.60.0 line.) The
  cross-process gate read `expected/narrow` +12.3% and `rollback/medium` +4.7% (Node
  26.13, macOS) where the Node 26 self-check stayed within ±2.6%. Per process, with the
  gate's worker parameters and mark-compact counts (diagnostic flags only):
  - Pretenuring off (`--no-allocation-site-pretenuring`), both builds are identical:
    0.54–0.56 ms, 31G instructions, about 238 scavenges. So the allocation volume is
    unchanged, and so is the table: a build with a byte-identical `expected/narrow`
    table behaves as 0.59.0.
  - 0.58.1 pretenures in every process and tenures the whole tree family: 10–16 sites
    per process (allocation-count fingerprints near 330, 1,000–1,450 and 210–290), at
    0.58–0.70 ms with about 24 mark-compacts and 1.35 ms per scavenge.
  - 0.59.0 pretenures in 2 of 12 to 9 of 16 processes, and then only six sites in
    three pairs (fingerprints near 367, 520–527 and 1,539–2,445). The rest of the
    family stays young. That leaves tenured parents pointing at young children:
    1.56–1.59 ms per scavenge, 0.67–0.83 ms per parse. Processes that pretenure
    nothing run 0.54–0.57 ms, faster than any 0.58.1 process.
  - `--no-maglev-pretenure-store-values` changes neither build.
  - Bisected by the share of slow processes and their cost: no commit carries it. The
    per-parse closure code is nearly unchanged between the commits where it moves, and
    a commit's slow-mode cost varies from run to run (0.62 ms, then 0.75 ms).
  - No source lever: no new field, allocation or object in 0.59.0 causes it. Jess's
    Less parser on Node 26 is unaffected and 0.9–1.6% faster than on 0.58.0
    (`benchmark.less`, bootstrap, a small file; 12 processes each, 5–7 mark-compacts on
    both sides).
  - Candidate, not built: make Parseman's tree objects tenure together with a
    grammar's nodes, or decouple the two, so a partial tenuring cannot leave
    old-to-young pointers. It would change how the tree is built, with unknown effect on
    real grammars.

- **0.59.0's pretenuring flips follow bundle layout, not parse work.** (Measured on #212, then declared 0.59.0; the 0.59.0 that shipped is main's, without it, and #212 is the 0.60.0 line.) The required
  cross-process gate on `504ddea1` (CI, Linux, Node 26, against v0.58.2) failed seven
  cases:

  | case | median Δ | mean Δ | head slower |
  | --- | ---: | ---: | ---: |
  | rollback/sparse | +7.3% | +11.6% | 89/100 |
  | rollback/medium | +7.5% | +10.0% | 613/900 |
  | expected/none | +12.4% | +18.5% | 92/100 |
  | expected/narrow | −1.4% | +4.7% | 427/900 |
  | less/stylesheet | +11.0% | +8.0% | 78/100 |
  | less/mixins | +11.2% | +7.5% | 80/100 |
  | graphql/document | +4.8% | +5.0% | 156/160 |

  `rollback/none`, `rollback/dense`, `expected/wide`, `css/stylesheet` and
  `json/document` passed. Every failure checked is V8's allocation-site pretenuring
  decision:
  - `graphql/document`: the 0.59.0 build pretenures in 8 of 8 processes (18–19
    mark-compacts), v0.58.2 in none. With `--no-allocation-site-pretenuring`
    (diagnostic), both run 48.6G–48.7G instructions at 0.49 ms.
  - `less/mixins`: 2 of 8 pretenure, against none for v0.58.2.

  Jess's `.jess` parser on Node 24 shows the same split. Bisected with Jess rebuilt
  per commit (16 processes per side, `benchmark.css`, N 100 → 400; slow means at
  least 290M marginal instructions):

  | commit | slow processes |
  | --- | ---: |
  | `acb421e2` | 0/16 |
  | `6183b237` | 2/16 |
  | `18a8a077` | 1/16 |
  | `c2f4fbf8` | 7/16 |
  | `4e8b3cda` | 8/16 |
  | `4348bded` | 11/16 |
  | `5e27a457` | 10/16 |

  - `c2f4fbf8` changes only the emitter, which `.jess` never runs: its artifact has
    no precompiled functions, and `dist/run` is byte-identical. It adds about 700
    bytes to `dist/index.js`, which the parser imports.
  - Appending a never-called 970-byte function to the fast `18a8a077` build flips
    `.jess` to 8 of 16 slow (median 290.4M, against 278.8M for 0.58.0).
  - With pretenuring off, every build counts the same instructions.
  - On Node 26, `.jess` is unimodal at 288M for 0.58.0, `18a8a077` and the padded
    build alike.

  So the pretenuring share follows heap layout and allocation timing set by the
  bundle, and no per-parse change in 0.59.0 accounts for it. Trimming code only
  re-rolls the outcome. The lever is the tree-construction redesign: tenure
  Parseman's tree objects with a grammar's nodes, or decouple the two.

- **`.jess` `ExpressionLogical` capture replay.** `and`/`or` in `.jess` are choice arms that
  reparse their left operand up to three times. Fixing it in the engine needs capture
  replay, for about 2% of the `.jess` parse. Reshape the grammar later instead.

- **Left-corner routes, second form, as table data
  ([#251](https://github.com/matthew-dean/parseman/pull/251), draft).** Routes derived at
  build time and read by the closure engine. Trees identical on 11,473 inputs × 4 dialects,
  AST and CST, and `callcount:guard` `macro/jess/ast/site.css` −6.1% calls. An adversarial
  review blocked it: the route reader re-implements rows the plain path already lowers
  (dispatch, node builders, choice failure, scope install), and one copy had already drifted.
  The fix the review asked for is to build each route level from its row's own piece with the
  corner swapped in. Counted per function on a value ladder (`ids`, 40 tokens: `main` 2,858
  calls, routes 1,574), the −32 calls per token come from: ~14 continuations entered and
  rolled back, ~14 lead and trivia re-reads at each level, ~3–4 node pushes, ~1 choice block.
  Row pieces with the corner swapped run the first two as `main` does, which leaves ~1–3 per
  token. Parked: the gap and continuation wins belong in the plain pieces (see the pure gap
  read under Rejected), and #251 stays unmerged.

## Queued and in progress

- **A `collapse` level opens its frame only where its tail starts (`experiment/no-collapse-wrappers`).**
  Today a ladder level opens a frame and a children array, runs its corner, counts one child
  and throws the frame away. The encoder now lowers `node(type, sequence(corner, tail), build,
  { collapse: true })` to `OP_CONT` when the corner always publishes exactly one node and the
  tail is a `many()` or `optional()` with a first-token test: the corner runs with no frame,
  the tail's test reads its own rows, a miss returns the corner, and a hit moves the corner
  into a frame opened in the same function. Nothing is marked in a grammar. Recovery, probes
  and the reference driver run the node as written. A `transform()` or `dispatch()` corner, a
  required tail that only reads as nullable, and a trivia with no scanner stay as written.
  - No vendored site lowers, so the vendored grammars test for collateral damage, not for
    the late path. The evidence for that path is the synthetic differential
    (`check:differentials --only=late-frame`, `test/unit/table-late-frame.test.ts`) and the
    overlay below. Against `main` @ `1cb8a80d`, results, errors, expected sets and spans match
    on every sweep input, strict and recovering, AST and CST: CSS 8,740, `.jess` 8,880, Less
    17,071, SCSS 23,202 (inputs from Jess `f2119a2d0`, core from `fe004e1b5`). 7 Less inputs
    hit a 5 s limit under CST recovery on both sides, so they were not compared. A partial
    parse compares only what it reached, and much of the sweep is partial. Strict AST, full /
    partial / failed / threw:

    | | Full | Partial | Failed | Threw | Corpus files, full / partial |
    | --- | --- | --- | --- | --- | --- |
    | CSS | 5,166 | 2,214 | 334 | 1,026 | 35 / 41 |
    | `.jess` | 3,513 | 4,140 | 1,227 | 0 | 21 / 3 |
    | Less | 11,567 | 3,730 | 991 | 783 | 268 / 20 |
    | SCSS | 10,572 | 7,815 | 4,617 | 198 | 1,808 / 214 |

    Recovery is partial far more often: strict and tolerant tallies print on every sweep.
  - Engine cost, on a tree that merged `main` @ `1cb8a80d`: first-parse calls +0, AST and CST, on
    all five files. `callcount:guard` passes with no row above v0.61.4 and its baseline exact.
    Sizes within 0.11% gzip. Marginal instructions, N 5 to 25, core `fe004e1b5`, 7 reps (15 for
    `benchmark.css` AST), AST then CST, A/A in brackets, load 85 to 360: SCSS -0.46% (-0.42%),
    +0.15% (+0.58%); Less -0.79% (-0.58%), -0.38% (-0.15%); bootstrap -0.65% (-0.89%), -0.15%
    (+0.94%); `.jess` +0.01% (+0.50%), -0.21% (+0.23%); `benchmark.css` +0.26% (-1.39%), +2.24%
    (+3.41%). None resolves: every row is at or inside what its A/A moved, or within 0.3
    points of it, and the calls are equal.
  - An earlier version tested in the generic node closure whether the node was a late frame, twice
    per node, though lowering knows. Calls stayed flat and branch tests rose up to 1.2% on closure
    rows (`macro/scss/cst/site.css` +21,214, `closure/less/mixins` +42,472). The decision now
    sits in `OP_CONT`, and the node closure is `main`'s.
  - The win needs grammars in that shape, so it is measured as an overlay and lands as Jess
    grammar changes with their CST readers. Marginal instructions and first-parse calls against
    `main` @ `1cb8a80d`, default runtime, interleaved, N 5 to 25, core `fe004e1b5` on both sides
    (byte-identical `core/core.js`, not the vendored one, which is older than `cea50fa88`), 7 reps
    (15 for `benchmark.css` AST), load 300 to 360. Budgets are `real-grammars.ts` at that commit on both
    sides: CSS 2.72, Less the default 0.5, SCSS 0.612, `.jess` 0. A budget is a share of a
    module's code, so the overlay spends a share of less. Each row parses the whole file, with no
    recovered error or diagnostic, AST with the options Jess's `parse` passes, and so do the
    positions variants:

    | | AST (A/A) | CST (A/A) | Calls, AST | Calls, CST | AST bytes |
    | --- | --- | --- | --- | --- | --- |
    | `gen-workload.scss` | -21.69% (-0.42%) | -26.56% (+0.58%) | -17.22% | -18.30% | -0.32% |
    | `benchmark.less` | -5.46% (-0.58%) | -15.41% (-0.15%) | -8.84% | -10.10% | +0.29% |
    | `bootstrap4-all.less` | -4.93% (-0.89%) | -11.29% (+0.94%) | -7.23% | -8.75% | +0.29% |
    | `jess-x8.jess` | -6.34% (+0.50%) | -6.73% (+0.23%) | -6.58% | -7.67% | +0.08% |
    | `benchmark.css` | -2.56% (-1.39%) | -10.37% (+3.41%) | -1.01% | -9.02% | -2.60% |

    Spreads across reps were 1% to 18%, widest on the smallest files' CST rows. CSS AST does not
    resolve: its legs spread 5% to 10% and its A/A moved 1.39%. The calls say about 1%. Before
    `main` moved, at `80732b81` with its budgets: SCSS -19.74 / -25.73, Less -4.91 / -17.83,
    bootstrap -4.09 / -12.93, `.jess` -6.18 / -7.22, CSS -0.75 / -9.73.

  - `benchmark.css` AST depends on which Jess core is linked, more than on anything here. Same
    legs, `main` @ `80732b81`, 15 reps except the last row, A/A in brackets:

    | | Core `fe004e1b5` | Core `cea50fa88` |
    | --- | --- | --- |
    | Overlay, N 5 to 25 | -0.82% (+0.15%) | +2.54% (-0.58%) |
    | Overlay, N 5 to 45 | -1.49% (+0.17%) | +1.71% (-0.27%) |
    | Overlay, N 45 to 145, 9 reps | -4.70% (-0.05%) | -0.93% (-0.61%) |
    | Overlay, `--jitless`, 3 reps | -5.22% (+0.04%) | -5.15% (-0.08%) |
    | Tip, N 5 to 25 | -0.89% (+0.15%) | +0.89% (-0.58%) |
    | Tip, N 5 to 45 | +0.40% (+0.17%) | +2.25% (-0.27%) |
    | Tip, N 45 to 145, 9 reps | -0.04% (-0.05%) | +5.59% (-0.61%) |
    | Tip, `--jitless`, 3 reps | -0.05% (+0.04%) | -0.09% (-0.08%) |

    Interpreted cost is the same on both cores, while the older core's JIT rows spread 4% to
    13% across reps against under 1% to 3.5% on the newer one. Earlier figures of +4.12% for the
    overlay and +1.99% for the tip came from 3 and 9 reps on `cea50fa88`, the first on an earlier
    conversion. Why the JIT differs was not isolated. Use `fe004e1b5` or later, and name the core
    with the number.
  - Strict and recovering results on the overlay match `main` @ `1cb8a80d`: AST whole, CST by
    leaves and logged trivia, except for the trivia below. Inputs where both sides threw compare
    only the message; under `tolerant` that is 15,721 of 17,071 Less AST inputs.
  - An earlier version of this record said trivia was compared. It wasn't: a CST from `cstBuildHost`
    does not carry it, and the sweep hashed a field that doesn't exist. Compared now, with a host
    that keeps each node's `triviaLog`, the overlay differs from `main` on two sets:
    - Less, strict, 40 inputs lose a run, 20 comments and 20 spaces: `a{b:~/*c*/(a=b);}`,
      `a{b:~ (a=b);}` and `@media (a:a=/*c*/b){}`. `ValueSequence` logged it on `main`.
    - `.jess`, tolerant, 2 inputs gain a run on `CompoundSelector`: `a/*c*/ > b {}`, `a/*c*/ || b {}`.
    CSS and SCSS show none. These come from the conversion and not the late frame: the same overlay
    with lowering turned off matches it with lowering on, whole on AST and CST, and by leaves and
    trivia, strict and tolerant, on all four dialects. A collapse wrapper takes its log with it, so
    the Jess change has to keep those comments or accept losing them.
  - Fixing what review found on the late frame moved no overlay number that resolves. Against the
    same overlay built before the fixes, first-parse calls are unchanged except `benchmark.css` AST
    (-32 of 1,724,400) and the selector row (-8). Instructions stay inside leg spreads of 3% to 10%.
    CSS AST grows 0.16% (388,014 to 388,641 bytes) because the budget now buys slightly different sites.
  - Every CST node was also compared by a throwaway script, with single-child
    chains erased and each node's type and span kept. In CSS and SCSS the only change is lost
    wrappers. Three exceptions, each the whole of what differs, strict and tolerant inputs in brackets:
    - Less `ValueListWithPriority` starts after its leading comment (50, 8): `b:/*c*/1 !important;`
      is 2-19 on `main`, 7-19 here.
    - Less `MathValue` starts before the comment or space it used to start after (40, 0): `a=/*c*/b`,
      `a= b` and `~/*c*/(a=b)`.
    - `.jess` gains a `ValueAtom` on a slash's right operand (70, 9): `a{b:a / b;}`.

    They belong to the Jess grammar change, which fixes or accepts them. Under `tolerant` the
    AST reducers throw on most Less inputs before and after (15,721), so CST is the recovery
    coverage that counts. Less CST recovery ran with a 5 s limit per parse: 7 inputs stop on both
    sides, so they were not compared. That cost is on `main` too: parseman#268.
  - `a.x b.y,c.z d.w{e:f}` x4000 through CSS AST, against `main` at 2.72, 9 reps, N 5 to 25, core
    `fe004e1b5`, A/A -1.02%: calls +14.21%, instructions +5.55%, on the same grammar and engine that
    give `a.x{...}` fewer calls. That is selection, not the hit path: the same file on the
    unconverted grammars is +0% calls, +0.03% instructions. `main` sits on a cliff here: at 2.67 it is
    calls +12.85%, instructions +4.07%. Overlay budgets, against `main` at 2.72 (398,370 B):

    | Budget | Bytes | Calls | Instructions |
    | --- | --- | --- | --- |
    | 2.72 | 388,014, -2.60% | +14.21% | +5.55% |
    | 2.85 | 393,715, -1.17% | +13.72% | +4.68% |
    | 3.4 | 452,875, +13.68% | +11.23% | +3.43% |
    | 3.9 | 497,472, +24.88% | -3.99% | -2.62% |

    So CSS AST does not pay until selection stops being a lottery, by corpus profile or
    otherwise. Before `assemblyBudget` changed meaning, calls turned negative at +15.46% bytes;
    now it takes somewhere between +13.68% and +24.88%.
  - What stopped paying. CSS `CompoundSelector`: a hit costs more than the `oneOrMore` it
    replaces. `ComplexSelector` and CSS `ValueList`: their trivia is unknown at the site, so
    they cannot decide. `RelativeSelector`: its corner is optional. Less `ValueList` written
    as `sequence(item, many(...))`: 3% of calls and about 0.5% of instructions, and it changes
    recovery on 73 of 17,073 inputs with 12 new throws, because `sepBy` resyncs and `many`
    does not. It stays a `sepBy`. The earlier -8% to -10% on Less counted that and a
    selection that happened to land well.
  - `matchesEmpty` has no `field` case, so a `field`-led sequence reads as nullable and its first
    set takes in what follows the field. None of the numbers above include a fix for it, and
    nothing here needs one. The fix is its own change with its own sweep: it changes recovery.
    `attempt` also falls to the nullable default; no late frame reads it, because a tail needs a
    repeat or optional row.
  - Sweep inputs and legs: `bench/jess/sweep-inputs.mjs`, `build-leg.mts`, `leg-sweep.mjs`.
    `leg-sweep` is not in `check:differentials`: a run needs two full builds and minutes of
    parsing.
    `tolerant-sweep.ts` loads grammars at runtime, which `compose()` now refuses for a
    macro-lowered base, so it stops on Less and `.jess` on `main` too.

- **Selective assembly ranked by a corpus instead of statically: faster at the same bytes.**
  A real `tsdown` build of Jess's AST grammars, trained on `benchmark.less` and
  `bootstrap-less-port`, or on the Bootstrap and Foundation SCSS files that parse today.
  JIT marginal instructions against `main`, on files outside the training set, not on a
  quiet machine. A/A within 0.7%.
  Less at `0.5`: `less-plugin-dls` -8.1%, less.js test data -5.5%, 682,388 B against
  687,822 B. SCSS at `0.5`: generated workload -2.7%, Sass spec files -3.0%, 432,585 B
  against 445,982 B. The static ranking at the same budgets is within 1.6% of `main`.
  Needs `assemblyProfile.scope` for grammars whose callbacks read helpers. Jess adopts it
  in a parser bump; the SCSS corpus waits on the parser gaps that stop the other files
  parsing. Quiet-machine and `--jitless` rows are still to do.

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
  - Through `dispatch()` and pretested choices (@ `701cbf53`). A route can end in a
    `dispatch()` whose arms re-read its token: the selector is the left corner, the
    dispatch's own tables pick the arm, and the arm's node completes as a lone level, with
    no `_routed` object. A route also passes a choice when every claiming arm but one is
    pretested, cutting back at entry if a pretest matches. Less `color: red;` drops from
    278.1k to 257.3k `--jitless`, about 21k of the 28k that `Value` and the dispatch cost.
    That is −16.4% JIT / −22.3% `--jitless` against the base, and `border-radius: a / b;`
    is −13.3% / −17.3%. Every whole file is faster in both modes (`benchmark.less`
    −6.8% / −9.4%, `bootstrap-less-port` −2.0% / −9.1%). The open `font` item is
    unchanged. CSS `calc(1px + 2px * 3)` is +0.7% `--jitless`, not yet attributed.
  - Open question, not built: can a `dispatch()` be derived from a plain `choice()`, so
    authors needn't write one? The route above still reads the hand-written dispatch's
    exact keys and prefix and suffix matchers. Deriving them would mean reading the
    arms' shared identifier corner once and routing on its text and on the next captured
    token, from the arms' leading literals.
  Superseded: the build-out that compiles these routes into table rows at encode time
  was built and is parked; see "Left-corner routes, second form, as table data" under
  Parked. Branch `perf/left-corner-routing`, raw samples under
  `scratchpad/left-corner/results/`.
- **Less declarations above the value (census, not built).** Marginal instructions per
  declaration in a block (`a{color: red; …}`, 21 against 1) with the routes above:
  ~35k JIT / 276k `--jitless`, against lessc's ~6.8k JIT for the whole declaration.
  Breakdown in `--jitless`. The first three rows split the declaration and sum to ~92%
  (the property token and a small remainder make up the rest). The reducer row overlaps
  them: each reducer is also counted in the level it runs in.
  - Value, after the routes: ~86k (31%).
  - The Declaration level: ~126k (46%). Of that, the declaration's frame and sequence,
    four scope switches, three choices, three optionals, the colon and the value gap.
    Two pieces are grammar shape: the `valueGap` field (6.3k, removing it as a probe) and
    the head's interpolated-property and numeric-key arms (4.7k). The declaration always
    has several children, so its frame stays; a route starting at the statement would
    remove only the choice, gate and scope steps above the property token.
  - The statement level: ~41k (15%). 33.5k of it is failed arms: before the declaration
    arm, `FunctionStatement`'s dispatch reads the identifier and the guarded ruleset
    pre-scans `/[-\w]+[ \t]*:[ \t\n\r\f]/` (moving the declaration arm first, as a probe).
    Removing them takes the identifier as the statement's left corner, routed on the next
    captured token: [jess#515](https://github.com/jesscss/jess/pull/515) grammar-side, or
    the dispatch derivation above. The rest is the item's frame and terminator.
  - Reducers (Jess grammar code), counted inside the rows above. Each pair below is
    `--jitless` / JIT. All reducers: ~40k / ~5.9k (14%). `Declaration`: 21.5k / 2.5k.
    The identifier's keyword: 3.3k / 1.2k. The five value-chain levels: 1.6k–4.5k /
    0.3k–0.7k each. A framed node costs parseman ~19k / ~2.5k around a reducer that is
    nearly free (a keyword node over an identifier).
  Census on `perf/left-corner-routing` @ `25597760`; probe edits were made only in a scratch
  checkout of the grammar.
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

- **Proving a reducer's trivia-log formal unused.** A reducer that names its fifth formal only
  to reach the sixth (`state`) has arity 6, so its node records trivia it never reads.
  Prove it unused with `confirmedBuildParamUnused(src, 4)`, as `buildRawUnused` does for
  the fourth formal, and carry the result through the IR. Jess's Less AST against `main` @
  `f521215e`: trivia-recording node matches fall from 12,450 to 7,402 on `benchmark.less`
  (`MathValue` 4,491) and from 12,603 to 6,239 on the Bootstrap 4 concatenation. Calls change
  by −0.10% and −0.59%, branches by −1.05% on Bootstrap. Trees are identical. The node shape
  is unchanged, because these reducers also read `state`. The time change is inside the
  spread. Queued as one unused-formals mask that replaces `buildRawUnused`: one field, one
  IR slot, the same proof.

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
