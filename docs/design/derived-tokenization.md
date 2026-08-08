# Derived tokenization

**Current status:** the derived scanner is **not wired into the canonical engine**.
The 0.46 source-codegen token-keyed `dispatch` experiment (§9.1, commits `caa3d14` /
`e8612eb`) is historical: `codegen.ts` was deleted in 0.47. The shipping path is one
compact `TableProgram` linked to closure pieces by `assemble.ts`. Sections below mix
current design, historical measurements, and rejected source-codegen forms; the
status labels identify which is which.

> ## Read these first — two results that invert earlier expectations
>
> 1. **The entire parse-time spread across every dispatch configuration is 2.4%**
>    (§9.1.1). Dispatch keying is **not** where css parse time goes. The technique
>    won on every axis it was measured on, and the win is small. **Effort should
>    redirect to the save/restore mass** (§8.1).
> 2. **The 1.83× speedup claimed earlier was NOISE and is WITHDRAWN** (§16.4). Three
>    configurations producing a **byte-identical** artifact measured **5.961, 6.101
>    and 11.952 ms** in separate processes. The chain baseline is **6.092 ms**, not
>    12.540 ms, and this document's own "32% of parse time" scan-cost share is
>    withdrawn with it (§10.3).
>
> 3. **The largest win of the day came from somewhere else entirely.** A
>    commitment/nullability question — **the `else` is unreachable for a non-nullable
>    term** — took css from 3,336,650 to **3,014,384 B (−9.66%)** with **no token
>    cursor involved** (§8.6). That is roughly **13× the entire dispatch thread**,
>    which is now closed as **LEGACY** (§9.2).
>
> Two methodological invariants follow, and they bind the whole workstream:
> **byte-level tree equality against a toggled baseline is the gate, not the test
> suites** (§16.3 — a shipped bug that 288 tests missed), and **every parse-time
> claim comes from interleaved rounds in one process** (§16.4). The instrument's
> noise floor is **~1%** — two byte-identical artifacts A/B'd at 5.144 vs 5.200 ms
> (§16.5), so a 1% spread is harness, not result.

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

## Contribution tags

**Every measured result and every register entry carries one of four tags**, so it is
visible at a glance how a piece of work relates to the token-cursor design. This exists
because effort was going into work that improves the **current emitter** but **will not
survive the rewrite**.

| tag | meaning |
| --- | --- |
| **FOUNDATION** | The token design needs this **regardless**. Do it now; it is not speculative. |
| **ENABLED-BY** | Only reachable **once the token design lands** — or may be **dissolved** by it. |
| **ORTHOGONAL** | Real work, **unrelated to the architecture**. Correctness fixes, gate repairs. |
| **LEGACY** | Improves the **current emitter**; **will not survive the rewrite**. Recorded, not worked. |

**FOUNDATION** covers: commitment/nullability analysis; combinator-depth disjointness;
the shared analysis module consumed by both codegen and interpreter; the derived
scanner; adjacency as a scan-time bit (§4); selector context as a scanner mode (§5).

Tags on the **measured** sections are the owner's. Tags on **register entries** are
assigned from the definitions above and are the most likely thing in this document to
be wrong — each carries a one-line rationale so a wrong one is visible and cheap to
correct.

> **A LEGACY tag is a PRIORITY statement, not a withdrawal.** The withdrawal rule
> (§14) is unchanged: an entry may only be withdrawn if **proven impossible** or its
> **premise proven false**. Tagging something LEGACY says *do not spend on it*; it does
> not say the finding is wrong, and it does not remove the entry.

---

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
for authors to maintain. Deriving and reusing a token can be a compiler-only change;
using tokens to predict past ordered PEG choice can be a language change. §2.1 makes
that boundary explicit so the implementation cannot choose semantics accidentally.

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

## 2. Recognize at the current cursor, then choose or trial from that result (settled) [FOUNDATION]

The design target is to classify every statically enumerable terminal the grammar
reaches. At a parser decision, the operation is:

```text
recognition = tokenize(input, currentPosition, lexicalContext)
branch = chooseInPegOrder(recognition)
```

`recognition` is one position-local result, not a whole-document stream. In
the common unique case it contains one id/value/end and choice is an integer fork. If
prefix-overlapping or same-token arms remain, it may expose compact compatible token
views so each PEG arm can try using the already-computed recognition rather than
rescanning characters. Tokenization is the discriminator and the substrate for cheap
trial; it does not imply that every decision has exactly one viable arm.

Tokenization is not conditional on arms already having
distinct first characters or on the conservative lead-terminal walker proving one
terminal per arm. Shared `@`, identifier/function, number/unit, prefix, wrapper and
rule-ref families are the principal reason to scan the full token before choosing.

`lexicalContext` is supplied by the current parser site: selector, value, at-rule
prelude, interpolation, or a compiled candidate-set identity. The scanner does not
guess it. The cursor remains stated in character offsets so spans, recovery and the
scannerless escape hatch keep their existing coordinate system.

The measured seven-token failure in §10 rejects only **mode-free maximal munch with
every terminal active everywhere**. Fifteen construct-local long-run regexes swallowed
a 123 KB document outside the contexts where they mean anything. The correction is to
activate terminals by lexical configuration, not to accept 32–44% token coverage or
ban comprehensive tokenization.

### Global identities, position-local recognition (settled)

| | scope | why |
| --- | --- | --- |
| **token id space** | **global** — one integer per terminal across the composed grammar | ids survive `compose()` resolution and let parser pieces fork on integers |
| **lexical context** | supplied by the current parser site; may be a named mode, candidate-set id, or a compiled combination | the same bytes can denote different terminals in different grammar contexts |
| **pending token result** | current cursor position plus the site/context that requested it | the choice and its tried/selected branches share one recognition result; the unique fast path is one id/value/end, while proven overlaps may carry compact compatible views |

Candidate sets are one representation of lexical context, not an eligibility filter
that admits only already-disjoint arms. The analysis must resolve wrapper and rule
leads far enough to present the scanner with the terminals the current decision can
recognize. Genuine same-token ambiguity may leave more than one parser branch, but it
does not make the position untokenizable.

### It composes with first-set gating; it does not replace it

First-set gating already reads **one character** and directly selects among disjoint
arms. Finishing a token solely to make that same decision would add work. Token
coverage and eager tokenization are separate questions: a terminal can be tokenizable
even when the cheapest choice path selects its arm before requesting the full token.

| decision shape | cheapest branch selection | token use |
| --- | --- | --- |
| disjoint first characters | existing O(1) character gate | the selected arm may finish a token from that known lead and pass it forward |
| shared character, distinct full tokens | tokenize once, then integer-fork | selected arm consumes the result |
| same-token or prefix overlap | tokenize once into compatible views, then ordered PEG trial | every compatible arm reuses the result across rollback |
| non-choice optional-loop exit | character/EOF guard | request no token merely to stop the loop |

A token distinguishes `~=` from `~`, and `url(` from `u`, where a character cannot.
The intended relationship is *upgrade in place*, not “tokenize eagerly everywhere”:
reuse the character gate when it has already solved the choice, and widen recognition
to a token when the decision or selected arm benefits. Existing gating machinery,
diagnostics, and the poisoned-first-set rules (a `gate(...)` leading a choice arm
still poisons dispatch) carry over unchanged.

#### Seeded recognition after a character gate

When a disjoint first-character gate has already selected an arm, the selected arm
must be able to turn that work into a token instead of restarting recognition from
scratch. The assembly seam is conceptually:

```text
seed = {
  position,          // post-trivia terminal start
  lead,              // code unit/code point or class already read by the gate
  prefixLength,      // normally 1; may be longer for a trie/prefix gate
  lexicalContext,
  triviaState        // adjacency / trivia facts already established
}

pending = recognizeSeeded(input, seed)
```

The recognizer starts in the state implied by `lead`/`prefixLength` and continues at
`position + prefixLength`. It does not re-read the known prefix. The result is an
immutable, parse-local record containing at least `{ position, contextId, tokenId,
end, value, adjacency }`. The selected terminal consumes that record; later terminal,
sequence or dispatch pieces can reuse its id/value/end. If an attempted arm rolls
back to the same position and lexical context, another compatible PEG arm reuses the
same result or compatible prefix view rather than recognizing the characters again.

Recognition and consumption stay separate. Creating `pending` does not publish CST
leaves, fields, errors, trivia or commitment. Consumption performs those effects.
That keeps the recognition record valid across ordinary PEG rollback while preserving
probe, tolerant recovery and expected-set behavior. Moving the cursor, changing the
lexical context, or beginning a new parse invalidates it; a result from one context is
never reused for a different active-terminal set at the same character position.

The shared recognition contract therefore needs two entries into the same kernel:

- `recognizeRaw(position, context)` for a site that has not read a prefix;
- `recognizeSeeded(seed)` for a gate/trie that has.

Literal, word, keyword-trie and straight-line scannable-terminal kernels should expose
the seeded entry directly. A terminal backed only by an opaque native `RegExp` may be
unable to resume after a prefix. In that case assembly chooses between eager raw-token
recognition and the existing character-gated raw terminal path; it must not add a
nominal seeded wrapper that simply reruns the whole regex. Comprehensive token
coverage does not require every site to request the token at the same point.

Every performance comparison keeps these three shapes separate:

1. eager token recognition before choice;
2. disjoint character gate followed by seeded token completion;
3. current character gate followed by the raw terminal.

