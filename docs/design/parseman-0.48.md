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

The current production-shaped release checkpoint, measured from source-identical
`0385764da4c8cf2aa00bb970d7a4420f1fab7d5e`/
`2a8c381fb056f57f8d8ba515d7e9c781ec377357` against pinned 0.46
`a5dc9bd20a5cc509eb516c36cc46ca10c00c82f3` on Jess
`f3b4c3fa1917bc2a1b4e5bd7f0e4b7992b64a002`, is:

| workload | regression against 0.46 | total relative time | matching A/A |
| --- | ---: | ---: | ---: |
| CSS `benchmark.css` | +148.8% | 2.488x | +0.4% |
| Less `benchmark.less` | +87.9% | 1.879x | +2.0% |
| generated Less | +91.5% | 1.915x | +1.7% |

This used Node 24.11.1, the authoritative two-graph macro release A/B, 16
interleaved samples per side, literal full consumption on both legs, and separate
same-shape A/A processes below the load ceiling. HEAD lost every one of the eight
paired rounds on all three workloads. All three shelves therefore remain release
blockers. The older corrected `e5247da` five-workload audit is retained in the
evidence register as a historical standard-workload checkpoint, not current
production-shaped release evidence. This is a performance/consumption checkpoint,
not final release proof: the two-graph timing deliberately omits the third
semantic-identity graph. Neither checkpoint lowers the 0.46 baseline.

## 2. Non-negotiable architecture

0.48 keeps one implementation:

```text
grammar combinators
        |
        v
compact TableProgram
        |
        v
assembly-linked shared or site-specialized pieces
        |
        v
interpreter / runtime compile / macro / compose / rule map / folded variants
```

The compiler decides which body shape each final site uses. Assembly resolves that
body's fixed children, predicates and routes into direct references; emitted artifacts
may give the selected site a static local name. The variants may not become parallel
parser engines or carry different parsing semantics.

The following remain prohibited:

- runtime `new Function` or equivalent source construction;
- `Object.defineProperty` fast-path metadata;
- `WeakMap` side metadata;
- whole-program static factories or indiscriminate per-rule source duplication;
- parent-closure multiplication by child category;
- a second token parser beside the character parser;
- downward performance baselines or broader release shelves;
- unbounded string keys for paths, prediction states, or call stacks.

`TableProgram` remains compact data. Runtime behavior is linked from a bounded
library of deterministic V8-friendly pieces. CSP safety is unchanged.

### 2.1 Selective static binding, not an all-or-nothing emitter

The earlier static-factory size result rejected emitting a complete duplicate parser
factory for every rule and assembly. It did **not** show that every combinator should
remain a generic array-indexed runtime operation. Those are separate questions.

For every final site, the compiler MUST choose the cheapest complete binding shape:

1. a shared generic piece, when its indirection is cheaper than specialization;
2. an assembly-bound piece with its child pieces, predicates, constants and routes
   captured directly; or
3. a statically named emitted body when eliminating the remaining lookup/dispatch is
   worth that site's source and package cost.

This decision is per site and may produce a mixed artifact. A hot site whose opcode,
children and route are final must not pay a parse-time opcode switch, `pieces[ip]`
lookup, optional-plan branch, or array walk merely because colder sites use the shared
representation. Conversely, a cold or structurally irregular site must not be copied
into source merely because another site benefits from a named body.

Static naming is therefore a local lowering tool, not a second engine and not a build
mode. `_pf<site>`-style names may be emitted only for selected sites; other sites keep
shared pieces. Closure assembly must achieve the equivalent result with direct captured
references where that is cheaper, without runtime source construction. The compact
`TableProgram` remains the authority, and all variants preserve one semantic body per
site.

The cost model compares the whole representation: parse-time calls, branches, indexed
loads and allocations; one-time assembly work; emitted bytes; package duplication; and
loaded-module cost. It may not turn the old whole-program factory blow-up into evidence
against a bounded static site, nor treat the existence of a shared implementation as
evidence that its indirection is free.

Permanent structural teeth MUST include a mixed grammar where:

- one selected hot site has a direct/named body containing no opcode dispatch,
  `pieces[ip]` lookup, or unused strategy branch;
