# Changelog

All notable changes to **Parseman** are documented here, grouped by minor version
(newest first). This project is pre-1.0, so minor bumps may carry breaking changes.

## 0.47.0 — unreleased

- **`buildSpecModel` no longer hangs the process on a `balanced()`.** Every rule
  reaching a `balanced()` sent `parseman/spec` — and so `toEBNF`, `toRailroadHtml`
  and `toRailroadSvg` — into unbounded recursion: `RangeError: Maximum call stack
  size exceeded` at the default stack, and **SIGSEGV** at `--stack-size=40000`. The
  raised-stack crash is the diagnosis: this was a true cycle, not a deep-but-finite
  walk, so no depth limit would have been a fix.

  `balanced()` builds its interior with a self-referencing `ref()` so a nested open
  is consumed recursively. That back-edge is anonymous, and the spec walker cut
  cycles **only at named rules** — an assumption that every cycle passes through a
  `_ruleName`. It does not, for `balanced()` or for any cycle a caller builds with
  the public `ref()`.

  Two changes, answering two different questions:

  - **The cycle is now cut on OBJECT IDENTITY**, via a path set added on entry and
    removed on exit — not a global visited set, so a combinator shared by two
    sibling positions is still drawn at both (sharing is structure; only a
    combinator containing *itself* is a cycle). This fixes the whole class. An
    anonymous back-edge renders as `/* (recursive) */` in place.
  - **A `balanced()` renders as its delimiters around an opaque interior** —
    `"(" /* balanced … */ ")"` — recognised through a `_balanced` marker set by
    `buildBalancedInterior`, so it covers the ambient, `raw` and `strict` forms
    alike. This is not a simplification: the delimiters are fixed at construction
    and the interior genuinely *is* a delimiter scan. Expanding its lowered shape
    would print the content-run regex and the `self` back-edge, which are emitter
    machinery rather than language. `scanTo()` was checked and does **not** share
    the defect — its `_def` is a leaf the walk never descends.

### BREAKING — a list now contributes its ITEMS and nothing else

Read this section before upgrading. Both changes below alter the shape of the tree
your reducers receive. **Your parse will still succeed and nothing will throw** —
that is precisely why it is called out at the top rather than buried in a bullet.

#### 1. `sepBy` / `oneOrMoreSep` no longer put separators in `children`

`sepBy(item, literal(','))` over `a,b,c` used to contribute **five** children to
the enclosing `node()` — `['a', ',', 'b', ',', 'c']`, items at even indices and
separators at odd. It now contributes **three** — `['a', 'b', 'c']`.

The separator is still matched and still consumed. It is simply not an item, and a
list contributes the items of the list. `many` and `oneOrMore` already behaved this
way; `sepBy` and `oneOrMoreSep` were the outliers.

**Why this is worth a break.** parseman's own analyzer described a `sepBy` result as
"a flat item list", which describes the VALUE and not the children — and that is the
sentence an author reads before writing `children[1]` and getting a comma. It fails
silently: the parse succeeds, the tree is quietly wrong, nothing errors. In a single
day it cost six lanes a debugging round each, with full context and the source open.

**How to tell whether you are affected.** You are affected if any reducer for a
`node()` containing a `sepBy` or `oneOrMoreSep`:

- indexes `children` positionally (`children[1]`, `children[i * 2]`, array
  destructuring `([a, b, c]) => …`), or
- correlates a `children` index with a `triviaLog` insert index (those refer to
  **`rawChildren`**, which still contains the separators — so the two arrays no
  longer advance in step), or
- reads `children.length` to count anything, or
- filters `children` for the separator's own token.

You are NOT affected if your reducer only filters `children` by node type, or
captures the separator with `field()` — field capture is a separate channel and is
untouched.

**The mechanical fix**, in order of preference:

1. **Delete the arithmetic.** A reducer that did `children.filter((_, i) => i % 2 === 0)`
   or `children[i * 2]` should now just use `children`. This is the common case and
   it makes the reducer shorter.
2. **Read the separator from `rawChildren`.** Separators remain there, in source
   order, so nothing is lost. `rawChildren` is the same channel trivia already uses:
   consumed, absent from `children`, still reachable. Declare the 4th positional
   parameter of your `build` callback to receive it.
3. **Opt back in with `keepSeparator()`** — see below.

#### 2. New: `keepSeparator(sep)`

Wrap the SEPARATOR argument to keep separators interleaved in `children`:

```ts
sepBy(g.Value, literal(','))                    // items only — the default
sepBy(g.Track, keepSeparator(SLASH_OR_COMMA))   // items AND separators, interleaved
```

Reach for it when the separator could have matched **more than one thing** — a
`choice`, a regex with alternation or a quantifier, a rule reference — and a
consumer depends on which one matched. In CSS the separator carries meaning:
`grid-area: 1 / 2` and `font: 12px/1.5` do not mean what `1, 2` means.

The underlying rule: **a combinator may collapse only what its construction makes
recoverable.** `sepBy(x, literal(','))` has a separator fixed at construction, so
dropping it destroys nothing. `sepBy(x, choice(literal(','), literal('/')))` does
not, so the author has to say so.

It is deliberately a wrapper on the separator rather than an option in the options
bag. The call site then STATES its own children arity, which is the exact failure
being fixed — a name that lies is what created this. `keepSeparator` in the source
is the only documentation that reaches an author who never reads docs.

#### 3. BREAKING — `balanced()` contributes exactly one leaf

`balanced('(', ')')` over `"(a(b)c)"` contributed **seven** children; it now
contributes **one**, equal to the whole matched source slice, with the same span —
matching `scanTo`, its sibling in the same file, which always did this.

`balanced` is declared `Combinator<string>` and its implementation ends in a
callback that reassembles the interior into exactly that one string. But it is
spelled `transform(sequence(literal(open), many(…), expect(literal(close))))`, and
`transform` is transparent to CST capture, so the reassembled string never reached
the parent. The declared type and the emitted arity disagreed and nothing checked.
Unterminated input recovered via `expect()` behaves the same way — one leaf over
what was consumed.

You are affected if a reducer counted or indexed children across a `balanced()`.
The fix is to stop compensating: a `token(balanced(…))` wrapper added to work
around the old behaviour is now redundant double-wrapping and should be removed.

**This closes the upstream half of P19.** The defect was upstream all along, so the
downstream `token(...)` wrappers that jess added to compensate are now removable —
they are the workaround, not the fix, and they can come out once jess moves to this
release. `_balancedAmbient` and the interior self back-edge stay on the inner
combinator, so the ambient-`scanSkip` rebuild and nested recursion are unaffected.

#### A latent defect this EXPOSED rather than created

Downstream consumers that walk `children` to compute a **trivia insert index** were
already wrong, and this release is what makes it visible.

`pushCstTriviaEntry` computes `const insertIdx = cstRawLen(ctx)`
(`src/cst/capture-buffer.ts`). **Trivia insert indices have always addressed
`rawChildren`, never `children`.** Two Less reducers in jess walked `children` and
used that index as an insert index into it. That only ever worked by coincidence: a
plain `sepBy` made the two arrays the same length, so the wrong array had the right
length and the bug was invisible.

Once a list stops contributing separators the two lengths diverge by exactly the
separator count, and the index silently drops comments and line breaks that sat
around separators from the emitted value layout. No error, no throw — the same
silent-wrongness this release exists to remove.

**The list change did not introduce this. It removed the coincidence that was hiding
it.** If you compute an insert index from a trivia entry, index it against
`rawChildren`.

#### Notes

