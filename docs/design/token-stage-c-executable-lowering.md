# Token Stage C: executable replacement lowering

Status: normative 0.48 design addendum; implementation is in progress. Primitive
terminal bodies and all fixed incoming bindings—including scanner sentinel and
authored own-skip children—now have reference, captured/CSP, and named/emitted
projections. Choice/dispatch effects now also carry final winner/route authority,
exact child-binding projections, three reader templates, and a common semantic
digest. The remaining composite token boundary, diagnostic, materialization,
and supported-variant bodies still keep whole-program TOKEN selection closed.

This addendum refines [parseman-0.48.md](./parseman-0.48.md) §§2–3. It does not
relax whole-grammar capability closure, replacement-only selection, or direct
binding of fixed grammar tuples. If this file conflicts with those requirements,
the stricter requirement controls.

## 1. Authority census, pipeline, and admission

The authoritative final composed occurrence inventory, from Parseman
`1a65170dfc11eb2f322f906157c4a92d2107d224` and Jess
`bbda2ec9f5295c7cd2a46e8237b7e564a8f844b8`, is:

- CSS: 842 bodies = 645 terminal + 39 token + 147 choice + 11 dispatch,
  with 2,705 fixed binding edges and 158 decision sites;
- Less: 1,687 bodies = 1,178 terminal + 62 token + 418 choice + 29 dispatch,
  with 6,819 fixed binding edges and 447 decision sites; and
- total: **2,529 bodies and 9,524 fixed binding edges**.

Stage C constructibility ranges over that entire inventory, not only authored
`token()` atoms or decisions expected to win TOKEN pricing. Permanent authority
pins both dialect totals, every category, edge count, and decision count; the
census is an omission authority, not a performance denominator.

Stage C uses one ordered compiler pipeline:

1. On the final composed, winner-resolved grammar, build every semantically valid
   CHARACTER and TOKEN candidate for every occurrence and every supported
   assembly variant. Recognition, token diagnostics, token boundary,
   token materialization, decision effects, supported variants, and binding are
   separate required obligations. A missing lowering is a named `GAP`, never
   cost evidence.
2. Token selection remains globally disabled while any reachable token-capable
   occurrence has a `GAP`. `IMPOSSIBLE` requires a semantic proof.
3. Only after both complete bodies exist does the compiler price CHARACTER
   against TOKEN. For the semantic winner it then constructs and freezes a
   separate binding projection for every reader class: captured/prewritten
   closure for CSP assembly, statically named body for emitted/precompiled
   assembly, and the reference projection for `execRules`. Every applicable
   projection must be complete before the body is selectable.
4. The semantic winner and all of its per-reader projections are frozen before
   `TableProgram` serialization. The losing semantic body is discarded.
   Readers consume their already-recorded projection; assembly never chooses or
   tests a binding strategy.

Every supported mode must use the same selected strategy. Probe, tolerant,
coverage, tracking, CST, host, macro, compose, precompiled, module, and folded
paths may select different effect-specialized constructors, but may not fall
back from TOKEN to CHARACTER.

An atom-only tranche or a binding-only tranche closes **zero serializable TOKEN
candidates**. Representation progress is useful evidence, but no body may enter
the wire until all required obligations and every fixed incoming edge are
constructible across the whole grammar. In particular, token boundary and
materialization plans do not cover a choice/dispatch occurrence's attempt,
expected, commitment, routed, rollback, and arm-order effects; those belong to
the distinct `decisionEffects` obligation.

Decision effect ownership is exact:

- CHOICE predecision owns no token boundary or materialization. It may publish
  only a scalar range/outcome/mask. Each arm actually entered in PEG order owns
  and executes its own B3 wrapper transaction and materialization. An
  unrestricted arm executes its exact TOKEN candidate, never a legacy body.
- DISPATCH owns classifier/route priority, no-route diagnostics, routed span,
  and routed cut/commit behavior. Its selector child owns the B3 wrapper
  transaction and materialization exactly once; the dispatch must neither move
  nor duplicate them.

## 2. Candidate schema and selected `LexBodyProgram`

