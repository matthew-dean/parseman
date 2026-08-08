# Parseman 0.48 architecture and release specification

**Status:** active implementation specification  
**Release branch:** `release/0.48.0`  
**Primary performance architecture:** tokenized PEG over the canonical compact
`TableProgram`  
**Detailed evidence registers:**
[`derived-tokenization.md`](./derived-tokenization.md),
[`RELEASE-0.48-TARGET.md`](../../notes/RELEASE-0.48-TARGET.md), and
[`TABLE-PERF-EXPERIMENTS-0.48.md`](../../notes/TABLE-PERF-EXPERIMENTS-0.48.md)

This is the canonical, current 0.48 design. The linked documents retain the full
experiment history, measurements, rejected implementations, and longer-form
reasoning. When an older note conflicts with this file, this file controls the
0.48 implementation direction. Measurements still come from the evidence ledger;
this specification does not turn a historical result into a baseline.

## 1. Release objective

0.48 must recover production-shaped parse performance to at least 0.46 on CSS,
`benchmark.less`, and generated Less while retaining the compact architecture and
correctness gains shipped in 0.47.

The release does not succeed by narrowing the benchmark, widening a shelf, lowering
a baseline, or substituting a toy grammar. A final claim requires the pinned 0.46
build, literal full consumption, complete semantic identity, interleaved paired A/B,
same-source A/A controls, independent recompilation, and the external Jess grammars.

The corrected `e5247da` checkpoint still measures approximately:

| workload | regression against 0.46 | total relative time |
| --- | ---: | ---: |
| Less stylesheet | +219.5% | 3.20x |
| Less mixins | +226.8% | 3.27x |
| CSS stylesheet | +238.9% | 3.39x |
| GraphQL document | +106.1% | 2.06x |
| JSON document | +123.3% | 2.23x |

CSS's exact center is run-sensitive, but its release disposition is not: two
corrected complete runs lost all 120/120 pairs. These figures are a checkpoint,
not a new acceptable baseline.

## 2. Non-negotiable architecture

0.48 keeps one implementation:

```text
grammar combinators
        |
        v
compact TableProgram
        |
        v
assembly-selected shared pieces
        |
        v
interpreter / runtime compile / macro / compose / rule map / folded variants
```

The variants may select fixed piece bodies at assembly time. They may not become
parallel parser engines or carry different parsing semantics.

The following remain prohibited:

- runtime `new Function` or equivalent source construction;
- `Object.defineProperty` fast-path metadata;
- `WeakMap` side metadata;
- static factory or per-rule source bloat;
- parent-closure multiplication by child category;
- a second token parser beside the character parser;
- downward performance baselines or broader release shelves;
- unbounded string keys for paths, prediction states, or call stacks.

`TableProgram` remains compact data. Runtime behavior is linked from a bounded
library of deterministic V8-friendly pieces. CSP safety is unchanged.

## 3. Leading implementation: tokenized PEG

Tokenized PEG is the leading 0.48 performance architecture, not a deferred sequel
to local fast paths.

At a parser decision, Parseman recognizes the current position under the lexical
context supplied by that site:

```text
position result = recognize(input, position, contextId, optionalSeed)
ordered result  = tryCompatibleArmsInPegOrder(position result)
```

Recognition filters impossible arms and supplies reusable terminal results.
It does **not** replace ordered PEG trial. An earlier compatible arm still wins
according to today's PEG prefix-commitment semantics.

### 3.1 Global identities, local contexts

- Token ids are compact non-negative integers in one global id space for the
  final composed grammar.
- A lexical context id is supplied by the parser site. It may represent a named
  mode, candidate set, or compiled combination of active terminals.
- Recognition is position-local. The cursor remains a character offset so spans,
  errors, recovery, CST data, and incremental parsing keep one coordinate system.
- Nearly every statically enumerable terminal should be tokenizable. A scannerless
  escape is explicit for genuinely dynamic/context-dependent constructs; it is not
  the default conclusion when a shallow lead walker stops at a wrapper.

The rejected seven-token CSS experiment tested mode-free global maximal munch with
every terminal active everywhere. It did not test this design.

### 3.2 Compact pending result

The common result is allocation-free scalar state owned by the active assembly and
reset at parse begin. Conceptually it contains:

```text
input identity
position
contextId
count
tokenIds[count]
ends[count]
flags[count]       # adjacency and other proven lexical facts
```

The unique case has one integer id and end. Same-token or prefix overlap retains a
small compatible list in source-order-compatible form. No object is allocated per
match. Reentrant parsing saves/restores the cursor frame exactly as it already does
for the installed trivia scanner and end cell.

The result is immutable for that `(input, position, contextId)` decision. Moving the
position, changing context, or beginning another parse invalidates it. A result is
never reused across contexts merely because the character offset is equal.

### 3.3 Recognition has no parser effects

Recognition publishes none of the following:

- CST leaves or raw children;
- node capture state;
- fields or trivia logs;
- errors, recovery materialization, or completion probe state;
- expected sets or commitment;
- the parser cursor itself.