- one cold site remains shared and is not duplicated into emitted source; and
- changing either site's cost decision makes the tooth RED without changing parse
  semantics.

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

### 3.0 The cheapest replacement lowering

Tokenization is a representation choice, not a coverage goal. The compiler MUST
select exactly one recognition strategy for every final decision site:

```text
final decision site
        |
        +-- CHARACTER: direct class/charCodeAt/literal/keyword/native-regex body
        |
        `-- TOKEN:     one recognizer -> token id/range/facts -> consuming decision
```

The choice is completed over final winner-resolved compiler IR before `TableProgram`
serialization. `TableProgram` records only the selected lowering. Assembly merely
links that recorded body; it never selects a strategy or tests whether a token plan is
available. The choice is therefore already fixed in the assembled closure and emitted
macro. A parse call never asks whether a token plan is present, never switches between
token and character recognition, and never runs both. Mixed grammars use different
statically linked bodies at different sites; they do not use a universal body with a
parse-time mode branch.

After CHARACTER versus TOKEN is fixed, §2.1's independent binding decision chooses
whether that selected body is shared, directly captured, or statically named. Neither
axis permits a parse-time fork, and the rejection of a whole-program static factory
does not force a selected token or character body back through generic table lookup.

Strategy selection is a strict two-phase compiler operation:

1. **Capability closure.** Before cost is considered, derive and build every
   semantically valid representation for the entire reachable final composed grammar:
   the complete
   character body and the complete token body, including recognition, diagnostics,
   pending consumption, lexical context, and all supported run modes. Token
   capability is computed from the authored language, not from which kernels happen
   to be convenient or already implemented.
2. **Cost selection.** Only after both complete candidates exist may the compiler
   compare their work and select one body for the site.

Both candidates exist only as compiler analysis/IR during this comparison. The
losing candidate is discarded before `TableProgram` serialization and assembly; the
runtime and package never carry both implementations merely because the compiler
considered both.

Capability scope cannot be narrowed to hot sites, supported kernels, current planner
candidates, or the sites the cost model is expected to choose. It includes every
reachable terminal/compound lexical atom and every supported assembly variant in the
final program. This is what prevents selection from defining away inconvenient token
candidates.

This ordering is fail-closed. “The token kernel is not implemented here” is an
implementation gap (`GAP`), not evidence that the character representation is cheapest. If
any reachable semantically tokenizable site remains in that state, token cost selection
is disabled for the whole program. The program may still compile using the established
all-character baseline while the architecture is incomplete, but it contains no
partially selected token sites and makes no cheapest-representation claim. A site is
exempt from token capability only when a semantic proof shows that no exact token
representation exists under the required context/modes. Semantic impossibility is
narrow: input recognition depends on arbitrary state, callbacks, or observable effects
that cannot be represented by the pure `(input, position, lexicalContext)` recognition
contract. The refusal records the exact proof category.

Capability analysis and cost selection therefore have separate data and separate
tests. The selector cannot query “did token lowering succeed?” as its cost model, and
the token builder cannot query which strategy the selector prefers. Hiding or deleting
a valid token candidate must make the capability-completeness gate RED rather than
silently selecting the character body.

`TOKEN` is admitted only when all of the following are proven:

1. The token kernel recognizes the complete authored selector language for that site,
   including its lexical context, escapes, case, boundaries, interpolation rules,
   trivia position, and every supported run mode.
2. The token result replaces work. It is consumed by the decision and continuation,
   or reused by more than one compatible PEG trial. Producing an integer that is used
   once before the old selector runs is not token lowering.
3. The token body contains no reachable legacy selector, recognizer, substring/fold,
   or diagnostic replay of that selector. A recognition miss resolves directly under
   the token body's compiled success/failure plan. If correctness would require
   falling back to or replaying the character body, the token candidate is `GAP` and
   whole-program token selection remains disabled until it is complete.
4. The selected shape is locally cheaper than the character body it replaces. The
   proof accounts for prefix reads, kernel calls, cursor/cache checks, saved parser
   pieces, avoided rescans, value materialization, and artifact bytes. “More
   tokenized” and “more clever” are not benefits.
5. Closure, emitted/macro, runtime compile, compose/linkable, folded, precompiled,
   probe, recovery, CST, coverage, and tracked variants consume the same selected
   strategy. If a cold/run mode cannot use the exact token body, the candidate is
   `GAP`; a token fast path with a character cold-mode fallback is not admitted.

`CHARACTER` is a first-class final lowering, not a tokenization failure. A site stays
character-based when one lead code unit already decides it, when recognition is used
once, when a recorded semantic-impossibility proof excludes a pure token candidate, or
when token bookkeeping costs more than the work it would remove. A character-selected
site instantiates no token cursor, cache, plan lookup, helper, or branch and should
remain byte-identical to the legacy body when no other change applies.

The optimization target is therefore minimum total work, not maximum token coverage.
Integer comparison is useful only after the compiler has eliminated enough recognition
and parser work to pay for producing the integer.

#### Current Jess 93c capability and cost baseline

The exact compiler-only census against Jess
`93c67d0ae7be0360a6db35f0cfa055043bca8025` separates capability from cost as
required above:

| | CSS | Less |
| --- | ---: | ---: |
| reachable rules / combinator nodes | 198 / 1,268 | 278 / 2,144 |
| distinct primitive terminal languages | 121 | 187 |
| authored compound token atoms | 16 | 25 |
| final `CHOICE` / `DISPATCH` rows | 75 / 7 | 168 / 9 |

Every primitive and compound atom in this graph is semantically tokenizable. None is
excluded by a Jess state gate or `withCtx` dependency. The existing normalizer still
has fourteen implementation gaps: nine CSS balanced/scan-transform atoms and five
Less balanced or trivia-scoped atoms. Complete TOKEN diagnostics, pending consumption,
CST, probe, recovery, coverage and tracked-mode bodies also do not yet exist for the
whole inventory. Consequently the canonical completeness gate is currently open and
TOKEN selection MUST remain disabled for these programs. These are `GAP` results, not
CHARACTER cost wins and not semantic impossibilities.

Once capability closes, the current cost ranking is:

1. **TOKEN candidate — Less identifier-led statements.** The final `blockItem`,
   `Body` and stylesheet decisions repeatedly enter and fail `FunctionStatement` and
   then a ruleset path. An atomic identifier/function result plus declaration/selector
   continuation facts has a conservative ceiling of 6,373 eliminated entries in
   `benchmark.less` and 13,654 in generated Less. Its binding comparison is a direct
   captured closure versus three named emitted sites—not a whole-parser factory.
2. **CHARACTER candidate — Less `Value`/`MixinReference`.** Although this has the
   largest raw failed-entry count, `MixinReference` can start only with `.` or `#`.
   A corrected finite FIRST gate excludes about 7,963 / 24,459 entries more cheaply
   than producing a general token. The remaining `.`/`#` cases have effectively no
   token-reuse payoff.
