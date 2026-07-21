# Grammar Semantic Coverage — Design

## Decision

Add grammar-semantic coverage as an explicitly enabled test/build feature. It
reports exercised named rules, selected choice arms, and structural labels.
It must not add code, allocations, branches, metadata, or changed output to a
normal interpreter or macro-compiled parser.

> **Status — implemented in 0.28.0.** This document preserves the design
> rationale. The current public API and operational contract are documented in
> [Grammar observability](/guide/grammar-observability).

## Coverage identity

Coverage IDs are derived from the **normalized composed IR**, after all
`compose`, `composeLeaf`, `pick`, and override winner selection has completed.
They are not derived from:

- source offsets;
- generated function names or generated-code offsets;
- import/module namespace strings;
- object identity;
- labels.

An ID is a canonical structural path rooted at an exported entry rule:

```text
rule:<winner-rule-name>
choice:<rule-name>/<normalized-child-path>/arm:<index>
label:<rule-name>/<normalized-child-path>
```

The normalized child path uses stable combinator tags and child indexes. The
normalizer must use the same winner graph used by the linker/code generator,
not a pre-compose grammar piece. A rule overridden by a later composed grammar
therefore contributes no coverage definition; its winning replacement owns the
same rule-root ID.

`label()` is an optional display annotation attached to a structural ID. Its
text is never identity: duplicate labels and renamed labels leave IDs stable,
while a label moved to a different structural path has that path's distinct ID.
Node types and field names are not coverage labels and must not be inferred as
such.

The artifact must carry a schema version and the canonical definition list so
that a changed grammar can be distinguished from an untested grammar.

### One required plan, built once

Before either engine executes, `buildGrammarPlan({ startRule, composed })`
must materialize the final winner graph, apply `pick` closure, and return one
immutable plan: definitions, rule/choice/label ID lookup tables, and the
explicit start-rule closure. The interpreter wrapper and coverage-specific macro
emitter consume that same plan; neither may walk parser objects independently
or invent a counter/path at emission time. Existing independent traversal maps
and generated `choice:<counter>` IDs are invalid prototype machinery and must
be removed before release.

`composeLeaf` is covered only when the macro lowering preserves this plan next
to the final fused grammar. If an imported opaque artifact cannot expose final
winner IR, plan construction fails explicitly; it must not fall back to a
pre-compose map.

## Collection semantics

A coverage-enabled parse gets a fresh collector by default. The collector owns
boolean hit sets and optional counts; thresholding uses booleans, while counts
are diagnostics only.

```ts
const run = runWithGrammarCoverage(grammar.Entry, input)
// run.result: ordinary ParseResult
// run.coverage: immutable snapshot for this parse

const collector = createGrammarCoverageCollector(definitions)
runWithGrammarCoverage(grammar.Entry, inputA, { collector })
runWithGrammarCoverage(grammar.Entry, inputB, { collector })
const merged = collector.snapshot()
collector.reset()
```

Rules tick when entered, even in recursion; repeated recursive visits only set
the same boolean rule ID. Choice arms tick only after that arm succeeds. Labels
tick only after their wrapped parser succeeds. Failed speculative alternatives
must not create hits. This makes the result semantic rather than an attempted
control-flow trace.

Coverage passes through `ParseContext` only in the dedicated coverage path.
No global mutable collector is allowed: parallel tests and nested parses must
not share state accidentally. A collector may be explicitly shared to merge
multiple inputs, and `reset()` has defined per-run semantics above.

## Interpreter and macro paths

These are separate implementations sharing only the normalized-ID
specification and artifact format.

### Interpreter

The coverage entry point builds a coverage-aware execution wrapper around the
normalized grammar and installs a collector in its parse context. The ordinary
`run`/`parse` path must retain its current call graph and context shape.

### Macro/compiler

The plugin must receive an explicit coverage compilation option and invoke a
coverage-specific code-generation path. Only that path emits tick calls.
That emitted path reads the final grammar plan and must tick final-plan rule
entry IDs, final-plan selected choice-arm IDs, and final-plan successful-label
IDs; trace emission uses the same plan for every defined rule/arm/label phase.
It must not retain macro-only choice counters or omit rule/label facts.
Normal `compileRuleMap`, `composeLeaf`, and plugin transforms must produce the
same generated JavaScript as before this feature.

