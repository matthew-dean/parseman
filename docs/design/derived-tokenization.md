# Derived tokenization

**Status:** design, **not implemented in `codegen.ts`**. Two standalone prototypes
have now run — an at-rule dispatch prototype (§9) and a general scanner (§10) — and
their numbers are quoted as **measured**. Nothing is wired into the compiler. No
end-to-end artifact produced by this design exists, so no whole-artifact byte or
parse-time figure for it exists either; §11 gives the arithmetic ceiling instead, and
says plainly what it does not reach. Sections are marked **settled** (owner decision,
build to it), **measured**, or **hypothesis** (plausible, unmeasured).

> ### Baseline correction — this supersedes figures quoted throughout the session
>
> The css artifact is **`lib/grammar/ast.js` = 3,336,650 B**. It is **not** 4,954,294 B.
> The larger number was the **whole css `lib/` across all four build variants**
> (13,626,294 B in full), and it was quoted repeatedly — including in the first
> revision of this document — as though it were the artifact. Every ratio derived
> from it was wrong and has been recomputed.
>
> | | corrected | previously quoted |
> | --- | --- | --- |
> | css artifact | **3,336,650 B** | 4,954,294 B |
> | × css source (114,446 B) | **29.2×** | — |
> | × postcss (92,915 B) | **35.9×** | 53× |
>
> Same build, other dialects: **less 3,937,767 B · scss 2,006,731 B · jess
> 2,052,239 B**. Percentage figures in the first revision that used the inflated
> denominator are superseded by §8 and are flagged there individually.

This document is also the **register of untried experiments** (§14), **measured dead
ends** (§15), and **methodological notes** (§16) for artifact size and parse speed.
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

The alphabets are scanner-sized, not pathological. **css, walked from the live
combinator graph** (this supersedes the 75-terminal figure in the first revision,
which came from a coarser source-level scan):

| css alphabet | count |
| --- | --- |
| literals | 31 |
| keyword sets | 30 (**68** words) |
| regexes | 57 |
| **total members** | **118** |

Adjacency- and scan-related sites in the same grammar: **50** `noTrivia`, **26**
`keywords(boundary:)`, **24** `scanTo`, **5** `token()`.

Other dialects (**scss 94 · jess 114 · less 151**) are still the first revision's
source-level count and have **not** been re-measured against the combinator graph.
Expect them to move the way css's did.

### The choice points, measured

92 choice points in css:

| | count | |
| --- | ---: | --- |
| decidable by **one** derived token | **40** | the population this design serves |
| genuine token clashes | **6** | need more than one token, or a parser decision |
| undecidable *only* because the walker bails | **46** | at a `dispatch` or an unresolved hole — a limitation of the analysis, not a finding about the grammar |

The 46 are the most important row to read correctly: they are **not** evidence that
half the grammar resists tokenization. They are places the static walker stopped.
Resolving them is analysis work, and until it is done the true decidable fraction is
somewhere between 43% and 93%.

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

### The id space is global; the candidate set is local (settled)

These are two different things and **must be kept separable**:

| | scope | why |
| --- | --- | --- |
| **token id space** | **may be global** — one integer per terminal across the whole composed grammar | ids must survive `compose()` override resolution and be comparable across rules; a dense global numbering is what makes `table[tokenId]` an index rather than a hash |
| **candidate set consulted at a choice** | **local** — only the terminals that choice can actually accept | a decision point asks "which of *my* arms matches here", never "what token is this, globally" |

**Conflating these is what produced the 7-token result in §10.** Handing a scanner the
whole 118-member alphabet and asking it to tokenize a document is not this design; it
is the whole-document tokenizer this design explicitly is not. The global numbering is
a naming scheme. It is not a licence to match against every name at every position.

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

This serves **262 `noTrivia` sites** across the dialect grammars (source-level count:
css 46, less 115, scss 40, jess 61). The combinator-graph walk finds **50** in css, so
the source-level count is a slight undercount and the other three are likely
undercounts too. Positions remain available as an **escape hatch**: if a
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
That chain is exactly the thing a scanner produces for free. **It is not, however,
where the artifact is fattest** — the first revision claimed that and was wrong.

The two largest css rules are at-keyword dispatches — but see §8.2 before reading
their size as dispatch cost: most of those bytes are save/rollback, not key chains.
The dispatch key chains across the whole css artifact are only **40,269 B (1.2%)**.

The dispatch prototype in §9 measures this decision directly, and §6.1 states the
design conclusion drawn from it.

### 6.1 Trie and table are not competing strategies (settled — design refinement)

The §9 prototype compared four strategies as though they were alternatives. They are
not. The refinement, which supersedes any reading of §9 as a strategy bake-off:

> **The trie is *how you get the token id*. The table is *what you do with it*.**
>
> - **Scanner** walks characters and yields a **small integer id** — **no slice, no
>   `toLowerCase`, no allocation**. This is the source of the measured **1.55×** speed
>   win.
> - **Dispatch** is then `table[tokenId]`, or a dense `switch` — **an index, not a
>   hash**. This is the source of the **17×** byte win.