- Incremental structural list-reuse now derives a list's separator from the
  GRAMMAR (`sepBy`'s own `separator` def) instead of sniffing it out of `children`.
  A list whose separator is not a `literal` — i.e. not recoverable from
  construction — no longer qualifies for a structural splice and falls back to a
  full, correct reparse.
- Emitted code grows ~101 B per `sepBy` call site (one guarded truncation), around
  +0.2-0.9% raw and +0.05-0.33% gzip per size-guard fixture.

### BREAKING — `run({ profile })` and the `RunProfile` types are removed

`RunOptions.profile`, `RunResult.profile`, and the exported `RunProfile` /
`RunProfilePass` types are gone. The three-pass profiling boundary (recognizer /
structuralCapture / hostConstruction) has had no working implementation since the
counters stopped being emitted into compiled artifacts, and `run({ profile: true })`
threw unconditionally — while still typechecking, because the option remained in the
public type. An option that advertises a capability, passes every gate, and fails
only for whoever calls it is worse than no option at all.

**Migration:** none is possible for the phase numbers, and none is needed for anything
else — omitting `profile` was already the only way to get a result. `run()` output is
otherwise unchanged. For allocation pressure, `bench/alloc-count.ts` measures GC
scavenges, major GCs, and pause time over a fixed parse batch.

`bench/alloc-profile.ts`, the only consumer, is deleted; its GC/heap half duplicated
`bench/alloc-count.ts`. `docs/future/bench-typecheck-followups.md` §2 records what the
option measured and what a restoration would take.

Six lanes, assembled onto the 0.46.0 shared prefix. Every lane was verified
independently on top of the prefix before inclusion — see the pull request body
for the per-lane verification status and the measured release-over-release
numbers.

- **New: `adjacent()` and `notAdjacent()` — zero-width ADJACENCY assertions.** They
  ask about the GAP behind the cursor, never about what a separator looks like:
  `adjacent()` succeeds when nothing separated the previous term from here,
  `notAdjacent()` when something did. This is the authoring surface for
  `docs/design/derived-tokenization.md` §4 ("Adjacency is a bit set at scan time"),
  whose positive half `noTrivia` has spelled all along and whose negative half had no
  spelling at all. Without it, a production that needs "these two are SEPARATED" had to
  disable trivia and re-spell whitespace as a regex —
  `noTrivia(sequence(regex(/(?:[ \t\n\r\f]|\/\*…\*\/)+/), op, …))` — which is a second,
  private definition of the dialect's trivia table inside one expression production, and
  it drifts: two productions in one file end up disagreeing about what separates two
  operands, with nothing to report it.

  `notAdjacent({ kinds: [...] })` narrows the assertion to trivia CATEGORIES from
  `classifiedTrivia({...})`. `notAdjacent({ kinds: ['whitespace'] })` accepts `a + b` and
  REJECTS `a/*x*/+b`, which is exactly css-values-4 §10.1 for `calc()`: `+`/`-` need real
  whitespace, because a comment vanishes at tokenisation. A `kinds` name the active
  trivia table does not declare, or a `kinds` filter over unclassified trivia, is a hard
  `TypeError` — at compile time for compiled output, on first reach for the interpreter —
  deliberately NOT the lenient "unknown name is a no-op" policy `triviaKindMask` uses for
  capture preferences, because a silently-dropped name turns the assertion back into a
  bare `notAdjacent()` and makes `calc()` quietly accept the comment form.

  Both are lowered as MARKER TAGS that `sequence` recognises at term `i` and tests at that
  boundary against the trivia scan the boundary already performs — zero context fields, no
  extra branch in the ordinary boundary, and nothing at all emitted for a grammar that
  writes neither. That lowering also sidesteps the trivia REWIND: a self-contained
  zero-width combinator at index `i` matches zero-width by construction, so `sequence`'s
  "term matched empty, roll the trivia back out" branch would undo the gap it had just
  asserted. The assertion moves no cursor, so the tree, the spans and the trivia log are
  identical to the same sequence written without it. The compiled kind filter is an
  independently emitted per-arm probe (`_akN`) rather than a new out-channel on the shared
  `_tfN` trivia scanner, so the sites that never ask pay nothing. Interpreter/compiled
  parity is pinned per case in `test/parity/adjacency.test.ts`.

  Placement is checked: an adjacency assertion tests the gap after the PRECEDING term, so
  `sequence(notAdjacent(), …)` throws at construction, and reaching one outside a sequence
  boundary throws rather than silently answering "no gap here". Both are zero-width and are
  dropped from a sequence's first-set (`isZeroWidthAssertion`), so neither widens a choice
  arm's dispatch.
- **Fixed: the token alphabet's key delimiters were written as raw control BYTES, which
  made the source file binary and corrupted the emitted artifact.** `keyOf` in
  `src/compiler/token-alphabet.ts` embedded U+0000 and U+0001 literally rather than as
  escape sequences. The repair is one line and changes nothing observable — the escapes
  produce byte-identical strings — but the DETECTION is the part worth recording, because
  this class of defect has now cost this project roughly sixteen instruments.

  A raw control byte makes a file **binary** to the whole toolchain at once: `git diff`
  shows `- -` instead of a diff, GitHub declines to render it, and — the one that actually
  did the damage — **`grep -rn` skips it silently and exits 0**. At a shell, a search that
  found nothing and a search that *refused to look* are indistinguishable. That is how a
  305-line module (`src/compiler/token-scanner.ts`, reached only from this file) stayed
  invisible to every search anyone ran against it.

  The guard is to treat an empty search result as a question rather than an answer: check
  for the `binary file matches` condition explicitly, or run the tree through
  `pnpm check:control-bytes`, which is what caught this one. The same defect had already
  been copy-pasted into the token-cursor measurement rigs and was fixed there too; the
  measured counts are unchanged.

- **A factory body that fails to evaluate now names the binding and the cause.** The
  dominant real cause is a forward reference — `const A = node('A', B, …)` above
  `const B = …` — and the macro reported it as a generic "rules(...) factory isn't
  statically evaluable", or, through `composeLeaf`, as a complaint about the ARGUMENT
  SHAPE (`final argument must be a local rules() map`). That message points at the
  wrong cause and was twice reported as a grammar defect. It now reads: ``Val``
  references ``Tok`` before its declaration — a temporal dead zone … move the
  declaration above ``Val``, or use ``g.Tok``, which is order-free. `composeLeaf` no
  longer restates a shape error when the argument had the right shape and failed to
  evaluate; when the leaf is an unresolved identifier it names it.

  Worth stating plainly, because it is NOT the same class as the two entries above:
  this constraint is **JavaScript's, not parseman's**. The interpreter throws
  `ReferenceError: Cannot access 'Tok' before initialization` on exactly the sources
  the macro refuses, so the two agree; `g.X` is order-free only because the proxy mints
  a ref and defines it in a second phase. A `g.X` → bare-const conversion is therefore
  safe **iff** the const is declared above every use and is not on a reference cycle —
  and dropping a const from the returned map is not what breaks such a sweep.

- **A terminal inside a `node()` no longer emits three runtime guards the emitter can
  already decide.** `emitNode` installs both collectors itself
  (`_ctx._cstLeaves = chV; _ctx._cstRawChildren = rawV`), and for a direct-builder node
  both are compile-time literals — a fresh `[]` or `undefined`. The per-terminal
  capture preamble was nonetheless emitting `if (_cstLeaves || _cstRawChildren)` plus
  two inner branches at every terminal inside every node. Measured per-terminal cost
  296.3 B → 109.3 B (−63%); a `node()` site at two terminals 2,283 B → 1,901 B over the
  same body written bare (−17%). The `node-scale` probes, which vary node density, fall
  10.04% (4 nodes) → 11.50% (32 nodes); `example/css` −3.00%; 48,965 B reclaimed across
  the size fixtures. Gated on tree identity: 220 real trees over 110 real CSS files,
  interpreted and compiled, identical to `bb2e587`. This matters beyond bytes —
  `node()` is the correct spelling where `transform()` corrupts the tree by spreading
  its result, so the correct spelling was the expensive one and nothing said so. The
  remaining per-site cost is 1,683 B of capture-scope frame, labelled block and
  fail-path truncation; the truncation is decidable by the same fact and is the next
  lever.

- **Fixed a TDZ throw when a recursive combinator has a SHARED interior.** A
  combinator lying on a self-reference cycle could be hoisted to a shared `const`,
  i.e. emitted outside the `ref()/define()` closure that binds the cycle's only lazy
  edge. The back-edge then re-resolved through the cycle target's own const and the
  two decls read each other eagerly — `const _s1 = many(choice(_s0, …))` declared
  before `_s0`, `ReferenceError: Cannot access '_s0' before initialization` at compose
  time. No declaration order fixes it, so cycle-interior nodes are now inlined; they
  are re-hoisted by identity on re-lowering. A nested recursive combinator that is
  itself on the cycle keeps its own closure, with the enclosing ref vars still in
  scope. `balanced()`'s interior is referenced once and never earned a const, so the
  IR and macro bytes are unchanged at every existing call site — verified identical on
  both surfaces across the byte gate, against `bb2e587`.
- **Fixed `compose()` dropping ambient `scanSkip` inside a `balanced()` interior** —
  an interpreter-versus-compiled divergence in shipped code. `balanced()` records the
  obligation as `_balancedAmbient`, an own property held outside `_def` so static
  analysis keeps seeing the eager interior; structural IR serialization therefore lost
  it, and the composed parser stopped at the first delimiter hidden inside a string or
  comment while the interpreter and a direct compile did not. A balanced now
  round-trips as the constructor call that built it, so `balanced()` re-creates the
  marker; `raw: true` stays structural. Measured over three surfaces in one process:
  `(')' e)`, `("a)b" e)` and `(a /* ) */ b)` diverged only under compose, and now
  agree. IR shrinks (a bare balanced 410 → 98 B) because the derived interior is no
  longer serialized.
- **Fixed `routed(fallback)` losing its fallback under the macro.** The macro's
  generic constructor table entered `routed` as zero-arg, so the fallback was dropped
  silently and a production written to work both inside and outside a `dispatch()`
  branch lost its out-of-branch behaviour when compiled — while the interpreter kept
  it. Bare `routed()` is byte-identical.
- **Fixed a `makeWhen(...)` alias rejecting matcher keys that `when(...)` accepts.**
  `makeWhen(opts)` is `(key, parser) => when(key, parser, opts)`, so it accepts every
  key `when` does, but the macro's factory branch handled only string and string-array
  keys. An arm keyed by `startsWith`/`endsWith`/`matches` through the alias was a hard
  macro failure — `rules(...) factory isn't statically evaluable` — for a grammar the
  interpreter builds, while the identical un-aliased `when(matcher, …)` compiled. Two
  grammar authors cut working function routing to get around it.
- **`balanced()` gains `strict: true`, making an unmatched close a real failure.**
  The close is wrapped in `expect()`, which never fails — on a miss it returns a
  ParseError, pushes it to `ctx._errors`, and reports a zero-width span. So
  `balanced()` was **unfailable once its opener was consumed**: the rejection was
  already computed and recorded, but nothing could branch on it.
- **What that blocked:** `choice()` could not fall through to another arm,
  `not()` could not negate an unclosed group, and an enclosing `sequence()`
  proceeded as though the group had closed. `balanced('(', ')')` returns ok on
  `(a`.
- **`strict: true` requires the close**, so the group fails and rolls back to the
  opener. Nested groups inherit it (the interior recurses through the same
  combinator). Ambient `scanSkip` rebuilds — interpreter and codegen — carry
  `strict` through, so a grammar declaring `scanSkip` does not silently get the
  recovering interior back.
- **Strict mode DOES change acceptance for unterminated input — that is the
  point — and it does NOT change the delimiter-pairing rule.** Being precise,
  since an earlier draft of this entry claimed it changed nothing:
  - An unterminated group now FAILS where it previously returned ok. Consequently
    an enclosing `choice()` can fall through to another arm and `not()` can
    negate it. Both are behaviour changes, and both are the reason for the flag.
  - What is unchanged is the PAIRING rule: `balanced()` tracks ONE pair, and a
    delimiter from any other pair is content, by design. `([c}])` stays
    well-formed to it in both modes, so `var(--x, ([c}]))` keeps parsing —
    pinned as a test on both.
- **Opt-in; the default is untouched.** Recovery is what a tolerant document
  parse wants and existing grammars are built on it.
- Verified byte-identical: 25 compiled artifacts across 11 `balanced()` call
  shapes, the ambient-`scanSkip` rebuild path, and the four example grammars,
  baseline vs HEAD. The comparison was shown to be sensitive — flipping the
  default moves 16 of the 25.
- Tree-identity gate: 111 css files, 111 real trees, 0 mismatched
  (`bench/tree-identity.ts`).
- 31 new tests in `test/unit/balanced-strict.test.ts`; full suite 181 files /
  3,438 passing.

- **New `pnpm spelling:gate` — a spelling differential for G20 ("equivalent grammars
  must emit equivalent artifacts").** Takes a construct, rewrites it into a provably
  equivalent form, lowers both through the real macro pipeline, and compares the bytes
  of the shipped artifacts. Equivalence is **established, not assumed**: both artifacts
  are imported and run over the pair's own corpus (accepting *and* rejecting inputs, so
  a boundary-policy difference cannot hide) and their trees compared with the
  tree-identity oracle's serializer; only a pair that passes that proof earns a ratio.
  `node()` vs `transform()` is carried permanently as a declared **non-pair** — the gate
  asserts its trees *differ*, which is the standing proof that the gate distinguishes
  "does more work" from "spelled differently". Reports raw and gzip per pair with a
  stated mechanism; the tolerance band is one named constant so it is a visible decision.
- **The gate is a ratchet, not a report.** Per-pair ratios are committed to
  `bench/spelling-baseline.json` and `pnpm spelling:gate` fails on any move away from
  them — two-sided, like `size-guard`: a widening gap is a REGRESSION naming the fat
  spelling and its mechanism, an un-banked improvement says BANK THE WIN, and a pair
  that is new or has silently stopped being measured also fails. Known breaches are
  baselined at their measured value rather than waived, so they stay visible in every
  run while being pinned against getting worse. Verified by disabling the normalisation
  and confirming the gate goes red.
- **First full run: two real missing normalisations, and one retraction.**
  (1) `keywords([N])` vs N `word()` arms under one boundary policy — 1.39x at N=5 rising
  to 1.90x at N=30 (65,869 vs 34,664 B) for **identical matching work** (373 `charCodeAt`
  sites on each side); the gap was per-arm scaffolding, not recognition.
  (2) by-const vs `g.X` is a **depth** effect, not the fanout effect it was reported as:
  flat fanout F=2/4/8 shows a constant ~2.6 kB offset that *shrinks* as a ratio, while
  nesting each level twice gives by-name exactly linear growth (+1,586 B/level) against
  superlinear by-const — 1.11x at depth 1 to 1.97x at depth 6. Mechanism located: the
  hoisted `_pf` helpers are re-emitted once per enclosing scope (`_pf0` declared **5
  times** at depth 6; 22 function declarations against 9 for the named-rule form).
  (3) RETRACTED — a 1.57x "left-factoring" finding from the gate's first revision. Once
  the corpus was strengthened to propagate failures it disqualified itself: on input `"@"`
  the unfactored choice re-anchors its failure span at the choice position and the
  hand-factored sequence has already consumed the `@`. Hand-factoring is span-observable
  and was never an equivalent spelling. It is now carried as a declared non-pair.
- **Two divergence CLASSES, because collapsing them turns the gate all-red for reasons
  that have nothing to do with bytes.** A LANGUAGE divergence disqualifies a pair; a
  DIAGNOSTIC divergence — both sides reject at the same span with different `expected`
  labels — keeps its ratio and is reported separately. Four pairs are diagnostic-only,
  including `keywords()` reporting 1 label where the equivalent arm list reports N.
- **`choice` of keyword arms now compiles to ONE keyword table (closes violation 1).**
  30 `word()` arms: **65,869 → 36,588 B (−44.4%)**, ratio against the equivalent
  `keywords()` table **1.90x → 1.06x**, gzip **1.73x → 1.01x**. Soundness, point by point:
  tries are emitted in ARM order so ordered first-match is reproduced exactly and no
  prefix-freeness precondition is needed; the block fails with the CHOICE's own
  `expected` array, not a keyword table's single `"keyword"` label, so the diagnostic
  divergence the gate found is preserved rather than silently adopted; and it **declines
  outright on a `disjoint` choice**, so O(1) first-char dispatch is never traded for
  bytes — it only fires where the choice was already an ordered scan. Gates, `autoNot`
  and coverage ids each decline the merge rather than being dropped. The repo's own
  example grammars are byte-identical (`size:guard` unchanged at all 24 fixtures).
- **The token cursor's absorbable share is measured, and it is not the scan cost.**
  `derived-tokenization.md` §10.3 stood as UNKNOWN — whether a token cursor moves
  substantially more character-level work into the scanner than a css-syntax-3
  tokenizer does. It does: the shipping grammars read each input byte **5.67×**
  (css) and **12.28×** (less) at 100% coverage, against a cursor's one. By time,
  on the AST path, that work is **18.6% of css parse time and 7.1% of less**,
  against a scanner cost of **7.9% / 1.4%** — a net ceiling of **~10.7 / ~5.7
  points**. Two things fall out that were not being asked for: the redundancy
  **inverts** against the time share, so scanner headroom is a css result while
  less's mass is elsewhere; and **42–57% of every regex terminal execution fails**,
  which is §3's arms-tried cost model measured. New in §10.4; instruments in
  `scratchpad/token-cursor/`.

- **A choice arm marks the root trivia log only when the arm can reach it.** Every
- **`PARSEMAN_SCANTO=indexof` emits scan-to-terminator as `String.prototype.indexOf`,
  whose V8 implementation is SIMD.** Covers the `until` shape (`<lit>[^X]*`, single
  stop char) and the `delimited` shape (`<open>…<close>`, fixed close literal) in
  `scannable-run.ts`. Defaults OFF and is a proven no-op when off — artifacts built
  with the flag unset are byte-identical to the unmodified compiler on all four
  workload grammars. Trees are equal to the toggled baseline on all five workloads.
  Artifact bytes: css 231,731 → 230,441 raw (−1,290, −0.56%) and 36,067 → 36,034
  gzip (−33); less 393,474 → 393,356 raw (−118) but gzip 52,616 → 52,626 (**+10** —
  the `indexOf` line is shorter yet breaks the ubiquitous
  `while (_j < input.length && !(…)) _j++` run that gzip matches everywhere else).
  Population is 11 sites on css and 2 on less; graphql and json have none.
- **Parse-time effect of the above is at or below the instrument's noise floor and is
  NOT claimed as a win.** Interleaved, batched, one process, 51 rounds: less/stylesheet
  rel 0.9922 at 36/51 wins, css/stylesheet 0.9814 at 25/51, less/mixins 1.0010 at
  23/51. The two grammars with zero converted sites are carried in the run as a live
  calibration and read rel 1.0096 and 0.9999 at 24/51 and 26/51 — so ~1% magnitude
  with a coin-flip win rate IS this instrument's floor. Only less/stylesheet's win
  rate is consistently non-random, and its magnitude is inside the floor.
- **A 4.3× microbenchmark result produced a null in situ, which is the §9.1.1 pattern
  repeating.** `indexOf` beats the emitted char loop 0.232 rel at 61/61 on a 0.97 MiB
  corpus for a single stop char, and sticky `/[^{};]*/y` beats it 0.725 at 61/61 for a
  three-member stop set. Neither survives contact with a whole parse, for the reason
  the design doc already records: the converted category is a small share of parse time.
  other mark in `emitFirstMatch` asks a question about the arm; this one asked only
  whether the grammar has root trivia at all, so it was emitted at 1,046 css sites
  against 186 for the capture marks beside it. 414 of those sites (39.6%) cannot
  append to `_rootTriviaLog` at all. Measured on top of the save/restore elision
  above, with which it is additive: css `ast.js` 3,140,585 -> 3,102,915 B (-1.20%,
  gzip -4,259), less -0.34%, scss -0.61%, jess -0.19%; `_cmlrg` 83,641 -> 50,548 B
  and 1,046 -> 632 sites. css expansion 27.45x -> 27.11x its 114,446 B source.

- **`dispatch()` keys off a data trie instead of a per-case character chain.** css
  `ast.js` 3,336,650 → 3,311,657 B (−0.75%, gzip −1,782 B); key-comparison bytes
  40,269 → 8,772 (−78%). Speed is inside noise — the strategy sweep behind
  `PARSEMAN_DISPATCH` is in `docs/design/derived-tokenization.md`.
- **A `dispatch()` site takes the trie only when the trie's own emission measures
  smaller than the chain it replaces.** A key-count rule of thumb had grown less
  `ast.js` by 902 B at its one qualifying site; that site now keeps the chain and
  less is back to 3,937,767 B, with css and scss unchanged.
- **Fixed `'@' | 32` folding every `@`-led dispatch key to a non-match**, so
  `@font-face` silently took the opaque at-rule arm. The 288-test css suite passed
  with the bug present; a full-tree diff against the pre-trie build caught it. Both
  sides now fold ASCII letters only.
- **Static rollback elision — the emitter no longer writes save/restore machinery it can
  prove will never run.** A new shared `analysis/commitment.ts` answers, over the rule
  graph, whether a construct can fail after consuming (`mayFail`) and whether it always
  consumes on success (`alwaysConsumes`); codegen drops the capture save/restore at
  fallible boundaries whose remainder is total, and the trivia mark/rewind at sequence
  boundaries whose next term cannot match zero-width. Compiled CSS `ast.js` **3,311,657 →
  3,140,585 B (−5.17%, against `fd1c5c7`)**, less −4.06%, scss −6.68%, jess −5.73%; parse speed unchanged on
  corpus (benchmark.css min +1.05%, benchmark.less min −0.20%) and faster on the guard's
  micro-parses (`css/decls` compiled −48%, `css/selector` −41%). Gated on byte-level parse-tree
  equality against a non-eliding build — 4,077 AST/CST/ParseDoc tree comparisons over the
  four dialect corpora, zero differences.

- **Fixed: `node<N>('Type', …)` no longer fails to type-check.** The `type`-first
  overloads gave `Type` no default, so a call supplying ONE explicit type argument failed
  their type-argument arity and fell through to the combinator-first overloads, where
  argument 0 must be a `Combinator`. One call site therefore emitted two unrelated-looking
  diagnostics: `TS2345 string is not assignable to Combinator`, and `TS7006` implicit-any
  on the reducer's `children`, because the rejected overload left the reducer contextually
  untyped. `Type` now defaults to `string` — jess 411 → 5 diagnostics, scss 342 → 4, of
  which exactly one is real debt. **The literal is not recovered by this spelling**:
  TypeScript fills a missing type argument from its default and never infers it, so the
  brand is `string`. Only a curried call form preserves the literal; that changes the
  public surface and is deliberately not taken. Spell `node<N, 'Type'>('Type', …)` where
  the brand matters. A type-level test pins the resolved brand for all three spellings.
  composed grammar's terminal alphabet, the prototype and landed-sweep measurements, a
  corrected css artifact baseline (`lib/grammar/ast.js` at 3,336,650 B, not 4,954,294 B,
  which was the whole css `lib/` across four build variants), and a register of 24
  untried experiments — including an auto-alias cluster for declaring escape, case and
  prefix equivalences once instead of hand-spelling them per site. Every entry and
  measured result now carries a **contribution tag** (FOUNDATION / ENABLED-BY /
  ORTHOGONAL / LEGACY) so it is visible which work survives the token-cursor rewrite. Records the dispatch
  sweep: the whole spread across every configuration is **2.4%**, so dispatch keying is
  not where parse time goes. **Withdraws
  the 1.83× speedup as noise** — three byte-identical artifacts measured 5.961/6.101/11.952 ms
  in separate processes — and makes byte-level tree equality against a toggled baseline
  the gate, after a bug 288 tests missed.

- **The peak clause gains a sanctioned way through: `PERF-PEAK-WAIVER`.**
  `docs/design/perf-gates.md` has always ended "do not widen the threshold to make a
  build pass — either fix the regression, or land it with the number visible", and only
  the first half was executable. A deliberate, *bought* slowdown had exactly one route
  past a red `pnpm perf:workloads:peak`: move `peak` or widen `allowancePct` — the edit
  §D calls **LAUNDERING RISK** by name, which makes the slower build the reference and
  destroys the record permanently to get one PR out. A PR may now declare, on one line
  in the CHANGELOG's open section, `PERF-PEAK-WAIVER <config> median <n>% min <n>% —
  <why>`, and the guard prints its **full drawdown report** and exits 0.
  **The peak record does not move**: the same bar, the same red, for the next PR. Every
  property is friction on purpose — it cannot be written without the measurement, the
  numbers must themselves breach the allowance, it cannot understate what was just
  measured, it must give a reason, it must be **absent from the base's CHANGELOG**
  (per-PR, non-sticky — and unverifiable without `--base`, so unwaivable without it), it
  cannot be combined with a `peak` edit, and a malformed one fails loudly rather than
  being ignored. It is **not** `release-exempt` and does not extend it. §D's failure
  message now names the route, so a red gate teaches it instead of leaving the next
  contributor to invent `allowancePct: 300`.

- **Fixed a shared-prefix miscompile that produced a WRONG TREE with no error.**
  Left-factoring recognises a choice's common leading terminal once and replays that
  result into each arm's own leading term. The replay was keyed on the combinator
  OBJECT, on the stated assumption that each arm's leading term is a distinct object
  reached during that arm's emission. That is false, and a grammar breaks it without
  doing anything unusual:

  ```ts
  const num = regex(/[0-9]+/)          // ONE instance, deliberately reused
  choice(sequence(num, literal('-'), num),
         sequence(num, literal('+'), num))
  ```

  Every emission of `num` inside any arm hit the map, so the TRAILING occurrence
  replayed the LEADING one's value and end. On `"1-2"` the interpreter yields
  `["1","-","2"]` over span 0-5 and the compiled parser yielded `["1","-","1"]` over
  span 0-1 — a parse that SUCCEEDS, with no error and no warning. Under ambient
  trivia it could also silently REJECT valid input. And on `"7-7"` the values are
  identical and only the SPAN diverges, so a harness comparing values alone reported
  agreement.

  **How to tell whether you are affected.** You compile (rather than interpret) a
  left-factored `choice` whose arms name the same rule more than once — binary
  operators (`A op A`), delimited pairs, `A sep A`. `g.X` returns the identical ref
  object on every reference, so a grammar written through the `g.` proxy is the
  common case here, not the exotic one. The interpreter was always correct; this was
  compiled output only.

  The replay is now consumed once per ARM, and the arm-boundary reset is scoped to
  the choice that REGISTERED the replay. That second half matters on its own: an
  unscoped reset let a NESTED choice inside an arm clear the OUTER choice's tracking
  mid-arm, re-opening the same hole one level in. Falling through to a real scan is
  always correct, so the failure direction is safe, and the optimisation is intact —
  the grouped arms still measure exactly one scan.

  The 286-test parity suite passed this defect with the bug present.
  `assertEnginesAgree` is sound — whole-object comparison on result and sinks —
  there was simply no fixture of this shape.
  `test/parity/shared-prefix-repeated-arm.test.ts` is that absence, with a
  distinct-but-equal control that passes both ways, which pins the defect to the
  replay KEY rather than to the factored shape.

- **Fixed `dispatch()`'s packed key tables wrapping silently above 4095.** The
  encoder behind an emitted dispatch table packs two characters at six bits each —
  twelve bits, range 0..4095 — and the mask made anything larger wrap without a
  word. `unpack` then decoded a wrong index and the table routed to the WRONG ARM at
  parse time, in shipped compiled output, with a successful parse over it. It now
  throws a `RangeError` naming the offending value at build time, which is the last
  point this is cheap to catch. It is TABLE SIZE rather than key count that
  approaches the ceiling: the packed vectors carry key offsets, key lengths, case
  indices and trie slots.

  The bound was missing because the encoder existed TWICE, as identical hand-spelled
  twins, neither of them bounded — which is how one defect became two. There is now
  one implementation, and the matching 12-bit DECODER is emitted from the same
  shared helper instead of being re-spelled beside a copy, so half an encoding can
  no longer live in a second file and agree with the other half only by luck. A test
  asserts the decoder appears only beside the encoder it inverts.

- **A third copy of the ASCII case fold, spelled `| 32`, is gone.** `| 32` is not a
  letter fold. It also folds `[`/`{`, `]`/`}`, `^`/`~` and `` @ ``/`` ` ``, so a
  case-insensitive matcher built on it collides on those characters, skips later
  terminals, and fires the EARLIER terminal's accept id for the later terminal's
  text. This is the same defect `e8612eb` fixed in `dispatch()` earlier in this
  release, written a second time by a second author.

  **Scope, stated because it is narrower than the two entries above.** The wrong
  copy was in `src/compiler/token-scanner.ts`, which nothing on the shipping path
  reaches — codegen imports `token-dispatch.ts` and nothing else from that group —
  so no emitted artifact carried it. `foldCode` and `foldExpr` are now exported from
  `token-dispatch.ts` and imported here, so the trie build and the emitted walker
  share one implementation; they must fold identically or a lookup misses the node
  the trie built. Two more defects in the same unreached module are fixed and
  recorded here for the class rather than the blast radius: its memo was keyed on
  `(pos, mode, set)` with no INPUT IDENTITY, so a second parse of a different string
  could take the first string's cached token at the same position; and
  `leadTerminal` asked a term for its inner terminal before checking whether the
  term can consume, so `sequence(optional(X), Y)` yielded X's terminal as THE lead
  when the input may legally start with Y's, and `sequence(not(X), Y)` yielded a
  terminal from a negative lookahead that never consumes at all. A single lead
  terminal cannot express "X's first set OR Y's", so a nullable prefix now REJECTS
  the site and scannerless gating handles it; a genuinely zero-width prefix still
  continues, because the next term does genuinely lead.

- **Fixed a zero-width trivia probe that recorded line data it is documented never
  to record.** `probeTriviaEnd` finds the end of a trivia run "WITHOUT recording any
  of it", and it was read-only for capture buffers and read-WRITE for line data:
  both paths call `recordLineRangeFromContext` whenever `ctx.trackLines` and the
  trivia can match a newline. A zero-width assertion — including one that REJECTS —
  therefore advanced `_lineScannedTo` over a gap the parse then re-scanned. You are
  affected if you parse with `trackLines` and use an assertion that probes trivia,
  which as of this release includes `adjacent()` and `notAdjacent()`. The probe now
  runs through a context with `trackLines: false`, which makes the recording
  unreachable in both scanners rather than undone afterwards; everything the
  scanners need to find the end is carried through unchanged.

- **`bench/` is now typechecked, under the same settings as `src/`.**
  `tsconfig.json` included `src/**` and `test/**` only, so the directory holding the
  performance evidence this project PUBLISHES had never been typechecked — which is
  how a committed bench came to die on a bare `ReferenceError: contests is not
  defined`. A bench that silently fails reads exactly like one that passes. It is in
  the main tsconfig now: no `tsconfig.bench.json`, no relaxed flags, no
  suppressions, so `pnpm typecheck` — which CI and the pre-commit hook already run —
  covers it.

  82 errors surfaced, and two of them were real defects in measurement rather than
  type noise. `choice-cost-guard` passed a SECOND argument to
  `analyzeChoiceInventory`, which takes one, so it was silently discarded; and
  `alloc-model` set `captureTrivia` as a key on `rules()`, which has no such option,
  so grammar-wide trivia capture was never enabled in a rig written to measure it
  enabled. Any number you took from those two before this release was measuring
  something other than what it claimed. Nothing is deferred and nothing under
  `bench/` is excluded: `docs/future/bench-typecheck-followups.md` records how each
  of the three held-back items was resolved, including the `ReferenceError` bench
  itself, whose report loop now iterates the contest list it built its results map
  from.

- **New and NOT on the shipping path: `parseman/table`, a second, prototype
  lowering.** `src/table/` encodes a rule map into a flat instruction table read by
  ONE shared driver, rather than codegen's recognizer emitted bespoke per rule. It
  gains a real `./table` export and a build entry in this release for one reason: an
  emitted table module has to be able to import its driver at all, and there was no
  runtime JS in `dist` for it to import.

  **Nothing routes to it.** The macro, `compile()` and `compose()` do not reach it,
  no grammar in this repo ships through it, and it is slower than codegen on every
  workload measured so far. No per-dialect artifact-size figure is claimed here,
  because none has been measured on a shipping grammar. Read it and run it; do not
  plan a 0.47.0 parser around it.

  It is carried in the release rather than held back because its identity gate —
  interpreted, compiled and table digested against each other through
  `parseman/oracle` — is what found several of the defects recorded elsewhere in
  this section, including ones in shipping code. The prototype's own silent-failure
  fixes (an unstamped host mode that returned AST from a table encoded for CST, an
  ambient-trivia bake that made three engines agree by all failing the same way, a
  root-trivia capture that recorded nothing because the labels never reached the
  entry) are internal to the prototype and are deliberately not given entries of
  their own.

  **Known limitations, since `./table` is a real export and anything behind it
  ships.** None is reachable from the macro, `compile()` or `compose()`; all are
  reachable by calling `parseman/table` directly.

  - **Failure REPORTING diverges from both shipped engines in four shapes.**
    `keywords()` names each keyword where the engines name `keyword`; `peek()`
    lets the lookahead's inner expectation escape; a `sepBy` that fails its `min`
    names the separator rather than the item; and both engines report at the
    furthest position an enclosing sequence could also have closed at, so they
    name a closer (`"]"`) where the table names one of the choice's own openers.
    Acceptance, rejection, trees and consumed spans agree — only the `expected`
    set differs. Pinned in `test/unit/table-encode-refusals.test.ts`.
  - **A STRUCTURAL node — no builder, no `project`, no `collapse` — is refused
    even under `hostMode: 'cst'`**, where a host is by definition present and
    would supply the value. The refusal is correct for `'ast'` and is a gap for
    `'cst'`. It fails closed with a named `UnsupportedConstruct`.
  - **`scanTo()` and `balanced()` are RUNTIME-ONLY.** They run correctly but park
    a live combinator in the const pool, so `emitTableModule` refuses a grammar
    using either, naming the construct. Every grammar in this repo except json,
    csv and lang uses at least one.

  No timing or per-dialect byte figure is published for the prototype in this
  release, and the two figures quoted during its development (113 B/rule, ~2.65x)
  were measured on a synthetic ladder and on json — never on a shipping grammar.

- **Fixed: `parseman/table` could not run ANY grammar with `classifiedTrivia`, because
  `regex()`'s first-set analyzer was registered by side effect from one module.** The
  analyzer (`src/regex/first-set.ts`) was wired into `regex()` at run time by the library
  entry, via a `registerRegexAnalyzer` seam, so that a bundle holding `regex()` without
  the library entry never pulled it in. A published subpath is its OWN module graph:
  `dist/table/index.js` never executes `src/index.ts`, so its private `regex()` fell back
  to the permissive `any()` first-set. `buildTrivia` (`src/table/program.ts`) rebuilds
  classified trivia through that `regex()`, and `classifiedTrivia()` requires a concrete
  finite first set per arm — so it threw on the FIRST arm of every table-lowered grammar
  with labelled trivia, which is every grammar that exposes trivia categories at all.
  Plain `trivia(regex(...))` survived because it asserts nothing.

  The analyzer is now imported DIRECTLY by `src/combinators/regex.ts` and the
  registration seam is deleted. Registering it a second time from the table entry would
  have fixed this instance and left the fragility for the next entry point; a mutable
  module-global that a *different* module has to remember to write makes `regex()`'s
  result depend on which bundle it landed in. It adds no new leaf modules — the analyzer
  imports only `combinators/first-set.ts` and `regex/classes.ts`, both already reachable
  from `regex()` — so the cost is the analyzer's own bytes: `dist/table/index.js` grows
  from 121,433 to 128,211 (+6.8 KB unminified), `dist/run/index.js` is unchanged at
  17,501, and `dist/index.js` shrinks slightly. `RegexFirstSetAnalyzer` and
  `registerRegexAnalyzer` were never in the `exports` map, so nothing public is removed.

  **`./table` is where it threw; it was never the only entry affected.** `./diagnostics`,
  `./spec`, `./language-service` and the CLI `bin` also build grammars without
  `src/index.ts` in their graph, so `regex()` returned a permissive first-set there too —
  no error, just choice dispatch silently disabled. Those are now correct as well.

  Both halves are pinned by `test/unit/table-entry-dist.test.ts`, which is deliberately
  the first test in the suite to import `dist/` — through package self-reference, so it
  resolves as a consumer's would. A source-only test could not have caught this and
  could not catch a regression: every test file has `src/index.ts` somewhere in its
  graph. Its second case bundles each `exports` entry in isolation and fails any entry
  that holds `regex()` without the analyzer.

- **Three documentation claims corrected against the code.** The gating diagnostic
  left the compile path in 0.45.0, but `README.md` and `docs/guide/combinators.md`
  still said the build reports it — `compile()` reports nothing. `ChoiceStrategy` was
  documented in `docs/reference/types.md` as a three-member string union; the real
  exported type is a four-member tagged union including `sharedPrefix`, so code
  written against the documented shape would not typecheck against the real one. And
  `docs/guide/macro-mode.md` still described pre-0.46 variant duplication —
  1.98x/3.92x, "full copy", "nothing is shared"; the 0.46 module-level hoist makes
  it 1.53x/2.57x. Size and benchmark figures across the guides are re-sourced to the
  committed `bench/size-baseline.json` and the committed chart assets, and claims
  that were stated universally but measured on ONE lowering now name that lowering.

## 0.46.0 — 2026-07-31

- **Add a `parseman` CLI — `parseman diagnose` and `parseman fix`.** Exit **0** clean,
  **1** blocking findings, **2** could not analyse. `--json` emits the structured object
  the human rendering is derived from. The bin is its own bundle (`dist/cli/index.js`,
  library twin at `parseman/diagnostics`); `dist/index.js` is unchanged and every
  size-guard fixture is still at its committed ceiling.
- **`diagnose` can now load a macro-authored grammar.** It died with `TypeError: Import
  attribute "type" with value "macro" is not supported` on every shipping parseman
  grammar; a module hook now drops the attribute for `type: 'macro'` only.
- **Fixed `diagnose` reporting a finding count over a run that examined nothing.** It
  reported `176 problems, 1 cause` against a built artifact with zero examined choices.
  Adds `examinedNothing(d)` (exported), a `COULD NOT ANALYSE` rendering with no tally, and
  **exit 2**. Partial runs exclude unreadable rules from the count and state them
  separately.
- **`parseman fix` offers only rewrites it has PROVEN.** Each candidate is applied, the
  grammar recompiled, the corpus re-parsed on every available engine, and the outputs
  compared; a rewrite that changes output is discarded and never shown. Ships
  `regex(/if(?!\w)/)` to `word('if', '\w')` and `not(not(X))` to `peek(X)`. Previews a
  diff by default and writes only under `--apply`.
- **Fixed `fix --apply` corrupting source.** `locateEdit` counted a parenthesis inside a
  string literal, producing an unbalanced `oldText` that `--apply` wrote to the user's
  file. Also gives colliding sites distinct ids.
- **Fixed `fix --apply` reporting a PARTIAL run as complete**, and the benefit line
  claiming "removes 1 of the N arms" whatever the rewrite measured.
- **The rebuilder checks itself before it is trusted** (`src/analysis/rebuild.ts`). An
  identity rebuild must reproduce the corpus output before any candidate is considered,
  and node kinds with no faithful public reconstruction are reused verbatim rather than
  dropped.
- **`--corpus` adds per-arm corpus positions and a located input site with a caret.**
- **Fixed the arm renderer re-walking the grammar and mislabelling every arm** —
  `ChoiceGating` now carries its arms non-enumerably (`choiceArms()`).
- **Rewrote every diagnostic in plain English** — no bare term of art, every number with
  its unit, every observation followed by its consequence. The wording lives in
  `gating.ts`, so `--json` and `formatGatingWarnings` improved with it.
- **Group findings by CAUSE, not by site** — a cause is stated once and followed by its
  sites. **146 lines to 100** on `examples/css/parser.ts`, every explanation exactly once.
- **A finding carries a wrench and the literal command to run** instead of the word
  `ACTIONABLE`, and only where a rewrite was actually proved. `LOCATED` is now `NEEDS YOU`
  and says why; `ACTIONABLE` is `SAFE TO APPLY`.
- **Fixed the suggested `parseman fix` command not reproducing the run** — it dropped
  `--ext` and `--accept`, values are now shell-quoted where needed, and a `-`-leading
  grammar path stays a path rather than becoming an option.
- **A one-line summary at the end of the report** — tally, causes, exit code in words, and
  the auto-fixable count with the command that does it.
- **Clickable file locations (OSC-8)**, zero-width so alignment is unaffected;
  `--no-links` disables.
- **Rich on a TTY, plain when piped** — colour for severity, glyphs distinct in SHAPE for
  cause class, column-aligned arm tables. A clean grammar renders in two lines. No
  timings, no dates, no absolute paths.
- **Render through `linecraft` (pinned `0.2.6`) instead of hand-rolled ANSI.**
  `src/analysis/terminal.ts` is the only module that talks to a terminal; renderers emit
  rows and never produce an escape byte. Colour is decided by the CLI, never sniffed in a
  renderer. Width pinned to 80 off-TTY (`--width`). `dist/index.js` contains no
  `linecraft`.
- **Fixed `broad-recognizer` advice being one string per cause** — it told the author of a
  genuine catch-all scanner to use `word()`. The suggestion now follows what the arm leads
  with.
- **Fixed four landings of raw control bytes in `src/`** (`choice.ts`, `degradation.ts`,
  `rebuild.ts`, `diagnose-render.ts`), which made those files binary to git and GitHub and
  made `grep -rn` skip them silently. Composite keys are `JSON.stringify`d and ANSI
  escapes written as `\u001B` sequences; output is unchanged and `pnpm check:control-bytes`
  is green.
- **Captured CLI output for review at `docs/samples/cli-output.md`** — verbatim, non-TTY,
  with the command that produced each block.
- **`fuseInterpreted()` — a composed grammar can now be RUN interpreted.** Any interpreted
  run of a composed grammar previously threw `ref<T>() used before .define()`. It takes
  the same items `compose()`/`composeLeaf()` take and returns a runnable combinator map
  with the compiled fuse's semantics — no codegen, no macro build step, and nothing added
  to codegen. `isInterpretedFuse(map)` distinguishes the shapes; `run()`/`parseDoc()`
  accept either. Equivalence pinned by `test/parity/interpreted-fuse-parity.test.ts`.
- **Interpreted fusion is MUTATING by construction** — a second, conflicting fusion over
  the same piece objects throws rather than rewriting the first one's parser, and a
  `pick()`/`linkable()` artifact is rejected rather than silently fused around.
- **Pinned: a piece containing no `node()` at all** compiles to non-capturing rules, so
  the compiled fuse hands a later piece's `node()` empty children where the interpreted
  fuse reports the real ones. Adding any `node()` removes the difference.
- **`composeLeaf()` no longer throws at runtime** — without the macro it materializes the
  interpreted fuse on first rule ACCESS. Still macro-only as a compiled artifact.
- **Refuse to emit an exported `rules()` factory instead of shipping a binding that
  throws.** The factory body was emitted verbatim, naming imports the artifact no longer
  has: it compiled clean, imported clean, and threw `ReferenceError` on first call. jess
  shipped that for three days, 26 undefined identifiers in css alone. Now a compile-time
  error naming the export and its line. A local `const` factory was never affected.
- **BUILD-TIME BEHAVIOUR CHANGE — the emitted module is scope-analysed and refused if any
  identifier is read but bound by nothing.** A macro build that used to succeed can now
  fail. The error names every free identifier with a `file:line:column` in the EMITTED
  module. Deliberately not reported: a name the SOURCE already left free, and an
  unreferenced, non-exported, function-valued `const`. Macro-build only — zero emitted
  bytes and zero codegen time.
- **Fixed a reducer named inside an IMPORTED factory being emitted as its SOURCE.**
  `node('Fold', …, fold)` emitted `const _build = [fold]` into the consuming module, so
  the artifact threw `ReferenceError` on IMPORT. Found by the scope check above on its
  first run.
- **Fixed reducer resolution for an imported `rules()` factory** — the plugin now
  registers each factory's module, so an offset resolves against the scope tree that
  indexes it and the node pays for the tiers its reducer declares. Completes the fix filed
  for 0.46 in 0.45.
- **Module-level hoist of byte-identical fused declarations — `probe/variants-4` is 35.5%
  smaller (77,732 B to 50,174 B), `probe/variants-2` 22.9% (39,284 B to 30,303 B).** A
  module publishing N variants of one grammar emitted the same rule functions N times,
  once per IIFE. `probe/variants-4` now costs 2.53x `probe/variants-1`, down from 3.92x,
  gated by `test/unit/size-guard.test.ts`. The other 22 gated fixtures are unchanged.
- **…and the `_pfFail` sentinel is hoisted from every scope or from none**, because a
  partial hoist makes a parse FAILURE read as a SUCCESS carrying `{}`. Keyed on the
  declared NAME, not the occurrence. Disabled under `grammarCoverage`.
- **Reverted "share cold capture restores through hoisted helpers"** — bisected as the
  cause of this branch's perf red: `rollback/dense` min +50.2…+52.3%, winning 0/12, 0/12
  and 1/12 across 36 paired comparisons, against its own predicted 1.4% at worst.
- **Grammar wasted-work analysis** (`analyzeChoiceInventory`, `profileWastedWork`,
  `checkWastedWork`, `buildWastedWorkBaseline`, plus rendering). The static inventory
  reports every shared-prefix choice site — including the ones codegen declined to
  left-factor, with the blocking arm and the reason, a backlog that was never written down
  anywhere. The dynamic profile attributes re-scanned bytes per site and per arm over a
  real corpus. Interpreted-only: `src/combinators/choice.ts` is untouched and codegen
  emits nothing extra.
- **The profile reports two columns**, interpreted (`attempts`/`wastedBytes`) and gated
  (`gatedAttempts`/`gatedWastedBytes`, modelling codegen's first-character guard), with
  rankings taken from the compiled column. Byte rankings survive the correction;
  failure-rate and attempt-count claims do not.
- **`pnpm choicecost:guard` — a two-sided ratchet, wired into CI as a required check.**
  `bench/choice-cost-baseline.json` is a BAND at ±0.1%: growth fails and an unbanked
  improvement fails with "bank the win". Absolute, never differential. It fails closed on
  every way of not having measured — missing, malformed, empty or over-ceiling baseline,
  changed corpus, stale or unbaselined entry, zero corpora, zero instrumentable sites, an
  incomplete grammar walk, or a corpus that did not parse. `failOnInversions` is on from
  day one. The corpus is `bench/workloads/fixtures/{site.css,app.less}`, already
  committed. A `1.0x` target is measured and printed every run and does not block in 0.46.
  It ranks bytes, not CPU, and is not a third perf gate.
- **Fixed the choice-cost gate's fail-open baseline paths.** A `"totals": null` reached
  `Object.keys` as an uncaught TypeError instead of the documented `invalid-baseline`
  breach, and a non-numeric entry made `pct` return `NaN` — `NaN > tol` and `NaN < -tol`
  are both false, so the gate passed over numbers it never compared. Every recorded value
  is validated finite before any is read.
- **`examples/css/parser.ts` and `bench/workloads/less.ts` export their whole rule map**
  (`cssRules`, `lessRules`), so analysis can name a site `Value › node(Value)` instead of
  reporting it anonymously. No behaviour change.
- **Fixed the grammar perf gate failing against a byte-identical `src/`.** Its private
  measurement loop sampled the two sides as contiguous blocks, so paired cases never
  shared GC state, cache state or position in the run — with both sides pinned to one
  commit it reported `expected/narrow` +23.3% median and FAILED while `rollback/sparse`
  read −9.2% in the same run. It now uses the shared `bench/ab-harness.ts` and fails only
  on a strict majority of independent passes. `--self` re-measures the noise floor.
- **Fixed both perf gates reading a COMPILATION LOTTERY.** Each side was compiled once
  before the pass loop and reused for every pass, so a pass resolved one draw twelve times
  and every pass inherited it — a majority was unanimous by construction. On
  byte-identical sides, `rollback/none` read 12/12 (−7.8%) and `expected/none` 0/12
  (+7.8%): a false FAIL in one direction, a BLIND case in the other.
- **`measurePasses()` resamples, and MEASURES the null instead of assuming it.** Both
  sides are recompiled every pass; a CONTROL PAIR of two reference instances runs at the
  same rotated positions and its pooled win rate is printed per case; the win-rate ceiling
  is null-relative, so calibration can never loosen an unbiased case. `calibrate()` no
  longer warms one side only. **`passes` 3 to 5** in `bench/grammar-density/config.json`
  and `bench/workloads/config.json`. No threshold widened, no reference re-baselined.
- **A PEAK clause: `pnpm perf:workloads --peak`.** The per-step gate structurally cannot
  see a slow bleed. The clause holds every release to the fastest one on record, named by
  COMMIT in `bench/workloads/config.json` so it is re-measured rather than inherited;
  median AND min must both breach. The peak is **seeded at 0.45.0, not swept**.
- **`scripts/check-changelog.mjs` gains section D, so the peak record cannot move
  quietly.** It validates every `peak` block structurally and requires any edit to one to
  be named in the CHANGELOG's current section, calling out by name the two edits that
  launder a regression into the baseline — moving the peak BACKWARD and widening
  `allowancePct`. It runs on every PR; `release-exempt` does not waive it.
- **Fixed `_signTestNote` arguing from pairs it treated as independent.** The pairs of one
  pass share a compiled pair, and `passes` is 5, not 3. Prose only — every threshold,
  `peak.sha` and `peak.allowancePct` is byte-identical.
- **Fixed a shared-temp-directory race in the size probe** (`bench/size/probe.ts`). The
  probe path is deliberately fixed, which also makes it shared: concurrent probes clobbered
  each other and the loser failed the build with `BANK THE WIN — output got smaller`.
  Access is now exclusive via a lock directory.
- **Fixed the size-probe lock reaping a live holder and swallowing real errors.**
  Staleness aged the waiting process, not the lock; and a bare `catch` made `EACCES`,
  `ENOSPC` and a missing `TMPDIR` indistinguishable from contention, so a fatal condition
  spun forever. Only `EEXIST` now means locked.
- **Exit codes are asserted by running the CLI** (`test/unit/cli-exit-codes.test.ts`) —
  nine cases over 0 / 1 / 2 through the real argv parsing, renderers and process exit.
- **In-process coverage for the CLI and the relative-span model.** `src/cli/index.ts`
  shipped in 0.46 at 0% on every metric because its only tests spawn a subprocess.
  `runCli` now takes a budget (default 300 s) and throws `CliDidNotSettleError` naming the
  command and the output so far, instead of returning `code: undefined`; scratch dirs are
  no longer leaked.
- **Coverage for the surfaces 0.46 added without tests** — `fix-render.ts` and
  `rebuild.ts` (59.7% statements), `choice-cost-render.ts` (5.98% statements, 0% branches
  and functions, to 100%), the duplication and diagnose surfaces, and the macro
  evaluator's rejection paths in `src/plugin/{evaluator,index}.ts`, the two largest
  uncovered branch pools in the repo.
- **Fixed `size-guard` and `release-gate` tests running a 60–180 s child under vitest's
  5 s default**, which discarded the child output those tests exist to assert on and read
  as a flake that vanished when the file was run alone.
- **`docs/design/derived-tokenization.md`** — the design for deriving a scanner from the
  composed grammar's terminal alphabet, the prototype and landed-sweep measurements, a
  corrected css artifact baseline (`lib/grammar/ast.js` at 3,336,650 B, not 4,954,294 B,
  which was the whole css `lib/` across four build variants), and a register of 20
  untried experiments. Records the dispatch sweep: the whole spread across every
  configuration is **2.4%**, so dispatch keying is not where parse time goes. **Withdraws
  the 1.83× speedup as noise** — three byte-identical artifacts measured 5.961/6.101/11.952 ms
  in separate processes — and makes byte-level tree equality against a toggled baseline
  the gate, after a bug 288 tests missed.
- **`proposeFixes` docs say "every available engine"** — `engines` is `['interpreted']`
  when the grammar does not compile, so "on both engines" overstated what was checked.

## 0.45.0 — 2026-07-30

- **Recognise the inline-`mk` shape when the node type is a factory parameter.** The
  matcher required a string LITERAL in the `mk(...)` type position, so the ordinary way
  to spell a family of nodes — `const N = (type, body) => node(type, body, (c, f, s, r,
  tl) => mk(type, c, r, s, tl))` — missed the fast path at every site and paid a
  `_build[n](...)` call per match, while still matching the near-miss heuristic and
  reporting itself as a degradation. parseman's own vendored Less workload uses one such
  factory at 31 sites. It is now accepted when the SAME identifier stands in the
  `node()` type position and in the `mk()` type position, which is a proof rather than a
  loosening: the arrow's parameters are `(c, f, s, r, tl)`, so nothing between the two
  occurrences can rebind the name, and the evaluator has already resolved that binding
  to the node's type. Two DIFFERENT identifiers, or a mismatched argument order, are
  still refused. This applies to the MACRO path, which is what produces shipped
  artifacts; a runtime `compile()` reads the reducer through `Function.prototype.toString`
  and has no call-site identifier to compare against, so the interpreter still reports
  the near miss there.
- **A cap on inline expansion (`maxInline` / `PARSEMAN_MAX_INLINE`, default 1000).**
  `emitLazy` pastes the body of a ref that is used exactly once and is not recursive,
  rather than hoisting a function nobody else calls. That is right per ref and had no
  ceiling in aggregate — a chain of single-use helpers expanded transitively by an
  amount no grammar author could see or predict. Each emitted function now gets a
  budget of `maxInline` combinator nodes of inlined single-use refs; once it is spent,
  the remaining refs in that function become named functions and are called. The
  decision is a pure function of the grammar and the configured cap, so two compiles
  make the same decisions in the same order, and it needs no eviction policy because
  the budget is per function rather than per artifact. **This is not the same
  mechanism as identity-keyed hoisting of a multiply-referenced subtree** — that
  already emits flat for a shared object referenced 1 or 38 times, and is untouched;
  conflating the two is what made this look like a duplication problem.
  The default is measured, and the measurement is the interesting part: across the
  whole in-repo corpus the largest single-use body is **16 combinator nodes** and the
  busiest function absorbs **99**, so 1000 sits ~10x above anything a hand-written
  grammar produces. It therefore does not bind on any grammar here — emitted output is
  byte-identical to the uncapped compiler, which makes the cap's perf cost zero by
  construction rather than small by measurement. It bounds the pathological case and
  nothing else, which is what a cap is for. The same sweep also shows that single-use
  inlining is **not** the size driver: disabling it entirely buys 2.2% on one fixture
  and nothing anywhere else, against ~5,230 generated bytes per `node()` site.
  `bench/size/inline-cap.md` has the table. When the cap does bind it is reported —
  collected during compile and drained by the caller (`beginInlineCapCapture` /
  `endInlineCapCapture` / `formatInlineCapSites`), never printed from the compiler, and
  deliberately NOT routed through `recordDegradation`, because the cap binding is
  intended behaviour and `PARSEMAN_DEGRADATION=error` would turn it into a build
  failure. Escape hatch, off by default: `maxInline` on `compile` / `compileRuleMap` /
  `compileLinkable`, or `PARSEMAN_MAX_INLINE=<n>` / `off`.
- **Hoist the raw-children coercion out of every node site.** Each `node()` emitted a
  ~300-byte inline expression deciding whether the produced value was already a tagged
  CST thing or needed wrapping in a synthesized leaf. It is now one shared `_rawEntry`
  helper in the artifact prelude. Measured on the size gate: **-1.9%** on
  `example/css`, **-5.5%** on `probe/node-scale-32`, **-6.5%** on `probe/trivia-off`;
  `probe/compose-leaf` moves **+0.1%** because at that scale the helper declaration
  costs more than the four sites it replaces. Allocation behaviour is preserved
  exactly — the `{ start, end }` span literal is still built only on the wrapping
  branch (the helper takes offsets, not a span, unless line tracking already holds one
  in a local), so the hoist cannot allocate a span the inline form did not. The code
  only runs inside `if (_sr)`, so a grammar with raw capture off pays nothing.
- **Delete the dead `_dcst` binding.** Its only gate was the profiling capture pass,
  which is not compiled in, so it constant-folded to `undefined` and never reached an
  artifact — but reserving its variable name still advanced the codegen counter and
  renumbered every subsequent `_NN` in the file, which made two otherwise-identical
  lowerings diff. Removing it is worth **-0.3%** on `probe/hostmode-ast` and under
  0.1% elsewhere; the value is that `'ast'` and `'cst'` lowerings of the same grammar
  no longer disagree about variable numbering.
- **`size-gate`: the committed baseline IS the ceiling, and it ratchets both ways.**
  The 10x raw-bytes target is not reachable in 0.45 — marginal cost is ~5,231 generated
  bytes per `node()` site and near-CONSTANT from 4 to 32 sites, so it does not amortise,
  and reaching 10x needs ~1,170 B/node, a 4.5x cut that inlined per-site preambles
  cannot give. Rather than ship a permanently-red required check — which trains people
  to ignore CI, and is how several gates in this repo went dead — the gate now enforces
  the property that actually protects the product: **no fixture may be worse than it is
  today.** Each fixture's committed `genBytes` is its ceiling, with 0.1% slack (codegen
  is deterministic; the measured noise floor is exactly 0).

  The check is two-sided. Growing past a ceiling fails, as before. **Shrinking below one
  ALSO fails**, with "bank the win" — because an un-banked improvement is silent headroom
  for the next regression to grow into, and a convention asking a human to lower it is
  not a check. `bench/grammar-density/config.json` and `bench/workloads/config.json` both
  carried exactly such a comment and sat unbumped for ten releases. Raising a ceiling
  needs owner sign-off; lowering one is mandatory.

  `CEILING = 10` stays in the source, is measured every run, and is reported per fixture
  — ratio, target, the multiple it must fall by, the byte number to hit, and the measured
  reason — as a hard `TODO(0.46)` warning that green never silences. 19 of 24 fixtures are
  above it today, worst `probe/variants-4` at 58.1x. The lever is deferred to 0.46:
  replace inlined per-site preambles with shared runtime helpers, and share across
  variants (`probe/variants-4` costs 3.92x `probe/variants-1` for the same grammar, with
  compression climbing 5.3:1 -> 12.7:1 — output that gzips better is output repeating
  itself).

- **`bench/size/probe.ts` no longer exits non-zero for having measured something.**
  `--json=/dev/stdout` was written with `writeFileSync`, which opens a second, independent
  file description on what is usually a pipe. That both raced the queued async writes
  `console.log` had already handed to the real stdout, and failed outright on Linux, where
  `/dev/stdout` resolves through `/proc/self/fd/1`. The probe therefore printed a complete,
  correct table and then exited 1 with the reason on a stderr its caller discarded. Stream
  targets (`-`, `/dev/stdout`, `/dev/stderr`, `/dev/fd/{1,2}`) are now written through the
  stream this process already owns, a genuine file I/O failure is reported with its path
  and reason, and when a machine-readable stream is pointed at stdout the human report
  moves to stderr so stdout carries one clean document. The layering this restores: the
  probe MEASURES, `bench/size-guard.ts` ENFORCES — a measurement tool has no ceiling, no
  budget, and no opinion about whether a number is too big.

- **`routed(fallback)` — one production instead of a `Routed*` twin.** `routed()` took
  no argument, so it had nothing to do outside a `dispatch()` branch and failed there.
  A grammar needing the same shape in both places had to spell it twice, as an original
  with a concrete lead and a twin differing by exactly one element, with a byte-identical
  reducer — two productions and two compiled emissions for a one-token difference.
  `routed(fallback)` reuses the dispatch-consumed token when there is one and parses
  `fallback` in place when there is not, so the pair collapses:

  ```js
  // before — two productions
  const AtRuleStatement       = node('AtRuleStatement', sequence(Name,      Prelude, literal(';')), reduce)
  const RoutedAtRuleStatement = node('AtRuleStatement', sequence(routed(),  Prelude, literal(';')), reduce)
  // after — one, usable from a dispatch branch AND standalone
  const AtRuleStatement       = node('AtRuleStatement', sequence(routed(Name), Prelude, literal(';')), reduce)
  ```

  Measured on a nine-kind model of that shape (a statement form and a block form per
  kind, each reachable both ways), collapsing ten twin pairs took the linkable/fused
  emission — the form a `compose()`d grammar actually compiles to — from 54,879 B to
  35,845 B, **-34.7%**, at half the productions. Note the opposite sign when a grammar
  is compiled as ONE fully-inlined root: there the collapsed production emits its
  two-way form at every use site instead of each specialized form once, and the same
  model grows 8.9%. The win is in the per-rule-function form.

  Bare `routed()` is unchanged in behaviour and in emitted bytes: the two-way form is
  emitted only when a fallback is present, and is skipped entirely where the routed
  token is provably at the site's position. `routed()` in a dispatch **selector** is
  still an error with or without a fallback. All 21 size-guard fixtures are +0.00%.

- **`sharedPrefix` eligibility stays at concrete literal/regex leads — measured, not
  assumed.** Widening it to `routed()` and `lazy` leads was tried and rejected, and
  `bareLeadingTermKey` (`src/combinators/choice.ts`) now records why, with
  `test/unit/routed-fallback.test.ts` pinning each exclusion. A bare `routed()` lead is
  replay-safe but does not pay: the strategy trades a duplicated lead scan for a
  prescan plus a prefix-matched flag, and `routed()`'s emission is a context read and
  one comparison, so it costs +242/+260/+296 bytes at 2/4/8 arms and never crosses
  over — against -468/-1597/-3846 on the regex-lead shape the strategy exists for. A
  `routed(fallback)` lead is not a leaf at all. A `lazy` ref lead is unsafe rather than
  unprofitable: the prescan's `ctx.capturing = false` suppresses capture only for code
  emitted at that site, while a ref compiles to a call into a body generated under its
  own ctx, so its captures and trivia writes would land during the prescan and again in
  every arm. Replaying a ref needs recorded-and-spliced capture state, not variable
  reuse.
- **New: choice-cost diagnostics — a shared-prefix inventory and a corpus wasted-work
  profile.** A PEG `choice` is ordered, so each additional and each earlier alternative
  costs time that is invisible in the grammar source; grammar shape drifts with nothing
  going red. Two new analyses make it measurable.
  `analyzeChoiceInventory(ruleMap)` reports EVERY reachable `choice` with the groups of
  arms that share a concrete leading term, whether the compiler left-factored the site,
  and — the part that did not exist before — WHY it declined, naming the blocking arm.
  `detectSharedPrefix` (src/combinators/choice.ts) already computed this to choose the
  `sharedPrefix` strategy, but it is all-or-nothing and returns `null` on the first arm
  that does not qualify, so a partial group had no representation anywhere. That set is
  the refactor backlog, generated rather than noticed by a human reading grammar source.
  `profileWastedWork({ rules, entry, corpus })` counts input bytes RE-SCANNED after a
  failed alternative, attributed per site and per arm, and ranks them; `inversions`
  ranks separately by ordering defect — an arm that failed every attempt while a later
  arm matched. `checkWastedWork(reports, baseline, policy)` is the gate policy over
  either, and `renderChoiceInventory` / `renderWastedWork` are the human layer.
  Analysis, policy and rendering are three separate layers over one structured report.
  MEASURES THE INTERPRETER, MODELS THE COMPILER. The interpreter's `firstMatch` loop
  enters every arm; compiled output gates each arm on its first character
  (src/compiler/codegen.ts:2246-2277), and first-set gating is the largest parse lever
  this project has. So every count is reported twice — interpreted and gated — and
  rankings use the gated column, with the warning on every rendered report rather than
  in a footnote. Measured over jess's four dialects (637 kB CSS, 212 kB Less), the gate
  removes 74-84% of arm ENTRIES and, in all four, exactly ZERO rescanned bytes: the
  guard comes from the arm's first set, so when it rejects, the arm's own leading
  terminal would have rejected at the same position having consumed nothing. Byte
  rankings therefore survive the correction; failure-RATE and attempt claims do not,
  which is why `inversions` is computed from the gated columns and ranked by entries.
  The model replicates codegen's own nullability predicate — deliberately shallow, so a
  `node()`-wrapped nullable IS guarded — and tests compile real grammars and assert the
  model matches the emitted guards, because a hand-copy of another module's logic drifts
  in silence.
  INTERPRETED MODE ONLY: nothing is emitted into a compiled parser and codegen pays
  neither bytes nor time. `src/combinators/choice.ts` is untouched — instrumentation is
  installed by temporarily substituting arm slots and terminal `parse` methods and
  removed in a `finally`, so there is no profiling branch on the shipping hot path to
  skip. QUIET BY DEFAULT: nothing here prints, or runs, unless called.
  The metric is a deterministic COUNT, not a timing: byte-identical across repeated
  runs and across separate processes (both asserted), so it is immune to machine load
  and has a noise floor of exactly zero — which is what makes it gateable rather than a
  benchmark. Calibrated against a case with an exact known answer, and fails closed on
  every way of measuring nothing: an empty rule map, an empty corpus, an empty corpus
  file, an unknown entry rule, a grammar with no instrumentable choice, a `compose()`
  artifact, a missing or malformed or over-ceiling baseline, a changed corpus, and a
  stale baseline entry each throw or fail rather than reporting a clean zero.
  Known blind spots are documented in the module header rather than left to be
  discovered: only `firstMatch`/`sharedPrefix` choices are instrumented, non-choice
  backtracking is not attributed, an `autoNot` rejection reads as a success, and
  `unresolvedRoots` reports how much of the grammar the walk could not reach.

- **BREAKING: the gating diagnostic left the compile path. Compiling produces an
  artifact and says nothing.** Importing one example grammar (`examples/css/parser.ts`)
  printed **51 `console.warn` lines** — 36 of them gating advice — before a single byte
  was parsed. The advice was correct, detailed, actionable and read by nobody: it arrived
  unasked, in the middle of an unrelated build log, on a build that had not gone wrong. A
  diagnostic that rides along with the thing that produces the artifact is a diagnostic
  nobody chose to run. This is the principle already settled for codegen ("anything
  'diagnostic' doesn't end up in codegen") applied one layer up, at build time.

  Removed: the `gating` option on `compile` / `compileRuleMap` / `compileLinkable`, the
  `CompiledParser.gating` field, the `PARSEMAN_GATING` env var, the exported
  `GatingOption` and `GatingWarnLevel` types, and the implicit fuse-time run inside
  `compose()` / `composeLeaf()` and the macro transform. That import now prints **0**
  lines. Nothing is lost: `analyzeGating`, `analyzeGatingRules`, `analyzeGrammarGating`
  and `formatGatingWarnings` are unchanged, and the fuse-time question — a shared shape's
  `g.Foo` hole answered where it is BOUND — is exactly what `analyzeGrammarGating` already
  does on a `compose()` result.

  **Migration:** delete the `gating` option / `PARSEMAN_GATING` env var and call
  `diagnoseGrammar(g)` where you want the report — on the same grammar, at a moment you
  chose. `formatGrammarDiagnosis(d)` renders it; `process.exit(d.ok ? 0 : 1)` gates CI.

- **New: `diagnoseGrammar(grammar, opts?)` / `formatGrammarDiagnosis(d)` — the deliberate
  entry point.** Getting the full report on purpose is now strictly easier than getting it
  by accident used to be: **one** call takes a combinator, an array of `[name, combinator]`
  entries, a `rules()` map **or** a `compose()` result, so there is no prior decision
  between `analyzeGating` / `analyzeGatingRules` / `analyzeGrammarGating`. It is
  **machine-readable first** — a plain, JSON-serializable `GrammarDiagnosis` with a
  versioned `schema` tag, an `ok` boolean, a `summary` of counts, `findings` sorted by
  (severity, code, id) so two runs are byte-identical and a snapshot is diffable, and an
  `acceptSnapshot` ready to paste into `{ accept: [...] }`. The human rendering is a
  separate function over that object, never the primary product.

  It **fails closed**, which is the property a gate needs and a warning channel never had:
  `unanalysable` stays authoritative and every entry is a BLOCKING finding, an opaque
  precompiled contributing artifact blocks, and an analysis that THROWS is reported as a
  blocking finding rather than as an empty, clean-looking report (`diagnoseGrammar` itself
  never throws). So `process.exit(d.ok ? 0 : 1)` is the whole CI contract, and an empty
  finding list cannot be produced by a walk that saw nothing.

- **The `[parseman] degraded` channel deliberately did NOT follow it — but it aggregates
  now.** Gating advice is advice; a degradation is parseman reporting it could not do what
  you asked, and this release is named for not letting that be silent. Trading
  silent-degradation for silent-everything is not a fix, so all three drains stay loud: the
  macro plugin's normal drain (onto the bundler's own warning channel, where `error` fails
  the build), the macro plugin's ABORTED-transform drain (a `console.warn` from a `finally`
  — those findings have nowhere else to go and losing them is the exact bug the capture
  stack exists to prevent), and a runtime `compile()`, which is the developer-watching case
  and the only place `PARSEMAN_DEGRADATION=error` could ever be honoured.

  What changed is the SHAPE on the runtime path. It printed one full ~500-character line
  per site as each was found, with no aggregation, while the macro drain had always capped
  at eight per code and appended a counted summary. `pnpm perf:workloads` emitted **31**
  such lines for a single code. `compile()` now opens its own drain (a no-op when a macro
  sink is already open, so it cannot steal that module's findings) and reports one
  aggregated block: **9** lines, ending `+23 more site(s) not listed (31 total)`. `'error'`
  still fails, and now lists every finding instead of throwing on the first.

- **BREAKING: `parseman/oracle` keeps the projection and drops the harness.**
  `loadCorpus`, `digestCorpus`, `compareReports` and `formatComparison` are removed,
  along with the `Surface`, `CorpusEntry`, `SurfaceReport`, `IdentityReport`,
  `DigestOptions`, `SurfaceComparison`, `IdentityComparison`, `LoadCorpusOptions` and
  `LoadedCorpus` types and `HARNESS_DIGEST`. The test is whether something helps a
  grammar author who has never heard of your project, and corpus walking, aggregate
  digests, three-way verdicts and report formatting fail it: they only mean anything
  with one consumer's corpus roots and committed baseline in hand. What stays is
  `digestInto` / `digestValue` / `canonicalize` — deterministic serialization of ONE
  parse result, which every grammar author needs and no consumer can write correctly,
  since it is parseman's node shapes that decide which distinctions are semantically
  meaningful. `docs/guide/identity-oracle.md` now carries the harness discipline as
  guidance rather than as an API, and each item in it is there because something went
  wrong without it; jess's replacement is
  `packages/syntax/less/less-parser/test/identity-oracle/` and is a reasonable model
  to copy. Migrating: the report shape was never load-bearing on parseman's side, so
  a recorded aggregate stays reproducible as long as you fold the same fingerprints,
  in id order, over the same `OK:`/`ERR:`-prefixed digests.
- **Gate the code-size budget.** Parseman published a code-size expectation in its own
  guide and enforced it nowhere: `bench:size` existed in `package.json` and in zero
  workflows, while speed had two blocking gates. The published figure had drifted by
  roughly an order of magnitude on real grammars without anything going red. There is now
  a blocking `size-gate` CI job (`pnpm size:guard`) on the same footing as `workload-perf`,
  with two independent checks — a hard **10x raw-bytes ceiling** that no rebaseline can
  waive, and **1% drift** against a committed absolute baseline (`bench/size-baseline.json`)
  so growth cannot accumulate a couple of percent per commit. Raw bytes fail the build
  (they are what V8 parses at import); gzip and the LOC multiplier are baselined and
  reported, because a rising compression ratio at flat raw size means the output is getting
  more repetitive. The gate fails CLOSED on a missing/malformed/empty baseline, a missing
  fixture, a build failure, empty output, an unbaselined fixture, or a stale entry, and
  `test/unit/size-guard.test.ts` proves each of those exits non-zero.

- **A canonical size probe (`pnpm size:probe`).** The gated set no longer consists only of
  the three smallest example grammars — which are all within budget and always were, which
  is precisely why nothing caught the drift. It now also covers the larger and derived
  in-repo grammars (`css`, `lang`, `toml-ish`, and the `jsonc`/`jsonl` variants, none of
  which `bench:size` ever measured) plus a probe that isolates each cost driver separately:
  `node()` count scaling, `compose()` depth 1-3, `composeLeaf`, trivia on/off, and
  `hostMode` ast/cst. It measures the macro-lowered module rather than `compile().source`,
  because that is what actually ships. The probe is API-floor-tiered (`--tier=core|leaf|full`)
  and refuses to run rather than silently drop units a checkout is too old to support, so it
  doubles as a portable historical instrument.

- **Corrected the published code-size guidance.** The guide promised "roughly 4-8x the
  source lines". Measured across the full size range, generated size is **linear in
  `node()` call sites at ~5.8 kB each**, with an implied fixed overhead of about zero — the
  apparently superlinear multiplier is a denominator artifact, since dense grammars pack
  far more node sites per source byte. Source-relative ratios are also **not comparable
  between grammars that compose**. Both docs pages now carry measured numbers and say so.

  The gated set includes **multi-variant fixtures** (`variants-1/2/4`), which is the
  axis every previous size measurement was blind to. A grammar factory is usually
  compiled more than once — jess's css parser calls `composeLeaf` four times over the
  same pieces, varying only `trackLines` and `hostMode` — and **each variant is emitted
  as a full copy**: measured 1.98x for two variants and 3.92x for four. Verified in the
  shipped artifact, where `function _r_Stylesheet(` occurs exactly four times in a
  13,124,728 B file. Without these fixtures a fix worth ~4x on the real product would
  have moved this gate by exactly zero, which is the same blind spot that made the old
  "4-8x" budget look honest. The compression ratio climbing with variant count
  (5.3:1 -> 8.8:1 -> 12.7:1) is the tell.

  Failure output distinguishes **standing debt from fresh regressions**: fixtures already
  recorded `overCeiling: true` render as "KNOWN, TRACKED, BLOCKING" with the note that the
  release stays blocked, while a fixture that crosses the ceiling in the current change
  renders as "CROSSED THE CEILING" with its baseline ratio for contrast. Drift fires
  normally in both cases, and names whether the added bytes compress better (duplicated
  output) or worse (distinct content). Every failure names the fixture, the delta in
  bytes, and the action — including the largest measured lever rather than "make it
  smaller".

  The gate earned its keep on the first rebase: it caught `graphql` at +1.20% and
  `toml-ish` at +1.32% raw bytes against the baseline taken three commits earlier, with
  gzip up 9.21% and 6.92% respectively — i.e. compression got *worse*, so the added bulk
  is distinct content rather than more of the same. Both are recorded in the baseline.
- **Integrity fixes for the diagnostics this release is named for.** The
  "never degrade silently" channel had four holes, each of which made a real degradation
  invisible.
  - `confirmedBuildArity` answered a confident **`0`** for `function () { [native code] }`
    — how a bound function, a `Proxy` and every host builtin stringify. A confident answer
    never reaches `recordDegradation`, so the node silently dropped capture tiers: the same
    reducer, once direct and once `.bind(null)`, produced different ASTs from the same
    grammar with zero diagnostics. Unreadable source now answers `null` (unknown → full
    capture → degradation recorded). The `arguments` guard also moved above the
    empty-parameter-list case, where it had been unreachable.
  - The parameter-list parse used `[^)]*`, which stops at the first `)` — the one inside a
    function-typed annotation. `(children: (n: N) => N, fields) => …` was read as arity
    **1** instead of 2, silently under-capturing on ordinary TypeScript; a `,` inside type
    arguments (`Map<K, V>`) tore one parameter into unreadable fragments. Both are now
    parsed with a balanced scan, so they report 2 and 1 rather than a wrong number.
  - `beginDegradationCapture()` and its drain were not `try`/`finally`-paired, and the
    transform throws between them. One failed macro transform left the sink open for the
    rest of the PROCESS, so every later finding — including from an unrelated runtime
    `compile()` — went into an orphaned Map and printed nothing. The capture is now a
    stack (the transform re-enters itself for private source modules, and a single slot
    let the inner call close the outer module's sink), released in a `finally`, and
    whatever an aborted frame had collected is reported rather than dropped.
  - `PARSEMAN_DEGRADATION=error` was **inert** for a runtime `compile()`: the drain that
    threw lived only in the macro plugin, so library users got `warn` behaviour from a
    setting documented as "fail the build". It now throws at the record site when no
    capture is open.

- **Wire up the two declared degradation codes that could never fire.** `opaque-artifact`
  and `coverage-definitions-unavailable` were declared in `DegradationCode` with **zero**
  record sites — half the published vocabulary was decoration. They now fire from their
  real triggers (a composed grammar carrying compiled rule functions rather than
  re-lowerable IR; a coverage denominator that could not be read out of the generated
  hooks). A test asserts every declared code has at least one record site, and that a
  recorded finding actually reaches a drain under each mode.

- **An empty coverage set is no longer reported as 100% covered.**
  `GrammarCoverageSnapshot.ratio` computed `ordered.length === 0 ? 1 : …`, so a grammar
  whose definitions failed to load presented as fully covered and any consumer gate of the
  shape `ratio >= threshold` passed on zero evidence. The unmeasurable case is now `NaN`,
  which is false against every threshold, alongside a new `measurable: boolean`.
  Relatedly, `compiledGrammarCoverageDefinitions` rejected everything except the one input
  its error message names: `[].every(…)` is vacuously true, so an empty array passed
  validation. **Breaking:** `ratio` is `NaN` rather than `1` for an empty definition set,
  and `GrammarCoverageSnapshot` gains `measurable`.

- **Gate raw control bytes in source (`scripts/check-control-bytes.mjs`, wired into CI).**
  A raw `0x00` in a template literal makes the file BINARY to every text tool: `git diff
  --numstat` reports `-  -`, GitHub will not render the blob, and `grep -rn` skips it
  SILENTLY — no "binary file matches", no output, exit 0. `src/compiler/degradation.ts`,
  the largest new file of this release, was invisible to review because of it, and
  `src/combinators/choice.ts` had the same defect. This had already been fixed once in
  `src/analysis/`, so it is now gated rather than remembered. Both composite keys are
  built with `JSON.stringify` of the tuple instead of a magic delimiter — injective by
  construction, printable, and needing no argument about which characters cannot occur in
  a regex source or a verbatim slice of reducer text.

- **Never degrade silently.** Every path where the compiler picks a correct-but-slower
  option now reports on one channel, formatted `[parseman] degraded [<code>] <where>:
  <subject> — <fell back to>; otherwise <what>`. It is default-on (`PARSEMAN_DEGRADATION=
  off|warn|error`, mirroring `PARSEMAN_GATING`), surfaces through the macro's ordinary
  bundler warnings, and is greppable on the literal `[parseman] degraded` so a consumer
  gate can assert zero degradations. Findings aggregate per code above eight sites: a
  diagnostic that fires on every rule gets filtered out, which is the same silence.

- **Resolve NAMED node reducers before deciding capture cost.** `node('Foo', p, build)`
  where `build` is a name gave `buildSrc === "build"`, which matches no parameter list, so
  `confirmedBuildArity` returned `null` and the node captured children, fields and raw
  children, logged trivia, and cloned `_ctx.state` on every match — making a rule's
  runtime cost depend on how its reducer was spelled, with no warning. The macro plugin
  now performs real lexical scope analysis over the module and follows imports across
  module boundaries, so all of these resolve: module-scope `const`/`function`, `let`/`var`
  that is never reassigned, alias chains, named / aliased / default / namespace-member
  imports, and re-exports including `export *`. Parameter lists are read from the AST, so
  defaults and destructuring count positionally (`(c, f = undefined, s, r)` is arity 4).
  Shadowing is decided rather than declined. Measured against the four jess grammars: 54
  of 54 named-reducer sites resolve, none still fail open.

- **Add `node(..., { buildArity })`.** The escape hatch for the shapes that remain
  genuinely undecidable — a rest parameter, a body reading `arguments`, a reassigned or
  computed reducer, an unresolvable import. Declaring the arity turns fail-open into a
  true last resort instead of a common outcome; a declaration is authoritative.

- **Stop deleting a node's first-set guard for a zero-arity reducer.** The `node()`
  first-set pre-guard was gated on `capturesChildren || structural`; a confirmed
  zero-argument `() =>` reducer clears that flag and so removed the guard entirely. CST
  mode forces the flag true, so the loss was `'ast'`-only. The gate is now
  `needsFirstSetGuard` alone, matching the `choice`/`many`/`attempt` guards.

- **Admit TypeScript-annotated parameters in the inline-`mk` shape**, and report a
  near-miss as `mk-inline-missed` rather than silently paying a `_build[n](...)` call per
  match.

- **Apply `cstBuildHost({ collapse })` to host-built nodes that carry reducers.** The
  collapse check was emitted for structural node defs only. Under `hostMode: 'cst'` a
  direct builder is bypassed and the node is built by the host exactly like a structural
  one — but every rule in a real grammar carries a reducer, so none was structural and the
  predicate was never consulted (measured across four jess dialects: `predicateCalls === 0`
  and zero occurrences of `_parsemanCstCollapse` in the built artifacts). A documented
  option silently did nothing for every CST consumer. Fixed identically in the interpreter
  and the compiler.

- **BREAKING — remove the unused offset-model trivia surface.** `OffsetIndex`,
  `buildOffsetIndex`, `collectLeafSlots`, `gapText`, `lineBreaksIn`, `blankLinesIn`,
  `lineStartWithin`, `indentWidth`, `indentMixed`, `commentsIn`, `gapIsSignificant` and
  the `Slot` / `Gap` types are gone from the main entry, along with `src/cst/offset-model.ts`.
  It was a THIRD trivia model — proposed as the "drop-in replacement" for
  `buildTriviaIndex`, never adopted by anything, referenced by no other module, absent
  from the docs, and covered only by its own two test files. The sparse `rootTrivia`
  capture added above is the model parseman actually took. Shipping three trivia models,
  two of them unused, makes the real one harder to find. **Migration:** none is needed —
  nothing in the ecosystem imported these. If you did, the gap arithmetic is
  reconstructible from any leaf's `span`, which is what the module did internally.

- **BREAKING — remove the deprecated `guard()` alias.** It has forwarded to `gate()`
  unchanged since the rename. **Migration:** `guard(pred)` → `gate(pred)`, a pure
  rename with identical behaviour. The FAILURE LABEL is still the string `'guard'` —
  that is the combinator's internal tag and compiled output depends on it, so it is
  deliberately unchanged and now pinned by `test/unit/gate.test.ts`.

- **Say so when a removed field is read.** Dropping the mandatory
  `RunResult.triviaMap` made it read `undefined` — and `undefined` travels, so the
  failure surfaced as a property access on nothing, deep inside the CONSUMER's
  code, in a message naming neither parseman nor the replacement. (Measured on
  jess: every `parse()` threw `Cannot read properties of undefined (reading
  'labels')`, six of nine gates red, with no mention of the removal anywhere.)
  The name is now an accessor that throws the migration — what went, what
  replaces it, and the `rootTrivia: { select: [...] }` call needed to get it. The
  property is non-enumerable, so it is absent from `Object.keys`, spreads,
  `JSON.stringify` and identity digests: no output moves and the parse path is
  unchanged. Same principle as the degradation diagnostics — parseman must give
  notice when it cannot do what a caller expects.

- **Read the root trivia log once per sequence boundary, not six times.** 0.44.0's
  sparse root-trivia capture added a mark/rollback around every sequence item in the
  NON-CAPTURING compiled path, and it re-loaded `_ctx._triviaLog` for each of its three
  jobs — taking the mark, computing the scanner's `_cap` argument, and deciding the
  rollback — for six property loads per boundary. Root trivia is OPT-IN, so every parse
  that never asked for it paid all six to re-prove the same field `undefined`. The load
  is now hoisted to one binding per site (284 → 49 loads in the compiled GraphQL
  workload). Hoisting is sound only because the mark and the rollback bracket ONE
  sequence item: `_ctx._triviaLog` is reassigned at nested-grammar boundaries, but that
  save/restore returns the same reference before control reaches the rollback, which is
  on the item's success path. A function-wide hoist would NOT be sound.

  This is what `perf:workloads` was reporting on `graphql/document`. That row had been
  drifting against the pinned v0.35.0 reference since 0.44.0 — it breached one of three
  passes on `main` and on `release/0.44.0-root-trivia` before this release branch
  existed — and tipped to a majority here. Measured, `--only=graphql`, three passes,
  load average 6.7–7.6: before `median +0.3% … +1.7%`, won 4/12 2/12 5/12; after
  `median −4.1% … −1.0%`, won 9/12 8/12 7/12. `json/document`, the other non-capturing
  workload, moves `−6.0% … −2.7%` → `−17.1% … −11.6%`. The capturing path (`less/*`,
  `css/*`) is untouched.

- **Stream the canonical oracle digest instead of materialising it.** `digestInto`
  folds each corpus entry into the running hash as it is produced, so the harness no
  longer retains the whole corpus in order to hash it at the end.

- **Take the oracle digest OUTSIDE `payload()`'s `try`.** A projection failure used to
  be caught and folded into the fingerprint, so a broken projection was recorded as a
  value rather than raised. **This moves fingerprints, and the harness guard cannot see
  it.** Any corpus entry whose stored baseline recorded a masked projection failure
  changes both its fingerprint and the report's `threw` count (demonstrated end to end:
  `threw 1 → 0`, the entry moved). `HARNESS_DIGEST` did NOT move with it, because the
  frozen canary corpus contains no entry that fails projection — so `compareReports`
  returned `moved`, reporting a HARNESS change in the vocabulary of a grammar change.
  That is the exact failure the three guarantees above `HARNESS_DIGEST` claim to make
  impossible. Fixed by giving the canary an entry that fails projection, so the harness
  digest moves when this decision changes and an old report is correctly refused as
  `incomparable` instead of being silently mis-compared. **Re-baseline any stored oracle
  report taken before this release**; a `moved` verdict across it is not a grammar
  regression.

- **Raise `CanonicalBudgetError` on an oversize walk**, rather than growing without
  bound, and **reject a non-finite `maxVisits`**. The budget is spent with
  `if (--state.visits < 0)`; `--NaN` is `NaN` and `NaN < 0` is `false`, so
  `maxVisits: NaN` — or any non-finite number — disabled the budget entirely and
  restored the unbounded walk the option exists to prevent. `newState` now requires a
  finite, non-negative integer.

- **Document `digestInto`'s two sharp edges.** It leaves a caller-owned hash partially
  written if the walk throws, and two calls against one target concatenate with no
  delimiter — so `digestInto(a, h); digestInto(b, h)` can collide with a single call
  over a differently-split pair. Both are now stated at the call site, and the flush
  test covers an astral-plane label, which is the surrogate-splitting hazard the
  streaming change is justified by.

## 0.44.0 — 2026-07-30

- **Add sparse, selected root trivia capture.** `run(entry, input, { rootTrivia:
  { select } })` records only markers for the named, grammar-defined trivia
  labels. Each fixed-width row also carries its complete authored owning range, so
  serializers can still reproduce the surrounding gap without retaining one root
  entry per whitespace run. Labels are arbitrary grammar policy — `blockComment`,
  `lineComment`, `pragma`, or a formatter-specific `significantNewline` are equally
  valid; ordinary whitespace remains implied by source offsets unless explicitly
  selected.

- **Keep selected capture correct across every parser form.** Rejected choice and
  `attempt` arms, `optional`/repeat tails, `sepBy`, lookahead, recovery probes,
  composed grammar factories, macro-fused artifacts, and AST/CST host modes all
  roll the sparse sink back transactionally. Semantic `leaf()` wrappers retain
  selected root markers, and selected row kind indexes use the requested label
  table rather than a scope-local label order. The result is exposed as
  `RunResult.rootTrivia`, whose `.index` provides the lazy query interface.

  **BREAKING, and previously mis-documented here.** This entry used to claim a
  `selectedKinds` option and that "legacy `triviaLog` remains available under the
  default `allEntries` mode". Neither exists: the option is `select`, there is no
  `allEntries` mode, and `RunResult.triviaLog`, `RunResult.triviaMap` and
  `RunResult.triviaKindLabels` are all GONE — root trivia is captured only when
  asked for. Reading any of the three now throws with its migration rather than
  returning `undefined`.

## 0.43.0 — 2026-07-30

- **Add CST tags and grammar-aware visitors.** `node(..., { tags })` can now
  declare category metadata for a CST node type, and `createVisitor(grammar, spec)`
  dispatches by concrete `type`, declared `tag`, plus `enter` / `leave` hooks.
  The visitor reads grammar reflection from interpreted, compiled, macro, and
  composed grammars, so consumers can share one traversal shape across engines.

- **Keep CST tag materialization explicit.** Tags stay in grammar reflection by
  default so normal CST output remains `{ _tag, type, span, state, children }`.
  Consumers that want self-describing JSON can opt in with
  `cstBuildHost({ tags: true })`, which reuses the rule's static tag array instead
  of allocating a fresh array for every node.

## 0.42.1 — 2026-07-28

- **Make line-aware macro artifacts ergonomic.** `rules({ trackLines: true }, factory)`
  now produces line/column-enriched compiled rule-map output under the macro, while
  `rules(factory)` keeps the default artifact free of line-tracking code.

- **Support entry modules over one imported grammar factory.** A macro entry can
  import a source-private factory normally, then apply `rules(...)` settings at the
  entry point. This lets packages publish standalone normal and diagnostic artifacts
  from one authored grammar source, and the same factory-derived artifact works when
  fed into macro `compose()`.

## 0.42.0 — 2026-07-28

- **Add optional parse-time line and column tracking.** Parsers can now opt into
  `trackLines` to populate `startLine`, `startColumn`, `endLine`, and `endColumn`
  on parse spans. CST nodes and leaves receive line/column fields as their spans
  are created, and `node()` builders receive the same enriched span so AST builders
  can carry source locations without a second full-tree pass.

  The default path stays offset-only: compiled parsers emit no line-tracking helper
  code unless `compile(..., { trackLines: true })` is requested, and interpreted
  parsers keep the previous trivia/terminal fast paths when tracking is off.

- **Track line starts incrementally for skipped and scanned regions.** The opt-in
  tracker records newline offsets with an append-only high-water cursor, then
  derives line/column from that index when spans are materialized. Generated
  parsers specialize fixed newline literals, skip dynamic tracking for terminals
  proven newline-free, and backfill newline offsets for trivia, `scanTo`, regex
  spans, and recovery-skipped error ranges before diagnostics are annotated.

- **Keep post-parse span annotation as a convenience path.** `buildLineIndex`,
  `annotateSpan`, and `annotateTreeSpans` remain available for already-built trees,
  but parse-time `trackLines` is the efficient CST/AST integration path.

- **Refine regex newline capability analysis.** Regex first-set analysis now tracks
  whether a successful match can consume a newline anywhere in the pattern, including
  negated character classes such as `[^,\r\n]*`. Generated line tracking uses that
  signal to avoid scanning spans that cannot contain line breaks.

## 0.41.0 — 2026-07-27

- **Fix: compiled rule-map entries now expose ambient trivia labels to `run()`.**
  A `compileRuleMap(..., { trivia })` output bakes labeled trivia capture into every
  compiled root, but ordinary public rule wrappers did not carry the trivia rule's
  `triviaKindLabels`. Calling `run(map.Root, input)` therefore returned the right
  flat root log but decoded it as unlabeled stride-2 entries instead of labeled
  stride-3 entries. Public wrappers now inherit the ambient grammar trivia label
  table unless the rule has its own label table, and the same wrapper helper is
  used by `compileRuleMap`, `compileLinkable`, and macro/fused outputs. The
  regression covers interpreter, direct compiled-map, and macro/fused `run()` paths.

- **Add sparse root trivia gap queries for AST integrations.** `run()` already
  returns `result.triviaMap`, a lazy index over the flat root trivia log. That
  index now also exposes `gapBefore(offset)`, `gapAfter(offset)`, `gaps()`, and
  `gapsWithKind(kind)` so downstream AST builders and serializers can query
  contiguous trivia gaps directly instead of rebuilding Parseman's number log
  into a second parser-specific map.

  `RootTriviaGap` values keep entry indices into `triviaMap.entries`, expose
  `hasKind(label)` for labeled trivia arms, and slice source text only on demand
  with `gap.text(input)`. The existing `before` / `after` maps and
  `entryIndicesBefore` / `entryIndicesAfter` methods remain intact for consumers
  that want the lower-level entry-index view. The helper stays in
  `cst/trivia-entries.ts`, preserving the small import closure of
  `parseman/run`.

- **Dispatch/codegen polish for shared-opener grammars.** Generated dispatch code now
  recognizes simple tail-only reducers such as `([, tail]) => tail`, keeps same-body
  `routed()` branches in locals instead of round-tripping through `_ctx._routed`,
  hoists `matches(...)` predicates into shared regex declarations, and tightens
  rollback around routed selector capture and `sepBy` field capture. The public
  dispatch API is unchanged; these are generated-code and macro-output improvements
  for the `dispatch(selector, when(...), otherwise(...))` shape introduced in the
  previous minor line.

- **Refresh dispatch-vs-choice performance evidence for broad shared openers.**
  `pnpm bench:dispatch` now tracks identifier/function, specific-plus-generic
  function, matcher, multi-branch identifier, and at-rule workloads. The note at
  `notes/PERF-dispatch-vs-choice.md` records the current directional evidence and
  explicitly marks matcher-heavy and mostly-specialized cases as tracked rather
  than hard win gates.

## 0.40.0 — 2026-07-26

- **Add declarative `node(..., { project: index })` semantic child projection.**
  Projection covers AST rules that recognize syntax scaffolding a CST host must still
  see while the semantic AST value is one captured child. For example,
  `node('Paren', sequence(literal('('), Expr, literal(')')), { project: 1 })`
  returns `Expr` in AST mode while `hostMode: 'cst'` still gives the positioned-CST
  host the full child/raw/trivia frame, including both parentheses.

  This is deliberately an extension of `node()` rather than a separate value-wrapper
  combinator: `node()` already owns CST capture, host-mode selection, IR serialization,
  coverage, trace, and generated specs. The option is plain serializable data, so macro
  lowering and composed grammar IR do not need direct-builder callback source just to
  drop punctuation. Projected leaves unwrap to their string value; projected sub-nodes
  are returned as-is. More dynamic shapes such as "first value child", filtered child
  lists, exact CST-leaf projection, or token-string reconstruction remain normal
  `build` callbacks.

  The interpreter, runtime compiler, macro evaluator, coverage rebuilds, and IR
  serializer understand the option. TypeScript infers a projected sequence slot when
  the index is a literal, so a punctuation wrapper around a typed sub-rule preserves
  the sub-rule's `Combinator<T>` result type.

  Perf note: this is a bytecode/allocation cleanup for grammars that replace trivial
  direct builders with projection, but this release does not claim a parser speedup.
  The benchmark note in `notes/PERF-node-project.md` records a focused callback-slot
  check and the remaining caveats.

- **Add Context7 documentation authority metadata.** `context7.json` points at
  the Parseman docs site so connected documentation tools can resolve the published
  docs source without a repo-specific prompt.

- **Add dispatch-vs-choice performance evidence for shared-opener grammars.**
  `pnpm bench:dispatch` now compares equivalent at-rule-shaped `choice` and `dispatch`
  grammars and records a media-feature head fixture for the `(width >= 50em)` vs
  `(min-width: 50em)` scannerless-routing docs story. The normal suite checks
  correctness and diagnostic shape; opt-in timing stays outside the hard release gate.
  The evidence note is `notes/PERF-dispatch-vs-choice.md`.

## 0.39.1 — 2026-07-26

- **Extend `dispatch` with case-insensitive cases, matcher keys, and
  `routed()`.** `when(key, tail, { caseInsensitive: true })` and
  `makeWhen({ caseInsensitive: true })` route from the parsed value while
  preserving the authored text. `when(startsWith(...))`, `when(endsWith(...))`,
  and `when(matches(...))` provide ordered matcher buckets for broad lexical
  families.

  `routed()` is a contextual combinator for branch nodes. `dispatch` consumes
  its first combinator once; a selected branch that contains `routed()` starts at
  the original dispatch position, and `routed()` places the already-consumed
  value/span inside that branch. This lets grammars express lexical routing,
  fallback behavior, and CST/AST ownership in one grammar shape, without
  speculative parsing or handwritten semantic rewiring.

  Dispatch arms are included in grammar coverage and trace output. Traces show
  only the selected route; excluded arms are not reported as attempted or
  backtracked. Macro lowering, serializable IR, and generated EBNF/railroad
  specs all understand exact keys, matcher keys, case-insensitive routing, and
  `routed()` branch ownership.

## 0.39.0 — 2026-07-26

- **Add `dispatch(combinator, when(...), otherwise(...))` for token-once static
  routing.** Use this when one broad combinator is valid generally, and selected
  values have specialized continuation grammars. CSS at-rules
  are the model case: every at-keyword is an at-rule name, while `@media`,
  `@scope`, `@layer`, etc. each require a specific prelude/body shape.
  `dispatch` parses the combinator once, chooses a static `when(key, tail)` /
  `when([keys], tail)` arm by returned value, and runs `otherwise(tail)` only
  when no key matches. A matched key's tail failure is committed, so it does not
  fall through to `otherwise` or an outer `choice` fallback.

  The interpreter, `compile()`, macro evaluator, IR serializer, coverage walks,
  first-set analysis, field/trivia walkers, and grammar-quality diagnostics all
  understand the new combinator. Macro-compiled `rules()` factories may also bind
  `when()` / `otherwise()` arms to local `const`s before passing them to
  `dispatch(...)`, matching the normal combinator-authoring style. V1
  intentionally keeps classification simple: the returned value must already be
  the dispatch key string, and the macro path supports explicit arm arguments
  rather than `dispatch(combinator, ...arms)` spread tables. Classifier callbacks,
  spread-arm tables, and pattern cases remain future design work.

## 0.38.0 — 2026-07-26

- **`makeWord()` carries the same explicit `caseInsensitive` option as
  `word()` and `keywords()`.** Use `makeWord(boundary?, { caseInsensitive: true })`
  or `makeWord({ caseInsensitive: true })` to define a whole keyword family once,
  while the default remains case-sensitive everywhere. The direct `word()` overloads
  also support both `word(str, boundary, opts)` and `word(str, opts)`, so a single
  keyword and a family factory share the same option shape.

  The macro evaluator understands both forms, including chained
  `makeWord(...)(str)` calls and factories bound inside `rules()` bodies, so
  macro-compiled grammars do not have to fall back to `regex(/kw/i)` for
  spec-defined case-insensitive keyword families.

- **Fix: rule aliases remain by-name references through `compose()` and the
  macro compiler.** A `rules()` factory can naturally expose one rule as a
  transparent alias for another, such as `small: g.Value`. Aliases keep their own
  public rule slot while targeting the referenced rule by name, so later composed
  overrides still flow through the alias. A direct self-alias such as `A: g.A`
  fails immediately instead of lowering to a recursive call to itself.

## 0.37.0 — 2026-07-25

- **Compile-time host mode reaches the MACRO — `rules({ hostMode })`, and two artifacts
  from one grammar source.** 0.40.0 made host mode a compile-time decision, which is what
  keeps the eval-AST artifact free of per-node host probing. But `src/plugin/index.ts`
  called `compileRuleMap` / `compileLinkable` with `{ trivia, scanSkip, recovery, coverage }`
  and never passed `hostMode` — so a macro-built grammar was **always `'ast'`**, and the
  macro is how a real grammar package is built. The feature was unreachable exactly where
  it was needed: "ONE grammar source, two compilations" could not be written down.

  ```ts
  const factory = (g) => ({ … })                              // written ONCE
  export const grammar    = rules({ trivia: rw }, factory)
  export const cstGrammar = rules({ trivia: rw, hostMode: 'cst' }, factory)
  ```

  Two call sites over one shared factory. The macro emits two independent top-level
  artifacts, so each bundle **tree-shakes away the one it does not import** — the compiler
  ships the AST image, the language service ships the CST image, and neither pays the
  other's cost. Each image is compiled exactly as it is today; nothing became switchable
  at runtime, which is the point.

  A single runtime-switchable artifact was the alternative and is deliberately NOT what
  this does. `hostMode` does not merely select a build expression: `cstOut` drives
  `capturesTrivia` / `clonesState` / `capturesChildren` / `capturesRaw` / `capturesFields`.
  Deciding per parse means every collector stays live on both paths, so the AST parse pays
  CST capture — the per-token `cstTriviaLog` push that is ~28% of a real jess parse, and
  the cost 0.40.0 existed to remove.

  `hostMode` is threaded the way `trivia` and `scanSkip` already are: the plugin stamps
  `_meta.grammarHostMode`, and all three lowering paths (`compile`, `compileRuleMap`,
  `compileLinkable`) fall back to that stamp. That is the pattern this file's own comment
  recommends, because a per-call-site option gets forgotten — and forgetting THIS one is
  silent, not slow. `compose()` picks the mode up from its pieces with no explicit option.

  Supporting change: a `rules()` factory may now be given **by name**
  (`rules(opts, factory)` where `factory` is a module-level `const`). Without it the shared
  factory reports "isn't statically evaluable" and falls back to the interpreter, and the
  only way to write the two-artifact pattern would be to duplicate the whole factory.

- **Fix: a macro-emitted `rules()` map carried NO host-mode stamp, so every driver-side
  host check passed vacuously.** `fuseRules` (the runtime fuse) stamped
  `parseman.fusedHostMode` / `fusedHostElided`; `emitFusedSource` (the macro fuse) and
  `compileRuleMap` did not. `assertHostModeCompatible` reads exactly those symbols, so an
  unstamped artifact reads as `{ mode: 'ast', elided: false }` and passes every check.

  This is not theoretical. Found in jess: giving a CST grammar's `Declaration` rule a
  direct builder made `parseCssCst('.a { color: red }')` return a Ruleset with **no
  Declaration child** and `ok: true` — the builder's own object is not a CST child, so the
  host's filter dropped it. 0.40.0's guard was supposed to make that loud and could not
  see it. Both fuses now stamp from inside `fusedBody`, so they cannot label the same
  artifact differently, and the mixed-mode rejection moved there too — `emitFusedSource`
  had never had it.

- **Fix: `run()` never checked host-mode compatibility.** The assertion ran from
  `parseDoc` and from a compiled parser's `parseWithContext`, but `run()` is the entry a
  one-shot CST parse uses. It is handed a RULE, not the registry, so it had nothing to
  read the mode off; the fused rule functions now carry the stamp themselves (set once at
  fuse time, before any call, so no per-parse cost).

  The INTERPRETER passes `elided: false` and that is not a shortcut: it has no compile
  step, re-decides the host route per parse, and has never dropped a branch. Only its
  `'cst'`-without-a-host half can be wrong.

- **Internal.** `HostMode`, the two fused-map symbols and `assertHostModeCompatible` moved
  to `src/cst/host-mode.ts`. The DRIVER has to enforce this contract and cannot import the
  compiler to reach it — and a second copy in the driver is how the two engines drift. The
  module is import-free by design, so the `parseman/run` closure grows by exactly one leaf
  module and still builds no grammars; `test/unit/run-entry-closure.test.ts` records that
  as a deliberate decision rather than absorbing it.

  Perf: no rule body changed — the added statements run at fuse/module-init time only.
  `perf:guard:grammars` ok on all 7 cases; `perf:workloads` ok on all 5, breached 0/3.

- **`parseman/oracle` — an AST-identity oracle for grammar refactors.** Digest a
  corpus through your parse entry points before and after a change and compare:
  identical digests mean the cleanup is output-neutral, different ones mean it is a
  semantics change rather than a refactor. Collapsing duplicated rules becomes an
  accept/reject instead of a judgement call.

  `digestCorpus` takes named surfaces — declare the interpreter and the compiled
  artifact together and the one you did not edit is a free control — and hashes
  thrown errors and returned failures alongside successes, so a rejection quietly
  becoming an accept is caught. `loadCorpus` throws on a root that does not resolve
  rather than returning a smaller, greener corpus, and entry ids are relative to an
  explicit base so two machines agree.

  The projection separates what `JSON.stringify` collapses — `{a: undefined}` from
  `{}`, `NaN` from `null`, `-0` from `0`, `Map`/`Set` from `{}`, and two node
  classes with the same fields — while ignoring property insertion order, which
  refactors churn and no consumer observes. A shared subtree is written out twice
  rather than reported as a cycle, so a DAG's digest does not depend on traversal
  order.

  A digest that moves because the HARNESS changed rather than the grammar would be
  worse than no oracle, so every report carries a behavioural fingerprint of the
  projection, `compareReports` refuses to compare reports that disagree on it, and
  the suite pins it to a literal. A nondeterministic grammar is diagnosed rather
  than hashed.

  Node-only, and a separate entry point: nothing here reaches the browser-capable
  `parseman` bundle. See `docs/guide/identity-oracle.md` and
  `docs/design/grammar-refactor-gates.md`.

- **Internal.** `docs:verify` now redirects subpath imports (`parseman/spec`,
  `parseman/oracle`, …) at the TS source, so a doc example for a secondary entry
  point can be checked at all.
- **Fix: the INTERPRETER still handed a positioned-CST host the collectors of the
  builder it replaced.** The compile-time host mode below settles this for the compiled engine
  (`hostMode: 'cst'` captures unconditionally). The interpreter has no compile step and
  was still eliding per-node capture from the DIRECT builder's formal arity — so under a
  `_parsemanCstOutput` host, an arity-1 `children => …` builder (which is nearly all of
  them) handed the host an **empty `triviaLog` and absent `fields` and `state`**. Nothing
  errored, and an empty trivia log is indistinguishable from a node that genuinely had
  none, which is why it survived.

  The interpreter now re-decides per parse what the compiled engine decides per
  compilation, and `test/unit/interpreter-host-capture.test.ts` pins the two engines to
  each other — a fix reaching one engine and not the other fails there. Assertions
  compare against a STRUCTURAL control (the same grammar on the path that was always
  gated correctly) rather than against a hand-written expectation.

  Scope note: this is the surviving half of a larger change. The other half — per-node
  runtime gating in codegen — is **not** needed, because `hostMode` removed the runtime
  question entirely. **Zero lines of `src/compiler/codegen.ts` changed here**, so the
  generated code is byte-identical to the host-mode entry below and the emitted hot path is untouched.

  That is also the cleanest available confirmation of the host-mode root cause. The earlier
  attempt at this fix destabilized `css/stylesheet` (readings from −36% to +74%) because
  it gated capture at parse time on every node. Rebuilt on top of the compile-time gate,
  the same correctness fix costs nothing: `perf:guard:grammars` ok on all seven cases,
  `perf:workloads` ok with `css/stylesheet` at min **−9.2 … −4.7%, won 8–9/12, breached
  0/3**. The runtime gate was the perturbation.

- **Host mode is now a COMPILE-TIME decision.** A `node()` with its own `build` is
  re-routed through a positioned-CST `ctx.build` host when that host marks itself
  `_parsemanCstOutput` — that is what lets ONE grammar serve the eval-AST consumer and
  the positioned-CST / language-service consumer. But `ctx.build` arrives at PARSE time,
  so every direct node in every grammar carried
  `_ctx.build?._parsemanCstOutput === true ? host : build` on its hot path, plus the
  `_dcst` probe gating its collectors — for a branch an eval-AST parse can never take.

  ```ts
  compile(g, { hostMode: 'cst' })
  linkable(map, ns, trivia, 'cst')
  compose(items, { hostMode: 'cst' })
  ```

  - `'ast'` (default) — direct builders own their result and the **host branch is not
    emitted at all**. Capture follows the builder's arity, exactly as before. (Precisely:
    `_dcst` is still emitted in this mode — what changed is that it binds a hoisted
    boolean local, `_cap`, instead of the `_ctx.build?._parsemanCstOutput` property
    chain, so it is no longer a host probe. In `'cst'` it is not emitted at all, because
    the collectors are unconditionally live. An earlier draft of this entry described
    that backwards.)
  - `'cst'` — direct builders always build through the host, and children / rawChildren /
    triviaLog / fields / state are captured unconditionally. Nothing to probe either way.

  One grammar source, two compilations — instead of one artifact asking, per node, per
  parse, which consumer it has. This is the same shape as the existing
  `compile(g, { recovery: true })` gate: a compile flag, off by default, that decides
  what is EMITTED rather than what is tested at runtime.

  **Structural nodes are deliberately unchanged.** `node(parser)` with no build callback
  is the documented "the host builds it" contract and is genuinely a per-parse choice, so
  it keeps its runtime `ctx.build` and its `_hostReads` arity gates. An all-structural
  grammar is unaffected by this release.

  **Silence stays unreachable.** `assertHostModeCompatible` runs ONCE per parse from
  `parseWithContext` and `parseDoc` — never from generated code — and throws, naming the
  fix, when an artifact that dropped a direct builder's CST branch is driven with a
  positioned-CST host, or when a `'cst'` artifact is driven without one. It is precise
  rather than merely conservative: `hostBranchElided` records whether a direct builder's
  branch was actually dropped, so an all-structural artifact still serves a CST host in
  either mode and never trips the check.

  MIGRATION: driving a compiled/fused artifact that contains direct builders with
  `cstBuildHost` now requires compiling that artifact with `hostMode: 'cst'`. The error
  message names the change. The interpreter (`run`, `parse`) still routes dynamically.