3. **CHARACTER by present evidence — CSS.** The benchmark has only 442 repeated exact
   lexical calls and no compound-token same-position reuse. CSS remains token-free
   unless a specific completed site proves a local cost win.

The previously suspected Less comma/semicolon mixin separator is not a leading target:
the measured hot separator/trailing probes belong to `CallArgumentFunction`; the
ambiguous `MixinArguments` site occurs only five times in `benchmark.less` and zero
times in generated Less. It remains part of capability closure, but coverage is not a
reason to select it.

This census is the selection baseline, not timing evidence. Its RED plant removed all
events and failed the pinned count; the clean source/reference/closure runs retained
full identity and consumption on CSS (123,029 bytes), `benchmark.less` (106,802), and
generated Less (275,211).

### 3.1 Global identities, local contexts

- Token ids are compact non-negative integers in one global id space for the
  final composed grammar.
- A lexical context id is supplied by the parser site. It may represent a named
  mode, candidate set, or compiled combination of active terminals.
- Recognition is position-local. The cursor remains a character offset so spans,
  errors, recovery, CST data, and incremental parsing keep one coordinate system.
- The compiler must inventory every statically enumerable terminal/compound lexical
  atom it can reach and either build its exact token language or record a semantic
  impossibility/missing implementation category. That capability does not admit token
  lowering at every use site. A dynamic/context-dependent or cheaper direct site
  remains explicitly `CHARACTER`; a shallow lead walker stopping at a wrapper is an
  analysis gap to close, not permission to install a dual path.

