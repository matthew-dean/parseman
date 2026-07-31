# Derived tokenization

**Status:** design, **not implemented**. No prototype exists at the time of writing;
no byte or speed number in this document describes this design. Every figure quoted
below is a measurement of the *current* compiler and its artifacts, cited as evidence
that motivates the design. Sections are explicitly marked **settled** (owner
decision, build to it) or **hypothesis** (plausible, unmeasured, needs a prototype).

This document is also the **register of untried experiments** (§11), **measured dead
ends** (§12), and **methodological notes** (§13) for artifact size and parse speed.
That half is arguably the more valuable one: the settled design can be re-derived
from the code, but an untried-experiment list and a dead-end list exist nowhere else
and are re-derived only by repeating the work.

**Audience:** anyone working on the macro, the codegen, first-set gating, `dispatch`,
or trivia handling. Related: [`artifact-format.md`](./artifact-format.md) — the
version-lock invariant and the *override invariant* (a named rule is never inlined)
both constrain what this design may do to emitted rule functions.

---

## 1. The core idea (settled)

Parseman knows every terminal in a composed grammar at **macro time**. Every
`literal`, every `keywords`/`word` set, every `regex` is a static, enumerable member
of the grammar's terminal alphabet. That alphabet *is* a lexer specification, and it
is already sitting in the compiler.

> **Derive a scanner from the composed grammar's terminal alphabet, and emit rules
> that dispatch on a token id instead of re-scanning characters at each decision
> point.**

Authors write the same combinators they write today. The lexer is **inferred**, not
declared. There is no grammar rewrite, no separate `.l` file, no token-name namespace
for authors to maintain. This is a compiler change, not a language change.

The measured alphabets are scanner-sized, not pathological:

| Grammar | Terminals | Breakdown |
| --- | --- | --- |
| css | **75** | 30 literals, 5 keyword sets (13 words), 32 regexes |
| scss | **94** | |
| jess | **114** | |
| less | **151** | |

*(Measured against the current composed grammars.)* A 151-symbol alphabet is an
ordinary lexer. Nothing here requires a scanner generator of unusual size.

---

## 2. Scanning is on demand, never a whole-document pass (settled)

The classic objection to lexing CSS-family languages is **modes**: the same bytes
mean different things in a selector, a value, an at-rule prelude, and an
interpolation. A whole-document tokenizer must therefore guess a mode ahead of the
parser, and gets it wrong.

This design does not have a pass to be in the wrong mode for.

> **At a choice, scan just far enough to pick the arm.** Nothing is tokenized until a
> decision needs it, and the decision supplies the context.

That makes the artifact a token **cursor**, not a token **stream**. There is no
buffered token array produced ahead of the parser, no re-lex-on-mode-switch, no
"restart the tokenizer at position N" recovery path.

### It composes with first-set gating; it does not replace it

First-set gating already scans **one character** at a choice to reject arms. This
design scans **one token** at the same choice. Same shape of work, same place in the
control flow, strictly more discriminating: a token distinguishes `~=` from `~`, and
`url(` from `u`, where a single character cannot.

The intended relationship is *upgrade in place*: the gate stays where it is and its
key gets wider. Existing gating machinery, diagnostics, and the poisoned-first-set
rules (a `gate(...)` leading a choice arm still poisons dispatch) carry over
unchanged.

---

## 3. One token per position (settled)

> **A token at a position is scanned once. Every arm of that choice reads the same
> value. Nothing rescans.**

This is the load-bearing invariant, and it is where the cost model changes:

- **Today:** cost of a choice scales with *arms tried* and with *backtracking* —
  each arm re-examines the characters at the same position, and a failed arm that
  backtracks hands the next arm the same bytes to re-read.
- **Under this design:** cost is bounded by **positions visited**. Arms are integer
  comparisons against an already-computed id. Backtracking to an already-scanned
  position costs nothing to re-tokenize.

This is strictly better than the current character-at-a-time gating on the same
grammar shape, and it is the mechanism by which the size win and the speed win are
the same win: an arm that is an integer compare needs no emitted scan code.

---