The consuming terminal/composite piece owns those effects. This makes the pending
result safe to reuse after ordinary PEG rollback.

### 3.4 Raw, seeded, and pending are one kernel

Every tokenizable terminal family exposes one recognition contract with three entries:

1. `recognizeRaw(input, position, context)`;
2. `recognizeSeeded(input, position, context, lead, prefixLength)`;
3. `consumePending(positionResult, tokenId)`.

The entries share semantics. There is no independent scanner regex beside an
independent terminal regex.

A disjoint first-character gate has already read useful input. It selects the arm
cheaply, passes the lead/prefix as a seed, and recognition continues after that
prefix. It must not reread the known prefix. Shared-leading choices recognize far
enough to distinguish token ids or retain compatible views. Non-choice loop exits
may keep their cheaper character/EOF guard and request no token.

### 3.5 Ordered compatible trial

The required semantics are visible in the smallest overlap:

```text
choice(literal('a'), literal('ab'))
```

On `ab`, token recognition may retain views for both `a` and `ab`, but it may not
select `ab` merely because it is longer. The first arm consumes the `a` view. If an
earlier compatible composite arm later fails and rolls back, the next compatible arm
uses the same position result without rescanning characters.

Unique id-to-arm mappings can jump directly by integer. This is an optimization of
tokenized PEG, not a semantic conversion to LL(1).

## 4. Recognition kernels, in implementation order

The rejected prototype established that looping over native sticky regexes to build
a compatible set costs more than the wrappers it removes. The next implementation
must not repeat that shape.

Frequency-weighted kernels land in this order:

1. exact and case-folded literal/keyword tries, preserving every accepting prefix;
2. identifier and escaped-identifier runs;
3. numeric runs and their boundary/follow facts;
4. keyword/identifier shared scans with integer lookup;
5. quoted strings and other proven straight-line scan shapes;
6. opaque native regex fallback, gated by a sound first set and called only when a
   fixed/shared kernel cannot represent the terminal.

The existing first-set analysis, literal constants, scalar recognizers, scan shapes,
and table class pools are inputs to one implementation. Token metadata must not
duplicate a second graph walk or second regex-analysis lattice.

## 5. Parser-piece integration

The token cursor binds through the shared piece library.

### Choice

- A disjoint character mask keeps its O(1) fork and publishes a recognition seed.
- A shared-leading choice requests one position result.
- Incompatible arms reject by integer/mask without entering their parser pieces.
- Compatible arms stay in source order and see the same result.

### Terminal

- A raw terminal calls the shared kernel.
- A seeded terminal continues after the known prefix.
- A pending terminal consumes the stored end/value facts and performs leaf,
  diagnostics, line, and cursor effects exactly once.

### Composite consumers

Node materialization, negative lookahead, dispatch, sequence, and routed pieces may
consume a pending scalar result directly. Their wins are retained because tokenization
replaces recognition at their seam rather than deleting their downstream work.

### Repetition and optional exits

Finite first-set guards may stop an optional iteration before tokenization. Accepted
items can seed or consume token recognition. This is complementary, not competing work.

### Trivia and adjacency

The existing grammar-selected trivia scanner owns skipping. Token recognition starts
at the already post-trivia position and never hardcodes whitespace/comments. The
position result carries whether trivia was consumed when a downstream adjacency check
needs it.

## 6. What current work means under this design

Retained components:

- direct terminal-node materialization is a pending-token consumer;
- direct terminal negative lookahead is a pending-token consumer;
- direct sequence projection removes reducer/array work outside recognition;
- repeat first-set admission avoids unnecessary token and child work;
- first-character dispatch supplies seeds and remains the cheapest path where it
  already decides the arm.

Rejected implementations remain rejected:

- native-regex compatible-set loops;
- a one-site literal trie that adds broad wrapper machinery but no shared value kernel;
- standalone numeric or escaped-identifier scanners with no consuming composite win;
- module-global token memo state;
- mode-free global maximal munch;
- longest-token-only arm selection;
- textual terminal inlining and multiplied parent closure families.

The architecture was not rejected by those results. They identify the implementation
costs the production cursor must remove.

## 7. Implementation sequence for 0.48

1. **Restore correctness first.** Synthetic scope rows must have an unambiguous
   layout, and actual Jess CSS/Less selected-root-trivia parses must fully consume.
2. **Install the position-result frame.** Parse-local reset, reentrant save/restore,
   compact integer arrays, emitted/closure/precompiled parity, and no per-match objects.
3. **Give terminals the raw/seeded/pending contract.** Existing scalar node and NOT
   consumers become the first production users.
4. **Wire shared-leading choices.** Begin with the measured Less `Value` site, but
   implement context and compatible-view machinery as reusable assembly infrastructure,
   not an IP-specific branch.
5. **Replace the native candidate loop with fixed/trie kernels.** Expand by measured
   frequency across standard CSS, benchmark Less, and generated Less.