- **Fix: an incremental reparse diverged from a fresh parse on `state`.** A CST node
  stores `state ?? null`, and `Doc.edit()` fed that `null` back into the next parse. The
  state-clone guard tests `!== undefined`, and `Object.assign({}, null)` is `{}` — so a
  reused subtree carried `state: {}` where a fresh parse carried `null`. Normalized at
  the single seeding site. Reachable only once direct builders clone state, which
  `'cst'` mode makes them do.

- **Perf note, and an unresolved disagreement between two ways of measuring it.** In
  `'ast'` mode the emitted code is strictly smaller and does strictly less per node: the
  CSS and Less workload grammars compile to **10,734 fewer bytes**, with one fewer
  property chain and no dead host branch per direct node.

  **What the gate said, and what the trusted method said — both belong here.**

  `perf:workloads` reports `css/stylesheet` at **+15% … +29%, breaching 3/3** on an idle
  machine, while the same working tree read **clean (breached 0/3)** twenty minutes
  earlier and `main` reads stable clean. No threshold was widened.

  Measured **cross-process** (one fresh process per side, order alternated, output
  retained), `ac4da09` → `c4804a3` over **15 rounds**:

  | statistic | pre-host-mode (`ac4da09`) | host-mode (`c4804a3`) | delta |
  | --- | --- | --- | --- |
  | mean of round medians | 1.7692 ms | 1.6940 ms | **−4.3%** |
  | median of round medians | 1.8380 ms | 1.6475 ms | −10.4% |
  | mean of round minimums | 1.3018 ms | 1.2659 ms | −2.8% |

  The host-mode side won **9 of 15** paired rounds. An earlier 12-round batch read −10.1% median /
  −3.6% min / 9-of-12. This release was merged on the cross-process reading, over the
  gate's — deliberately, and that judgement is the record, not the favourable number
  alone.

  Three lines of evidence therefore disagree with the gate: the generated code is
  smaller and does less; the gate's own verdict flips between runs on identical input;
  and cross-process measurement reads neutral. Note that `perf:workloads --self` is clean
  here and does **not** cover this case — identical sides produce identical code images,
  and the artifact appears to arise from two DIFFERENTLY-SIZED images sharing one heap
  and one JIT profile. See `docs/design/perf-harness-interleaving.md`.

  No threshold was widened and the gate's number is recorded as it stands.