Required proof of the zero-default claim:

1. a macro fixture compiles with coverage disabled before and after the feature;
2. the emitted JS is byte-identical;
3. it contains no coverage identifier/import/helper;
4. a coverage-enabled fixture contains ticks and produces the same parse result.

Runtime macro fallback is coverage-aware only when the caller selected coverage
mode. The artifact must record `engine: "interpreter-fallback"`; it must not
claim macro structural source information it cannot actually provide.

## Source origin metadata

Coverage does not require source locations. The deterministic structural ID is
the contract.

## Unsupported structural nodes

`recover` is a control-flow wrapper, not a grammar alternative; it contributes
no coverage definition of its own. Its child remains in the normalized graph
and must be executed by either coverage engine with the same recovery behavior
as an ordinary parse. `unknown` is intentionally opaque and contributes no
definition or child closure. A coverage runner must never silently delegate a
structural node to the ordinary graph, because that would make nested hits
disappear. Until recovery-aware rebuilding exists, a coverage run containing a
`recover` node must fail explicitly rather than publish a partial result.

If macro lowering can preserve an actual Oxc AST span through the evaluated
combinator and the plugin can serialize it without changing normal output, a
coverage artifact may include this optional field:

```ts
origin?: { moduleId: string; start: number; end: number }
```

Do not add a source-map sidecar merely as a plan. It is permitted only after an
implementation proves that the origin is correct through local rules,
`compose`, `composeLeaf`, `pick`, and macro fallback. Runtime/interpreter-only
grammars omit `origin`.

## Deterministic artifact and CI

The canonical feature is the per-run in-memory collector and its immutable
snapshot. JSON is an optional deterministic interchange/export artifact for CI
and review; parsing a test input must not write a file, and ordinary callers do
not need JSON at all.

When CI or another caller requests export, it writes one stable JSON artifact,
with sorted keys and sorted ID arrays, for example:

```json
{
  "schema": 1,
  "grammar": "test/json",
  "engine": "macro",
  "definitions": ["choice:Value/0/arm:0", "rule:Value"],
  "hits": ["rule:Value"],
  "unhit": ["choice:Value/0/arm:0"],
  "ratio": 0.5
}
```

This is distinct from V8 line coverage and its existing ratchet. Add a new
command (proposed name: `pnpm grammar-coverage:check`) that:

1. runs designated semantic-coverage fixtures using explicit shared collectors;
2. optionally writes/reads `coverage/grammar-coverage.json` deterministically;
3. validates an explicit per-grammar required-ID list and minimum ratio;
4. fails when a required ID is unhit, an unknown required ID is configured, or
   a grammar's ratio falls below its configured threshold.

Do not reuse `test:coverage`, `coverage:guard`, or the line-coverage baseline.
Semantic coverage changes when grammar topology changes; a global percentage is
too easy to game and hides a newly untested critical arm.

## Trace: semantic schedule over the same plan

Coverage and trace ship together in this release. A trace event uses the exact
post-compose, explicit-start-rule ID from the coverage definition plan; it must
never use parser object identity, source offsets, generated-function names, or
pre-override piece names.

```ts
type GrammarTraceEvent = {
  id: string
  phase: 'enter' | 'attempt' | 'selected' | 'success' | 'failure' | 'backtrack' | 'rollback'
  offset: number
  end?: number
}
```

Event ownership is fixed: rules emit `enter` at their entry cursor, `success`
with their returned end, and `failure` at their failure cursor; choice arms emit
`attempt` at the choice cursor, `failure` at the arm's furthest cursor, and
`backtrack` at the restored choice cursor; a locally committed arm emits
`selected` and `success` with its end. Labels emit only `success` after their
wrapped parser succeeds; they do not suppress or duplicate child rule/arm
events. `offset` is the cursor at the named phase; `end` is present only for a
successful return. Events from an enclosing parse that later fails remain in
the trace. Recursion and re-entry produce new ordered events with the same ID.