Read the §9 numbers through that lens and the apparent trade-off dissolves:

- The **table** row was slower **because of how it got its key**, not because tables
  are slow: it sliced the input, allocated a lowercased copy, and hashed. Given an id,
  none of those happen.
- The **trie**'s 25,223 B was an **emitted comparison tree**. Once the id is a dense
  index, the arm selection becomes **data**, and that bulk goes away.

> **The configuration that plausibly dominates both — trie-walk-to-id + index-based
> arm selection — has NOT been measured.** It is the obvious next prototype. Neither
> §9 row is it.

### 6.2 Hard requirement: the discriminator must be searched for, not assumed

The hash row of §9 established this the expensive way. **A fixed discriminator is not
injective.**

Measured collisions on css's at-keyword set with a `(len, c1, c2)` key:

- `@counter-style` / `@color-profile`
- `@font-feature-values` / `@font-palette-values`

Adding the **last** character does not fix it: **11 buckets for 13 keys**.

> **Codegen must SEARCH for a distinguishing position set at macro time.** It must not
> assume one — not `(len, c1, c2)`, not "first two plus last", not any hardcoded
> triple. The alphabet is known at macro time, so the search is a compile-time cost
> paid once, and it either finds a distinguishing set or falls back to verification.

A fallback path (bucket, then verify with a full compare) must exist regardless, since
no position set is guaranteed to exist for an arbitrary alphabet.

### 6.3 Keep the hybrid open (settled)

**Table for cold dispatches, trie-to-id for hot ones.** The §9 numbers make the case
directly: **728 B beats 25,223 B**, and the table's ~20 ns extra per token is
invisible at a dispatch that runs rarely. At a hot dispatch the ratio inverts.

> This is a **per-site codegen choice driven by profile data**, not a global decision.
> Committing the whole compiler to one strategy would be choosing the wrong one for
> roughly half the sites.

---

## 7. The correctness argument (settled — and independent of size)

This is the part of the case that does **not** depend on any performance number.

`noTrivia`, `nthNameBoundary`'s lookahead, and the `keywords(…, boundary: …)` sites
are all **hand-rolled approximations of the same question**: "is the next thing
adjacent?" One concept, spelled by hand at every site, as a character class an author
must get right.

### 7.1 The scale of the under-spelling (measured)

**16 of the 26 `keywords(boundary:)` sites in css are under-spelled**, across **three
different spellings of one intent**:

| spelling | sites | defect |
| --- | ---: | --- |
| `-_a-zA-Z0-9-￿\\` | 10 | **complete** — the intended class |
| `-_0-9A-Za-z` | 15 | omits **65,408 code points** *and* `\\` |
| `-_a-zA-Z0-9-￿` | 1 | omits `\\` |

Three spellings of one predicate, and the majority spelling is the broken one. **These
survive verbatim into the artifact** — the compiler copies the author's class
through, so every one of the 16 is a live defect in shipped code.

### 7.2 The two that shipped as user-visible bugs

1. **The `nth-` boundary.** `nthNameBoundary`'s lookahead was written to end
   `…0-9-￿`, intending the non-ASCII tail `-￿`. The range's low bound was
   dropped, so only U+FFFF itself remained in the class and **65,407 code points
   (U+0080-U+FFFE) fell outside the boundary set**. `:nth-childé(2n)` was rejected.
   Fixed in jess at `46a395ede`.
2. **The keyword boundaries.** `-_0-9A-Za-z` is ASCII-only, so a non-ASCII character
   reads as a boundary: in `redé`, the guard is satisfied after `red`, the keyword
   matches, and the trailing `é` is left dangling — the parse of the whole identifier
   fails. Same failure for `@supportsé` and `tané` in Less.

Both bugs are *the same bug*, and §7.1 shows they are not two incidents but two
surfacings of a 16-site population: an author writing, by hand, a character class that
approximates "not an identifier continuation".

> **A scanner-set bit cannot be mis-spelled.** If the scanner produced the token, the
> scanner already decided where the token ended, by one munch rule applied uniformly
> to that decision's candidate set (§10 — *not* to the whole alphabet). Adjacency is
> then a fact about two tokens, not a predicate an author re-states per site.

This argument stands even if the size and speed wins turn out smaller than expected.
It is the reason to want derived tokenization independent of the artifact numbers.

---

## 8. Where the bytes actually are (measured)

Measured against the **corrected** baseline: css `lib/grammar/ast.js` = **3,336,650 B**,
**337 emitted functions**. These are measurements of the *current* artifact. None of
them is a prediction about this design.

### 8.1 Whole-artifact category breakdown

| category | bytes | share |
| --- | ---: | :--: |
| **capture save + rollback** | **723,605** | **21.7%** |
| &nbsp;&nbsp;├ rollback | 582,855 | 17.5% |
| &nbsp;&nbsp;└ save | 140,750 | 4.2% |
| char scan (`charCodeAt` / `codePointAt`) | 297,607 | 8.9% |
| trivia | 187,478 | 5.6% |
| dispatch key char-chains | 40,269 | 1.2% |