- **New: `structure-loss` — an arm that FLATTENS what its sibling structures.** The
  quiet counterpart to `shadowed-arm`. That finding catches an arm that can never
  run; this one catches an arm that runs when it should not have and produces a
  SHALLOWER tree than the sibling it intercepted.

  The shape is a "fast path" placed first in a `choice`: same `node()` type as the
  arm below it, overlapping first characters, and a body containing no `node()` at
  all. Found in a real Less grammar, where a single-numeric-value declaration arm
  sat ahead of the ordinary one — so `margin: 0px` produced a `Declaration` with no
  number node while `margin: 0px 0px` produced two. The commonest shape in CSS was
  the one that lost its structure.

  Nothing else reports this. Both inputs parse, both spans are right, both
  round-trip to the same text, and the emitted CSS is identical — so a suite that
  asserts *does it parse* stays green and so does a corpus diff. It surfaces only in
  whatever reads the tree: an editor lint keyed on the number node, a formatter, a
  rename.

  The finding names the flattening arm, the arm it shadows, the characters the
  shadowing bites on, and the node types deleted, and prints as
  `parseman BUG [structure-loss]`. Refs are followed, because the structure usually
  lives behind one (`g.valueList`) and an analysis that stopped at the ref would
  report a structured grammar as flat. `leaf()`/`token()` are opaque: they collapse
  their interior on purpose, so a `node()` inside one does not count.

  Two deliberate limits keep it a signal rather than a lint. Only the EMPTY case
  fires — "earlier arm is poorer than later arm" is the same family, but grading it
  means comparing two ref-reachable type sets, and in a recursive grammar the later
  set reaches most of the grammar, so the graded rule would fire on nearly every
  pair. And a GATED arm is never reported: a runtime predicate is a deliberate
  branch, not a shadow.

  This is the ordered, consequential half of `divergentNodes`, which reports two
  productions building one type and expressly allows *"a fast path tried first"*.
  `structure-loss` is the case where that defence is the bug.

  Docs: [Grammar duplication](docs/guide/grammar-duplication.md#the-third-bug-class-an-arm-that-flattens-what-its-sibling-structures).

- **New: `analyzeDuplication()` — a structural duplication / overlap / rewrite
  diagnostic.** A parseman grammar is a combinator tree, so "did I write this
  production twice?" has an exact answer. Finding it by reading does not scale: a
  few hundred productions is tens of thousands of pairs, and the reference grammars
  turn out to carry a comparison terminal spelled seven times, a character class
  spelled eleven ways across 80 terminals, and 39 hand-rolled separated lists.

  Nine families (`structureLoss` is the entry above), all located by rule name and
  structural path: `rewrites`
  (mechanical algebra — `choice(sequence(A, B), B)` → `sequence(optional(A), B)`, a
  hand-rolled `sepBy`, idempotent nesting, and the two dead-arm BUGS
  `duplicate-arm` / `shadowed-arm`), `divergentNodes` (one `node()` type built by
  several productions that share terms), `nearDuplicates` (subtrees identical
  except at one slot — the clone family), `duplicates`, `regexFragments` (an
  alternation run re-spelled across terminals), `regexClasses` (character classes
  re-spelled, with near-identical spellings grouped so the DRIFT is visible side by
  side), `keywordRegexes` and `overlaps`.

  Two things it deliberately does not do. It does not claim rewrites are safe: only
  the dead-arm findings (and unwrapping a one-arm `choice`) are `astNeutral`, and
  every other rewrite changes the child array the site produces, so it says
  *candidate — verify AST identity* and names
  the enclosing `node()`. And it does not report a count where a verdict is needed:
  each hand-rolled `sepBy` carries `convertible` / `blocked-by-capture` (the
  repetition `field()`s its separator, which `sepBy` cannot express) /
  `reducer-stride-review`, because on a real grammar those split roughly evenly and
  a count of matches would be a list of false work.

  `keywordRegexes` is a correctness finding, not a style note. It covers single
  keywords AND large literal alternations, on the principle that **a regex
  enumerating a fixed vocabulary is a keyword set written the hard way**: it exposes
  no first-set for `choice` to dispatch on, it hand-maintains an ordering
  `keywords()` guarantees, and with `/i` and no `/u` it inherits the non-ASCII
  case-folding bug `keywords()` fixes internally (`combinators/case-fold.ts`).

  The ordering analysis makes that a third BUG class. Regex alternation is
  first-match, not longest-match, so an earlier alternative that is a strict prefix
  of a later one makes the longer branch unreachable — unless a trailing boundary
  guard rejects the following character and forces a backtrack. `hazards` reports
  each such pair and whether the guard rescues it; an unrescued one is a live
  defect, not a style preference.

  Wired on ALL THREE lowering paths — `compile`, `compileRuleMap`, `compileLinkable`
  — and tested on each. The gating diagnostic was default-on and blind in the macro
  build for two minor versions precisely because the latter two never called it.

  Default is `'off'` (`{ duplication: 'warn' | 'error' }` or `PARSEMAN_DUPLICATION`).
  An ungated hot choice is a cliff with no other symptom; a duplicated subtree is a
  cost the author may have chosen, and most findings are candidates needing an AST
  check — printing those on every build teaches people to stop reading the output.

  Passing a `compose()`d artifact **throws** with an actionable message instead of
  reporting an empty result. Handed a fused grammar, `analyzeGating()` throws deep
  in its walker; the failure that matters is not the throw but that an analysis
  which sees nothing reports "no findings". Silence is not a permitted outcome.

  Docs: [Grammar duplication](docs/guide/grammar-duplication.md).

- **Fix: a derived `expected` set names each token once — and that is 32% of Less
  parse time.** 0.35.0's `fix(expect)` (deriving expectations through a nullable
  prefix) is correct and stays. What it did not account for is that a nullable
  prefix re-reaches the SAME tokens from every term it derives through: a value
  grammar whose leading terms are all optional named its value-start set once per
  term, per choice arm. One constant in jess's compiled Less grammar went from 20
  entries to 70+.