## 4. Adjacency is a bit set at scan time (settled)

`noTrivia` asks one question: *was there nothing between the previous token and this
one?* The scan loop already answers it and throws the answer away — it has a
skip-trivia step, and it already knows whether that step consumed anything.

> **Record "no trivia preceded me" as a bit on the token at scan time.** `noTrivia`
> becomes a bit test.

Explicitly **not**:

- **not** trivia tokens in the stream — trivia is still skipped, not emitted (except
  in selector mode, §5);
- **not** a positional compare at the consuming site — that is the re-derivation this
  replaces.

This serves **262 `noTrivia` sites** across the dialect grammars (measured: css 46,
less 115, scss 40, jess 61). Positions remain available as an **escape hatch**: if a
site needs *span-level* adjacency (byte-range touching) rather than
*consecutive-token* adjacency, it can still compare positions. The bit covers the
common case; it does not remove the general one.

---

## 5. Selector context is a scanner mode (settled)

`.a .b` and `.a.b` are different selectors. In selector context, whitespace is
**significant** and must be emitted as a token. Everywhere else it is skipped and
only the adjacency bit of §4 survives.

> **A mode flag on the scan loop — one scanner, two behaviours — not two scanners.**

Precedent exists: `scanSkip` is already declared **per composed grammar**
(`rules({ scanSkip }, factory)`, threaded as `ctx.scanSkip` and baked as the compiled
seed). Making the skip behaviour a scan-loop parameter is an extension of a knob the
compiler already turns, not a new axis.

Note the deliberate asymmetry with §2: modes are dissolved *for the parser* because
scanning is on demand, but whitespace significance is a property of the **scan
loop's skip set**, and that one flag remains. It is one bit of context, supplied by
the calling rule, not a mode the scanner must infer.

---

## 6. `dispatch` keys on a token; `routed()` produces one (settled)

A `dispatch` is already *compute a key, then select*. Today it computes the key by
scanning characters and comparing strings. As a token id it is an **integer switch**.

`routed()`'s at-keyword lookup **is** tokenization of an at-keyword — the consumer
grammars spell it as a chain of case-folded string comparisons over the at-rule name.
That chain is exactly the thing a scanner produces for free, and it is where the
artifact is fattest.

The two largest css rules are at-keyword dispatches (measured):

| Rule | Emitted size |
| --- | --- |
| `_r_DeclarationListAtRule` | **214,134 B** |
| `_r_StylesheetAtRule` | **203,792 B** |

Over 400 KB of the css artifact is two string-comparison chains that a token id
replaces with a switch. **Hypothesis:** this is the single largest size win available
and the first thing a prototype should target.

---

## 7. The correctness argument (settled — and independent of size)

This is the part of the case that does **not** depend on any performance number.

`noTrivia`, `nthNameBoundary`'s `(?![-_a-zA-Z0-9-￿])` lookahead, and the ~14
`keywords(..., boundary: '-_0-9A-Za-z')` sites are all **hand-rolled approximations
of the same question**: "is the next thing adjacent?" Three spellings, one concept,
each maintained separately, each spelled as a character class an author must get
right by hand.

**Two have shipped live bugs from mis-spelled character classes.**

1. **The `nth-` boundary.** The class was written to end `…0-9-￿`, intending the
   non-ASCII tail `-￿`. The range's low bound was dropped, so only U+FFFF
   itself remained in the class and **65,407 code points (U+0080–U+FFFE) fell outside
   the boundary set**. `:nth-childé(2n)` was rejected. Fixed in jess at `46a395ede`.
2. **The keyword boundaries.** `boundary: '-_0-9A-Za-z'` is ASCII-only, so a non-ASCII
   character reads as a boundary: in `redé`, the guard is satisfied after `red`, the
   keyword matches, and the trailing `é` is left dangling — the parse of the whole
   identifier fails. Same failure for `@supportsé` and `tané` in Less.

Both bugs are *the same bug*: an author writing, by hand, a character class that
approximates "not an identifier continuation".