> **Supersedes the first revision.** It reported "capture bookkeeping 37.2% of css
> (1,318,267 B) / 40.9% of less (1,759,812 B), mark+restore 27–29%". Those used the
> inflated denominator and a broader category definition. **The figure to use is
> 21.7% (723,605 B) for save + rollback**, of which **rollback is the overwhelming
> majority (17.5% vs 4.2%)** — which sharpens the target: the win is in *not having
> to unwind*, not in cheapening the marks.

### 8.1.1 Which sink each mark guards — and what that does to the claim (measured)

§8.1 says where the bytes are. This says **what they are protecting**, which is the
question that decides whether a token cursor deletes them or merely renames them.

`bench/size/rollback-attribution.ts` attributes every mark and every guarded restore
in a built artifact to the `codegen.ts` site that emitted it. Attribution is by
**mark-variable prefix**: `v(ctx, prefix)` gives each emission site a unique prefix,
so the mapping is exact rather than pattern-guessed. Run against the shipped
`lib/grammar/ast.js` of all four jess dialects:

| Grammar | artifact | mark+restore | sequence boundary | everything else |
| --- | ---: | ---: | ---: | ---: |
| css | 3,336,650 B | 806,025 B (24.2%) | 375,524 B (**46.6%**) | 430,501 B (**53.4%**) |
| less | 3,937,767 B | 1,059,125 B (26.9%) | 442,460 B (41.8%) | 616,665 B (58.2%) |
| scss | 2,006,731 B | 653,805 B (32.6%) | 318,414 B (48.7%) | 335,391 B (51.3%) |
| jess | 2,052,239 B | 560,207 B (27.3%) | 256,470 B (45.8%) | 303,737 B (54.2%) |

> The css total reads 806,025 B here against §8.1's 723,605 B. Same artifact,
> **wider category**: this pass also counts the `_fields`, `_errors` and `dispatch`
> selector marks (`_mkf`, `_derr`, `_ds*`). Use §8.1's 723,605 B for the
> whole-artifact category table and this pass for the *split*, which is what it
> exists to produce.

**The sequence boundary is trivia-only.** Its four marks are `_mk`
(`_cstRawChildren`), `_mktl` (`_cstTriviaLog`), `_mklg` (`_triviaLog`) and `_mkrlg`
(`_rootTriviaLog`) — `emitSeqValues`, both the capturing and the non-capturing
branch. Across all **4,268** css sequence-boundary commit sites, the number
mentioning `_cstLeaves` is **0** and the number mentioning `_cstChildren` is **0**.
What this rollback undoes is never a leaf and never a node. It is: *I scanned
whitespace forward and recorded it, then the next term matched empty, so that
whitespace belongs outside the sequence.* `emitLeafCapture` returns `[]` under
`ctx.capAsTrivia`, which is why no leaf mark is taken here at all.

So **the CST-commit hazard does not bind at sequence boundaries.** There is no
committed leaf to defer, therefore no commit point is forced at each boundary,
therefore the save/restore is **deleted rather than renamed**. On a token cursor the
boundary's decision — "did the term consume past the scanned trivia?" — is
`endTok > scanTok`, and the trivia was never speculatively appended anywhere,
because it is a scan-time property of the token (§4).

**The other half is where the hazard does bind.** `_fc*` (`emitFallible` over a
sequence term whose `mayLeavePartialCapture` is true — 152,015 B on css) is the
genuine case: an earlier term captured **leaves** and a later term can fail. `_cm*`
(choice arms, 180,883 B) and `_ds*`/`_nt*`/`_at*` are the same shape. These delete
only if a term's leaf pushes can be **withheld** until the sequence succeeds — and
withholding them into a side buffer just renames the mark.

**They can be withheld, because a leaf is derivable from a token.** Of the **766**
leaf-capture sites in the css artifact, the emitted `value` expression is a **literal
constant at 418** and the **matched input slice at 264** — **89%** are exactly
`input.slice(tokStart, tokEnd)`, or a constant selected by the token id, and `span`
is the token's own extent. Only **45** come from a named-rule call
(`_r_AtRuleKeyword`) and ~38 from labels. A sequence can therefore record a token
index range and materialise its leaves at the owning `node()`, with a per-site
fallback for the ~11% that are not token-derivable.

**Status.** The sequence-boundary half is **measured** as clean-deleting. The
`emitFallible`/choice-arm half is **hypothesis**, plausible on the 89% derivability
figure, with no prototype. The 46.6/53.4 split is the correction to make to the
plan: **token-cursor sequence emission alone addresses under half** the mark/restore
bytes on css, and the larger half needs deferred leaf materialisation to follow it.

### 8.2 Per-rule save + rollback share