The rejected seven-token CSS experiment tested mode-free global maximal munch with
every terminal active everywhere. It did not test this design.

### 3.2 Virtual tokens and compact pending results

The runtime token is a **virtual classification of an input range**, not a token
object. Recognition does not copy the range or eagerly construct a string value.
The common result is allocation-free scalar/packed state owned by the active assembly
and reset at parse begin. Conceptually it contains:

```text
input identity
position
contextId
count
tokenIds[count]
starts[count]      # omitted when every view starts at position
ends[count]
flags[count]       # other proven lexical facts; never used to split an atomic token
```

The unique case has one integer id and end. Same-token or prefix overlap retains a
small compatible list in source-order-compatible form. Multiple ids may classify the
same `[start,end)` range without duplicating it. No match object, `{ type, value,
span }`, or copied substring is allocated per recognition. A semantic consumer slices
the input only when its result actually requires the text; integer dispatch,
lookahead, admission, and failed trial do not.

CSS lexical atoms stay atomic. In particular, `foo(` is one `FUNCTION_OPEN`
classification whose range includes the name and `(`; it is never represented as an
`IDENT` token plus an adjacent `LPAREN` token. Plain `foo` is `IDENT` only when the
active lexical context does not recognize a function token at that range. Less may
extend the accepted name/interpolation family, but an accepted function opener is
still one virtual token with one id, start, and end. Parser-level multi-token admission
starts after that atomic range; it must not reconstruct lexical tokens from adjacency
flags.

An authored `token(parser)` wrapper is an explicit lexical-atom boundary. Its child
literals, regexes, optionals, and sequences are recognition machinery and are not
exposed as separate cursor tokens at a site consuming the wrapper. A single wrapper
may define a statically derivable token family: for example, the existing
`identOrFunction` wrapper recognizes one contiguous range and its dispatch classifies
that range as `IDENT`, `FUNCTION_OPEN`, or a more specific proven function subtype.
Those outcomes receive token ids/views over the same atomic range; the optional `(`
inside the wrapper never receives a parser-visible token id for that decision.

Therefore the derived alphabet is not limited to primitive `literal`, `keywords`, and
`regex` rows. It includes explicit compound lexical atoms and their statically proven
dispatch classifications. Primitive children remain independently tokenizable only in
contexts that actually consume them outside the compound wrapper.

Readable token grammar must not carry a parse-time tax. Within an effect-free,
contiguous `token()` body, the compiler normalizes literal, regex, choice, sequence,
optional, and bounded/repetition structure into canonical lexical IR. For example,
`sequence(identifier, optional(literal('(')))` and an equivalent regex optional
character/run must select the same class of straight-line recognizer. The combinator
form must not add child parser calls, child token ids, CST leaves, copied ranges, or
temporary values. Canonically equivalent lexical shapes should share recognition
machinery/specs when their matching semantics agree.

This normalization is deliberately bounded and proven. A token body with state gates,
semantic callbacks, recovery, commitment, externally visible internal capture, dynamic
context, or an unsupported regex equivalence declines to the ordinary correct path. A
refusal is preferable to silently changing the token language, but author syntax alone
is never a valid reason to decline a shape the compiler can prove equivalent.

Surface similarity is not an equivalence proof. JavaScript regex quantifiers may
backtrack into later regex terms, while Parseman's ordered PEG sequence does not rewind a
successful `optional()` or repetition merely because a following term fails. For example,
`/a?a/` accepts `"a"`, whereas `sequence(optional(literal('a')), literal('a'))`
fails after the optional consumes the only `a`. Those shapes must not share a recognizer.
The compiler may normalize a regex optional run with a readable combinator form only when
it proves that backtracking cannot change acceptance or the final token range—for example,
the production identifier recognizer followed by a terminal optional `(`. Every expanded
equivalence class requires a semantic RED counterexample/oracle, not just matching IR text.