Report terminal calls, known-prefix re-reads, pending-result hits, parse time and
artifact bytes. A win in the shared-leading eager path does not prove seeded
recognition wins at disjoint sites, and vice versa.

### It composes with fixed pieces; it does not reset the lowering

The current shipping architecture adds a second integration constraint that the
original source-codegen design did not have. `compile()` and macro artifacts carry
one compact `TableProgram`, then `assemble.ts` links that program to shared closure
pieces. A token cursor is therefore an **assembly-selected acceleration of those
pieces**, not a second lexer/parser engine and not a reason to discard useful
character-path work.

The durable shape is layered:

1. **Use the cheapest sound discriminator and pass its work forward.** A disjoint
   first-character gate may select directly and seed later token recognition with the
   known lead. Shared-leading choices use the token result: unique ids fork directly,
   while compatible overlaps remain cheap ordered PEG trials over that same result.
   Do not perform a complete character-level choice and then repeat the same terminal
   recognition in an unrelated scanner.
2. **Keep cheap non-choice guards.** EOF and finite first-character exclusions may
   still stop optional loops before any child or token work. Scannerless sites are
   explicit exceptions, not the conservative default.
3. **Pass the classified result forward.** Every tried terminal uses, and the selected
   terminal consumes, a pending result containing at least the position, terminal
   identity and end (or a compatible prefix view). A gate that scans and then lets an
   arm scan again is not token-cursor integration; it is added work.
4. **Share recognition semantics.** Fixed literal/regex recognizers are both the
   scanner's kernels and the raw-input fallback. Do not create an unrelated scanner
   implementation beside unrelated terminal pieces.
5. **Keep composite improvements.** Sequence, node, repeat, rollback, capture and
   reducer costs outside terminal recognition remain real. Token-aware pieces may
   remove a leading-terminal call, but they do not make those costs disappear.

This makes the implementation order explicit: bank a large first-character or
composite win when it remains useful in front of, behind, or outside token-aware
sites. Defer only a shape that would duplicate recognition or make a pending token
impossible to consume. Token cursors constrain the seam; they do not reset the work.

**Current evidence.** The preserved static probe's 32–44% is only the reach of a
walker that stops at wrappers/refs and requires distinct lead terminals; it is not
tokenizability. Frequency-weighted nested-lead analysis on the canonical closure
artifacts finds that position-token choice can remove **10.1% of actual arm entries
on benchmark.less and 12.3% on generated Less**, concentrated in one `Value` choice
with zero observed winner mismatches. The same classifier removes only **0.5%** on
CSS. A global longest-match rule is not yet safe at every site (303/1,552 Less winner
mismatches), so each lexical context needs a proof or fallback. The next gate is a
pending-result implementation at the proven `Value` site; timing remains unclaimed.

### 2.1 Parsing semantics over tokens: three different designs

Moving recognition from characters to tokens creates an LL-style prediction seam,
but it does **not** by itself decide Parseman's parsing semantics. These are different
architectures:

| design | decision rule | effect on ordered choice |
| --- | --- | --- |
| **tokenized PEG** | recognize once at the position; each arm tries from the shared token result; incompatible arms fail immediately and compatible arms stay in source order | preserves Parseman's contract |
| **LL(k) / LL(*) prediction** | select a production from bounded or regular token lookahead before parsing the arm | can change overlapping-choice behavior |
| **ALL(*)-style adaptive prediction** | explore viable productions over token lookahead at parse time, choose a survivor, and cache the decision DFA | can preserve source-order precedence for ambiguities, but is not strict PEG prefix commitment |

The release-safe first step is **tokenized PEG**. Cheap ordered trial and tokens are
not alternatives: trial uses the shared token result. If `choice(literal('a'),
literal('ab'))` sees `ab`, recognition may exclude unrelated arms, but it may not
silently select `ab`: today's PEG contract lets the first arm consume `a`. The result
must retain the compatible prefix view needed by that arm, and after an attempted arm
rolls back the next compatible arm reuses the same position result. A unique
token-to-arm mapping executes like LL(1), but that is an optimization result, not a
semantic pivot. Same-token and prefix-overlap survivors stay in source order and use
the existing attempt, commitment, runtime-gate, probe and recovery rules.

This preserves an important authoring property. Parseman rewards LL(1)-like,
first-character-disjoint arms with O(1) dispatch, but does not require authors to
left-factor every overlap or prove that a fixed `k` distinguishes every path for the
grammar to be correct. Ordered trial is the semantic fallback. The implementation
goal is to make recognizing, rejecting and rolling back that trial cheap enough that
authors can organize rules around the language rather than around a predictor.