| rule | bytes | save+rollback |
| --- | ---: | :--: |
| `_r_DeclarationListAtRule` | 214,136 | **36.1%** |
| `_r_StylesheetAtRule` | 203,794 | **36.1%** |
| `_r_QueryClause` | 196,257 | 22.4% |
| `_r_TypedValueSequence` | 185,998 | 23.2% |
| `_r_ConditionalGroupAtRule` | 140,503 | **38.5%** |

**Top 20 rules = 62% of the artifact.**

This corrects a misreading in the first revision, which pointed at the two 200 KB+
at-rule dispatches and called them "two string-comparison chains". They are not. They
are **36.1% save/rollback**, and the dispatch key chains across the *entire* artifact
come to only **40,269 B (1.2%)**. The big rules are big because they are big rules
that speculate a lot — not because their key comparison is fat.

### 8.3 The bar

| Artifact | Size | |
| --- | ---: | --- |
| postcss `parser.js` + `tokenize.js` | **92,915 B** | (58,551 + 34,364) |
| postcss-less | **15,062 B** | |
| ours, css | **3,336,650 B** | **35.9×** postcss, **29.2×** its own source (114,446 B) |
| ours, less | **3,937,767 B** | |
| ours, scss | **2,006,731 B** | |
| ours, jess | **2,052,239 B** | |

### 8.4 Targets (settled)

- **≤4× the source grammar**, with **10× as the hard ceiling**.
- **250 KB is the ideal** artifact size.
- **One grammar, one artifact.**
- **No factory pattern.**

The last two are structural: a derived scanner is a property of the *composed*
grammar, so it must be emitted once per artifact, not parameterised per call site.

css at 29.2× is **outside the hard ceiling by ~3×**. See §11 for what this design
does and does not close.

### 8.5 The `_r_*Block` templates — corrected, and much smaller than claimed

There are **14** `_r_*Block` functions in the css artifact; **ten** have exactly one
caller each. Measured properly:

- They are **3,729–4,011 B** each, not the 4,542–4,875 B first reported.
- **Nine are byte-identical modulo one line** — 71 normalized lines, **70 shared**.
  The single differing line is **which at-keyword rule is called**.
- Those nine total **33,661 B**. Collapsing them to one token-keyed body saves
  **~29,500 B = 0.88%** of the artifact.
- `_r_OpaqueAtRuleBlock` shares only **54.5%** and is **genuinely different** — it is
  not a tenth instance of the same template and must not be folded in.

> **The first revision implied this was a ~148 KB opportunity. It is ~29.5 KB.** The
> shape of the finding survives — nine near-identical bodies differing by one call --
> but it is a rounding error against a 3.3 MB artifact, and should not be used to
> motivate the design.