`LexBodyCandidate` is compiler-only canonical IR. Every complete CHARACTER and
TOKEN candidate is derived from this one schema before pricing. Its binding
inventory is a required projection set over one semantic body, not one universal
binding kind: closure/CSP, named emitted/precompiled, and reference projections
are each constructed, validated, and priced for their own reader. Candidate
inventories never enter `TableProgram`.

After cost selection, only the winning semantic body and its complete frozen
projection set become the compact, table-owned numeric `LexBodyProgram`. It may
contain:

- canonical recognizer/state-machine rows and input-indexed outcome tables;
- relocated Stage-B diagnostic, control, boundary, and materialization IDs;
- fixed site operands: children, predicates, compatible arms, routes, effects,
  expected IDs, and continuation targets; and
- numeric operands for each frozen per-reader binding projection and a semantic
  version/digest.

It contains no combinator pointers, functions, parser paths, string strategy
keys, alternate CHARACTER body, or runtime eligibility flag. A program with no
selected TOKEN body has no token pools, cursor state, token opcode, lookup, or
branch; its compact program, emitted source, linked Piece source, allocation
shape, and fold representation remain byte-identical to the character baseline.

`LexBodyProgram` is serialization and link input, not a parse-time interpreter.
Input-indexed recognition transitions and outcome masks may use numeric tables:
their index is genuinely produced by input. Fixed grammar topology may not.
The projection set does not authorize a reader to choose among representations:
the closure reader consumes only the frozen closure projection, emitted and
precompiled readers consume only the frozen named projection, and `execRules`
consumes only the frozen reference projection. All three carry the same semantic
body digest.