`attempt(parser)` is transactional rather than a coverage definition: a failed
transaction emits trace-only `attempt:<structural-path>/rollback` at its entry
cursor after its owned capture/diagnostic sinks are restored. That ID is not in
the coverage denominator and no inner locally successful arm is credited when
the enclosing transaction rolls back.

`selected` is local PEG commitment, not a global parse winner: it is the first
locally successful arm of that choice invocation. A later enclosing retry emits
a new attempt/selected sequence. Disjoint dispatch emits one attempt for its
selected dispatch slot and no attempts for arms excluded by the normalized
first-set schedule. Greedy classification emits one attempt for the classifier
and selected for the classified final arm; longest-literal emits attempts in its
normalized longest-first order; gates emit no attempt for a gated-off arm; an
auto-not rejection emits failure then backtrack before the next scheduled arm.
Both engines emit this abstract schedule, not incidental physical calls.

The sink contract is normative. `createGrammarTraceSink({ capacity, write })` requires
a finite non-negative capacity and retains the first `capacity` events in order
(zero retains none). An event is retained before `write` is called. A `false`
return retains and forwards that triggering event, then detaches; a thrown error
retains the triggering event, does not count it as dropped, catches the error,
and detaches. Every event presented after detachment, or presented when capacity
is already full, increments `dropped`. A zero-capacity sink immediately detaches
on its first presented event: snapshot `{ events: [], truncated: true,
dropped: 1 }`. There is no unbounded streaming-only mode in this release.
Snapshots are immutable and include `truncated` and `dropped`; detachment never
alters parse results. Nested parses inherit no sink unless one is explicitly
passed; a caller may explicitly share a sink. A collector and trace sink are
separate ownership channels.

Interpreter and macro trace fixtures compare the ordered semantic event stream
from the same plan. The matrix includes recursion, shared collectors/sinks,
compose override, nested compose, pick, composeLeaf, gates, auto-not rollback,
disjoint dispatch, greedy classification, longest-literal, and truncation.

## Required test matrix before implementation is accepted

- interpreter and macro produce identical definition IDs and hits for the same
  normalized grammar;
- interpreter and macro produce identical trace event sequences and IDs for the
  same normalized grammar, including failed speculative arms;
- ordinary macro output has the zero-default proof above;
- direct recursion and mutual recursion do not duplicate IDs or leak hits;
- a `choice` with failed speculative arms records only the selected successful
  arm;
- a rejected `attempt()` emits its trace-only rollback event and credits no
  rolled-back inner arm;
- duplicate `label()` names remain separate structural IDs;
- `compose` override picks the final winner only;
- nested compose (`base → mid → leaf`) keeps stable IDs after flattening;
- `pick` removes non-picked definitions and retains the picked winner's IDs;
- `composeLeaf` uses the final fused grammar, not imported recognition-piece
  identities;
- a macro compilation fallback reports interpreter-fallback provenance;
- collector isolation, explicit merge, and reset semantics work under parallel
  test execution;
- generated package `dist` contains the coverage API only when it is intended
  to be public, and a packed-package macro fixture validates that the published
  plugin—not `src`—can compile coverage mode.

## Release checklist

1. Decide whether the coverage API is public in this release; if not, keep it
   test/internal-only and omit it from package exports.
2. Run interpreter/macro parity and the complete matrix above.
3. Run normal macro byte-identity fixture plus package build/typecheck/test.
4. Run `pnpm pack` (or the repository's package verification equivalent) and
   execute a macro coverage fixture against the packed `dist` package.
5. Add the semantic CI command and a checked-in threshold configuration.
6. Document the schema/versioning and threshold update procedure.
7. Release from current `main` through the normal next-version process; do not
   resurrect an historical `release/*` branch. Current `main` is ahead of
   `origin/main`, so branch/release selection must preserve those pending macro
   fixes rather than cut from an older release line.

## Adversarial verdict

Approved only under this design: identity after composition winner selection,
label-as-annotation, separate macro/interpreter instrumentation, optional
proven source metadata, isolated collectors, and a distinct semantic CI gate.
Any implementation that instruments default generated parsers, uses source
offsets as IDs, merges label names, or thresholds only a global percentage is
rejected.