The concrete storage may be a structure of packed integer arrays, an interleaved
integer array, or V8-fast Smi arrays. That is a measured representation choice, not a
reason to expose token objects. Artifact tables and runtime cursor buffers are reported
separately; typed arrays are not assumed faster without production A/B evidence.

Reentrant parsing saves/restores the cursor frame exactly as it already does for the
installed trivia scanner and end cell.

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

Recognizer identity and diagnostic identity are separate. Two authored token bodies
may share a pure success recognizer while retaining different failure checkpoints and
expected sets. For example, `token(sequence(literal('a'), literal('b')))` can fail on
`"ax"` after the first child and report `"b"`, while `token(regex(/ab/))` fails the
single regex at the starting position. A replacement consumer therefore needs a
spelling-specific diagnostic plan (including probe/commit behavior where applicable);
an `end | -1` recognizer result alone is not enough to bypass the authored child path.

### 3.4 Raw, seeded, and pending are one kernel

Every terminal family selected for token replacement exposes one recognition contract
with three entries:

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

### 3.6 Leading Less target: structural triage from token prefixes

The first production target is not limited to the leaf-heavy `Value` choice. Less
repeatedly has to distinguish grammar families that share the same character prefix:

```text
.name(...) { ... }    # mixin declaration
.name(...);           # mixin call/reference
.name { ... }         # ordinary ruleset
```

The exact language has guards, namespaces, interpolation, selector combinations, and
optional argument forms, so this is not a promise that three tokens always select one
production. It is the reason the cursor must retain a **compatible token-prefix view**
rather than only one longest token.

At the relevant statement/selector context, recognition should derive and cache the
shared opener tokens once—for example a class/id sigil followed by either an atomic
`FUNCTION_OPEN` range or a plain identifier/interpolation range, then later braces,
semicolons, colons, or other distinguishing tokens. A compiled arm-signature table
then removes only arms whose token prefix is impossible. The signature is a numbered
sequence over virtual range classifications, not a string key:

```text
packed token-id sequence -> packed signature trie/table -> compatible arm mask
compatible arm mask      -> existing PEG arms in source order
selected arm             -> consumes cached range ends and lazily requested values
```

This may inspect more than one token, but it remains tokenized PEG rather than LL(k)
production selection. If declaration and call remain compatible through an argument
list, both remain eligible in source order. Their common token sequence is still scanned
once and consumed from the cursor; the parser continues trial at the first grammar point
that has not been classified. A later arm is never selected merely because a predictor
can see farther than an earlier prefix match.

The implementation census must map the authored mixin-declaration, mixin-call/reference,
and ordinary-ruleset choices to their TableProgram sites and report dynamic calls,
failed arms, nested row work, rollback work, token-prefix lengths, compatible-mask sizes,
and pending-result consumption on both `benchmark.less` and generated Less. The first
landing target is chosen by nested work removed, not by terminal-call count alone.

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
6. an opaque native-regex token kernel, selected as that site's sole recognizer only
   when the fixed/shared kernels cannot represent the language and the measured
   replacement still wins. It is not a fallback to the character parser.

The existing first-set analysis, literal constants, scalar recognizers, scan shapes,
and table class pools are inputs to one implementation. Token metadata must not
duplicate a second graph walk or second regex-analysis lattice.

## 5. Parser-piece integration

At token-selected sites, the token cursor binds through the shared piece library.
Character-selected sites link their original bodies with no token branch or state.

### Choice

- A disjoint character mask keeps its O(1) fork and publishes a recognition seed.
- A shared-leading choice requests one position result.
- Incompatible arms reject by integer/mask without entering their parser pieces.
- Compatible arms stay in source order and see the same result.
- These are distinct linked choice bodies. A token-selected choice cannot call the
  original arm selector on miss or after routing; a character-selected choice cannot
  consult token state.

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
2. **Close token capability.** Derive/build every semantically valid token candidate
   across the entire reachable final grammar independently of cost; record proven
   dynamic impossibilities separately from missing implementation. Any missing
   implementation keeps the whole program on the token-free character baseline. A
   planted candidate omission must fail.
3. **Freeze the site strategy.** Compute `CHARACTER` versus `TOKEN` from the final
   composed program, link distinct bodies, and prove no runtime strategy branch,
   selector replay, or inactive token allocation.