> **A scanner-set bit cannot be mis-spelled.** If the scanner produced the token, the
> scanner already decided where the token ended, using the same maximal-munch rule
> for every terminal in the alphabet. Adjacency is then a fact about two tokens, not
> a predicate an author re-states per site.

This argument stands even if the size and speed wins turn out smaller than expected.
It is the reason to want derived tokenization independent of the artifact numbers.

---

## 8. The size evidence (measured)

All figures below are measurements of the **current** artifacts, quoted to size the
problem. None of them is a prediction about this design.

### 8.1 What the artifact is spending bytes on

| Grammar | Capture bookkeeping | Share of artifact |
| --- | --- | --- |
| css | **1,318,267 B** | **37.2%** |
| less | **1,759,812 B** | **40.9%** |

Mark + restore alone is **27–29%**. That bookkeeping exists because a speculative arm
must be able to rewind a character position *and* the CST capture buffer that
position implies.

**Hypothesis (unmeasured):** a token index is a cheaper rewind unit than a character
position plus a capture mark, and most of that 27–29% would go away with it. This is
the largest single claim in this document and it is **not** yet backed by a
prototype. The mechanism is plausible — rewind to token *k* is one integer, and the
tokens between *k* and the current position are already scanned so their capture
contributions are recomputable — but the interaction with the existing `sink`/`mark`
gating (which is itself a measured optimisation: the naive form regressed compiled
CSS ~2.3×, and an ungated `sink.length = mark` cost +32% on `benchmark.less`) is
exactly the kind of thing that surprises. **Measure before believing.**

### 8.2 The bar

| Artifact | Size |
| --- | --- |
| postcss `parser.js` + `tokenize.js` | **92,915 B** (58,551 + 34,364) |
| postcss-less | **15,062 B** |
| ours, css | **4,954,294 B** — **53×** postcss |
| ours, less | **5,950,263 B** — **395×** postcss-less |

### 8.3 Targets (settled)

- **≤4× the source grammar**, with **10× as the hard ceiling**.
- **250 KB is the ideal** artifact size.
- **One grammar, one artifact.**
- **No factory pattern.**

The last two are structural: a derived scanner is a property of the *composed*
grammar, so it must be emitted once per artifact, not parameterised per call site.

### 8.4 The `_r_*Block` observation, and the constraint on it

There are **14** `_r_*Block` functions in the css artifact; **ten** of them are
4,542–4,875 B with **exactly one caller each**. They read as obvious inlining
candidates.