6. **Expand coverage toward the complete terminal graph.** Resolve wrapper/rule leads
   and compiled lexical contexts; keep explicit scannerless exceptions small and named.
7. **Only then evaluate buffering and prediction.** On-demand position recognition is
   the first production cursor. Buffered mode-aware chunks are an optional layer after
   correctness and reuse are proven.

Local fast paths may land during this sequence only when they are token-compatible and
move a measured release surface. They do not displace the sequence above.

## 8. LL(k), LL(*), and ALL(*) are separate

Tokenized PEG preserves Parseman's current authoring contract: authors need not prove a
fixed `k`, left-factor every overlap, or reorganize language-shaped rules merely to make
the grammar correct.

Static LL(k)/LL(*) or adaptive ALL(*)-style prediction may be evaluated after a
production tokenized-PEG baseline. It is not an accidental consequence of tokenization.
Any adaptive predictor must use compact integer/table identities, cap live
configurations and cache bytes per decision, and fall back to tokenized PEG when the cap
is exceeded. Cold construction, warm parsing, maximum live configurations, cache size,
and artifact bytes are separate reported measurements. Stringified paths/configuration
sets are prohibited.

## 9. Correctness and performance gates

Every cursor change requires a deliberately RED differential before its green result is
evidence.

Semantic teeth include:

- `a | ab` and `ab | a`;
- equal-token arms and rollback after a compatible prefix;
- wrapper, rule-ref, runtime gate, attempt, commitment, dispatch, and routed paths;
- post-trivia positions and adjacency;
- case-sensitive, ASCII-folded, non-ASCII, EOF, and boundary behavior;
- expected/furthest-failure state;
- probe, tolerant recovery, CST/raw children, fields, errors, and trivia logs;
- line tracking and grammar coverage;
- reentrant parse and multiple parser instances over equal/different input strings;
- interpreter, reference, closure, emitted, macro, and precompiled identity.

Performance reports include:

- classifier calls and fixed/native kernel counts;
- compatible views, integer arm rejections, and prior arm entries removed;
- pending-result hits and known-prefix rereads;
- cold assembly and warm parse time;
- A/A controls, dispersion, and independent process/graph replication;
- TableProgram words, runtime bundle size, packed/unpacked package size;
- complete input consumption and complete `RunResult` identity before timing.

Near-flat results use the hardened high-sample mode; routine gates remain short. No
timing is promoted when load exceeds the harness ceiling or engine/source realpaths are
not printed before the number.

## 10. Release gates

0.48 cannot ship until all of the following are true:

- CSS, benchmark Less, and generated Less are at least as fast as pinned 0.46 under
  the authoritative production protocol;
- every named 0.47 shelf is removed rather than widened;
- actual Jess CSS and Less fully consume and preserve selected root-trivia maps;
- interpreter, reference, closure, emitted, runtime compile, macro, compose/fuse,
  rule-map/linkable, run-tabled, folded, CST, tolerant, probe, coverage, and tracked
  variants remain semantically identical;
- supported Node versions pass;
- size, package, coverage, invariant, differential, comparison-margin, build, and docs
  gates pass on the final integrated SHA;
- CSP safety and the single compact TableProgram architecture remain intact.

The required local preflight is:

```sh
pnpm typecheck && pnpm lint && pnpm check:invariants && \
pnpm check:differentials && pnpm test:coverage && pnpm coverage:guard && \
pnpm test && pnpm build && npm pack --dry-run && pnpm docs:verify
```

Passing that command is necessary, not sufficient: the final pinned performance and
external Jess gates remain separate release blockers.

## 11. Evidence that motivates the cursor

The compatible-view oracle preserved PEG winners with zero mismatches and found these
eliminable prior failures:

- CSS: 140/4,167;
- benchmark Less: 8,170/23,856;
- generated Less: 27,137/65,059.

The dominant Less `Value` choice alone can eliminate 7,734/7,927 and 27,119/30,430
prior retries. The rejected implementation reduced the remaining retries to 193 and
3,311 but regressed because it ran a native regex candidate loop. That is the immediate
implementation target: keep the elimination, replace the classifier cost, and pass the
integer/end result into the consuming arm.

Historical shipping-Jess instrumentation also measured repeated character work as at
least 18.6% of CSS parse time and 7.1% of Less parse time, with 42–57% of regex terminal
executions failing. Those figures came from an older source-lowered engine and are
motivation, not current closure-engine speed claims. Current production A/B decides each
landing.

## 12. Authority and maintenance

Update this file when the 0.48 architecture, implementation order, semantics, or release
criteria change. Record individual measurements and dispositions in
[`TABLE-PERF-EXPERIMENTS-0.48.md`](../../notes/TABLE-PERF-EXPERIMENTS-0.48.md). Preserve
long-form historical evidence in [`derived-tokenization.md`](./derived-tokenization.md)
instead of copying its full experiment register here.

This split is intentional:

- this file answers **what 0.48 is building and what must be true to ship**;
- the experiment ledger answers **what was tried and what happened**;
- the long-form design answers **why earlier alternatives were accepted or rejected**.