- **Fix: a gating analysis that crashed reported the same as one that passed.**
  `reportGating` wrapped the analysis in `try { … } catch { return undefined }`. A
  throw therefore produced no report, no warning, and a passing `'error'` gate —
  byte-identical to `gating: 'off'` and to a genuinely clean grammar. The diagnostic
  ships default-on, so anyone whose grammar it could not walk was told nothing and
  reasonably concluded there was nothing to tell.

  Something did make it throw. `compose()` returns a map of FUSED rule functions:
  fusion lowers each rule to executable code, so the returned map carries no `_def`
  combinator graph. Walking one read `_def` off a function and threw
  `TypeError: Cannot read properties of undefined (reading 'tag')` — on every rule.
  Reproduced on 0.32.0 (the version jess pins) and unchanged on `main`.

  Three things change:

  - `GatingReport` gains `unanalysable: Unanalysable[]`. The walk now RECORDS a value
    it cannot introspect instead of throwing, and `formatGatingWarnings` emits a
    "report is PARTIAL" banner for it unconditionally — including when there are no
    other findings, which is exactly the case that used to look clean. `'error'`
    fails on it. Silence is no longer reachable: an empty `ungated` over an
    unanalysable grammar now says so.
  - New `analyzeGrammarGating(grammar, opts?)` accepts a `rules()` map **or** a
    `compose()` result, recovering the combinator graph from the composition's
    carried IR. This is not cosmetic: analyzing a contributing `rules()` map alone
    reports a cross-artifact choice as `deferred`, because the shape site cannot
    answer it — only the fused view binds the hole and returns a real verdict. It
    also sees the union of base + delta rules, which no single `rules()` map does.
  - The same defect existed in `parseman/spec`: `toEBNF` / `toRailroadSvg` on a
    composed grammar threw the identical bare `TypeError`. Both now share ONE
    recovery helper (`recoverComposedRules`), so a future fix cannot land on one
    walker and miss the other. An opaque precompiled artifact makes the spec path
    throw a specific, actionable error rather than silently rendering a grammar that
    omits whole artifacts.

  Both engines thread opaque carried pieces into the fuse-time diagnostic — the
  runtime linker via `carriedRuleMapsDetailed`, and the macro plugin via its own
  copy over its private carried-item representation — with a parity test, since
  these are separate implementations and this repo has shipped one-engine fixes
  before.