`ParseContext.scanSkip` (and `scanTo`'s ambient `ctx.trivia`) are public runtime
parser-extension seams, not serialized fixed topology. A scan-sensitive body
records its authored scanner kind, its directly bound own-skip topology, and the
required dynamic ambient policy. Parsers reached through the live context remain
runtime callback operands; they never become combinator pointers in
`LexBodyProgram`. Their identity can never authorize substitution with a compiled
body because `.parse` lookup/call is itself observable and mutable.

## 3. One semantic authority, two renderers

One table-owned lowering catalogue and its shared semantic primitives define
each body operation and its complete effect contract. They are the sole effect
implementation. From that authority the build produces:

1. CSP-safe assembly constructors using prewritten bounded templates and direct
   scalar captures; and
2. a hygienic named-source renderer used by emitted and precompiled artifacts.

The two renderers are representations of the same selected `LexBodyProgram`, not
parallel engines. A renderer-version stamp may invalidate cached generated text;
it is distinct from the semantic digest. Adding an operation is incomplete until
both renderers and every supported mode implement it. Runtime `new Function`, a
precompiled-only semantic path, and a closure-only fallback are prohibited.
Named emitted fusion is generated from this catalogue; it may spell fixed
topology inline but may not hand-code a second semantic leaf/effect operation.

`execRules` remains the reference/oracle reader for a selected plan. It must
execute the selected TOKEN semantics (directly or through an explicitly
reference-only `LexBodyProgram` reader) and may not silently run CHARACTER for a
token-selected row. Its indexed reference implementation is not authorization
for the shipped closure/emitted renderers to violate the direct-shell law.

Shared helpers may own pure recognition/effect primitives and dynamic input
tables. They must not accept a fixed child Piece and become a shared indirect
call site. Hot fixed kernels may be fused into a captured or named shell when
that complete expression wins the cost model.

The lowering catalogue has two scanner-kind operations which are also the
source/table authority for the public dynamic ambient contract:

- `scanTo` reads ambient trivia and spreads the live ordered `scanSkip` iterable
  on every parse attempt, preserving getter/iterator/order/throw behavior. It
  invokes those ambient callbacks through one detached probe context with the
  same copied `state` and forwarded `_errors` channels as today.
- ambient `balanced` reads `ctx.scanSkip` and `.length`, caches the ordered
  callback snapshot by the array object's identity, and enumerates only on a
  cache miss. A later parse with that same array identity reuses the old snapshot
  even if its elements changed. Its callbacks execute through the token-cleared
  original context, not `scanTo`'s detached probe context.

Both operations perform dynamic `.parse` lookup/call on each cached callback;
even a callback object identical to a compiled grammar skipper is never replaced
with a direct body. Authored own-skip children remain fixed topology and use the
frozen per-reader binding projections. Calling a live ambient skipper is an
opaque public callback, like a gate/reducer invocation; it never invokes the
selected site's original CHARACTER parser and is not legacy grammar replay.

## 4. Direct-shell law

Assembly decodes `LexBodyProgram` once. Each linked decision shell captures fixed
children, compatible arms, routes, wrapper continuations, constants, and effect
handlers as scalars. Emitted bodies name the same facts directly.

At parse time, a fixed site contains no:

- opcode or strategy switch;
- `pieces[ip]`, `kids[i]`, `arms[id]`, or route-array lookup;
- structural loop over fixed children/arms;
- optional-plan branch; or
- legacy selector, recognizer, replay, or fallback path.

An input-derived token/outcome may select a direct captured/named arm through a
bounded switch, chain, or tree. It may not index a fixed arm array. Compatible
arms still execute in authored PEG order. Recognition miss and final failure
execute the selected diagnostic plan directly, without replaying CHARACTER.

Cold diagnostic/control rows may use assembly-threaded continuations when their
call cost is cheaper than duplication. The hot recognizer/decision/continuation
path must be priced as a whole; a generic micro-IR interpreter is not an allowed
shipping representation.

## 5. Pending range and reentry

Only an assembly containing selected TOKEN sites owns pending range state. The
hot current fact is an allocation-free scalar keyed by input identity,
post-trivia position, family, and an immutable post-enter recognition-context
snapshot. This reusable pending path is available only to bodies whose
recognition is independent of live ambient parser callbacks.

Each consumer checks or produces pending state only **after** its ordered B3
wrapper enter/clone/clear operations. A predecision result is reusable only when
the consumer reaches the identical immutable snapshot. Public
`parseWithContext` state supplies genuinely dynamic ordered parser extensions.
A scan-dependent TOKEN body executes the scanner-kind policy above exactly where
the authored scanner would have executed. Its decision relation remains
`unrestricted`: it cannot run as an effect-free predecision and cannot publish a
cross-arm/context pending fact, because an ambient callback may mutate shared
state, append errors, or throw. Its successful range may flow directly to its own
selected continuation inside that one body invocation, but no other site may
look it up. This is complete TOKEN recognition at the original semantic point,
not a CHARACTER fallback. Static wrapper equivalence, parser identity/order, and
stable container identity are never pending-reuse authority.

One scalar is not universal across PEG rollback. Every speculative decision
saves the prior pending fact in a choice-local parse-state frame before entering
an arm and restores it on ordinary failure or post-match rejection. Recognition
at a later position may replace the hot scalar inside that arm without destroying
the saved earlier fact. Thus `p -> q -> fail -> retry p` recognizes `p` once.
The frame stack is dynamic rollback/reentry state, not a fixed-arm array or a
grammar-topology lookup. Compatible PEG trial and the selected continuation
consume the same restored fact without rescanning.

Nested parsing saves and restores the complete scalar plus rollback-frame mark.
Changing context/input, beginning a parse, or crossing an incompatible wrapper
invalidates only facts not protected by the active rollback mark. Materialization
slices only when semantic value or the outer CST leaf needs text. Recognition
classification and pending publication themselves are effect-free. The two
dynamic scanner operations are explicit ordered effect operations owned by the
selected TOKEN body and never cached as reusable lexical facts.

## 6. Relocation, precompile, and fold

All body references relocate after final compose/unfold, using table offsets and
pool IDs only. Relocation validates exact operand arity, range, ownership,
well-nested control ancestry, and one referenced record per required obligation.
Malformed or missing records fail closed before a factory runs.

A precompiled assembly records:

- semantic `LexBodyProgram` digest and format version;
- renderer version;
- assembly configuration key; and
- exact reached-site inventory.

The loader validates these against the relocated program before invoking its
factory. A valid factory paired with mutated body data must be rejected.

Fold classifies `LexBodyProgram` and its pools explicitly. Strategy and semantic
body must be identical shared fields across variants unless a field is declared
as a checked variant delta. A mismatch is refused; it is never inherited from
the base. Folding happens before per-variant precompilation. `unfoldVariant()`
must derive, relocate, and validate the complete selected body and binding
projection set from that variant's code and deltas before any factory runs; it
may not seed resolved body state from the base and swap only `code`.

## 7. Required RED gates

No Stage C checkpoint is evidence until each relevant harness has been planted
RED and restored GREEN.

- Capability: omit a valid final occurrence, variant, candidate, renderer, or
  binding expression; global TOKEN selection must disable/fail closed.
- Selection: mutate cost output or serialize both candidates; only the selected
  body may remain in the artifact.
- Structure: reintroduce opcode dispatch, a fixed tuple array lookup/loop,
  optional token branch, or legacy selector/replay. Closure reached graphs and
  emitted source must fail the tooth.
- Replacement: admitted success, miss, compatible rollback, routed
  continuation, and materialization each record exactly one token scan and zero
  legacy recognitions.
- Rollback cache: an arm recognizes a family at `p`, recognizes it again at
  `q`, fails, and a later compatible arm retries `p`; the `p` recognizer count
  must remain exactly one after choice-local pending restoration.
- Mutable context: for `scanTo`, mutate/Proxy ambient trivia or `scanSkip` and
  prove one fresh ordered enumeration plus detached-probe state/error/throw
  behavior on every attempt. For ambient `balanced`, prove array-identity cache
  hit/miss and iterator/throw counts, same-array mutation invisibility on the
  second parse, and token-cleared original-context channels. In both, mutate
  `.parse` on callback objects whose identities match compiled skippers and prove
  the dynamic lookup is observed. No scan-dependent fact may enter predecision
  pending reuse, and no tooth may invoke the original selected token/choice
  CHARACTER body.
- Identity: source/reference/closure/emitted/precompiled/module/fold agree on
  full result facets, consumption, expected/commit/probe, CST/raw/fields/errors,
  trivia/root logs, line data, recovery, throwing accessors, and reentry.
- Wire: corrupt every body operand, relocated ID, digest, reached set, or fold
  classification; loading must reject with a stable malformed-body error.
- Variant relocation: mutate a folded variant opcode or body reference while
  leaving the base valid; per-variant relocation must reject before its
  precompiled factory is invoked (`factoryCalls === 0`).
- Reader projections: omit or cross-wire closure, named, or reference binding
  projections; selection must remain disabled, and no reader may substitute a
  different projection at runtime.
- No-token: exact program/module/Piece hashes and zero token allocation/read
  against the pre-Stage-C character baseline.

The Less `Value` and identifier-led FunctionStatement sites are required generic
performance proofs, not admission exceptions. Their one-scan/zero-legacy and
retry-removal counters must be produced by reusable family/context/outcome and
direct-shell machinery that also constructs the full occurrence inventory. No
Jess rule name, IP, hot-site allowlist, or special body opcode may close their
capability or bypass whole-grammar completeness.

## 8. Size and call-shape gates

Before executable work lands, report independently for closure and named forms:

- exact shared template/operation count and maximum body size;
- packed/unpacked npm delta across every ESM/CJS entry graph and source map;
- loaded module bytes, cold import/assembly time, and retained memory;
- selected program words/pool bytes and fold delta behavior;
- removed versus added calls, branches, indexed loads, scans, and allocations;
- steady parse with isolated-process A/A and A/B controls only after correctness
  review.

Stop or redesign if the implementation requires a whole-program factory,
duplicates the assembler into entry bundles, makes a no-token graph load token
machinery, leaves fixed topology in a generic interpreter, or cannot prove the
one-scan/zero-legacy contract. Package growth requires proportionate production
benefit and must preserve the net package gains of the compact table design.