Static multi-token prediction would be an LL(k)/LL(*) feature. Adaptive prediction
would be closer to ALL(*): the algorithm described by Parr, Harwell and Fisher
launches alternative subparsers at a decision, advances them over lookahead, and
caches observed prediction paths as DFA states. It resolves an ambiguity by production
order, but it chooses the first alternative that leads to a valid parse, whereas PEG
commits to the first alternative that matches a prefix. Those are observably different
rules; `a | ab` is the paper's minimal example. See
[Adaptive LL(*) Parsing: The Power of Dynamic Analysis](https://www.antlr.org/papers/allstar-techreport.pdf).

Therefore the architecture decision is:

1. **0.48 token work preserves PEG.** Tokenization owns recognition; every ordered
   arm trial uses that result. It removes impossible arms cheaply but does not look
   past a viable earlier arm to choose a later one.
2. **LL(k) and adaptive prediction remain explicit experiments, not an accidental
   consequence of a token cursor.** Either would need a versioned public-semantics
   decision plus differentials for overlapping alternatives.
3. **An ALL(*)-inspired predictor must beat tokenized PEG after charging prediction
   construction.** Knowing the path is useful only when computing and caching it is
   cheaper than the speculation it removes.

The third rule comes from a concrete JavaScript warning. The Chevrotain ALL(*) plugin
keys each ATN configuration with a string containing its alternative, state and whole
call stack, then concatenates all such keys into another string for DFA-state identity
([`dfa.ts` at `573c41b`](https://github.com/TypeFox/chevrotain-allstar/blob/573c41bdd8715c7fc929f3b97aa51731292405dd/src/dfa.ts#L30-L72)). Its predicate-set DFA
cache is string-keyed too
([`all-star-lookahead.ts` at `573c41b`](https://github.com/TypeFox/chevrotain-allstar/blob/573c41bdd8715c7fc929f3b97aa51731292405dd/src/all-star-lookahead.ts#L56-L94)). On large
paths those structures can become the workload. Parseman must not copy that shape:
prediction identities are compact integers/table words, state growth has a hard
per-decision ceiling, and exceeding the ceiling falls back to tokenized PEG. Any
prototype reports cold construction time, warm parse time, maximum live
configurations, cache bytes and artifact bytes separately; a warm-only speedup cannot
hide an explosive predictor.

---

## 3. One position-recognition result per cursor decision (settled) [FOUNDATION]

> **The choice recognizes its current position once. Every ordered arm trial uses
> that result, and the chosen branch consumes it. No arm rescans characters.**

This is the load-bearing invariant, and it is where the cost model changes:

- **Today:** cost of a choice scales with *arms tried* and with *backtracking* —
  each arm re-examines the characters at the same position, and a failed arm that
  backtracks hands the next arm the same bytes to re-read.
- **Under this design:** a decision pays for one tokenization at its cursor position.
  Incompatible branches are integer/set checks; compatible PEG trials use the same
  recognized id/value/end or prefix view; and the selected branch receives that result
  rather than matching the bytes again.

This is the intended cost model, not a universal speed guarantee. Classification
has a cost; at a low-frequency site or a site already decided by one character, it
can cost more than the arm entries it removes. The implementation must therefore be
site-selected and frequency-weighted. Where it qualifies, an incompatible arm becomes
an integer/set rejection and a compatible terminal reuses the same result instead of
emitting or calling a second recognizer.

---

## 4. Adjacency is a bit set at scan time (settled) [FOUNDATION]

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

## 5. Selector context is a scanner mode (settled) [FOUNDATION]

`.a .b` and `.a.b` are different selectors. In selector context, whitespace is
**significant** and must be emitted as a token. Everywhere else it is skipped and
only the adjacency bit of §4 survives.

> **A mode flag on the scan loop — one scanner, two behaviours — not two scanners.**

Precedent exists: `scanSkip` is already declared **per composed grammar**
(`rules({ scanSkip }, factory)`, threaded as `ctx.scanSkip` and baked as the compiled
seed). Making the skip behaviour a scan-loop parameter is an extension of a knob the
compiler already turns, not a new axis.

The current parser site supplies this lexical context to the position cursor. The
scanner does not infer selector mode from bytes; it applies the context while
classifying the token on which the parser will choose.

---

## 6. `dispatch` keys on a token; `routed()` produces one (settled) [LEGACY — thread closed, §9.2]

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

> **MEASURED SINCE (§9.1): this is what landed.** trie-walk-to-id with if-chain arm
> selection is now the shipped default. It won on SIZE, raw and gzipped. It did NOT
> win on speed: §9.1 measures `trie:switch` at 5.945 ms against `trie:ifchain` at
> 5.967 ms, so the shipped configuration is the smallest and the second fastest. The caveat is the size of the prize: the whole spread
> across every configuration is **2.4%** (§9.1.1).

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

> **MEASURED (SS9.3): the search works.** `phash` finds an **injective** `(position
> pair, multiplier, modulus)` over the real css at-keyword set. A *searched*
> discriminator is therefore **available** where the fixed `(len, c1, c2)` failed --
> the failure above was of the assumption, not of the technique. Perfect hashing lost
> the sweep on **table bytes**, not on feasibility. Any earlier reading of this section
> as "a searched discriminator may not exist" is corrected by that result.

### 6.3 Keep the hybrid open (settled)

**Table for cold dispatches, trie-to-id for hot ones.** The §9 numbers make the case
directly: **728 B beats 25,223 B**, and the table's ~20 ns extra per token is
invisible at a dispatch that runs rarely. At a hot dispatch the ratio inverts.

> This is a **per-site codegen choice driven by profile data**, not a global decision.
> Committing the whole compiler to one strategy would be choosing the wrong one for
> roughly half the sites.

---

## 7. The correctness argument (settled — and independent of size) [FOUNDATION]

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

### 7.3 The same argument generalises: declare equivalences once

Boundary spelling is one equivalence hand-spelled per site. **Escapes, ASCII case
folding, the `--` prefix and vendor prefixes are others**, and they are handled today
ad-hoc, inconsistently, or not at all — the escape alternatives inside the ident
regexes alone repeat at **11** and **9** sites in css. The `| 32` bug (§16.3) was a
broken special case of ASCII case folding.

**§14.5 records the owner's design direction for this — "auto-alias for token
detection" — and the four approaches to measure.** In a token model the token id is
the canonical thing, so escapes and case would stop being the grammar's problem
entirely rather than being centrally handled.

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
### 8.6 LANDED — the unreachable `else`: the largest win measured to date [FOUNDATION]

**Tag: FOUNDATION.** This needed **no token cursor at all**, and the token design needs
it regardless. It is the clearest demonstration of why the tag scheme exists: it is
worth **13×** the entire dispatch thread (§9.2) and was found by asking a
*commitment/nullability* question, not a tokenization one.

A sibling lane measured, on css `ast.js`:

| | before | after | delta |
| --- | ---: | ---: | ---: |
| artifact | 3,336,650 B | **3,014,384 B** | **−9.66%** |
| gzip | | | **−7.93%** |
| expansion vs source | 29.16× | **26.34×** | |
| boundary mark/restore | 375,524 B | **135,246 B** | **-64%** |
| boundary clauses | 4,268 | **1,651** | |

**Mechanism: the `else` is unreachable for a non-nullable term**, decided by
`matchesEmpty` **at macro time**. If a term cannot match empty, the boundary's
rollback arm cannot be taken, and the whole clause is deleted rather than emitted and
never executed. It also found that **`_cstRawChildren` never needed a mark even for
nullable terms**, because no trivia function pushes a raw child.

#### The conversion split is the actionable part

**165 of 558 boundaries converted. 393 fall back SOLELY because the term is reported
nullable** — and `matchesEmpty` **deliberately errs toward nullable** when it cannot
resolve.

> So **a sharper nullability analysis converts more, by the same predicate as
> commitment.** That is not a separate project: commitment analysis and nullability
> analysis are the same FOUNDATION work, and 393 boundaries are sitting behind its
> precision. This is the highest-value known lead in the document.

#### Its own caveat, recorded by the lane that produced it

`_mk*` prefixes are **minted by three emitters**, so §8.1.1's "46.6% is sequence
boundary" attribution is an **upper bound**, not an exact split. The **artifact delta
is instrument-independent** — it is a byte count of two built files — and **stands**
regardless.

---

## 9. At-rule dispatch: the prototype, then the landed sweep (measured) [LEGACY]

### 9.0 The standalone prototype that the design was argued from

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

**Superseded by §9.1:** trie-walk-to-id + index-based arm selection has since been
built into `codegen.ts` and swept against three alternatives on the shipped artifact.
Read §9.1 for the result; this table is retained only because it is the microbenchmark
the design was argued from, and because comparing the two shows how badly an isolated
decision-point measurement predicts an end-to-end one.

---

### 9.1 LANDED: the full dispatch sweep in `codegen.ts` (measured)

Token-keyed dispatch is **implemented and shipped as the default**, landed on
`release/0.46.0` as **`caa3d14`** (`feat(codegen): token-keyed dispatch via a data
trie`) and **`e8612eb`** (`fix(dispatch): fold ASCII letters only, and pick the id
strategy by measurement`). Strategies are selectable via the **`PARSEMAN_DISPATCH`**
environment variable.

**Methodology** (this matters — see §16.4): measured on the **shipped artifact**, trees
**diffed equal** against a toggled baseline, **medians of 31 interleaved rounds in one
process**.

| config | ms/parse | rel | raw B | gzip B |
| --- | ---: | ---: | ---: | ---: |
| chain (baseline) | 6.092 | 1.000 | 3,336,650 | 426,247 |
| **trie:ifchain** (landed default) | **5.967** | **0.979** | **3,311,657** | **424,465** |
| trie:switch | 5.945 | 0.976 | 3,333,421 | 424,895 |
| phash:switch | 6.011 | 0.987 | 3,331,361 | 424,637 |
| firstchar:switch | — | — | falls back to chain | — |
| lenswitch:switch | — | — | falls back to chain | — |

#### 9.1.1 The headline: the entire spread is 2.4%

> **Across every configuration — chain, trie, perfect hash, two id strategies — the
> whole parse-time spread is 2.4%.** Dispatch keying is **not where css parse time
> goes.**

This is the most consequential result in the document, and it is a **negative** one. It
means:

- The **1.55×** from the §9 microbenchmark is real *on that decision in isolation* and
  worth **~2% end-to-end**. An isolated decision-point measurement overstated the
  end-to-end effect by roughly **70×**. Treat every future microbenchmark in this
  workstream accordingly.
- **Effort should redirect to the save/restore mass** (§8.1: 723,605 B / 21.7%,
  rollback-dominant; §8.1.1 for which half is addressable). That is where both the
  bytes and, on this evidence, the time actually are.
- It does **not** retract the design. Token-keyed dispatch still won on **every**
  axis it was measured on — fastest, smallest raw, smallest gzip — and the
  correctness argument of §7 never depended on speed. It retracts the *expectation of
  a large speed win from dispatch keying*.

#### 9.1.2 Perfect hashing: the search WORKS, and lost on bytes

`phash` **finds an injective `(position pair, multiplier, modulus)`** over the real key
set. This settles §6.2's open half: a **searched** discriminator is feasible where the
fixed `(len, c1, c2)` was not.

It then **lost the sweep on table bytes** — 3,331,361 B raw / 424,637 B gz against
trie:ifchain's 3,311,657 / 424,465, at 0.987 rel against 0.979.

> Status: **`measured — works, loses on bytes`**. Not rejected as infeasible. If the
> table representation gets cheaper, it is a live candidate again, and the search
> machinery already exists.

#### 9.1.3 `firstchar` and `lenswitch`: not applicable, which is not rejected

Both **build** but do not **apply** to the css at-keyword set, and fall back to chain:

- **`firstchar`** — every at-keyword key starts with `@`, so the first character
  discriminates nothing.
- **`lenswitch`** — key lengths collide.

> Status: **`measured — not applicable to this key set`**. This is a statement about
> css at-keywords, **not** about the strategies. A dialect or a site with a
> better-separated key set could select either. Do not remove them on this evidence.

#### 9.1.4 `trie:switch`'s larger raw size is a formatter artifact

`trie:switch` emits **3,333,421 B** raw against `trie:ifchain`'s 3,311,657 — but the
difference is the **downstream formatter indenting case bodies two extra levels**, not
the emitter producing more structure. Its gzip figure (424,895 vs 424,465) is far
closer, as leading-whitespace runs compress away.

> **For switch-shaped emission, gzip is the deciding metric.** Raw bytes measure the
> formatter as much as the codegen. (This generalises §9's fourth point — gzip
> flattens these differences — into a rule for choosing between shapes.)

#### 9.1.5 What it cost, per dialect

The conversion rule as landed: **convert a site unconditionally when it has ≥3 keys
that share a case-folded walk.** Measured artifact deltas:

| dialect | delta | |
| --- | ---: | --- |
| css | **-0.75%** | -24,993 B |
| scss | -0.09% | |
| jess | 0.00% | |
| **less** | **+0.02%** | **+902 B — a REGRESSION** |

**less regresses** because it has dispatch sites whose key sets make the emitted trie
tables cost *more* than the character chain they replace. The unconditional rule
converts them anyway. Untried item **#20** (§14.2) is the fix.

Note also that css's measured **-24,993 B** came in **under** the 40,269 B this
document attributed to dispatch key chains (§8.1) — about **62%** of the predicted
category. That is a useful calibration on §11's arithmetic: **a category's byte count
is an upper bound on what converting it removes**, because the replacement is not free.

---

### 9.2 VERDICT on the whole dispatch thread: LEGACY [LEGACY]

**Tag: LEGACY.** Dispatch keying was **only ever ~1.2% of the artifact** (§8.1), and
the measured spread across every configuration is **2.4% of parse time** (§9.1.1).
Compare §8.6's **−9.66%** from a single commitment/nullability question: the
FOUNDATION item is worth roughly **13×** this entire thread.

**It is finished, not abandoned.** What landed:

- The trie shipped (`caa3d14` / `e8612eb`).
- **Experiment #20 cleared the less regression** (`2413e1f`, "take the trie only where
  it measures smaller than the chain"): **−902 B**, putting less back at **exactly its
  pre-trie size**. The per-site cost check worked as predicted in §14.2.
- **Trie-to-id + dense `switch` was built, and it LOST**: **+10,867 raw / +160 gzip**.

#### Why trie-to-id + dense switch lost — and the honest reading

This was the configuration §6.1 predicted would dominate both prototype rows. It did
not, and the cause is instructive:

- **The +10,867 B is the artifact printer**, indenting case bodies **one level deeper,
  one tab per line**, across the three largest bodies. **Net of indentation the case
  labels are *smaller*.** This is the same formatter effect as §9.1.4, now confirmed
  as the dominant term rather than a footnote.
- **No renumbering or `table[]` was warranted**: ids are already **`1..n` with no
  gaps**, so the "dense index" the design asked for **already existed**. There was
  nothing to convert.

> So §6.1's prediction is **neither confirmed nor refuted on its own terms** — the
> index it wanted was already there, and what remained was a printing artifact. The
> settled-design status of §6.1 stands; its *expected win* does not.

**Left unpushed on `lane/trie-id-dispatch`:** the matcher-site hybrid and key-walking.
**Printer indentation is an owner call**, worth **10,867 raw / 160 gzip** — small, but
free if taken.

---

## 10. Prototype: general scanner (measured) — and the decisive negative result [FOUNDATION]

**Standalone prototype. Not wired into `codegen.ts`.**

### 10.1 Mode-free global maximal munch is wrong; comprehensive cursor tokenization is not

Handing the scanner the **whole 118-member css alphabet** and running it over a
**123 KB file** produced **7 tokens**.

Cause: **15 construct-local long-run regexes** — `[^()]+`-style runs and `scanTo`
prelude runs — are legitimate terminals *at the decision points that use them*, and
catastrophic anywhere else. Under global maximal munch they simply swallow the
document.

> This is decisive evidence that the **current cursor's lexical context must select
> the active terminals**. It is not evidence against comprehensive tokenization. A
> terminal like `[^()]+` is meaningful only in the parser contexts that offer it;
> there it remains an ordinary token candidate.

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

### 10.3 Scan cost as a share of parse time — WITHDRAWN, denominator was wrong

> **The "32% of current parse time" figure is withdrawn.** It divided the scanner's
> 4.05 ms by a full-css-parse baseline of **12.540 ms**, and that baseline was
> **noise** — see §16.4. The correct chain baseline, measured interleaved in one
> process, is **6.092 ms**.

Naively re-dividing gives **~66%**, which would be a far worse result than the one
originally recorded. But the 4.05 ms numerator came out of the **same unreliable
separate-process regime** as the 12.540 ms denominator, so it is not trustworthy
either.

> ~~**Honest status: the scan-cost share is UNKNOWN.**~~ **ANSWERED — see §10.4.**
> What survives unchanged is the qualitative point: **derived tokenization is not
> free, and if the parser saves less than the scanner costs, it loses.** §10.4 is
> the measurement of both sides of that inequality.

### 10.4 MEASURED: the absorbable share [FOUNDATION]

This closes §10.3 and the §17 open question *"what does on-demand scanning actually
cost?"*. Both sides of the inequality are now numbers, on the **shipping** jess
grammars and the **AST** path (G10), 61 interleaved rounds in one process with the
noise floor carried live as a second registration of the same parse.

Method: the shipped artifact is rewritten so **every** `charCodeAt`, `codePointAt`,
`slice` and regex `exec` is counted and its input position recorded — and the
rewritten artifact is **gated on producing a tree identical to the shipped one**
before a single count is reported (§16.3). The recorded work is then **replayed on
its own**, in the same process as the real parse. Instruments and reproduction:
`scratchpad/token-cursor/`.

#### The census — exact counts, no sampling

| | css / `benchmark.css` | less / `benchmark.less` |
| --- | ---: | ---: |
| corpus bytes | 123,029 | 106,802 |
| `charCodeAt` + `codePointAt` | 590,937 | 1,248,495 |
| regex `exec` calls | 33,047 | 20,818 |
| … of which **FAILED** | **13,933 (42.2%)** | **11,803 (56.7%)** |
| `input.slice` calls / bytes | 10,943 / 117,427 | 46,694 / 483,251 |
| **total input char reads** | **697,034** | **1,311,540** |
| distinct positions touched | 123,029 (**100%**) | 106,802 (**100%**) |
| **reads per input byte** | **5.67** | **12.28** |

#### The timing

| case | css, share of parse | less, share of parse |
| --- | ---: | ---: |
| `parse` (AST) — 5.205 ms css / 15.628 ms less, min-of-mins | — | — |
| `parse-control` (the in-run noise floor) | +3.0% | +2.8% |
| `replay-cc` — the recorded char reads | 5.4% | 3.8% |
| `replay-ex` — the recorded regex execs | 13.5% | 2.9% |
| **`replay-all` — the ABSORBABLE SHARE** | **18.6%** | **7.1%** |
| `replay-slice` — leaf materialisation | 0.8% | 1.2% |
| **`scan-emit` — what the CURSOR PAYS** | **7.9%** | **1.4%** |

> **Net ceiling for a scanner-shaped change: ~10.7 points on css, ~5.7 on less.**
>
> **The cursor absorbs 2.4× (css) / 5.1× (less) what a blind one-pass tokenizer
> does** by time, and **5.7× / 12.3×** by read count. §10.3's question — does a
> token cursor move substantially *more* char-level work into the scanner than a
> css-syntax-3 tokenizer does? — is answered **yes**, with a multiple.

`replay-all` is a **lower bound**: it re-executes the reads but not the comparisons,
branches and loop bookkeeping around them, nor the dispatch-key walks, nor the
keyword-boundary and `noTrivia` predicates the scanner deletes outright (§4, §7).
`scan-emit` is a **floor**: a scanner written for this measurement, emitting
`(kind, start, end, tight)` at the finest context-free grain — it is not a proposal.

#### 10.4.1 The redundancy INVERTS against the time share

**less reads each byte 2.2× more often than css and yet character work is a 2.6×
smaller share of its parse time.** less's 3× slower parse is not character reading.

> So the scanner headroom is a **css** result, and §9.1.1's "redirect to the
> save/restore mass" is specifically the **less** prescription. They are not
> competing recommendations; they are one recommendation each, and which applies
> depends on the dialect. A single blended figure would have hidden both.

#### 10.4.2 42–57% of every regex terminal execution FAILS

13,933 of 33,047 on css; 11,803 of 20,818 on less. On css that failing population
sits inside the **largest** single char-cost category — `replay-ex` at 13.5% of
parse, more than twice `replay-cc`.

> This is §3's arms-tried cost model, measured rather than asserted: a failed arm
> re-reads the bytes the next arm is about to read. It is the population
> token-keyed dispatch removes **by construction**, and it is the most concrete
> target the scanner half of this design has.

#### 10.4.3 A cost that is NOT there

Regex objects allocated during a parse: **0**, both dialects. The emitted regex
literals sit in a per-rule IIFE closure evaluated once at module load, not per
call. Recorded because a per-call `RegExp` construction would have been a real cost
and the emitted shape looks like one; it is not.

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

> **First calibration against a real conversion (§9.1.5).** The key-chain row above was
> the one category actually converted. Predicted 40,269 B; **delivered 24,993 B —
> 62%**. The replacement is not free, so **a category's byte count is an upper bound on
> what converting it removes**. Scale the rest of this table accordingly.

| | now | after | target |
| --- | ---: | ---: | ---: |
| bytes | 3,336,650 | **~2,543,000** | 250,000 |
| × source (114,446 B) | 29.2× | **22×** | ≤4× (10× ceiling) |
| × postcss (92,915 B) | 35.9× | **27×** | ~1× |

> **~22× source is nowhere near the 250 KB ideal, and still more than double the 10×
> hard ceiling.** Derived tokenization does not get parseman to its size target. It
> removes about a quarter of the artifact.

> **Family scope of that conclusion (§16.1 applied to this document).** The arithmetic
> above is taken over **codegen's per-rule emitted mass** — the categories in §8 are
> measured on the compiled artifact, and every row is a count of bytes *in emitted
> JavaScript*. So the bound is: **derived tokenization does not reach the size target
> _within the current emitted form_.** It is not a bound on artifact size in general,
> and it says nothing about a lowering that changes what is being counted — which is
> exactly the caveat §16.1 exists to enforce, quoted twice in its own session before it
> was written down. The next paragraph but one already points at the emission-form
> family (§14.2) for that reason; #7 there is no longer hypothetical (see its entry).

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

1. **One recognition pass per cursor decision.** The choice tokenizes once; every PEG
   trial uses that result and the selected arm consumes it. Two arms at the same
   choice never both rescan characters.
2. **Tokenization supplies branch discrimination.** Do not require
   character-disjoint arms before tokenizing; shared-leading composite families are
   the high-value population. A unique id selects directly; overlap retains ordered
   compatible token views instead of forcing another character scan.
3. **The current parser context selects active terminals.** Mode-free maximal munch
   over every terminal is measured wrong — it produced 7 tokens for a 123 KB file
   (§10.1). This does not limit token coverage inside the correct context.
4. **Adjacency is produced, never re-derived.** The bit comes from the scan loop.
   Consumers do not compare positions except through the documented escape hatch.
5. **Authors are unaffected.** No combinator gains a required token argument; no
   grammar file needs editing to benefit.
6. **A named rule is still never inlined** (see §8.5 and `artifact-format.md`).
7. **Version-locked like every other artifact shape.** A derived scanner table is a
   compiled artifact; per `artifact-format.md` it carries no back-compat read path.
8. **Every change is gated on a byte-identical parse tree against a toggled baseline**,
   not on a green test suite. §16.3 — a shipped bug that 288 tests missed is why this
   is an invariant and not a suggestion.
9. **Every parse-time claim comes from interleaved rounds in one process.** §16.4 —
   separate-process A/B of this parse has a noise floor an order of magnitude above
   the effects being measured.
10. **One canonical engine.** Token-aware and raw-input sites are assembly-selected
    pieces over the same `TableProgram`; neither is a parallel parser or fallback
    implementation.
11. **No scan-then-rescan.** Tried and selected terminals use the classified result.
    A prior character gate may supply the already-read lead to token recognition; it
    must not trigger a second complete recognition of the same terminal.
12. **Cheap character decisions survive.** Optional-loop EOF/first-character guards
    may stop work before a token is requested, and a disjoint first-character choice
    may select its arm before the selected arm finishes a token. Shared-leading
    choices use the token result for discrimination.
13. **One recognition contract.** Scanner kernels and raw terminal pieces share the
    same maximal-munch, prefix, case-fold, boundary, span and capture semantics; a
    second independently drifting recognizer is forbidden.
14. **PEG order is preserved unless a versioned parser-semantics decision says
    otherwise.** Tokens may reject impossible arms; they may not skip a viable earlier
    arm merely because a later arm is a longer or globally successful match.
15. **Prediction pays for its own machinery.** An LL(k), LL(*) or ALL(*)-style
    experiment reports construction, cache and configuration growth separately and
    has a bounded fallback. Stringified paths, stacks or configuration sets are
    forbidden in the hot prediction identity.

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
produced it. **29 entries.** Every entry carries a **contribution tag** (see the
scheme near the top of this document) and a status. Status is one of:

- `untried` — no measurement attempted;
- `measured — <result>` — a number exists, cited;
- `rejected — <evidence>` — a number exists **and** it killed the idea;
- `blocked — <reason>` — cannot be measured yet, reason stated.

**No entry may be marked `rejected` without measurement attached.** An idea that
merely looks wrong is `untried`.

### 14.0 FOUNDATION queue — the token design needs these regardless

These are not optional and not speculative. **§8.6 is the evidence**: it came from this
family and returned **−9.66%** without any token cursor.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 26 | **Sharpen the nullability analysis** | **FOUNDATION** | `untried` — **highest-value known lead** |

*Why:* **393 of 558 boundaries fall back SOLELY because the term is reported nullable**,
and `matchesEmpty` errs toward nullable when it cannot resolve (§8.6). Every boundary
its precision recovers is deleted outright, by the mechanism already proven to work.
*Rationale for the tag:* commitment and nullability are the same predicate, and the
token cursor needs it to know where a choice is decided.
*How to measure:* boundaries converted (165 → ?), artifact bytes, tree equality.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 27 | **Combinator-depth disjointness** | **FOUNDATION** | `untried` |

*Why:* deciding an arm needs to know at what depth alternatives become distinguishable
— the same question first-set gating answers at depth 1 and a token answers at depth
"one token". *Rationale:* it is the analysis that tells codegen how much lookahead a
choice actually needs, which is a prerequisite for emitting a token-keyed choice at all.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 28 | **A shared analysis module consumed by BOTH codegen and interpreter** | **FOUNDATION** | `untried` |

*Why:* commitment, nullability and disjointness are currently answered inside codegen.
The interpreter needs the same answers, and two implementations of one predicate is the
drift pattern §7 and §16.3 both document — in the component that decides *what
matches*. *Rationale:* the token design makes these answers load-bearing in two places
at once.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 29 | **Bounded integer-keyed adaptive token prediction** | **ENABLED-BY** | `untried` — only after tokenized PEG has a production baseline |

*Why:* shared-token alternatives can require more than one token of lookahead, and a
cached adaptive decision could remove repeated speculative composite parsing. *Why it
is not the default:* it changes PEG prefix commitment if it chooses the first arm that
leads to a complete valid path, and the Chevrotain implementation demonstrates how
ATN/configuration and key construction can dominate the saved work. *Required shape:*
compact integer configurations and stack identities, no path/config strings, hard
per-decision state and byte ceilings, and fallback to tokenized PEG. *How to measure:*
cold construction, warm parse, state/config/cache high-water marks, artifact bytes,
and production A/B against both character PEG and tokenized PEG; plant overlapping
choice cases that distinguish `a | ab` from `ab | a` before reporting parity.

### 14.1 Capture-bookkeeping family

These all target the same measured mass: **save + rollback is 723,605 B = 21.7% of
the css artifact, and rollback alone is 17.5% against save's 4.2%** (§8.1). The
asymmetry matters: experiments that make *unwinding unnecessary* attack four times the
mass of experiments that make *marking cheaper*.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 1 | **Commit-discipline inversion** | **ENABLED-BY** | `untried` |

*Tag — ENABLED-BY:* the token cursor supplies the rewind unit this needs, and deterministic choices may dissolve the mass outright.

*Idea:* accumulate speculatively and commit only on success, instead of recording
eagerly and unwinding on failure. **The measured 17.5%-vs-4.2% rollback/save split
(§8.1) points straight at this one.** *Why it might work:* it does not deduplicate the
restore code — it makes the restore code **not exist**. There is nothing to unwind
because nothing was committed. Directly targets the **17.5% rollback** mass — the
larger of the two halves — rather than compressing it. *How to measure:* prototype on one grammar, compare emitted
bytes and the `rollback/dense` benchmark family against the current form.
*Assessment:* **highest-ceiling untried item in this document.**

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 2 | **Arena / watermark capture** | **ENABLED-BY** | `untried` |

*Tag — ENABLED-BY:* same mass as #1, at the allocator rather than the control flow.

*Idea:* capture appends into a region; rollback resets a single watermark. *Why it
might work:* same family as #1, one level down — at the allocator rather than the
control flow. *How to measure:* as #1; additionally watch allocation-rate and GC in
the parse benchmarks, since a region changes lifetime, not just bookkeeping.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 3 | **Mark stack with pointer rollback** | **LEGACY** | `untried` |

*Tag — LEGACY:* compresses the current boundary form — §8.6 deleted 64% of that form outright by a FOUNDATION route.

*Idea:* replace the four guarded stores at each boundary with one index assignment
into a mark stack. *Why it might work:* mechanical, low-risk, no semantic change.
*Ceiling:* bounded by the rollback mass, **17.5%** (§8.1). *How to measure:* emitted bytes plus
the same benchmark family; the current guarded form is itself a measured optimisation
(§8.1) so the comparison must include the ungated-store regression case.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 4 | **Shared failure epilogue per rule** | **LEGACY** | `untried` |

*Tag — LEGACY:* extraction over emitted text the rewrite replaces.

*Idea:* reach the restore sequence by jump rather than by copying it to each failure
site. *Why it might work:* extraction-family — the restore text exists once per rule
instead of once per boundary. *Ceiling:* floor-bounded; it compresses the current
form rather than removing it, so #1 dominates it if #1 works.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 5 | **Rule-level restore** | **LEGACY** | `untried` |

*Tag — LEGACY:* same — and §8.6 already took the reachable part of this mass.

*Idea:* one unwind at the rule's failure exit, instead of a quartet at every internal
boundary. *Why it might work:* most internal boundaries never independently fail —
the rule fails as a unit. *Risk to check when measuring:* boundaries that *do* need
independent rollback (repetition arms) must be identified, or the semantics change.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 25 | **Deferred leaf materialisation** | **ENABLED-BY** | `untried` |

*Tag — ENABLED-BY, and this placement is the point:* it does **not** stand alone.
§8.1.1 identified `_cm*` choice-arm mass as the case where captured leaves must be
withheld until a sequence succeeds. But **lookahead may make those choices
deterministic**, in which case the arm mass **disappears rather than needing
deferral** — the technique is dissolved by the design it was meant to complement.

*Idea:* withhold a term's leaf pushes until the owning sequence succeeds, materialising
from a token-index range at the owning `node()`. §8.1.1 measured the feasibility: of
766 css leaf-capture sites, **89% are `input.slice(tokStart, tokEnd)` or a constant
selected by the token id**, with span the token's own extent — reproducible from a
token range, with a fallback for the ~11% that come from a rule call or a label.

*Do not build this before the choice-determinism question is answered.* Building it
first risks engineering a solution to a mass that the token design removes.

*How to measure:* `_cm*` bytes before and after lookahead-driven determinism, **then**
deferral on whatever remains.

### 14.2 Emission-form family

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 6 | **Superoperators / superinstructions** | **LEGACY** | `untried` |

*Tag — LEGACY:* fuses sequences of the current emitted primitives.

*Idea:* fuse frequently co-occurring combinator sequences into a single emitted
primitive. *Why it might work:* **the one candidate in this list that could be both
smaller and faster**, because fusing removes the dispatch *between* the fused
operations as well as their duplicated text. *How to measure:* mine the emitted
artifacts for the top co-occurring sequences, fuse the top *n*, compare bytes and
parse time.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 7 | **Table-driven emission (hot/cold split)** | **ENABLED-BY** | **no longer `untried` — a prototype exists and is measured** (see below); the hot/cold *split* is still untried |

*Tag — ENABLED-BY:* its strongest evidence (§10.2, 30:1 gzip) is the **scanner's** emitted form, so it applies to the post-rewrite emitter and not only this one.

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

*Status correction (this entry described work that has since started).* A table
lowering was prototyped and measured — `src/table/` on `pm-g5-driver`, written up in
`notes/G5-TABLE-DRIVER.md`. It is **additive and not wired into the macro, `compile()`
or `compose()`**, and **codegen remains the shipping lowering**, so nothing below
should be read as a description of what parseman emits today. What it measured, on its
own benches: **113 B/rule marginal against codegen's 4,932 B (43.7×, `bench/g5-size.ts`)**
and **~2.65× codegen's parse time** in steady state (`bench/g5-scaling.ts`, after the
SEQX fuse + `OP_RULE` collapse). It also folds `trackLines` × `hostMode` into one
driver: **8,418 B for four variants, zero option reads in `exec.ts`**.

The **hot/cold split this entry actually proposes is still untried** — the prototype
interprets *every* rule rather than only the cold tail, so the "hot benchmarks
unaffected by construction" property has not been bought and remains the open question.
The 30:1-gzip evidence above is untouched by any of this.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 8 | **Compact emission expanded at load** | **LEGACY** | `untried` |

*Tag — LEGACY:* a shipping-format change for the current artifact.

*Idea:* ship a compact spec and build the closures at init via `new Function`. *Why
it might work:* the shipped bytes and the executed form stop being the same artifact,
so the size target and the speed target stop competing. *Sanctioned:* the owner has
explicitly accepted **a small startup cost** for this. *How to measure:* shipped
bytes, gzipped bytes, and time-to-first-parse (not just steady-state parse time).

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 9 | **Defunctionalisation** | **LEGACY** | `untried` |

*Tag — LEGACY:* replaces the current closure representation.

*Idea:* replace closures with tagged values dispatched by a switch. *Why it might
work:* removes per-closure allocation and gives V8 one monomorphic dispatch site
instead of many megamorphic call sites. *How to measure:* bytes plus parse time;
watch for the dispatch switch itself becoming the bottleneck.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 10 | **Rerolling** | **LEGACY** | `untried` |

*Tag — LEGACY:* rerolls current emitted text.

*Idea:* turn repeated unrolled sequences back into a loop over data. *Why it might
work:* the artifact is ~86–90% repeated lines after identifier normalisation
(§16.2) — that repetition is the population. *How to measure:* bytes; parse time is
the risk side, since rerolling trades emitted text for runtime indirection.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 11 | **Deforestation / fusion of combinator pipelines** | **LEGACY** | `untried` |

*Tag — LEGACY:* fuses current combinator pipelines.

*Idea:* remove intermediate structures passed between pipeline stages. *Why it might
work:* classic win where a pipeline builds a value only to destructure it
immediately. *How to measure:* allocation rate first, then bytes and time.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 12 | **Threaded code / bytecode for the cold tail** | **LEGACY** | `untried` |

*Tag — LEGACY:* a denser form of #7's cold tail in the current emitter.

*Idea:* the cold half of #7, taken further. *Why it might work:* same population,
denser representation. *Dependency:* only worth attempting after #7 shows the
hot/cold split is real in practice.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 13 | **Token-keyed shared body for the nine near-identical `_r_*Block` templates** | **LEGACY** | `untried` — **and now measured as small: ~29,500 B, 0.88%** |

*Tag — LEGACY:* 0.88%, and a relative of the dispatch thread now closed as LEGACY (§9.2).

*Idea:* the nine byte-identical-modulo-one-line block templates, 3,729–4,011 B each
(§8.5). They differ only in **which at-keyword rule is called** — precisely a token
key. Exclude `_r_OpaqueAtRuleBlock` (54.5% shared, genuinely different).
**Hard constraint:** a named rule must **never** be inlined into its call site — that
breaks `compose()` override semantics ([`artifact-format.md`](./artifact-format.md)).
So this must be a **token-keyed shared body**, not inlining: one body, selected by
token, with the named functions preserved as entry points. *How to measure:* bytes,
plus the existing override test must stay green. *Priority:* low — the corrected
saving is **0.88%**, an order of magnitude below what the first revision implied.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 20 | **Per-site table/chain cost check** | **LEGACY** | **DONE — landed `2413e1f`, less regression cleared (−902 B, back to exactly pre-trie size)** |

*Tag — LEGACY:* a per-site rule inside the LEGACY dispatch thread.

*Context (§9.1.5):* token-keyed dispatch converts a site **unconditionally** when it
has **≥3 keys sharing a case-folded walk**. That rule is right on average and wrong per
site: css **-0.75%** (-24,993 B), scss -0.09%, jess 0.00%, **less +0.02% (+902 B)**.
**less regresses** — it has dispatch sites whose key sets make the emitted trie tables
cost more than the character chain they replace.

*Idea:* at macro time, **emit both forms for a site, compare their sizes, and keep the
smaller.** Convert only where the tables actually win.

*Why it should work:* the comparison is exact and available at the moment of emission
-- both forms are already generated by existing code paths, so this is a selection
rule, not a new representation. It replaces a heuristic (≥3 shared-walk keys) with the
measurement the heuristic was approximating.

*Expected:* removes the less regression entirely, and **may improve css further** by
declining marginal sites the current rule converts anyway. Note this is a **bytes**
experiment — §9.1.1 says there is ~2.4% of parse time in this whole area, so do not
expect a speed result.

*How to measure:* per-dialect artifact bytes **raw and gzipped**, plus a count of sites
**converted versus declined**. The site counts are the diagnostic — a rule that
declines almost nothing has not actually changed the policy.

### 14.3 Analysis, not optimisation

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 14 | **Re-Pair or Sequitur over the emitted token stream** | **ORTHOGONAL** | `untried` |

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

| # | Question | Tag |
| --- | --- | --- |
| 15 | **Argument-count effects on inlining.** A 14-argument helper was measured as rejected by V8's inlining heuristics (§15.4). What is the actual threshold, and does splitting a helper below it recover the win? | **ORTHOGONAL** |
| 16 | **Hidden-class shape of emitted closures.** Do the emitted rule closures share a map, or do conditional fields split them? (The analogous split has been confirmed costly elsewhere.) | **ORTHOGONAL** |
| 17 | **Do small shared helpers get JIT-inlined anyway?** If yes, extraction-family experiments (#4) cost nothing at runtime and the trade is purely bytes. | **ORTHOGONAL** |
| 18 | **Identifier length against LZ77 match length.** Shorter identifiers shrink raw bytes but may shorten gzip matches. Which dominates? | **LEGACY** |
| 19 | **gzip-aware function ordering.** Emitting similar functions adjacently should lengthen matches. Free to try; effect size unknown. | **LEGACY** |

### 14.5 Auto-alias for token detection — the equivalence-class family

**Owner direction. A design to be measured, not decided on paper.** Four approaches
are recorded below as separate experiments (#21–#24), all `untried`.

#### The idea

> **Declare, once, what surface forms map to a given token** — instead of
> hand-spelling each equivalence at every site that cares.

Case folding is one such rule. There are others, and today they are handled **ad-hoc,
inconsistently, or not at all**.

#### The equivalence classes in play (CSS)

| class | detail | status |
| --- | --- | --- |
| **Escapes in identifiers** | `\40` is `@`, `\6D` is `m` — so `@m\065 dia` and `\40 media` are both **`@media`** | currently spelled as escape alternatives **inside every ident regex**: the `[-_a-zA-Z0-9-￿]\|\\(?:…)` fragments repeat at **11** and **9** sites in css alone |
| **ASCII-only case insensitivity** | and **only** ASCII — **`İ` must not fold to `i`** | the `\| 32` bug (§16.3) that made `@font-face` parse as `OpaqueAtRuleBlock` was **a broken special case of exactly this** |
| **The `--` custom-property prefix** | including **`\--`** reaching the same token | |
| **Vendor prefixes** | arguably `-webkit-foo` is an **alias family**, not a distinct name | design question, not just mechanism |
| **Numeric forms** | `.5`/`0.5`, `1e2`/`100` | **value level, not name level — probably OUT of scope.** Recorded so the boundary is explicit rather than assumed |

**Dialect additions:** Less **`@@name`** indirection and **`~"..."`** escaping; SCSS
**`#{}`** and jess **`${}`** producing a name **not literally present in the source**.

#### Why this matters beyond convenience

Two arguments, and the first is the same one that carries §7:

1. **A rule declared once cannot drift.** Every equivalence is currently hand-spelled
   at every site — which is precisely the pattern that produced **three different
   spellings of one boundary intent across 26 css sites, 16 of them wrong** (§7.1).
   The `\| 32` bug (§16.3) is the same failure in a different costume. This is not a
   hypothetical risk; it is the measured failure mode of the status quo.
2. **In a token model the token id IS the canonical thing.** The grammar would only
   ever see ids, so **escapes and case stop being the grammar's problem at all** —
   not "handled centrally", but absent from the grammar's vocabulary. The owner notes
   this may also make grammars **easier to write**.

#### The four approaches

Owner's framing: *"you could just not normalize, but 'expand' the user-written grammar
to the larger match set OR you could normalize and match to the user-written
grammar... or other slight variations."*

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 21 | **Expand the terminal's match set** | **FOUNDATION** | `untried` |

*Tag — FOUNDATION:* the derived scanner is FOUNDATION, and it cannot be built without deciding how equivalences reach a token id.

*Idea:* **no normalization.** Each terminal accepts its equivalence class directly.

*Critical constraint:* **literal enumeration is impossible.** Escape forms are
**unbounded** — any character can be written `\XX`, with optional trailing whitespace.
So this is a **per-terminal matcher**, closer to what the ident regexes already do,
not a expanded key list.

*Advantage:* **spans stay trivially correct**, because nothing is rewritten.
*Cost:* lands in **per-character scanner work**.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 22 | **Normalize, then match against the user-written grammar** | **FOUNDATION** | `untried` |

*Tag — FOUNDATION:* as #21.

*Idea:* the scanner **folds a run to canonical form** and looks it up.

*Advantage:* **cheap on the common path**, since folding is a no-op for plain ASCII.

*The open question — to MEASURE, not reason about:* **folded length differs from
source length.** Spans and the **`tight` adjacency bit (§4)** must track **source**
positions while matching on **normalized** bytes. This is the specific interaction
that makes this approach non-obvious, and it is not resolvable on paper.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 23 | **Lazy fold** | **FOUNDATION** | `untried` |

*Tag — FOUNDATION:* as #21.

*Idea:* scan **raw**; normalize **only when a raw match fails**.

*Advantage:* **escaped input pays; ordinary input does not** — and ordinary input is
essentially all input. *Risk to check:* the failure path is also the backtracking
path, so "only on failure" may be less rare than it sounds.

| # | Experiment | Tag | Status |
| --- | --- | --- | --- |
| 24 | **Macro-time canonicalisation into the trie** | **FOUNDATION** | `untried` — **RECOMMENDED STARTING POINT** |

*Tag — FOUNDATION:* as #21 — and it composes with machinery already shipped.

*Idea:* build a trie that **accepts both plain and escaped/case-varied forms**, so the
walk **absorbs the equivalence** with **no separate pass and no allocation**.

*Why start here:* it **composes directly with the trie that just won the dispatch
sweep on evidence** (§9.1) — the machinery exists, is shipped, and is already the
default. That makes it **the cheapest of the four to try**, and the only one that adds
no new mechanism.

#### Measurement, for all four

Identical, and non-negotiable:

1. **Artifact bytes, raw and gzipped** (per dialect — §9.1.5 shows dialects diverge).
2. **Parse speed on the comparison corpora** — interleaved rounds in one process
   (§16.4).
3. **Correctness via byte-level tree equality against a toggled baseline** (§16.3).
   This family touches *which characters match which token*, so it is exactly the
   class of change a passing test suite does not catch.

---

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

### 16.3 Byte-level tree equality against a toggled baseline is THE GATE — not the test suites

**This is a methodological invariant for the whole derived-tokenization workstream, not
an anecdote.**

`caa3d14` shipped a correctness bug that **288 passing tests did not catch**:

- `'@' | 32` is **`` ` ``** (backtick, 96), not `@` (64) — `| 32` is a lowercasing
  trick that is only valid for ASCII **letters**.
- Key tables were built from **lowercased** text; input was read with **`| 32`**.
- So **every `@`-led key fell through.** `@font-face` parsed as `OpaqueAtRuleBlock`.

**The full css suite passed with the bug present.** What caught it was a **byte-level
diff of the parsed tree against the pre-token build**, which failed on the **first
differing byte**.

> **The gate for any change in this workstream is: build both configurations, parse the
> corpus with each, and assert the trees are byte-identical.** Test suites assert the
> properties someone thought to assert. A tokenization change can alter *which rule
> matched* while leaving every asserted property intact — which is exactly what
> happened here. A green suite is not evidence; a byte-identical tree is.

This is why every measurement in §9.1 is reported as "trees diffed equal against a
toggled baseline". That clause is the load-bearing part of the methodology, not
boilerplate.

The fix (`e8612eb`, **fold ASCII letters only**) also removed a **latent
over-acceptance**: `| 32` mapped `_` (95) and DEL (127) onto each other, so the old
form accepted key characters it should have rejected. The bug and the latent defect had
the same cause — treating a bit trick as if it were a case fold.

### 16.4 Separate-process parse measurements are unreliable at this magnitude

**The 1.83× speedup claimed earlier in this workstream is WITHDRAWN. It was noise.**

Proof, and it is unambiguous: **three configurations producing a BYTE-IDENTICAL
artifact** measured **5.961, 6.101 and 11.952 ms** in separate processes. A **2×
spread** on the same file with the same bytes.

The chain baseline is **6.092 ms**, not **12.540 ms**. Every figure derived from
12.540 ms is void — including this document's own "32% of parse time" scan-cost
share, withdrawn at §10.3.

> **Methodology, required for any parse-time claim in this workstream:**
> **interleaved round-robin in ONE process**, reporting **medians over many rounds**
> (§9.1 uses 31). Separate-process A/B of this parse cannot resolve differences of
> the size being argued about — and the differences being argued about turned out to
> be **2.4%** (§9.1.1), an order of magnitude below the noise floor of the discarded
> method.

Note how the two failures compound: the discarded method produced a **1.83×** claim
where the truth was **2.1%**, and it did so in the *favourable* direction. Assume any
un-interleaved number in this workstream's history is wrong until re-measured.

#### Settled a second time, by a real git toggle

The env-toggled result has now been confirmed by an **independent method**: building
`143324e` (pre-trie) and `caa3d14` (post-trie), compiling css-parser after each, with
the resulting artifacts **`cmp`-verified byte-identical** to the env-toggled builds.

**5.41 ms pre-trie, 5.42 ms post. No gap.**

Two conclusions:

1. **The 1.83× is settled twice**, by two methods that share no machinery. It is not
   an artifact of the env toggle.
2. **The V8-budget hypothesis is UNSUPPORTED.** Removing **all 31 KB of chains**
   changed **nothing measurable**. Whatever bounds this parse, it is not the size of
   the emitted dispatch code.

### 16.5 The noise floor, as a standing instrument fact [ORTHOGONAL]

> **Two BYTE-IDENTICAL css artifacts A/B'd at 5.144 vs 5.200 ms, winning 6 of 15
> rounds.**

Same bytes. Same file. Same process discipline. That spread is the **instrument**.

> **~1% spreads in this workstream are HARNESS, not RESULT.** Every lane should cite
> this number before reporting a delta of that magnitude, and no lane should report one
> as a finding.

This is why §9.1.1's 2.4% total spread is reported as "there is nothing here" rather
than as four distinguishable configurations: most of the gaps inside it are at or below
this floor.

---

## 17. Open questions

- **Rewind unit.** Is a token index sufficient to rewind CST capture, or must a
  capture mark ride alongside it? §11 assumes the former in its arithmetic; nothing
  has tested it, and it is the single largest unverified term in that total.
- ~~**Does trie-to-id + index selection actually dominate?**~~ **ANSWERED (§9.1):**
  yes on every axis, by 2.1% of parse time. The question that replaces it is
  **whether anything in dispatch keying is worth further effort at all** — §9.1.1 says
  the entire remaining headroom there is under 2.4%.
- ~~**What does on-demand scanning actually cost?**~~ **ANSWERED (§10.4).** The
  absorbable share is **18.6% of css parse time and 7.1% of less**; the cursor pays
  **7.9% / 1.4%**; net ceiling **~10.7 / ~5.7 points**. The question that replaces
  it is **which half of the design to build first per dialect** — §10.4.1 shows css
  and less give opposite answers.
- **Does alias resolution belong at scan time, or as a separate normalization pass?**
  (§14.5.) The deciding interaction is specific and known: **escapes change token
  length**, so a folded run's length differs from its source length, and spans plus
  the `tight` adjacency bit must track **source** positions while matching on
  **normalized** bytes. That is not resolvable on paper — it is what experiments
  #21–#24 exist to settle.
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

1. **Activating every terminal without the current parser context.** This is measured
   (§10.1): mode-free maximal munch degraded to 7 tokens for a 123 KB file. Global
   token ids are correct; globally active recognition is not.
2. **Using conservative lead distinctness as token eligibility.** It selects choices
   the character gate already decides and excludes the shared-leading families for
   which full-token choice has leverage.
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

### WITHDRAWN or FALSIFIED

| Claim | Status |
| --- | --- |
| **1.83× parse speedup** | **WITHDRAWN — it was NOISE (§16.4).** Three byte-identical artifacts measured 5.961 / 6.101 / 11.952 ms in separate processes |
| **Chain baseline = 12.540 ms** | **WITHDRAWN.** The interleaved figure is **6.092 ms** |
| Scanning every position = 32% of parse time | **WITHDRAWN (§10.3)** — wrong denominator. **REPLACED by §10.4:** absorbable share **18.6% css / 7.1% less**, scanner cost **7.9% / 1.4%** |
| Maximal munch uniform over the whole alphabet | **FALSIFIED (§10.1)** — 7 tokens for 123 KB |
| A searched discriminator may not be available | **FALSIFIED (§9.1.2)** — `phash` finds an injective (position pair, multiplier, modulus) over the real key set |

### Landed and measured since the sweep

| Claim | Tag | Status |
| --- | --- | --- |
| **Unreachable-`else` elimination: css 3,336,650 → 3,014,384 B, −9.66%; gzip −7.93%; expansion 29.16× → 26.34×** | **FOUNDATION** | **measured (§8.6) — largest win to date, and NO token cursor was involved** |
| Boundary mark/restore 375,524 B / 4,268 clauses → 135,246 B / 1,651 (−64%) | **FOUNDATION** | **measured** |
| 165 of 558 boundaries converted; **393 fall back solely on reported nullability** | **FOUNDATION** | **measured — a sharper nullability analysis converts more, by the same predicate (#26)** |
| `_cstRawChildren` never needed a mark even for nullable terms | **FOUNDATION** | **measured** — no trivia function pushes a raw child |
| `_mk*` prefixes are minted by three emitters | | **caveat — §8.1.1's "46.6% is sequence boundary" is an UPPER BOUND.** The artifact delta is instrument-independent and stands |
| **Absorbable share = 18.6% of css parse time, 7.1% of less; cursor pays 7.9% / 1.4%; net ceiling ~10.7 / ~5.7 points** | **FOUNDATION** | **measured (§10.4) — closes §10.3 and the §17 open question. AST path, shipping grammars, 61 interleaved rounds, instrumented artifact gated on tree identity** |
| Current parser reads each input byte **5.67×** (css) / **12.28×** (less); coverage 100% both | **FOUNDATION** | **measured (§10.4) — exact counts. A cursor reads it once** |
| **Redundancy INVERTS against time share**: less reads 2.2× more per byte, char work is a 2.6× smaller share of its parse | **FOUNDATION** | **measured (§10.4.1) — scanner headroom is a css result; save/restore is the less prescription** |
| **42.2% (css) / 56.7% (less) of regex terminal executions FAIL** | **FOUNDATION** | **measured (§10.4.2) — §3's arms-tried cost model, and the most concrete target the scanner half has** |
| Regex objects allocated per parse = 0 | **ORTHOGONAL** | **measured (§10.4.3) — literals sit in a load-time IIFE closure, not per call** |
| Experiment #20 cleared the less regression: −902 B, back to exactly pre-trie size | **LEGACY** | **measured, landed `2413e1f`** |
| trie-to-id + dense `switch`: **+10,867 raw / +160 gzip** | **LEGACY** | **measured — LOST.** Cause is the artifact printer indenting case bodies one level deeper; net of indentation the case labels are *smaller* |
| Ids are already `1..n` with no gaps | **LEGACY** | **measured — no renumbering or `table[]` was warranted; the dense index already existed** |
| **The whole dispatch thread is ~1.2% of the artifact** | **LEGACY** | **closed (§9.2) — finished, not abandoned** |
| **1.83× settled a SECOND time by a real git toggle** | | **measured — 5.41 ms pre-trie vs 5.42 ms post, artifacts `cmp`-verified byte-identical to the env-toggled builds. No gap** |
| **V8-budget hypothesis** | | **UNSUPPORTED — removing all 31 KB of chains changed nothing measurable** |
| **Noise floor: two byte-identical artifacts at 5.144 vs 5.200 ms, 6/15 wins** | **ORTHOGONAL** | **measured — ~1% spreads are HARNESS, not result. Cite this before reporting one** |

### Corrected or superseded

| Claim | Status |
| --- | --- |
| css artifact = 3,336,650 B; 29.2× source; 35.9× postcss | **measured — CORRECTS 4,954,294 B / 53×** |
| Save + rollback = 723,605 B, 21.7% (rollback 17.5%, save 4.2%) | **measured — SUPERSEDES "37.2% / mark+restore 27–29%"** |
| css alphabet = 118 members | **measured from the live combinator graph — SUPERSEDES 75** |
| `_r_*Block` collapse saves ~29,500 B / 0.88% | **measured — CORRECTS an implied ~148 KB** |
| The two 200 KB+ at-rule rules are 36.1% save/rollback, not key chains | **measured — CORRECTS "two string-comparison chains"** |
| 50 `noTrivia` in css (vs 46 source-level) | **measured — source-level counts are undercounts** |
| Key-chain conversion delivers 24,993 B against 40,269 B predicted (62%) | **measured (§9.1.5) — a category count is an UPPER BOUND on what converting it removes** |

### Measured — the landed dispatch sweep (§9.1)

| Claim | Status |
| --- | --- |
| **Whole spread across every dispatch config = 2.4%** | **measured — THE HEADLINE. Dispatch keying is not where css parse time goes** |
| trie:ifchain 5.967 ms / 0.979 rel / 3,311,657 B / 424,465 gz (landed default) | **measured** |
| chain 6.092 / trie:switch 5.945 / phash:switch 6.011 | **measured, 31 interleaved rounds, one process, trees diffed equal** |
| The §9.0 microbenchmark's 1.55× is worth ~2% end-to-end | **measured — an isolated decision-point figure overstated it ~70×** |
| Perfect hashing: search works, loses on table bytes | **measured — `works, loses on bytes`, NOT rejected as infeasible** |
| `firstchar` / `lenswitch` fall back to chain on css at-keywords | **measured — `not applicable to this key set`, NOT rejected** |
| trie:switch's larger raw size is the downstream formatter, not the emitter | **measured — gzip is the deciding metric for switch-shaped emission** |
| Per-dialect delta: css -0.75%, scss -0.09%, jess 0.00%, **less +0.02%** | **measured — less REGRESSES; untried #20 is the fix** |

### Measured — everything else

| Claim | Status |
| --- | --- |
| Whole-artifact category breakdown (char scan 8.9%, trivia 5.6%, key chains 1.2%) | **measured** |
| Mark/restore split: sequence boundary is trivia-only; the other ~53% is the binding case | **measured (§8.1.1)** |
| Per-rule save+rollback shares; top 20 rules = 62% of artifact | **measured** |
| Dialect artifact sizes and the postcss bar | **measured** |
| 92 css choice points: 40 token-decidable, 6 clashes, 46 walker-bail | **measured** |
| §9.0 prototype ns/token and code sizes | **measured, one decision point, standalone — see the ~70× caveat above** |
| `(len, c1, c2)` collides; 11 buckets for 13 keys even with last char | **measured** |
| Gated scanner: 18,238 tokens, 30:1 gzip on `benchmark.css` | **measured** (the 4.05 ms figure is from the discarded regime) |
| 16 of 26 css `keywords(boundary:)` sites under-spelled, three spellings | **measured** |
| The two shipped boundary bugs | **measured** (both reproduced and fixed) |
| **A correctness bug that 288 tests missed** (`'@' \| 32` is a backtick) | **measured (§16.3)** — caught only by byte-level tree diff |
| Prefix-pair and interpolation-opener counts | **measured** |
| css top-ten rules = 53.5% of rule bytes; ~86–90% repeated lines normalised | **measured** |

### Settled design

| Claim | Status |
| --- | --- |
| Recognize at the current cursor; direct-fork unique token ids and let compatible PEG arms trial from the shared result | **settled (§2, §2.1)** |
| Token ids are global; the current parser context selects active terminals | **settled — and §10.1 is why** |
| One position result per cursor decision; every compatible trial uses it and the selected branch consumes it | **settled (§3)** |
| Adjacency as a scan-time bit | **settled** |
| Selector context as a mode flag | **settled** |
| `dispatch` on token id; `routed()` produces a token | **settled — and now LANDED (§9.1)** |
| Trie = how you get the id; table = what you do with it | **settled (§6.1)** |
| Codegen must SEARCH for a distinguishing position set at macro time | **settled (§6.2), and the search is now measured to work** |
| Hybrid: table for cold dispatches, trie-to-id for hot, per-site from profile | **settled (§6.3)** |
| **Byte-identical tree vs a toggled baseline is the gate, not the suites** | **settled methodological invariant (§16.3)** |
| **Parse-time claims come from interleaved rounds in one process** | **settled methodological invariant (§16.4)** |
| Token cursor is an assembly-selected layer over fixed pieces, not a replacement lowering | **settled integration rule (§2)** |
| Cheap character gates survive where they already decide; shared-leading choices discriminate from tokens; compatible overlap retains ordered trial | **settled integration rule (§2, §12)** |

### Hypothesis, untried, or nonexistent

| Claim | Status |
| --- | --- |
| Token-index rewind removes most of the 723,605 B save/rollback | **hypothesis — unmeasured; the largest unverified term in §11.** §8.1.1 narrows it: under half of css mark/restore is the binding case |
| Sharper nullability analysis converts more of the 393 fallback boundaries (#26) | **FOUNDATION, untried — the highest-value known lead** |
| Deferred leaf materialisation (#25) | **ENABLED-BY, untried — may be DISSOLVED if lookahead makes those choices deterministic** |
| **Auto-alias for token detection** (#21–#24, §14.5) — expand / normalize / lazy-fold / macro-time trie | **untried — owner design direction, to be measured not decided.** #24 recommended first: composes with the trie already shipped |
| Whether alias resolution belongs at scan time or a separate pass | **open — decided by escapes changing token length vs. source-position spans** |
| Every item in §14 (28 entries) | **untried except #20 (done, LEGACY) and #7 (prototyped and measured, not shipping; its hot/cold split is still untried) — see each entry's tag** |
| Rule-level inline cap; cross-artifact sharing; source-level shape sharing; arity-only shared restore helper | **rejected — evidence in §15** |
| **Mechanically removable total: 793,374 B, 23.8%, to ~2,543,000 B (22× source)** | **arithmetic over measured categories — NOT an end-to-end result, and the one converted category delivered 62% of its estimate.** Derived **within the current emitted form**: every category is a count of bytes in emitted JavaScript (§11, §16.1) |
| That this technique reaches 250 KB, or 10×, or 4× | **NO — see §11; it does not, and nothing measured suggests it does.** Scope: *this technique, within codegen's emitted form.* Not a bound on artifact size in general, and not a statement about a lowering that changes what is being counted (§16.1) |
| That dispatch keying is a large speed win | **NO — measured at 2.4% total spread (§9.1.1). Redirect to the save/restore mass** |