## 0.36.0 — 2026-07-24

- **A broad, realistic-workload perf gate — `pnpm perf:workloads`.** parseman
  shipped three consecutive Less parse regressions that its own gates did not
  catch. The last of them is the argument for this one: `fix(expect)` regressed
  derived expected-set width, `perf:guard:grammars` swept speculative-rollback
  density, and it read flat. That is not a bug in the sweep — it is the
  structural limit of any targeted gate. It can only catch the regression someone
  already thought of, and `fix(expect)` was a *correctness* fix to error-message
  quality that nobody would have predicted a 50% cost from.

  So the new gate is parameterised on nothing. It parses five realistic
  workloads end to end — two Less, one CSS, one GraphQL, one JSON, ~50 KB each —
  and reports the time, so a cost on ANY axis shows up. Everything it needs is in
  this repository: the grammars are `bench/workloads/`, the corpora are
  hand-authored under `bench/workloads/fixtures/`, and `pnpm install && pnpm
  perf:workloads` is the whole contract. No sibling checkout, no clone, no
  network.

  **Per-workload, never aggregated.** Replaying `fix(not)`, `less/stylesheet`
  moves +41.8% while `css/stylesheet` moves −0.5% in the same process; any mean of
  the five rows is mild and passes. That ordering also matches the real event
  (less +25.5%, css −1.6%), which is the evidence that the workloads are worth
  having.

  **Watched going red on all three known regressions**, five runs each, on a
  machine at load average 5–9:

  | replay | `less/*` median | verdict |
  | --- | --- | --- |
  | `fix(not)` — unconditional rollback stores | **+34.4% … +43.9%**, 0–2/12 pairs | **RED, 5 of 5 runs** |
  | `fix(expect)` — nullable-prefix derivation | **+2% … +13.9%**, 1–5/12 pairs | **RED in 4 of 5 runs** |
  | the fixed state (0.35.0 + dedup) | −5.0% … +7.3% | green, 3 of 3 |

  No other workload failed in any of those thirteen runs. The `fix(expect)` row is
  reported as it measured rather than as "caught": it is the weak detection of the
  three, it sits near this gate's resolution floor, and one run in five was green.
  That is exactly why the amplifying `expected/wide` sweep, which fires 5 of 5, is
  not redundant with it. The two gates are complementary — this one FINDS a
  regression, the sweep EXPLAINS it — and both are required checks.

  Three measurement decisions are load-bearing and were arrived at by measuring,
  not by choosing:

  - **Sides are measured in adjacent, order-alternated pairs**, not as two blocks
    with a rotation. Measured the block way, the reference side of a 50 KB CST
    workload read **38% slower than an identical build of itself** — the
    workloads allocate heavily and whichever side runs first eats the previous
    one's garbage. Directional bias of that size masks a regression on the head
    side. Pairing dropped the self-vs-self floor from 38% to 2%.

  - **Three independent passes, majority verdict.** The gate fails a workload only
    when a strict majority of passes breach. The floor was measured at load
    average 5–9 deliberately, because that is what a shared runner looks like:
    worst single-pass median +9.9%, worst single-pass min +3.4%, worst absolute
    swing 12.3% — and **0 of 15 passes breached**, because every breach rule
    requires the win rate as well as a percentage, and a noise pass keeps its win
    rate near 50%.

  - **A sign test, for effects too small for a percentage threshold.** The
    percentage rules caught `fix(not)` and could not reliably catch `fix(expect)`,
    which genuinely costs the realistic workloads only +2%…+9%. Widening the
    threshold would have been backwards — it would blind the gate to the band
    where 0.34.0's css row moved −1.6%. What separated signal from noise there was
    direction, not magnitude: paired samples make each pair a coin flip, and the
    affected rows lost 1–4 of 12 pass after pass while unaffected rows sat at 5–9.
    A workload therefore also breaches when it loses ≤ 25% of its pairs AND is
    ≥ 1.5% slower on both median and min.

  Documented blind spots, in `docs/design/perf-gates.md`: below ~1.5–2% per
  workload it reads green; a regression appearing in only half the passes reads
  green (the deliberate price of not false-failing); it cannot attribute a cause;
  the corpora are repeated rather than 50 KB of unique source; and five workloads
  is five shapes — nothing here parses a template language, real operator
  precedence, or anything using `expect`/recovery heavily.

  One more, worth reading before trusting any workload benchmark: **a workload can
  be realistic and still structurally blind.** The first draft of
  `bench/workloads/less.ts` routed every value alternative through a named rule —
  a perfectly reasonable way to write a grammar — and read FLAT on the
  `fix(expect)` replay, because a rule reference is a function boundary and the
  enclosing choice never sees the widened set. Same dialect, same vocabulary, same
  input, opposite answer, from nothing but where the rule boundaries were drawn.
  `bench/workloads/fxprobe.ts` measures that exposure directly.

  The A/B machinery is factored into `bench/ab-harness.ts` so the two gates cannot
  drift apart on the parts that make a measurement a measurement.
  `perf:guard:grammars` still carries its own copy; migrating it onto the shared
  harness is deliberately left out of this change to avoid conflicting with the
  `fix(expect)` PR it sits on top of.