And the constraint on it is unchanged: [`artifact-format.md` § "Override invariant: a
named rule is never inlined"](./artifact-format.md) makes single-use explicitly *not*
a licence to inline. The collapse must be a **token-keyed shared body with the ten
named functions preserved as entry points**, never an inlining.
## 9. Prototype: at-rule dispatch (measured)

**Standalone prototype. Not wired into `codegen.ts`.** One decision — the 8-key
at-rule dispatch — implemented four ways over a 470 KB corpus, 20,000 lookups × 50
runs.

| strategy | ns/token | code B | gz |
| --- | ---: | ---: | ---: |
| **current** (regex → slice → 8-way charCode chain) | 53.8–57.0 | 12,540 | — |
| **trie** (derived token, switch on `charCodeAt`, no slice) | **34.6–40.5** | 25,223 | 1,240 |
| **table** (regex → `toLowerCase` → `Map.get`) | 71.9–85.3 | **728** | 475 |
| **hash** (len + 2-char bucket + verify) | 46.6–54.9 | 1,998 | 1,052 |

Read at face value this looks like a trade: the fastest option is **2× the code** of
the current one and **35×** the smallest, and the smallest is the slowest. **That
reading is wrong** — see §6.1. The trie's speed comes from *not slicing and not
allocating*; the table's slowness comes from *how it built its key*, not from being a
table. Those are independent axes, and the prototype happened to bundle them.

What the numbers do establish:

1. **Avoiding the slice is worth ~1.55×** on this decision (53.8–57.0 → 34.6–40.5
   ns/token). That is the derived-token speed claim, measured, on one decision point.
2. **An emitted comparison tree is expensive in bytes** (25,223 B) — which is the
   argument for making arm selection *data* rather than *code*.
3. **A fixed discriminator does not work** (§6.2) — the hash row's real finding.
4. **gzip flattens the byte differences** (1,240 / 475 / 1,052 B): raw-byte
   comparisons between these strategies overstate the shipped difference considerably.

**Not measured: trie-walk-to-id + index-based arm selection**, which §6.1 argues
should take the trie's speed and the table's size. Until that exists, no row of this
table is the design.

---

## 10. Prototype: general scanner (measured) — and the decisive negative result

**Standalone prototype. Not wired into `codegen.ts`.**

### 10.1 Global maximal munch is definitively wrong

Handing the scanner the **whole 118-member css alphabet** and running it over a
**123 KB file** produced **7 tokens**.

Cause: **15 construct-local long-run regexes** — `[^()]+`-style runs and `scanTo`
prelude runs — are legitimate terminals *at the decision points that use them*, and
catastrophic anywhere else. Under global maximal munch they simply swallow the
document.

> This is the **decisive evidence for per-decision-point candidate sets** (§2, "the id
> space is global; the candidate set is local"). It is not a tuning problem and no
> ordering heuristic fixes it. A terminal like `[^()]+` is *meaningful only relative
> to the choice that offers it*.

It also **falsifies "maximal munch is uniform over the alphabet"**, which the first
revision listed as a prototype invariant. The corrected invariant is in §12.

### 10.2 The 42-regex core, gated — on `benchmark.css` (123,029 B)

Excluding those 15 leaves a **42-regex core**:

| | tokens | time | emitted raw | gz |
| --- | ---: | ---: | ---: | ---: |
| ungated | 7,986 | 8.48 ms | 21,642 B | — |
| **first-char gated** | **18,238** | **4.05 ms** | 129,755 B | **4,257 B** |

- **Gating is 2.1× faster** and produces a sane token count (the ungated run is still
  under-tokenizing).
- The gated form's **30:1 gzip ratio** (129,755 → 4,257 B) says it is almost entirely
  **duplicated candidate lines**. That is a direct, measured argument for
  **table-driven emission**: the emitted bulk is data wearing a code costume. (This is
  untried item #7, and this is the strongest evidence for it yet recorded.)

### 10.3 The honest upper bound on scan cost

Current full css parse on the same file: **12.54 ms**. Scanning **every position**
costs **4.05 ms = 32% of current parse time**.

> **That 32% is an upper bound, not a projection.** On-demand scanning (§2) calls the
> scanner far less than once per position — only at decision points. The true cost is
> unknown and lower. But 32% is the honest ceiling, and it is quoted here so nobody
> discovers it later as a surprise: **derived tokenization is not free**, and if the
> parser saves less than the scanner costs, it loses.

---

## 11. The honest total: what this design does NOT reach

This section exists so the document cannot be read as promising the target.

Everything **mechanically removable by token-keyed dispatch**, from the measured
categories in §8:

| removable | bytes |
| --- | ---: |
| capture save + rollback (§8.1) | 723,605 |
| dispatch key char-chains (§8.1) | 40,269 |
| `_r_*Block` collapse (§8.5) | 29,500 |
| **total** | **793,374 B** |

That is **23.8%** of the css artifact, taking it from 3,336,650 B to **~2,543,000 B**.

| | now | after | target |
| --- | ---: | ---: | ---: |
| bytes | 3,336,650 | **~2,543,000** | 250,000 |
| × source (114,446 B) | 29.2× | **22×** | ≤4× (10× ceiling) |
| × postcss (92,915 B) | 35.9× | **27×** | ~1× |

> **~22× source is nowhere near the 250 KB ideal, and still more than double the 10×
> hard ceiling.** Derived tokenization does not get parseman to its size target. It
> removes about a quarter of the artifact.

And the 793,374 B figure is **optimistic**. It assumes token-index rewind removes
*all* 723,605 B of save/rollback — **91% of the total** rests on that one unverified
assumption (§17, "rewind unit"). The interaction with the existing `sink`/`mark`
gating is exactly where such assumptions break: that gating is itself a measured
optimisation, whose naive form regressed compiled CSS ~2.3× and whose ungated
`sink.length = mark` cost +32% on `benchmark.less`. **No prototype has removed a
single byte of save/rollback.** Treat 23.8% as a ceiling on a ceiling.

### What the remaining ~2.5 MB is

**Node construction, field plumbing, and sequence bodies.** **Nothing measured says
tokenization touches any of it.** Reaching the size target requires a different
technique acting on that mass — the emission-form family in §14.2 (table-driven
emission, compact-emission-expanded-at-load, defunctionalisation, rerolling) is where
that work lives, and none of it has been measured either.

Stated plainly: **this design is a worthwhile ~24% with a strong independent
correctness argument (§7). It is not the path to 250 KB, and no measurement suggests
it is.**

---

## 12. Invariants a prototype must hold

1. **One scan per position.** Two arms at the same choice never both scan. Violating
   this reintroduces the cost model it exists to remove.
2. **No whole-document pass.** Tokenization is reachable only from a decision point.
   Any code path that tokenizes ahead of the parser is out of scope by construction.
3. **Maximal munch is uniform *within a candidate set*, never across the alphabet.**
   One munch rule, applied to the terminals a given decision offers. Applying it to
   the whole alphabet is **measured wrong** — it produced 7 tokens for a 123 KB file
   (§10.1). This supersedes the first revision's "one rule, applied to the whole
   alphabet".
4. **Adjacency is produced, never re-derived.** The bit comes from the scan loop.
   Consumers do not compare positions except through the documented escape hatch.
5. **Authors are unaffected.** No combinator gains a required token argument; no
   grammar file needs editing to benefit.
6. **A named rule is still never inlined** (see §8.5 and `artifact-format.md`).
7. **Version-locked like every other artifact shape.** A derived scanner table is a
   compiled artifact; per `artifact-format.md` it carries no back-compat read path.

---

## 13. Known hazards (measured counts, unresolved design)

### 13.1 Prefix pairs needing maximal munch

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

### 13.2 Construct-local long-run regexes — the hazard that was underestimated

**15** of css's 57 regexes are long runs (`[^()]+`-style, `scanTo` prelude runs) that
are correct at the decision point that offers them and ruinous anywhere else. They are
what produced the 7-token result (§10.1).

They are not excludable in general: each is a real terminal at a real choice. The
design consequence is §2's global-id / local-candidate-set split, and the measurement
consequence is that any scanner benchmark must state **which** candidate set it used.
The §10.2 figures use the **42-regex core**, i.e. the alphabet with these 15 removed —
that is a benchmark convenience, not a proposal to remove them.

### 13.3 Interpolation openers — the likely-only genuine remainder

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

## 14. Untried experiments

Derived tokenization is one entry in a larger search over artifact size and parse
speed. The rest of that search is recorded here so it survives the session that
produced it. **None of the items in §14.1–§14.4 has been measured.** Status is one of:

- `untried` — no measurement attempted;
- `measured — <result>` — a number exists, cited;
- `rejected — <evidence>` — a number exists **and** it killed the idea;
- `blocked — <reason>` — cannot be measured yet, reason stated.

**No entry may be marked `rejected` without measurement attached.** An idea that
merely looks wrong is `untried`.

### 14.1 Capture-bookkeeping family

These all target the same measured mass: **save + rollback is 723,605 B = 21.7% of
the css artifact, and rollback alone is 17.5% against save's 4.2%** (§8.1). The
asymmetry matters: experiments that make *unwinding unnecessary* attack four times the
mass of experiments that make *marking cheaper*.

| # | Experiment | Status |
| --- | --- | --- |
| 1 | **Commit-discipline inversion** | `untried` |

*Idea:* accumulate speculatively and commit only on success, instead of recording
eagerly and unwinding on failure. **The measured 17.5%-vs-4.2% rollback/save split
(§8.1) points straight at this one.** *Why it might work:* it does not deduplicate the
restore code — it makes the restore code **not exist**. There is nothing to unwind
because nothing was committed. Directly targets the **17.5% rollback** mass — the
larger of the two halves — rather than compressing it. *How to measure:* prototype on one grammar, compare emitted
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
*Ceiling:* bounded by the rollback mass, **17.5%** (§8.1). *How to measure:* emitted bytes plus
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

### 14.2 Emission-form family

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
| 7 | **Table-driven emission (hot/cold split)** | `untried` — **strongest supporting evidence of any item here** |

*New evidence (§10.2):* the gated scanner's emitted form compresses **30:1**
(129,755 → 4,257 B gz). A 30:1 ratio means the bulk is duplicated candidate lines —
**data wearing a code costume**, which is exactly what this experiment converts. Also
§16.2: the artifact is ~86–90% repeated lines once identifiers are normalised.

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
(§16.2) — that repetition is the population. *How to measure:* bytes; parse time is
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
| 13 | **Token-keyed shared body for the nine near-identical `_r_*Block` templates** | `untried` — **and now measured as small: ~29,500 B, 0.88%** |

*Idea:* the nine byte-identical-modulo-one-line block templates, 3,729–4,011 B each
(§8.5). They differ only in **which at-keyword rule is called** — precisely a token
key. Exclude `_r_OpaqueAtRuleBlock` (54.5% shared, genuinely different).
**Hard constraint:** a named rule must **never** be inlined into its call site — that
breaks `compose()` override semantics ([`artifact-format.md`](./artifact-format.md)).
So this must be a **token-keyed shared body**, not inlining: one body, selected by
token, with the named functions preserved as entry points. *How to measure:* bytes,
plus the existing override test must stay green. *Priority:* low — the corrected
saving is **0.88%**, an order of magnitude below what the first revision implied.

### 14.3 Analysis, not optimisation

| # | Experiment | Status |
| --- | --- | --- |
| 14 | **Re-Pair or Sequitur over the emitted token stream** | `untried` |

*Idea:* run a grammar-compression algorithm over the emitted artifact **as
analysis**, not as a shipping format. *Why it is worth doing:* it establishes the
**theoretical ceiling on repetition** in the current emitted form. Without it, every
result is judged against an arbitrary percentage; with it, a result can be judged
against what was actually available. *Note the methodological caveat in §16.1:* the
ceiling it produces bounds *repetition-removal on the current form*, and says nothing
about a different form.

### 14.4 V8 / codegen-shape items

All `untried`. Each is a small, independently measurable question about how the
emitted code meets the JIT:

| # | Question |
| --- | --- |
| 15 | **Argument-count effects on inlining.** A 14-argument helper was measured as rejected by V8's inlining heuristics (§15.4). What is the actual threshold, and does splitting a helper below it recover the win? |
| 16 | **Hidden-class shape of emitted closures.** Do the emitted rule closures share a map, or do conditional fields split them? (The analogous split has been confirmed costly elsewhere.) |
| 17 | **Do small shared helpers get JIT-inlined anyway?** If yes, extraction-family experiments (#4) cost nothing at runtime and the trade is purely bytes. |
| 18 | **Identifier length against LZ77 match length.** Shorter identifiers shrink raw bytes but may shorten gzip matches. Which dominates? |
| 19 | **gzip-aware function ordering.** Emitting similar functions adjacently should lengthen matches. Free to try; effect size unknown. |

---

## 15. Measured dead ends

Recorded so nobody re-derives them. Each carries its evidence.

### 15.1 Rule-level inline cap (K inlines per rule) — `rejected — not applicable`

Every named rule is **already emitted exactly once**. Less has **255 rule functions
at 1,322 call sites, maximum 21 references** to any one rule. There is no population
of repeated inlined bodies for a cap to constrain — and a cap of 2 would *increase*
size by forcing additional emissions. The premise (that rules are being inlined
repeatedly) is false; see also the override invariant, which forbids inlining named
rules at all.

### 15.2 Cross-artifact rule sharing — `rejected — measured, no population`

**55–59 of css's 176 rule bodies** are byte-identical in less/scss/jess — which is
**1.1–3.5% of an artifact**. Worse for the specific proposal "share the body,
parameterise the first-set guard": **zero** rule bodies differ *only* in first-set
gating. The idea has no population to act on.

### 15.3 Source-level shape sharing — `rejected — cannot change emitted bytes`

Unregistered consts are **fully inlined by the macro**, so restructuring them is
invisible in the output. `RoutedLayerBlock`, `RoutedKeyframes`, `GenericFunction`, and
`TypedGenericFunction` each produce **zero emitted functions and zero references**.
**Two independent lanes measured a delta of exactly 0** on different combinator
families. Source-level sharing is a readability change, not a size change.

### 15.4 Arity-only shared restore helper (`0665871`) — `rejected — measured regression`

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

## 16. Methodological notes

Both of these cost real time in the session that produced this document.

### 16.1 A bound derived within one technique family applies only to that family

The **"perfect-dedup floor" for css (1,088 KB)** bounds **line-level deduplication of
the current emitted form**. It says nothing about a different emitted form — a
commit-discipline inversion (#1), a table-driven form (#7), or a load-time expansion
(#8) all change what is being deduplicated, so the floor does not apply to them.

It was quoted **twice** in this session as though it were a ceiling on achievable
artifact size. It is not. When citing any floor or ceiling, state the family it was
derived within.

### 16.2 Byte-identity is a useless duplication metric on generated code

Generated code increments temp counters, so two structurally identical lines differ in
their identifiers and compare unequal. **Normalise generated identifiers before
counting.**

Evidence: unnormalised comparison reported **0.0% duplication** on an artifact that is
**~86–90% repeated lines** once identifiers are normalised. Any duplication number
produced without normalisation should be discarded rather than argued with.

---

## 17. Open questions

- **Rewind unit.** Is a token index sufficient to rewind CST capture, or must a
  capture mark ride alongside it? §11 assumes the former in its arithmetic; nothing
  has tested it, and it is the single largest unverified term in that total.
- **Does trie-to-id + index selection actually dominate?** §6.1 argues it takes the
  trie's speed and the table's size. **Nobody has built it.** It is the highest-value
  next measurement in this document.
- **How much of the 32% scan ceiling does on-demand scanning actually pay?** §10.3
  gives the every-position upper bound. The on-demand figure — the one that decides
  whether this design is a net speed win at all — is unknown.
- **The 46 walker-bail choice points.** Resolving `dispatch` and unresolved holes in
  the static walker would move the token-decidable fraction somewhere between 43% and
  93% (§1). Until that analysis exists, the size of the addressable population is
  genuinely unknown.
- **Regex terminals in the alphabet.** **57** of css's 118 terminals are `regex()`,
  and 15 of those are the construct-local long runs of §13.2. Some
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

## 18. What would break it

In rough order of likelihood:

1. **Tokenizing against the global alphabet instead of a local candidate set.** This
   is no longer a hypothetical failure mode — it is **measured** (§10.1), and it
   degrades to 7 tokens for a 123 KB file. Any code path that asks "what token is
   here?" without a candidate set has already broken the design.
2. **Letting a whole-document pass creep in** as an "optimisation" — it is the one
   thing that reintroduces the mode problem this design dissolves, and it will look
   like a straightforward buffering win.
3. **Per-site adjacency predicates surviving.** If `noTrivia`, keyword boundaries, and
   `nthNameBoundary` continue to exist alongside the scanner bit, the correctness
   argument of §7 is not collected — three spellings become four.
4. **A second scanner for selector context** instead of a mode flag. Two scanners
   drift, and the drift shows up as `.a .b` vs `.a.b` bugs.
5. **Rescanning at any arm.** Any arm that reaches for characters rather than the
   token restores the arms-tried cost model for that whole choice.
6. **Inlining named rules** to chase the size target (§8.5).
7. **A terminal that is not statically known.** The whole design rests on the alphabet
   being enumerable at macro time. A runtime-constructed terminal — a `literal()` over
   a computed string, a regex assembled at parse time — is not merely unsupported; it
   invalidates the derived scanner. If such a thing is ever wanted, it needs a
   deliberate escape hatch, not an accommodation in the scanner.

---

## 19. Summary of claim status

### Corrected or superseded since the first revision

| Claim | Status |
| --- | --- |
| css artifact = 3,336,650 B; 29.2× source; 35.9× postcss | **measured — CORRECTS 4,954,294 B / 53×** |
| Save + rollback = 723,605 B, 21.7% (rollback 17.5%, save 4.2%) | **measured — SUPERSEDES "37.2% / mark+restore 27–29%"** |
| css alphabet = 118 members (31 literals, 30 keyword sets / 68 words, 57 regexes) | **measured from the live combinator graph — SUPERSEDES 75** |
| `_r_*Block` collapse saves ~29,500 B / 0.88% | **measured — CORRECTS an implied ~148 KB** |
| Ten block templates are 3,729–4,011 B; nine identical modulo one line | **measured — CORRECTS 4,542–4,875 B** |
| The two 200 KB+ at-rule rules are 36.1% save/rollback, not key chains | **measured — CORRECTS "two string-comparison chains"** |
| Maximal munch uniform over the whole alphabet | **FALSIFIED (§10.1) — 7 tokens for 123 KB** |
| 50 `noTrivia` in css (vs 46 source-level) | **measured — source-level counts are undercounts** |

### Measured

| Claim | Status |
| --- | --- |
| Whole-artifact category breakdown (char scan 8.9%, trivia 5.6%, key chains 1.2%) | **measured** |
| Per-rule save+rollback shares; top 20 rules = 62% of artifact | **measured** |
| Dialect artifact sizes (less / scss / jess) and the postcss bar | **measured** |
| 92 css choice points: 40 token-decidable, 6 clashes, 46 walker-bail | **measured** |
| Dispatch prototype: trie 34.6–40.5 vs current 53.8–57.0 ns/token (1.55×) | **measured, one decision point, standalone** |
| Dispatch prototype code sizes 25,223 / 12,540 / 1,998 / 728 B | **measured** |
| `(len, c1, c2)` collides; 11 buckets for 13 keys even with last char | **measured** |
| Gated scanner: 18,238 tokens, 4.05 ms, 30:1 gzip on `benchmark.css` | **measured** |
| Scanning every position = 32% of current parse time | **measured — an upper bound, not a projection** |
| 16 of 26 css `keywords(boundary:)` sites under-spelled, three spellings | **measured** |
| The two shipped boundary bugs | **measured** (both reproduced and fixed) |
| Prefix-pair and interpolation-opener counts | **measured** |
| css top-ten rules = 53.5% of rule bytes; ~86–90% repeated lines normalised | **measured** |

### Settled design

| Claim | Status |
| --- | --- |
| Scanning on demand dissolves the mode problem | **settled** |
| Token id space may be global; candidate set is local | **settled — and §10.1 is why** |
| One token per position; cost bounded by positions visited | **settled** |
| Adjacency as a scan-time bit | **settled** |
| Selector context as a mode flag | **settled** |
| `dispatch` on token id; `routed()` produces a token | **settled** |
| Trie = how you get the id; table = what you do with it | **settled (§6.1) — supersedes reading §9 as a bake-off** |
| Codegen must SEARCH for a distinguishing position set at macro time | **settled, hard requirement (§6.2)** |
| Hybrid: table for cold dispatches, trie-to-id for hot, per-site from profile | **settled (§6.3)** |

### Hypothesis, untried, or nonexistent

| Claim | Status |
| --- | --- |
| Trie-walk-to-id + index-based arm selection dominates both prototype rows | **hypothesis — the obvious next prototype, NOT measured** |
| Token-index rewind removes most of the 723,605 B save/rollback | **hypothesis — unmeasured; the largest unverified term in §11** |
| Every item in §14 (19 experiments) | **untried — no measurement attempted** |
| Rule-level inline cap; cross-artifact sharing; source-level shape sharing; arity-only shared restore helper | **rejected — evidence in §15** |
| **Mechanically removable total: 793,374 B, 23.8%, to ~2,543,000 B (22× source)** | **arithmetic over measured categories — NOT an end-to-end result** |
| That this technique reaches 250 KB, or 10×, or 4× | **NO — see §11; it does not, and nothing measured suggests it does** |
| Any end-to-end artifact size or parse-time figure for this design | **does not exist** |