4. **Install the position-result frame only for token-selected sites.** Parse-local
   reset, reentrant save/restore, compact integer arrays, emitted/closure/precompiled
   parity, and no per-match objects. No-token programs remain byte-identical.
5. **Give selected terminals the raw/seeded/pending contract.** Existing scalar node and NOT
   consumers become the first production users.
6. **Wire shared-leading choices as replacements.** Begin with the measured Less `Value` site, but
   implement context and compatible-view machinery as reusable assembly infrastructure,
   not an IP-specific branch. The old selector must be unreachable at an admitted site.
7. **Replace the native candidate loop with fixed/trie kernels.** Expand by measured
   frequency across standard CSS, benchmark Less, and generated Less.
8. **Expand only where replacement cost wins.** Resolve wrapper/rule leads and compiled
   lexical contexts, but retain direct character bodies wherever they are cheaper.
   Token-coverage percentage is not a milestone.
9. **Only then evaluate buffering and prediction.** On-demand position recognition is
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

Replacement-structure teeth are blocking:

- an admitted token site's linked/reached graph and emitted source contain the token
  kernel and contain no legacy selector/recognizer/replay path;
- counters observe one token scan per `(input, position, lexicalContext)` result and
  zero legacy recognitions across compatible rollback, routed continuation, and final
  consumption;
- planting a reached legacy selector replay makes that one-scan/zero-legacy
  differential RED;
- a wholly no-token program has byte-identical `TableProgram`, compact/fold output,
  emitted module, and linked closure-piece source to the character baseline;
- a refused/direct site contains no token symbol, cursor allocation, plan lookup, or
  parse-time strategy branch;
- a mixed grammar proves that token and character sites receive separate statically
  linked bodies rather than one conditional body, and that the legacy piece itself
  contains no token symbols;
- every run mode uses the same site strategy; inability to preserve probe/recovery/CST
  semantics refuses token admission instead of selecting a cold fallback.
- capability enumeration is independent of cost selection; a plant that removes a
  known valid token candidate after compose/root relocation fails the completeness
  gate instead of selecting character;
- capability scope is the entire reachable final composed grammar and all supported
  assembly variants; a plant that narrows it to hot/supported/planned sites fails;
- any `token-capable but not implemented` site keeps token selection disabled for the
  whole program, so partially supported tokenization cannot become the shipped shape;
- reports distinguish `token-capable but not implemented`, `semantically impossible`,
  and `both candidates built; character selected by cost`. Only the last is evidence
  that character is cheapest.

Performance reports include:

- classifier calls and fixed/native kernel counts;
- compatible views, integer arm rejections, and prior arm entries removed;
- pending-result hits and known-prefix rereads;
- cold assembly and warm parse time;
- A/A controls, dispersion, and independent process/graph replication;
- TableProgram words, runtime bundle size, packed/unpacked package size;
- complete input consumption and complete `RunResult` identity before timing.
- token production cost versus character work removed at each admitted site; token
  coverage without removed work is reported as zero benefit.

Near-flat results use the hardened high-sample mode; routine gates remain short. No
timing is promoted when load exceeds the harness ceiling or engine/source realpaths are
not printed before the number.

There is no universal per-change percentage floor. A stable control-adjusted gain above
1% with negligible artifact, package, complexity, and cross-fixture cost is a bankable
0.48 improvement even when it does not remove a shelf by itself. Orthogonal gains are
measured again on the integrated head because cumulative recovery is the release path.
Larger mechanisms and package increases require proportionally larger payoff; noise,
semantic risk, or a material regression elsewhere still rejects a candidate.

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

The primary 0.48 orchestrator owns the external Jess integration base. Before Jess
work is delegated or measured, the primary fetches `origin/dev`, pushes any
independently approved Jess-native prerequisite to `origin/dev`, records the exact
remote SHA, and requires every dependent agent to create or refresh an isolated
worktree from that SHA. Stale, dirty, or privately diverged Jess checkouts are evidence
archives, not production measurement bases. After `origin/dev` moves, the primary
reruns the external build, macro/compose, full-consumption, and semantic identity gates
before promoting performance evidence.