- **Expectation sets are deduplicated.** An `expected` array on a parse failure no
  longer repeats an entry. Deriving an expectation through a nullable prefix reaches
  the same tokens once per term it derives through, per choice arm; the repeats were
  duplicates, never newly-reachable tokens, so nothing is dropped from the set.

  Minor rather than patch: `expected` is observable output and a consumer may be
  asserting on its contents.

  Building the sets is also cheaper, which matters on a grammar that backtracks. A
  choice that loses every arm concatenates its arms' sets into `_ctx._fx`, and that
  result becomes an arm snapshot for the enclosing choice, so width compounded with
  nesting rather than adding. On a 106 KB Less stylesheet the oversized sets were
  about a third of parse time.

  `deriveExpected` is the single derivation site, read by both the interpreter and
  the codegen, so the two cannot drift here.

- **Internal.** `perf:guard:grammars` gains an `expected/*` sweep, so derived-set
  width is an axis the gate can see. Every PR now has to carry its own version bump
  and a changelog section naming it — `scripts/check-changelog.mjs`, CI job
  `release-gate`, design in `docs/design/release-gates.md`.

## 0.35.0 — 2026-07-24

- **New `parseman/run` entry — the driver without the library.** The macro removes
  the combinators, the compiler and the codegen from your bundle, but executing a
  compiled grammar is still a `run()` call, so a package that *ships* a parser keeps
  a runtime import of parseman. Importing that from the main entry pulled the whole
  library along.

  ```ts
  import { run } from 'parseman/run'   // three modules, not the whole library
  ```

  The closure is `functional/run.ts`, `recovery/scan.ts` and `cst/capture-buffer.ts`
  — 7.2 kB built, against 349.6 kB for the main entry.
  `test/unit/run-entry-closure.test.ts` pins it by module list rather than byte
  budget, so an import added to the driver fails the suite instead of quietly
  re-inflating every downstream bundle.

  This is what put `parseman` in a published parser's `peerDependencies`: the
  driver was only reachable through the full entry.