**They are not.** [`artifact-format.md` § "Override invariant: a named rule is never
inlined"](./artifact-format.md) makes single-use explicitly *not* a licence to
inline: a named rule stays a standalone `_r_<Name>` function so that `compose()`
override resolution happens by function name at fuse time. Any size work in this area
— including anything this design does to shrink block rules — must shrink the
**bodies**, never collapse the functions. Under derived tokenization the bodies
shrink because their leading discrimination becomes an integer compare; the ten
functions stay.

---

## 9. Invariants a prototype must hold

1. **One scan per position.** Two arms at the same choice never both scan. Violating
   this reintroduces the cost model it exists to remove.
2. **No whole-document pass.** Tokenization is reachable only from a decision point.
   Any code path that tokenizes ahead of the parser is out of scope by construction.
3. **Maximal munch is uniform.** One rule, applied to the whole alphabet — not per
   terminal, not per call site.
4. **Adjacency is produced, never re-derived.** The bit comes from the scan loop.
   Consumers do not compare positions except through the documented escape hatch.
5. **Authors are unaffected.** No combinator gains a required token argument; no
   grammar file needs editing to benefit.
6. **A named rule is still never inlined** (see §8.4 and `artifact-format.md`).
7. **Version-locked like every other artifact shape.** A derived scanner table is a
   compiled artifact; per `artifact-format.md` it carries no back-compat read path.

---

## 10. Known hazards (measured counts, unresolved design)

### 10.1 Prefix pairs needing maximal munch

Terminal pairs where one is a prefix of another, so the scanner must commit to the
longest match:

| Grammar | Prefix pairs |
| --- | --- |
| css | 2 |
| scss | 5 |
| jess | 9 |
| less | 14 |

Small enough to enumerate and test exhaustively. **Open:** whether maximal munch is
always the right answer, or whether any pair needs the parser's context to choose the
shorter token. If such a pair exists, it is a genuine scannerless remainder.

### 10.2 Interpolation openers — the likely-only genuine remainder

**1–4 per dialect:** `#{`, `${`, `$[`, `$(`, `@{`, `@{-}`.

Interpolation bodies vary by dialect (Less admits a single identifier; SCSS and jess
admit a full expression), so an interpolation opener is not a self-contained token —
what follows it is parsed by the grammar, not scanned. These are the constructs
expected to stay **scannerless**: the scanner recognises the opener as a token and
hands control back.

**Open:** whether the closing `}` / `]` / `)` can be a scanned token in the enclosing
mode, or whether the whole interpolation must be a scanner escape with its own
re-entry point.

---

## 11. Untried experiments

Derived tokenization is one entry in a larger search over artifact size and parse
speed. The rest of that search is recorded here so it survives the session that
produced it. **None of the items in §11.1–§11.4 has been measured.** Status is one of:

- `untried` — no measurement attempted;
- `measured — <result>` — a number exists, cited;
- `rejected — <evidence>` — a number exists **and** it killed the idea;
- `blocked — <reason>` — cannot be measured yet, reason stated.

**No entry may be marked `rejected` without measurement attached.** An idea that
merely looks wrong is `untried`.

### 11.1 Capture-bookkeeping family

These all target the same measured mass: capture bookkeeping is 37.2% of the css
artifact and 40.9% of less, of which mark + restore alone is 27–29% (§8.1).

| # | Experiment | Status |
| --- | --- | --- |
| 1 | **Commit-discipline inversion** | `untried` |

*Idea:* accumulate speculatively and commit only on success, instead of recording
eagerly and unwinding on failure. *Why it might work:* it does not deduplicate the
restore code — it makes the restore code **not exist**. There is nothing to unwind
because nothing was committed. Directly targets the 27–29% mark+restore mass rather
than compressing it. *How to measure:* prototype on one grammar, compare emitted
bytes and the `rollback/dense` benchmark family against the current form.
*Assessment:* **highest-ceiling untried item in this document.**

| # | Experiment | Status |
| --- | --- | --- |
| 2 | **Arena / watermark capture** | `untried` |

*Idea:* capture appends into a region; rollback resets a single watermark. *Why it
might work:* same family as #1, one level down — at the allocator rather than the
control flow. *How to measure:* as #1; additionally watch allocation-rate and GC in
the parse benchmarks, since a region changes lifetime, not just bookkeeping.

| # | Experiment | Status |
| --- | --- | --- |
| 3 | **Mark stack with pointer rollback** | `untried` |

*Idea:* replace the four guarded stores at each boundary with one index assignment
into a mark stack. *Why it might work:* mechanical, low-risk, no semantic change.
*Ceiling:* bounded by the restore mass, ~18–19%. *How to measure:* emitted bytes plus
the same benchmark family; the current guarded form is itself a measured optimisation
(§8.1) so the comparison must include the ungated-store regression case.

| # | Experiment | Status |
| --- | --- | --- |
| 4 | **Shared failure epilogue per rule** | `untried` |

*Idea:* reach the restore sequence by jump rather than by copying it to each failure
site. *Why it might work:* extraction-family — the restore text exists once per rule
instead of once per boundary. *Ceiling:* floor-bounded; it compresses the current
form rather than removing it, so #1 dominates it if #1 works.

| # | Experiment | Status |
| --- | --- | --- |
| 5 | **Rule-level restore** | `untried` |

*Idea:* one unwind at the rule's failure exit, instead of a quartet at every internal
boundary. *Why it might work:* most internal boundaries never independently fail —
the rule fails as a unit. *Risk to check when measuring:* boundaries that *do* need
independent rollback (repetition arms) must be identified, or the semantics change.

### 11.2 Emission-form family

| # | Experiment | Status |
| --- | --- | --- |
| 6 | **Superoperators / superinstructions** | `untried` |

*Idea:* fuse frequently co-occurring combinator sequences into a single emitted
primitive. *Why it might work:* **the one candidate in this list that could be both
smaller and faster**, because fusing removes the dispatch *between* the fused
operations as well as their duplicated text. *How to measure:* mine the emitted
artifacts for the top co-occurring sequences, fuse the top *n*, compare bytes and
parse time.

| # | Experiment | Status |
| --- | --- | --- |
| 7 | **Table-driven emission (hot/cold split)** | `untried` |

*Idea:* represent rules as arrays interpreted by one small interpreter for cold
rules, keeping emitted code only for hot ones. *Why it might work:* the hot/cold
boundary in css is unusually clean — **the top ten rules hold 53.5% of rule bytes,
while css's median rule is *smaller* than jess's** (measured). A long thin tail is
exactly the population an interpreter serves cheaply. *How to measure:* pick the
cutoff from the measured size distribution, interpret below it, compare artifact
bytes and parse time on the hot benchmarks (which should be unaffected by
construction — verify that).

| # | Experiment | Status |
| --- | --- | --- |
| 8 | **Compact emission expanded at load** | `untried` |

*Idea:* ship a compact spec and build the closures at init via `new Function`. *Why
it might work:* the shipped bytes and the executed form stop being the same artifact,
so the size target and the speed target stop competing. *Sanctioned:* the owner has
explicitly accepted **a small startup cost** for this. *How to measure:* shipped
bytes, gzipped bytes, and time-to-first-parse (not just steady-state parse time).

| # | Experiment | Status |
| --- | --- | --- |
| 9 | **Defunctionalisation** | `untried` |

*Idea:* replace closures with tagged values dispatched by a switch. *Why it might
work:* removes per-closure allocation and gives V8 one monomorphic dispatch site
instead of many megamorphic call sites. *How to measure:* bytes plus parse time;
watch for the dispatch switch itself becoming the bottleneck.

| # | Experiment | Status |
| --- | --- | --- |
| 10 | **Rerolling** | `untried` |

*Idea:* turn repeated unrolled sequences back into a loop over data. *Why it might
work:* the artifact is ~86–90% repeated lines after identifier normalisation
(§13.2) — that repetition is the population. *How to measure:* bytes; parse time is
the risk side, since rerolling trades emitted text for runtime indirection.

| # | Experiment | Status |
| --- | --- | --- |
| 11 | **Deforestation / fusion of combinator pipelines** | `untried` |

*Idea:* remove intermediate structures passed between pipeline stages. *Why it might
work:* classic win where a pipeline builds a value only to destructure it
immediately. *How to measure:* allocation rate first, then bytes and time.

| # | Experiment | Status |
| --- | --- | --- |
| 12 | **Threaded code / bytecode for the cold tail** | `untried` |

*Idea:* the cold half of #7, taken further. *Why it might work:* same population,
denser representation. *Dependency:* only worth attempting after #7 shows the
hot/cold split is real in practice.

| # | Experiment | Status |
| --- | --- | --- |
| 13 | **Fuser inlining policy for the ten one-caller `_r_*Block` templates** | `untried` |

*Idea:* the ten 4,542–4,875 B block templates with exactly one caller each (§8.4).
**Hard constraint:** a named rule must **never** be inlined into its call site — that
breaks `compose()` override semantics ([`artifact-format.md`](./artifact-format.md)).
So this must be a **token-keyed shared body**, not inlining: one body, selected by
token, with the named functions preserved as entry points. *How to measure:* bytes,
plus the existing override test must stay green.

### 11.3 Analysis, not optimisation

| # | Experiment | Status |
| --- | --- | --- |
| 14 | **Re-Pair or Sequitur over the emitted token stream** | `untried` |

*Idea:* run a grammar-compression algorithm over the emitted artifact **as
analysis**, not as a shipping format. *Why it is worth doing:* it establishes the
**theoretical ceiling on repetition** in the current emitted form. Without it, every
result is judged against an arbitrary percentage; with it, a result can be judged
against what was actually available. *Note the methodological caveat in §13.1:* the
ceiling it produces bounds *repetition-removal on the current form*, and says nothing
about a different form.

### 11.4 V8 / codegen-shape items

All `untried`. Each is a small, independently measurable question about how the
emitted code meets the JIT:

| # | Question |
| --- | --- |
| 15 | **Argument-count effects on inlining.** A 14-argument helper was measured as rejected by V8's inlining heuristics (§12.4). What is the actual threshold, and does splitting a helper below it recover the win? |
| 16 | **Hidden-class shape of emitted closures.** Do the emitted rule closures share a map, or do conditional fields split them? (The analogous split has been confirmed costly elsewhere.) |
| 17 | **Do small shared helpers get JIT-inlined anyway?** If yes, extraction-family experiments (#4) cost nothing at runtime and the trade is purely bytes. |
| 18 | **Identifier length against LZ77 match length.** Shorter identifiers shrink raw bytes but may shorten gzip matches. Which dominates? |
| 19 | **gzip-aware function ordering.** Emitting similar functions adjacently should lengthen matches. Free to try; effect size unknown. |

---

## 12. Measured dead ends

Recorded so nobody re-derives them. Each carries its evidence.

### 12.1 Rule-level inline cap (K inlines per rule) — `rejected — not applicable`

Every named rule is **already emitted exactly once**. Less has **255 rule functions
at 1,322 call sites, maximum 21 references** to any one rule. There is no population
of repeated inlined bodies for a cap to constrain — and a cap of 2 would *increase*
size by forcing additional emissions. The premise (that rules are being inlined
repeatedly) is false; see also the override invariant, which forbids inlining named
rules at all.

### 12.2 Cross-artifact rule sharing — `rejected — measured, no population`

**55–59 of css's 176 rule bodies** are byte-identical in less/scss/jess — which is
**1.1–3.5% of an artifact**. Worse for the specific proposal "share the body,
parameterise the first-set guard": **zero** rule bodies differ *only* in first-set
gating. The idea has no population to act on.

### 12.3 Source-level shape sharing — `rejected — cannot change emitted bytes`

Unregistered consts are **fully inlined by the macro**, so restructuring them is
invisible in the output. `RoutedLayerBlock`, `RoutedKeyframes`, `GenericFunction`, and
`TypedGenericFunction` each produce **zero emitted functions and zero references**.
**Two independent lanes measured a delta of exactly 0** on different combinator
families. Source-level sharing is a readability change, not a size change.

### 12.4 Arity-only shared restore helper (`0665871`) — `rejected — measured regression`

Measured: `rollback/dense` **min +50.2% … +52.3%**, **won 0 of 12** benchmark cases.

Cause, established on code evidence rather than guessed:

1. The dedup key at `codegen.ts:1199` keys on `String(pairs.length)` — arity alone.
   Every parameter position therefore becomes **polymorphic** across `_cstLeaves`,
   `_cstRawChildren`, and a hoisted local, so V8 sees megamorphic property access
   where the emitted form had monomorphic locals.
2. The resulting **14-argument helpers are rejected by V8's inlining heuristics**
   (this is the origin of untried item #15).

Closure capture and wrapper introduction were both examined and **ruled out** as
causes on code evidence.

This does **not** reject the extraction family as a whole (#4 remains `untried`); it
rejects *arity-only* dedup keys. A shared helper needs a key that preserves the
monomorphism of its parameter positions.

---

## 13. Methodological notes

Both of these cost real time in the session that produced this document.

### 13.1 A bound derived within one technique family applies only to that family

The **"perfect-dedup floor" for css (1,088 KB)** bounds **line-level deduplication of
the current emitted form**. It says nothing about a different emitted form — a
commit-discipline inversion (#1), a table-driven form (#7), or a load-time expansion
(#8) all change what is being deduplicated, so the floor does not apply to them.

It was quoted **twice** in this session as though it were a ceiling on achievable
artifact size. It is not. When citing any floor or ceiling, state the family it was
derived within.

### 13.2 Byte-identity is a useless duplication metric on generated code

Generated code increments temp counters, so two structurally identical lines differ in
their identifiers and compare unequal. **Normalise generated identifiers before
counting.**

Evidence: unnormalised comparison reported **0.0% duplication** on an artifact that is
**~86–90% repeated lines** once identifiers are normalised. Any duplication number
produced without normalisation should be discarded rather than argued with.

---

## 14. Open questions

- **Rewind unit.** Is a token index sufficient to rewind CST capture, or must a
  capture mark ride alongside it? §8.1 assumes the former; nothing has tested it.
- **Regex terminals in the alphabet.** 32 of css's 75 terminals are `regex()`. Some
  already lower to `charCodeAt` scan loops (`src/compiler/scannable-terminal.ts`);
  the unscannable remainder needs a policy — scanner-with-callback, or excluded from
  the alphabet and left to the parser?
- **Token id space across `compose()`.** Ids must be assigned over the *composed*
  alphabet, after override resolution. A piece cannot carry pre-assigned ids, for the
  same reason a call site cannot carry a pre-override body.
- **Error reporting and recovery.** "Expected one of {tokens}" is a better message
  than today's; but recovery currently resynchronises on characters, and it is not
  settled whether it resynchronises on tokens instead.
- **Incremental reparse.** A token cursor's interaction with incremental reparse is
  unexamined.
- **Does gating survive, or merge?** §2 says upgrade in place. Whether first-set
  gating remains a distinct mechanism or becomes a degenerate case of token dispatch
  is an implementation call a prototype should answer.

---

## 15. What would break it

In rough order of likelihood:

1. **Letting a whole-document pass creep in** as an "optimisation" — it is the one
   thing that reintroduces the mode problem this design dissolves, and it will look
   like a straightforward buffering win.
2. **Per-site adjacency predicates surviving.** If `noTrivia`, keyword boundaries, and
   `nthNameBoundary` continue to exist alongside the scanner bit, the correctness
   argument of §7 is not collected — three spellings become four.
3. **A second scanner for selector context** instead of a mode flag. Two scanners
   drift, and the drift shows up as `.a .b` vs `.a.b` bugs.
4. **Rescanning at any arm.** Any arm that reaches for characters rather than the
   token restores the arms-tried cost model for that whole choice.
5. **Inlining named rules** to chase the size target (§8.4).
6. **A terminal that is not statically known.** The whole design rests on the alphabet
   being enumerable at macro time. A runtime-constructed terminal — a `literal()` over
   a computed string, a regex assembled at parse time — is not merely unsupported; it
   invalidates the derived scanner. If such a thing is ever wanted, it needs a
   deliberate escape hatch, not an accommodation in the scanner.

---

## 16. Summary of claim status

| Claim | Status |
| --- | --- |
| Terminal alphabets (75 / 94 / 114 / 151) | **measured** |
| Capture bookkeeping 37.2% css / 40.9% less; mark+restore 27–29% | **measured** |
| Prefix-pair and interpolation-opener counts | **measured** |
| Artifact sizes and the postcss comparison | **measured** |
| `_r_*AtRule` / `_r_*Block` sizes and caller counts | **measured** |
| 262 `noTrivia` sites | **measured** |
| The two shipped boundary bugs | **measured** (both reproduced and fixed) |
| Scanning on demand dissolves the mode problem | **settled design** |
| One token per position; cost bounded by positions visited | **settled design** |
| Adjacency as a scan-time bit | **settled design** |
| Selector context as a mode flag | **settled design** |
| `dispatch` on token id; `routed()` produces a token | **settled design** |
| Token-index rewind removes most capture bookkeeping | **hypothesis — unmeasured** |
| At-keyword dispatch is the largest single size win | **hypothesis — unmeasured** |
| Every item in §11 (19 experiments) | **untried — no measurement attempted** |
| css top-ten rules = 53.5% of rule bytes; median rule smaller than jess's | **measured** |
| Artifact is ~86–90% repeated lines after identifier normalisation | **measured** |
| Rule-level inline cap; cross-artifact sharing; source-level shape sharing; arity-only shared restore helper | **rejected — evidence in §12** |
| Any specific artifact size or parse-time figure for this design | **does not exist** |