- **Perf: rollback truncations are guarded on a CHANGED length — in both engines.**
  Assigning `array.length` is not a plain field store: it runs V8's length setter,
  which must decide whether to trim the backing store, and it costs the same
  whether or not the value changes. Rollbacks overwhelmingly restore a length that
  never moved — the speculative branch captured nothing — so the store was pure
  overhead on the common path. Every rollback now emits/executes
  `if (sink && sink.length !== mark) sink.length = mark`.

  This is the fix for a **+32% Less parse regression 0.33.0 → 0.34.0**. 0.34.0's
  `not()` probe-leak fix is correct and stays; what it could not afford was six
  UNCONDITIONAL length stores on a probe that jess's Less grammar executes ~600
  times per KB (62,447 executions parsing `benchmark.less`). Measured on that
  corpus, interleaved in one process, 4 rounds × 3 runs, 8 warmup + 25 timed:

  | build | vs 0.33.0 median |
  | --- | --- |
  | 0.34.0 | +32.5% |
  | 0.34.0, `not()`'s six stores guarded | +4.3% |
  | 0.34.0, ALL ~3000 rollback sites guarded | **−12.0%** |

  The guard is worth more than the regression it repays, because it applies to
  every `attempt` / `choice` arm / `many` item / sequence term as well. Against
  0.32.0, the version jess pins, the guarded 0.34.0 is faster on every corpus:
  Less `benchmark.less` −3.9%, `bootstrap.css` −18.5%, jess corpus −18.5%, each
  winning 12/12 interleaved pairs.

  Why it ordered the way it did across dialects: the cost is per-EXECUTION, not
  per-SITE. `not()` executions per KB — css **20**, jess **121**, less **599** —
  match the observed regression ordering, while site counts do not (scss has 43
  `not()` sites and zero in its compiled artifact's hot path).

  Landed in both engines, since they have drifted on exactly this kind of change
  before: codegen emits the guarded form at all 33 emission sites, and
  `rollbackCstCapture` / `rollbackTrivia` / `attempt` / `choice` carry the same
  guard in the interpreter. `test/unit/rollback-store-guard-parity.test.ts` fails
  the specific engine that loses it.

- **A grammar performance gate — `pnpm perf:guard:grammars`, required on every
  code PR.** `perf:guard` measures a 47-byte `css/decls` and a 34-byte
  `css/selector`. It passed on every PR of the 0.34.0 cycle, including the one
  that made a real downstream Less grammar parse 25% slower. Its trigger ("did
  parseman's microbenchmarks move?") was not its goal ("did the code parseman
  emits get slower?").

  The new gate measures a **rollback-density sweep** that lives entirely in this
  repo — one grammar shape over one ~38 KB input at 0 / 1 / 4 / 16 speculative
  probes per value term, bracketing the 20 / 121 / 599 `not()`-per-KB measured
  across the real grammars in that event. It A/Bs against a pinned reference
  commit of this repo, **interleaved in one process** with per-round rotation, and
  reports **per case** — median, min AND win rate, never one aggregate. Replaying
  0.34.0 against 0.33.0 it reads +1.2% / +54.9% / +89.0% / +112.8%: the spread is
  the finding, because it says the cost is per-execution.

  Thresholds (6% median / 6% min, with 3/4 of paired samples lost) come from a
  measured same-build-vs-itself floor of 1.9% median / 1.0% min. The ~3%
  resolution limit and the ~4.4× amplification versus a real grammar are stated in
  `docs/design/perf-gates.md` rather than implied. `--ref` / `--head-ref` replay a
  known regression so the gate can be watched going red; a missing reference
  commit is a hard failure, never a skip.

  No sibling checkout, no network fetch, no setup step: `pnpm install && pnpm
  perf:guard:grammars`.
- **Fix: `expect()` derives expectations through a nullable prefix.** A sequence
  whose leading terms can all match empty reported the wrong expected set — the
  derivation stopped at the first term instead of continuing past the ones that
  match nothing. Recursive rules reached that way could also cycle; the walk now
  cuts the cycle rather than recursing.

- **Docs: the macro removes the combinators, not the driver.** Six places said, in
  different words, that "the `parseman` import disappears" — homepage, getting
  started, modes (twice), macro mode (twice). Read together they promised that a
  macro-compiled parser needs no parseman at runtime at all. The macro'd import
  does disappear and the compiled grammar carries no parseman reference; running it
  is still a `run()`/`parse()` call. Corrected in place, and "Macro build (zero
  runtime cost)" is now "(no runtime compile step)", which is the claim being made.

- **Docs: the README summarizes and points.** It carried the benchmark story twice
  (headline claims, then the same µs figures again with methodology and grammar
  provenance that live in the benchmarks guide). Now: the claims, one proof point,
  the charts, and links — 1205 → ~920 words with the feature surface roughly
  tripled, since railroad diagrams, EBNF, grammar observability, gating
  diagnostics, composition and editor integration were absent entirely.

- **CI tests every supported Node line.** The matrix runs one leg per supported LTS
  line instead of a single pinned major, and `pnpm docs:verify` — which executes
  every documented example — now runs in CI, where it previously ran in no
  automated check at all. Both found real breakage immediately: Node 20 could not
  run the test toolchain (`fs.globSync` is Node 22+; chevrotain calls
  `Object.groupBy`, Node 21+), so the floor declared in 0.34.0 was not actually
  exercisable until this release.

## 0.34.0 — 2026-07-24

- **`peek(combinator)` — the positive lookahead.** PEG's `&X`, the counterpart to
  the existing `not(X)`. Zero-width, and — crucially — it **carries its body's
  first-set**, so an arm led by `peek(regex(/[.#]/))` still emits O(1) first-char
  dispatch. The only previous spelling, `not(not(X))`, reports first-set `any` and
  poisons the whole choice's dispatch; the gating diagnostic already flagged it as
  the `double-not` anti-pattern, and now names `peek()` as the fix. In a sequence
  the lookahead's first chars are **intersected** into the sequence's set (sound:
  `A ⊇ a ∧ B ⊇ b ⇒ A ∩ B ⊇ a ∩ b`); a nullable body constrains nothing and reports
  `any`. See [not & peek](/reference/api#not-combinator-peek-combinator).

- **`word()` takes `caseInsensitive`.** `word(str, boundary?, opts?)` and
  `word(str, opts)` now accept the same `caseInsensitive` flag `keywords()` has.
  CSS at-keywords, function names and units are ASCII case-insensitive *per spec*,
  and the only conforming spelling used to be `regex(/media/i)` — which the
  diagnostic correctly flags as the `keyword-regex` anti-pattern. The resulting
  first-set is ASCII case-**folded** (`{m, M}`), so the arm still gates.

  Case-insensitive `keywords()` no longer compiles under the `u` flag. `/iu` folds
  by Unicode *simple case folding*, so `keywords(['stroke'], { caseInsensitive })`
  also matched `ſtroke` (U+017F → s) while its ASCII-folded first-set dispatched
  that input away from the arm — an unsound gate. Matching and the first-set now
  fold the same ASCII set, the invariant `regex()` established in 0.32.0.
  *(Behaviour change for non-ASCII case-folded keywords — hence a minor.)*

- **The four repetition combinators take `{ min, max }`, and separated lists get a
  non-empty form.** `many(item, opts?)` · `oneOrMore(item, opts?)` ·
  `sepBy(item, sep, opts?)` · **`oneOrMoreSep(item, sep, opts?)`** (new). Named
  combinators are sugar for the common option combinations: `oneOrMore(x)` **is**
  `many(x, { min: 1 })`, and `oneOrMoreSep(i, s)` **is** `sepBy(i, s, { min: 1 })`
  — the same combinator, not a lookalike. `min`/`max` count **items**, not
  separators; defaults are unchanged, so every existing call site behaves exactly
  as before.

  This is a gating fix as much as an ergonomic one. Plain `sepBy` is
  `(item (sep item)*)?` — it **matches the empty string**, which makes it nullable,
  and a nullable arm disables its choice's first-char dispatch by parseman's own
  first-set rule. An audit of parseman's reference grammars found `sepBy` used
  **zero** times across ~135 hand-rolled separated lists: the nullable default was
  wrong for essentially every real list and nothing surfaced the fix. `min >= 1` is
  genuinely non-nullable with first-set = the item's; `max` never affects
  nullability.

  Separated forms also take **`trailing: 'forbid' | 'allow' | 'require'`** (default
  `'forbid'`, today's behaviour: the trailing separator is left unconsumed for the
  enclosing rule). `'allow'` consumes it; `'require'` demands one after the last
  item (an empty list is vacuously satisfied).
  See [repetition](/reference/api#many-c-opts-oneormore-c-opts-sepby-c-sep-opts-oneormoresep-c-sep-opts-optional-c).

- **Shared grammar SHAPES — a composable piece may now reference rules it doesn't
  define, and still ship compiled.** A `rules()` map is allowed to leave holes
  (`g.Value` naming a rule defined by whoever composes it), so a composite *shape* —
  `<ratio> = <value> '/' <value>`, a media-feature range, a custom-property tail — is
  written ONCE and each dialect binds its own value/interpolation rule by name. This
  is what [Assembling one grammar from parts of several](/guide/extending#assembling-one-grammar-from-parts-of-several)
  always described; under the macro it now actually compiles.

  ```ts
  // @scope/shapes — the shape, with a hole
  export const ratio = rules(g => ({ Ratio: sequence(g.Value, literal('/'), g.Value) }))

  // each dialect binds its own Value, and the whole thing macro-fuses
  export const parser = composeLeaf([ratio, rules(g => ({
    Value: regex(/[0-9]+/),
    Document: node('Document', g.Ratio, (children, _f, span) => …),
  }))])
  ```

  Under the hood: a map with a hole can't be inlined as a standalone parser, so its
  own value stays the `rules(…)` map — but the macro now also stamps its **compiled
  linkable pieces** on that value, so a downstream `compose()` / `composeLeaf()`
  fuses it statically (no runtime composition, no base source). A hole nobody binds
  is a hard build error, never a silent drop.

  `composeLeaf`'s safety gate is unchanged in strength: a pre-final piece must still
  prove **recognition-only**. An unresolved external ref is now correctly read as a
  *hole* rather than as unknown semantics — it holds no callback, and whoever binds
  it is either another pre-final piece (gated the same way) or the local leaf (allowed
  to be semantic). Every other unresolvable reference still counts as semantic.

- **Fix: the gating diagnostic was blind in the macro build.** A macro-built
  `rules()` grammar compiles through `compileRuleMap`/`compileLinkable`, and
  **neither ran the analysis at all** — so a whole grammar reported zero ungated
  choices and zero anti-patterns, and every warning the build did print came from
  the stray single-combinator `compile()` calls, each unnamed as `choice @ <entry>`.
  Now:
  - `compileRuleMap` runs the diagnostic over the WHOLE rule map in one shared
    walk, so every choice is attributed to the rule that owns it and anti-patterns
    are reported. New `analyzeGatingRules(ruleMap, opts?)` is the programmatic
    multi-root surface (`analyzeGating` is the single-entry case of it).
  - New `gating.entryName` option names an UNNAMED entry; the macro plugin passes
    the binding's own variable name, so a top-level combinator const now warns as
    `choice @ directMixinReferenceAhead` — actionable, and a discriminating
    `accept` allowlist key, which `<entry>` never was.
  - `compileLinkable` takes `gating` too, but opt-IN only: it re-lowers the same
    map for the linkable form, so running it by default would double every warning.
    It is also the wrong site for a shared shape — one piece at a time, the holes
    are still unbound (see the next entry).

- **Fix: the gating diagnostic now asks its question where the answer exists.**
  Combined with shared shapes (above), the diagnostic was inverted in BOTH
  directions at once. A shape's hole makes every first-set through it `any`, so the
  shape module warned about an ungated `choice` — describing a configuration that
  never runs, which its author could not fix — while the artifact that IS executed,
  the fused consumer whose binding decides the answer and whose author CAN act, was
  never analyzed at all. A false positive at the shape site and a false negative at
  the fuse site, simultaneously; muting the shape warning would have hidden the more
  damaging half.

  A choice ungated SOLELY by unresolved NAMED cross-artifact holes is now
  **`deferred`**: silent at the shape, excluded from the `'error'` gate, and listed
  in `GatingReport.deferred` (`ChoiceGating.deferred` / `AnyArm.unresolvedExternal`
  carry the per-choice detail). Every `compose()` / `composeLeaf()` — macro build and
  runtime linker alike — re-runs the analysis over the **fused winner map**, with the
  hole bound, and reports what the binding actually produced, named by rule and with
  the real cause:

  ```
  parseman gating: choice @ Term is UNGATED [firstMatch] — no first-char dispatch; …
    · arm[0] ∩ arm[1] overlap on '@'
  ```

  Only deferred choices are reported at the fuse, so an ordinary hole-free grammar is
  still warned about exactly ONCE — at the site that authors it — however many times
  it is later composed. An UNNAMED unresolved `ref()` is deliberately not deferrable:
  nothing can bind it by name, so it stays a local finding. `analyzeGating` /
  `analyzeGatingRules` gained `opts.resolveRef` for the fused view.
  See [Shared shapes and the fuse](/guide/first-char-gating#shared-shapes-the-verdict-belongs-to-the-fuse).

- **Docs: every combinator now has a worked, executed example.** `docs/guide/combinators.md`
  shows input → what matches → what it yields for the full export surface,
  including the instructive failure and the discriminating case between similar
  combinators. Every sample is run by `scripts/verify-doc-examples.mjs`.
- **Fix: `not()` no longer leaks its speculative probe.** A negative lookahead is
  zero-width on both outcomes, so it must leave no observable trace — but it left two.
  Its rollback mark covered the CST buffers and `_errors` and NOT the global
  `_triviaLog`, so a probed body that skipped ambient trivia between its terms
  committed that trivia and kept it; because `not()` consumes nothing, the enclosing
  rule then re-parsed the same region and the span was logged **twice** (nothing
  dedups `_triviaLog`, and `triviaEntries()` is a positional view over the flat
  array). Separately, the compiled `emitNot` emitted no rollback of its own, relying
  on `emitFallible`'s — which fires only on the inner-FAILURE path — so when the
  probed parser SUCCEEDED its captured leaves survived, and an enclosing
  `optional`/`many` that swallowed the failure absorbed them as real children.

  It also left `_probe.best`, the completions tracker, so tokens reachable only
  inside the probe were offered as completions — the same leak fixed for `peek()`.

  Both engines leaked the trivia identically, so they agreed with each other while
  both being wrong and interpreted/compiled parity never flagged it. Fixed on both:
  the interpreter uses the shared `saveLookaheadMark`/`rollbackLookahead` helper, and
  `emitNot` now emits an `emitAttempt`-style six-sink restore, unconditionally rather
  than `if (!ok)`. Grammars with no `node()` and no recovery compile byte-identically
  (nothing can write those sinks there); the four example grammars are unchanged.

- **Declared a Node floor: `^20.19.0 || >=22.12.0`.** The package shipped no
  `engines` field at all, which understated what it actually needs — `oxc-parser`
  is a runtime `dependencies` entry declaring exactly that range, so the floor was
  already real, just undeclared. `oxlint` and `vite` land on the same range
  independently.

  Note the gaps: **20.0–20.18 and 22.0–22.11 are excluded**, so a bare `>=20`
  would have claimed support for versions where the dependency tree will not
  install.

  This does not reach anyone consuming a *compiled* grammar. Macro-compiled output
  is self-contained — zero `import`/`require`, zero references to `parseman`, and
  its highest language feature is optional chaining (Node 14) — so a build-time
  macro user carries parseman as a devDependency and never exposes this floor
  downstream. (Tolerant/recovery parsing is the exception: the emitted source
  reaches for `_ctx._rec`, so the host supplies parseman's recovery machinery at
  run time.) The runtime bundle itself uses no `node:` builtins and no post-Node-18
  built-ins.

## 0.33.0 — 2026-07-24

- **Ambient scan-skip — `scanTo`/`balanced` no longer match a sentinel hidden in a
  string or comment.** Two layers, mirroring grammar-level `trivia`:
  - `scanTo` and `balanced` skip the grammar's ambient **`trivia`** (comments/ws)
    during a scan by default. Byte-identical for whitespace; a sentinel hidden in a
    comment is no longer matched. *(Default-behavior change — hence a minor.)*
  - New grammar-level option **`rules({ scanSkip: [...] })`** for opaque non-trivia
    units (strings, `balanced` brackets). Declared once, inherited everywhere
    (interpreter, `compile()`, and macro; standalone `rules()`, `composeLeaf`, and
    `compose`), the scan-time analogue of `trivia`. Under `compose`/`composeLeaf` it
    threads PER-PIECE — a local `rules({ scanSkip })` element's units reach the
    re-lower of that element's own rules (not composing-wins like trivia, since
    opaque units are dialect-specific).
  - Per-call `skip` now **extends** the ambient set rather than replacing it; new
    `raw: true` opts a call out of all ambient skipping (the pre-ambient byte walk).

  See [scanTo & balanced](/guide/combinators#scanto-and-balanced). *(A new ambient
  option plus a default-behavior change, so a minor.)*

- **Perf guard fix — the interpreter had a systematic ~15% dead zone.** A case's
  median depends on which OTHER cases shared its process: measured in isolation,
  CSS interp runs ~15% faster than the same case measured inside the full suite,
  while the compiled path does not move (~0%). That is the measured effect; the
  cause has not been instrumented, so no mechanism is claimed for it. The
  guard measured CSS alone while `bench:baseline` captured it inside the full
  30-case suite, so a freshly written baseline already read −14% on interp and an
  interp regression had to exceed ~30% before the 15% tolerance fired.

  The baseline now stores one case map **per measurement context** (`full` /
  `all` / `css`), each captured in its own child process, and every comparison
  site names its context. A guard run whose context is missing from the baseline
  now skips with a re-baseline instruction instead of silently comparing against
  the wrong numbers. *(Bench/test tooling only — no library change.)*

## 0.32.0 — 2026-07-23

- **Fix (soundness): three first-set FALSE-EXCLUDES the initial cross-artifact
  dispatch introduced.** The tighter first-sets below were, in three cases, too
  NARROW — gating out valid input on the real jess CSS/Less/SCSS grammars (15 parser
  tests regressed: nested-paren `@supports`/media/container preludes rejected;
  case-`ReD` named colors mis-classified). All three widen the first-set back to a
  correct SUPERSET without losing the gating win:
  1. **Shared rule ref treated as a false cycle.** `leadingFirstSetRecipe`'s cycle
     guard was a global visited-set, so the SAME ref appearing in two sibling arm
     positions — `choice(sequence(not, g.R), sequence(g.R, …))`, `g.R` both arm-0's
     nullable-prefix tail and arm-1's lead — hit the guard on its 2nd visit and
     returned an EMPTY recipe, dropping that arm's first chars. A named ref is now
     resolved by name (never recursed) so it never pollutes `seen`, and the guard is
     **path-based** (added on entry, removed on exit) so a shared inlined `node()`
     used across sibling positions is recomputed fresh instead of mistaken for a
     cycle. Only ancestors on the current recursion path are true cycles.
  2. **Case-insensitive regex first-set omitted the opposite case.** The first-set
     analyzer is flag-agnostic, so `/red|blue/i` yielded `{r,b}` not `{r,R,b,B}`;
     dispatching on that false-excluded `ReD`. `regex()` now widens the leading set
     under `i`, FLAG-AWARE: a plain `/i` (no `u`) folds only ASCII case pairs per
     ECMAScript — a sound, tight superset that keeps at-keyword gating (`/@media/i` →
     `{@}`); a `/ui` OR `/iv` pattern uses Unicode simple case folding
     (`u`, or the ES2024 `v` Unicode-sets flag — both match `ſ`/`K`), which ASCII-folding can't enumerate, so it widens to `any` (always-try)
     rather than a narrow set that would false-exclude those. (A blanket `any` for all
     `/i` would wrongly de-gate the ASCII at-keywords.)
  Fuzz-verified + a regression test matching the real jess shape (recursive
  nested-paren prelude behind a cross-artifact ref, shared inlined node,
  case-insensitive recognizer); full jess corpus (css/less/scss/jess parsers +
  all-less + scss-render) back to baseline, gating win preserved.

- **Fix: cross-artifact first-set dispatch across the `composeLeaf` boundary.** A
  fused choice arm / node whose leading term is a rule REFERENCE into a separately
  compiled recognition artifact — `sequence(g.SyntaxAtRuleName, prelude, ';')`, the
  shape every jess at-rule cluster uses — degraded to an `any` first-set and was
  entered SPECULATIVELY at every input position (each of ~2000 top-level rulesets
  paid ~11 doomed at-rule node-frame enter+regex+rollback cycles). Two coupled
  causes, both fixed:
  - **`canMatchEmptyAtStart` was imprecise for a `regex`.** It tested the pattern
    SOURCE for a `?`/`*`/`{n,}` anywhere — including inside a `(?!…)` lookahead or on
    a non-leading term — so a required-prefix recognizer like `/@media(?![-\w])/`
    (first-set `{@}`, cannot match empty) was wrongly flagged nullable, and
    `compileLinkable` poisoned that rule's `firstSets`/`firstSetRecipes` to `any`. It
    now uses the precise `regexMatchesEmpty` (`^(?:source)$` against `''`) — tighter
    AND sound (also fixes a latent unsoundness: `/a{0}/` matches empty but has no
    `{n,}`, so the old test missed it).
  - **The leading first-set recipe over-unioned the tail past a leading ref.** The
    old flat `{concrete, refs}` recipe treated a leading cross-artifact ref as
    nullable (its nullability is unknown at compile time) and unioned the FOLLOWING
    terms' first-sets — and a `scanTo` prelude's set is `any`, collapsing the whole
    recipe. The recipe is now an ORDERED CHAIN (`{alts}`: a union of ordered
    leading-term chains) plus a per-rule `nullable` map, and `fusedBody` resolves each
    chain left-to-right, STOPPING at the first non-nullable segment — so a
    `sequence(ref, …)`-led arm resolves to the ref's real `{@}` even when the tail is
    `any`, exactly as a grammar-local `regex(/@…/)` would.

  Net effect: a fused grammar first-char-gates a cross-artifact `sequence(ref, …)`
  arm identically to a monolithic compile, so grammar authors no longer need to
  hand-copy recognizer regexes into the consuming grammar to recover dispatch.
  Verified on the real jess CSS AST grammar: the at-rule cluster went from **0**
  gated arms (0.31.1) to gated on `@` throughout (11/13 `CssAstAtRuleStatement`
  sites, 7/9 conditional/layer, 14/16 opaque/page/scope), AST byte-identical
  (css-parser suite green), bootstrap4.css parse **~−38%** median in a same-store
  interleaved A/B vs 0.31.1. Soundness fuzz-verified over 1.8M randomized
  cross-artifact grammar × input pairs (0 false-excludes, 0 end-mismatches; the
  guard is load-bearing — a deliberately-broken chain-stop produced 2311).

  **Breaking (artifact format):** `firstSetRecipes` now serializes as `{alts}` and
  a new per-rule `nullable` map ships alongside `firstSets`. New exported type
  `FirstSetSeg`; `FirstSetRecipe` / `leadingFirstSetRecipe` changed shape. There is
  **no cross-version back-compat** — see the version-lock item below.

- **Artifacts are version-locked (documented + enforced).** A grammar is compiled AND
  fused/linked by the SAME parseman version; parseman never reads an artifact produced
  by a different version. The compiled-artifact format may therefore change freely
  between versions and carries no back-compat shim. This is now (1) documented as a
  design invariant (`docs/design/artifact-format.md`), (2) stamped — a
  `PARSEMAN_VERSION` banner tops every generated artifact and a `v` field rides on
  each serialized `LinkablePieces` (kept in sync with `package.json` by
  `test/unit/version-sync.test.ts`), and (3) enforced — `fusedBody` throws a loud
  "recompile — parseman does not fuse across versions" error if a piece's stamp
  mismatches OR is absent (an unstamped pre-invariant artifact is unsupported;
  `LinkablePieces.v` is required). Consequently the initial `LegacyFirstSetRecipe` /
  `{concrete, refs}` read path (a back-compat shim for a scenario the design forbids)
  was removed as dead code; the ordered-chain `{alts}` recipe is the sole format.

- **DX: default-on first-char gating diagnostic.** `compile()` now runs a static
  gating analysis and, by default, WARNS when a `choice` on the hot path won't
  first-char-gate — naming the offending arm, the cause (`broad-recognizer` /
  `leading-not` / `nullable-prefix` / `cross-artifact-ref` / `opaque-wrapper`), a
  concrete fix, plus overlap (shared-prefix) pairs and API anti-pattern lints
  (`not(not(...))`, leading-`not`, keyword-`regex`). This surfaces the invisible
  perf cliff behind the hand-found 25–48% jess grammar wins — PEG choices are
  correct whether or not they gate, so the cliff never shows up in tests. New pure
  `analyzeGating(entry)` / `formatGatingWarnings(report)` API; `compile(g, { gating:
  'off' | 'warn' | 'error' })` (or the `PARSEMAN_GATING` env var) controls it;
  `GatingReport` is attached to `CompiledParser.gating` for CI budget snapshots. It
  honors shallow-any-vs-deep-any so `ref()`-built choices that still gate in
  compiled code aren't false-flagged. A deliberately-ungated choice is accepted by
  listing its stable `id` in the snapshot allowlist (`{ gating: { level, accept } }`
  / `analyzeGating(entry, { accept })`) — the SINGLE per-choice suppression
  mechanism, driving both warn-suppression and the CI gate. Analysis-only —
  compiled output is byte-identical regardless of level.
- **Rename `guard()` → `gate()`** (API-surface only). The state-assertion
  combinator's name now matches the `gate:` field on a gated `choice` arm (arm
  field SELECTS a branch; `gate()` combinator ASSERTS mid-sequence). `guard` is kept
  as a deprecated alias (`guard === gate`); the internal node tag and failure label
  are unchanged, so compiled output/IR is byte-identical.
- New guide **First-char gating**, combinator when-to-use tables, and a root
  **`AGENTS.md`** rule sheet for LLM grammar authors keyed to the build warnings.

## 0.31.1 — 2026-07-23

- **Fix: first-set computation skips past leading zero-width assertions.** A
  `sequence` that LEADS with a negative lookahead — `sequence(not(literal('@-')),
  @name)` (jess's opaque at-rule arm) — computed a first-set of `any`, because the
  leading `not(...)` reports `firstSet: any()` (it cannot know what it forbids) and
  that `any` was unioned into the sequence's set BEFORE the nullable-prefix loop
  reached the first CONSUMING term. An `any` first-set silently disables first-char
  dispatch gating of the whole arm/node/rule, so an assertion-led subtree (e.g. the
  at-rule cluster across the jess parsers) was entered on every input char instead
  of only on `@`. `sequenceFirstSet`, `firstSetOf`, and the compile-time
  `leadingFirstSetRecipe` now skip a zero-width assertion's (meaningless) first-set
  contribution while still treating it as nullable: `not(X) Y` can only start with a
  char in firstSet(Y) — the assertion only NARROWS the language, never widens the
  possible first chars — so firstSet(Y) stays a correct (and tighter) SUPERSET,
  which is the soundness contract for a dispatch gate. Fuzz-verified over randomized
  grammars (0 false-excludes: every input the sequence matches has its first char in
  the computed set). Byte-identical parse output — this only re-enables the dispatch
  gate the spurious `any` was suppressing; it adds no new API, IR field, or
  combinator (cf. the 0.29.0 first-set-recipe minor, which added the recipe IR).
  Parseman has no positive-lookahead combinator; the doc on `isZeroWidthAssertion`
  records the `firstSet(body) ∩ firstSet(Y)` rule required before one could be added.

## 0.31.0 — 2026-07-23

- **Perf: structural children-array (`chV`) elision via `_parsemanReadsChildren`.**
  A structural `node()`'s per-node `children` array is a byte-for-byte duplicate of
  its `rawChildren` array (every captured item is a CST child, so the raw-entry
  synthesis never diverges). A build host that constructs its node purely from
  `rawChildren` (e.g. jess's `cssCstBuildHost`) never reads `children` — but arity
  inference (`_hostReads` / `Function.length`) CANNOT detect this: a host that reads
  any LATER positional arg (`span`/`rawChildren`/`state`) must still DECLARE
  `children` positionally, so its length stays high and every arg-gate reports
  "read". Hosts may now set `build._parsemanReadsChildren = false` to declare they
  build from `rawChildren` only; structural nodes then skip allocating `chV`
  entirely (one fewer array per node). Leaf capture was restructured to gate on
  `_cstLeaves || _cstRawChildren` so terminals still reach `rawChildren` when the
  children collector is elided. Output-neutral: the default (`undefined`) keeps the
  array, and the opt-out is kept inert whenever `children` is actually read — a
  default CST (no host), unwrap/collapse rules, or a `_parsemanCstCollapse` host
  (which inspects `children`). Monomorphism and macro-fusion are unchanged (an
  allocation gate, not a shape change). A/B on a structural jess-shaped model:
  ~25% fewer young-gen scavenges, ~10% wall; on a real jess Less-CST parse of
  benchmark.less (10.3k nodes): ~8.5% fewer scavenges (415→380/400 parses), ~6%
  faster wall (18.1→17.0 ms/parse), byte-identical CST. Does not affect direct-AST
  builders (whose `children` is read) — only the structural-host CST path.

## 0.30.0 — 2026-07-22

- **New `choice` codegen strategy: shared-prefix left-factoring.** When several
  alternatives of a `choice` begin with the same concrete leading `literal`/`regex`
  — including the natural wrapped forms authors write (`node(...)`, `parser({trivia}, ...)`,
  `transform`, `label`) — Parseman now recognizes that prefix ONCE and branches on the
  residual, instead of re-scanning it per alternative on backtrack. Fires on both the
  plain-compile and the linkable/fused (`deferFirstSetRefs`) paths; conservatively falls
  back to the byte-identical ordered `firstMatch` whenever it can't prove byte-identity
  (arms that would hoist to separate functions, differing trivia, ref/overridable prefixes,
  coverage/recovery compiles). It shares only the *scan*, so it pays off when the shared
  prefix does real scanning work: a head-to-head A/B benchmark (`bench:sharedprefix`) shows
  ~1.85–1.95× on adversarial shapes (24–40-char shared prefix, 8 arms, last-arm-wins) and
  ~1.24× on a plausible-favorable grammar; it is (correctly) a no-op for trivially cheap
  prefixes. See `docs/guide/natural-grammars.md`.
- **Interpreter: first-set fail-fast parity.** The 0.29.0 codegen first-set fail-fast
  guards now also apply in the interpreter runtime for `many`/`oneOrMore`/`attempt`/`node`,
  so interpreted grammars skip the same doomed setup the compiled path already skips (same
  soundness + skip conditions; verified byte-identical by the interpreter≡compiled parity
  suites).

## 0.29.0 — 2026-07-22

- **Perf: fused grammars now first-char-dispatch as well as monolithic ones.** A
  composed/`composeLeaf` grammar compiled a `sequence(ref, …)`-led choice arm or
  node body with NO first-char gate: the referenced rule bakes an `any` first set
  at construction, so the arm degraded to always-enter (Less `@{…}` interpolation
  was ENTERED ~56.5k times/parse, 97% at a non-`@` char). `compileLinkable` now
  records a per-rule LEADING first-set RECIPE — concrete leading chars (through the
  nullable prefix) kept separate from leading rule-ref NAMES — and `fusedBody()`
  fixpoint-resolves the ref names against the WINNING rules. This matches what a
  single-file compile emits (`firstSetOf`), and stays sound under override (the
  winning rule supplies the char, and a wider override WIDENS the gate — never
  drops a parse). Less `@{…}` entries fell 56.5k→7.4k; ~9% faster Less parse,
  behavior-identical (interpreter/compiled/macro parity green). DX-friendly
  composition no longer costs first-set dispatch.

- **Perf: first-set fail-fast before a node()'s capture frame.** A `node()` whose
  body has a discrete (non-`any`) first set and cannot match empty now emits a
  single code-point first-set check BEFORE allocating its children/raw/trivia
  collectors and swapping the CST context. Non-dispatching callers (an early arm
  of a non-disjoint `choice`, a `many` body) invoke such nodes at many positions
  and reject them on the first byte — previously each miss allocated the whole
  capture frame, then failed. The guard rejects a first-set miss with no
  allocation, recording the same static `expected` a body start-fail would (named
  rules run with `recordFail`), so diagnostics are unchanged. Emitted only when the
  node captures (children/structural) and outside compiled recovery (where a
  swallowed failure still feeds the completions probe). Measured ~6–7% faster Less
  parse on top of the repeat-body guard below (Less `@{…}` interpolation alone was
  invoked ~56k times/parse, almost all rejected on the first byte).


- **Perf: first-set fast-path on `many`/`oneOrMore` loop bodies.** The repeat
  codegen now emits a single code-point first-set check before each loop
  iteration's body attempt: when the next code point can't start the repeated
  element, the loop stops immediately instead of running the full body
  recognizer and backtracking. This is the same first-set arm guard the `choice`
  codegen already emits, applied to the repeat body, and it removes the
  attempt-then-fail every `many`/`oneOrMore` pays at its terminating iteration
  (e.g. a value list that ends at `;`/`)`/`,`).

  Emitted only when the body has a discrete (non-`any`) first set and cannot
  match empty (`needsFirstSetGuard`), so a first-set miss is a guaranteed
  non-match and stopping is behavior-identical; and only when the body does not
  already `failsAtStart` (a bare literal/regex/keywords leaf leads with the same
  first-char check, so guarding it would be redundant and would perturb
  byte-identical leaf-body output). The win lands on composite bodies —
  `sequence`/`node` — that do setup before discovering a first-char mismatch.
  Suppressed under compiled
  recovery (`compile(g, { recovery: true })`): there a swallowed body failure
  still feeds the completions probe, so the IDE build keeps recording the body
  as a candidate at a non-matching char. A normal parse records nothing on a
  swallowed body failure, so the fast-path is a pure speedup with no diagnostic
  or output change. Interpreter semantics are unchanged.

## 0.28.1 — 2026-07-21

- **Fix: make `FusedRule` compatible with `run()`'s public `Runnable` contract.**
  The exported type now uses Parseman's `ParseContext` and discriminated
  `ParseResult<unknown>` instead of a looser private context/result shape, so
  macro-fused grammar entries can be passed directly to `run()` without
  consumer-side casts.

## 0.28.0 — 2026-07-19

- **New: macro-only `composeLeaf([...recognition, localRules])`.** A terminal
  composition fuses imported, explicitly recognition-only grammar pieces with
  one local `rules()` map whose direct builders may use lexical AST
  constructors. The macro emits one parser; an unlowered runtime call throws
  instead of creating a composition fallback. The terminal result cannot be
  composed again.

- **New: `leaf(combinator, reducer)` semantic terminal composition.** A structural
  grammar can now publish one reducer-selected value and full source span to its
  parent while suppressing internal CST captures. It keeps local trivia explicit,
  macro-compiles, round-trips through linkable IR, and preserves inner coverage and
  trace identities.

- **New: `attempt(parser)` transactional ordered-choice arms.** A rejected arm
  restores every Parseman-owned sink—CST leaves/raw children/trivia, fields,
  global trivia diagnostics, and recovery errors—then reports failure at the
  transaction entry while retaining the inner expected-token set. User state is
  deliberately not cloned. Interpreter, runtime-compiled, macro-compiled, and
  re-lowered composed grammars use the same semantics.

- **New: transaction trace lifecycle.** Coverage-enabled parser output now emits
  a trace-only `attempt:<path>/rollback` event for a rejected transaction. It is
  intentionally absent from semantic-coverage definitions and never credits a
  rejected inner choice arm; normal generated output remains uninstrumented.

- **New: opt-in grammar observability.** `runWithGrammarCoverage()` reports
  stable rule, choice-arm, and label coverage from an immutable snapshot, while
  `createGrammarTraceSink()` records bounded lifecycle traces. IDs come from the
  final start-rule graph, including final compose winners. The public guide
  documents the distinction from line coverage and the bounded-sink contract.

- **New: coverage-aware compiled and macro output.** `compile(..., {
  coverage: true })` and the Parseman plugin's `grammarCoverage: true` option
  emit rule, choice, and label instrumentation only in that opt-in mode. Static
  combinators, `ref()` entries, and `rules(...)` maps share the same plan. Normal
  generated output remains byte-identical. `createGrammarInstrumentationContext()`
  provides the typed context for covered generated parsers; `run(..., {
  instrumentation })` forwards it without changing ordinary parse contexts, and
  `compiledGrammarCoverageDefinitions()` exposes the immutable generated-map
  denominator used for a truthful ratio.

- **New: semantic choice traces.** Coverage traces record rule
  enter/success/failure, choice attempt/failure/backtrack/selected/success, and
  successful labels with parser-local offsets and ends. Interpreter and generated
  paths agree across disjoint dispatch, greedy classification, longest literals,
  auto-not rejection, recursion, and re-entrant choices.

- **Fix: preserve grammar observability through macro `composeLeaf()`.** The
  coverage plan now uses the exact re-lowered final-winner graph, including
  imported recognition fragments and the final local semantic map. Parseman's
  own `balanced()` delimiter reconstruction remains recognition-only for this
  purpose; grammar-authored reductions still make an imported leaf ineligible.

- **Improved: direct-AST node codegen omits unobserved CST collectors.** When a
  direct `node()` builder's confirmed formal parameters cannot read `children`
  or `rawChildren`, normal generated parsing leaves those buffers unallocated.
  Structural/CST output, explicit `cstBuildHost()`, and capture profiling retain
  their complete collector contract.

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
