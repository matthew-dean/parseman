# First executable RegionIR binder tranche

Status: design for independent review. This file selects the first executable
cover and freezes its semantic-lowering boundary. It adds no parser body,
runtime selection, wire field, or emitted/named binding.

Independent disposition: **design GO; implementation HOLD**. The RegionIR and
semantic contract remain viable, but the only package-viable assembly topology
currently fails the document's cold-import gate. No regional binder work starts
until a behavior-neutral topology checkpoint reaches the matched A/A envelope,
or the release owner explicitly accepts a separately quantified cold-versus-
steady trade for a combined unlanded prototype.

## Selected generic categories

The first tranche is the smallest retained, RED-proven generic cover set whose
non-overlapping dynamic edge floor is above 20% on all three authoritative
`Jess bbda2ec` fixtures:

1. **Deterministic cap-3 core.** Own only the existing typed edges
   `NODE -> stable SCOPE|SEQ(2|3)`, `stable SCOPE -> SEQ(2|3)`, and
   `SEQ(2|3) -> OPT|eligible NODE`. Shared, rule, recursive, adjacency, and
   cover-split children remain direct captured boundaries.
2. **One generic depth exception.** When the exact trail is
   `N0 -> S -> SEQV(2)`, also own the `SEQV -> OPT` edge. This is a structural
   category, not a grammar/site exception.
3. **Strict `GATE -> eligible NODE` priority.** Select the bounded gate/node
   candidate before an overlapping enclosing candidate. The gate remains an
   assembly-time alias in tolerant or probe variants; those variants never
   instantiate this template.

The first two categories remove 46,721 / 17.8506% CSS calls, 132,083 /
21.6415% `benchmark.less` calls, and 369,505 / 20.8832% generated-Less calls.
They therefore fail the CSS admission floor. Adding the generic gate/node
category raises the authoritative non-overlapping totals to 57,035 / 21.7912%,
140,657 / 23.0463%, and 397,579 / 22.4698%, respectively. Its incremental
credit is 10,314 CSS, 8,574 benchmark-Less, and 28,074 generated-Less calls.

The resulting strict-AST cover has 146 CSS chunks / 56 context-qualified planning
keys, 309 Less chunks / 103 keys, and 127 planning keys in the union. A chunk
owns at most four opcode rows. Removing occurrence context and scalar operands
leaves **65 structural control shapes**. Adding the predicate-resolved node facts
for the authoritative CSS/Less chunks still leaves **65 executable CSP template
identities**: the shape flags already distinguish every node-fact combination
present in this cover. That equality is measured, not assumed; a future new
node-fact combination mints another executable template or declines admission.

No terminal, recognizer, choice, dispatch, repeat, field, leaf, transform, or
user callback body is duplicated. Those operations remain scalar-captured
boundary calls. The first executable variant is ordinary strict AST only:
`hostCst=false`, `hostReadsChildren=true`, `trackLines=false`,
`tolerant=false`, `coverage=false`, `probe=false`, and `recovery=false`.
Every other variant statically links its existing Pieces and contains no region
test in its parse body. This is variant refusal, not reader refusal: a strict AST
region may be selected only when **every shipping reader for that variant** can
render it. Runtime compile, macro, compose, and fold use the CSP renderer; emitted
assemblies and already-precompiled modules use the named renderer in the first
executable tranche. If either renderer lacks one owned opcode/fact combination,
the region is globally unselected and every reader links the legacy Pieces.

## Executable-shape and package price

The 65-shape cover is an evidence authority, not the minimum executable set.
Solving the RED-proven disjoint dynamic counts as a three-constraint selection
problem gives 48 nonzero shapes. A fixture in isolation needs 9 CSS, 16
benchmark-Less, or 18 generated-Less shapes, but those sets do not transfer: the
CSS top nine cover only 5.985% / 5.707% of the Less fixtures. The exact minimum
common set has **21 structural shapes** and removes:

- 53,600 / 261,734 = 20.4788% CSS calls;
- 126,437 / 610,323 = 20.7164% benchmark-Less calls;
- 357,822 / 1,769,389 = 20.2229% generated-Less calls.

The complete selected list and per-fixture contributions are retained in the
package evidence report. Constants, callbacks, contexts, and occurrence IPs do
not create additional factories.

| selected structural shape | CSS | benchmark Less | generated Less |
| --- | ---: | ---: | ---: |
| `G(N0(S(K)))` | 11,944 | 6,976 | 39,716 |
| `G(N0(K))` | 10,002 | 5,576 | 11,490 |
| `N16(S(V2(K,K)))` | 8,270 | 5,600 | 13,654 |
| `N0(S(K))` | 6,112 | 0 | 0 |
| `V2(O(K),K)` | 4,293 | 1,234 | 4,842 |
| `S(V2(K,O(K)))` | 3,688 | 15,142 | 28,632 |
| `S(Q2(K,O(K)))` | 3,578 | 0 | 0 |
| `V2(K,O(K))` | 2,755 | 20 | 1 |
| `S(Q3(O(K),K,O(K)))` | 1,564 | 3,161 | 11,900 |
| `N0(V2(O(K),K))` | 602 | 2,156 | 6,604 |
| `G(N0(V2(K,K)))` | 584 | 2,650 | 7,086 |
| `N0(S(V2(K,K)))` | 208 | 3,514 | 9,264 |
| `Q3(O(K),K,O(K))` | 0 | 4,358 | 10,149 |
| `S(V2(O(K),K))` | 0 | 5,600 | 13,654 |
| `N0(V3(K,K,O(K)))` | 0 | 5,642 | 13,654 |
| `N12(S(V2(K,K)))` | 0 | 7,074 | 16,770 |
| `N28(S(V2(K,K)))` | 0 | 8,854 | 20,298 |
| `N0(S(V2(K,O(K))))` | 0 | 8,403 | 27,753 |
| `N32(V2(K,K))` | 0 | 10,165 | 26,643 |
| `N44(V2(O(K),K))` | 0 | 10,676 | 35,282 |
| `N44(S(V2(K,K)))` | 0 | 19,636 | 60,430 |

Two disposable, actual `npm pack --dry-run` builds of the deterministic source
upper model reject placing the factory switch lexically in every bundled copy
of `assemble.ts`. The model uses each selected shape's complete representative
emitted body and dummy scalar captures; it is package topology evidence, not an
executable semantic prototype:

| topology | packed | unpacked | entries | delta vs exact base |
| --- | ---: | ---: | ---: | ---: |
| exact `24caacb` | 3,217,062 | 13,742,235 | 403 | — |
| lexical 65 | 3,417,999 | 17,676,148 | 403 | +200,937 / +3,933,913 / 0 |
| lexical minimum 21 | 3,296,282 | 14,904,001 | 403 | +79,220 / +1,161,766 / 0 |

The 21-shape source adds 45,578 bytes to shipped `assemble.ts`; each of five
assembly-reaching entries in each format grows 68,960–68,970 bytes and each map
42,630–42,656 bytes. This is measured ten-graph duplication, so both lexical
topologies are rejected.

The only package-viable topology found by this screen externalizes the **whole
table assembly implementation**, including the regional factories, once per
ESM/CJS format. It does not externalize an environment callback or a template
leaf: factories remain lexical to the same module-local `SCAN`, `EC`, `HOST`,
marks, and lowering helpers. The disposable build measured:

| shared-assembly topology | packed | unpacked | entries | delta vs exact base |
| --- | ---: | ---: | ---: | ---: |
| existing assembler only | 3,143,887 | 13,157,681 | 407 | −73,175 / −584,554 / +4 |
| assembler + minimum 21 | 3,163,049 | 13,426,437 | 407 | −54,013 / −315,798 / +4 |

Thus the factories' incremental price in the shared module is +19,162 packed /
+268,756 unpacked, while the complete package remains smaller than `24caacb`.
Co-locating assembly with the already-shared compiler capability file removes
one module pair but not the cost of parsing the larger private module; it measured
3,158,046 / 13,404,008 / 406 (−59,016 / −338,227 / +3 vs base).

Externalization is therefore a **prerequisite architecture**, not an incidental
build cleanup. Before any regional binder code it must prove:

- one private static assembly module per format, with no new public export or
  package export and no dynamic import, `Function`, eval, or CSP exception;
- one `FAIL`/cell/helper identity within each format and direct identity of
  `tableRules` through main/table/compiler consumers; `EC` remains minted per
  assembly and no mutable parse state becomes module-global;
- browser resolution and package-copy/install behavior for every public entry;
- root/table/plugin/diagnostics/CLI ESM+CJS load graphs gain only the intended
  private module, while run/spec/language-service/oracle remain assembly-free;
- macro, compile, compose, fold, emitted, and precompiled behavior consumes that
  same assembly authority; and
- API keys, CSP behavior, full parse identity, and package maps remain exact.

Cold import is the unresolved cost. In 24 alternating isolated-process pairs,
whole-assembly +21 was slower than monolithic base by 55.5% ESM main, 19.3% CJS
main, 31.4% ESM table, and 30.7% CJS table, with zero candidate wins. A 16-pair
same-topology A/A control was within roughly ±2%. Co-location remained +54.0%,
+19.2%, +29.2%, and +26.6%, so the signal is code parsing, not merely another
module hop. Externalization may proceed only if a production implementation's
isolated cold-import result is inside the matched A/A envelope; any stable
control-adjusted signal above 1% blocks landing unless the release owner
explicitly accepts a separately quantified startup/steady-state trade.

### Bounded monolith-preserving alternative search

A final read-only grouping screen tried to reduce factory count without sharing
the whole assembly module. This cannot merge semantically distinct operations;
it is an optimistic lower bound that asks how far factory count could fall if
node fact bits were scalar operands, SEQ/SEQV shared one control skeleton, and
SCOPE/SCOPE_PLAIN shared one skeleton without adding a parse-time strategy
branch.

- merging node facts alone still requires at least 14 common bodies;
- additionally merging SEQ/SEQV and both scope opcodes still requires at least
  **13 common control skeletons** for the three >20% constraints;
- the 13 include distinct gate-node, node-scope-sequence, node-sequence,
  scope-sequence, bare-sequence, optional-position, arity-2, and arity-3 control
  flows. Converting those differences to callbacks or flags adds an internal
  continuation/strategy branch to the parse path and violates the fixed-body
  contract.

Therefore no `<=10` shared-template monolith architecture exists within this
bounded cover, even under optimistic semantic merging. Named-only macro or
precompiled bodies are also inadmissible because runtime closure semantics may
not diverge. The alternative search stops here rather than introducing a second
engine or an assembly-time structural interpreter.

## One semantic-lowering authority

The executable work must first add one typed `RegionalProgram` lowering. It is
derived from `RegionIR`, not from emitted source and not from closure source.
For each owned opcode it contains structured blocks, scalar locals, fixed
operands, direct boundary-call slots, cursor/end-cell operations, and explicit
success/failure edges. It contains no JavaScript snippets.

Two mechanical renderers must consume the same program before selection is
enabled:

- the CSP renderer generates checked-in, prewritten closure-template factories;
- the named renderer prints hygienic identifiers for emitted/precompiled
  assemblies from the same blocks.

The canonical `RegionalProgram` has one **semantic digest**, independent of
spelling. Each renderer has its own version stamp and output digest; neither is
folded into the semantic digest. A selected region records the semantic digest
plus the renderer stamp used by that artifact. A differential that mutates one
opcode lowering must change the semantic digest and make the reference and both
generated spellings disagree. There is no separately handwritten closure
semantic table.

The CSP factory **source** is generated into a marker-delimited switch lexically
inside the externalized whole assembly function. That placement is load-bearing:
returned Pieces directly access assembly-local `SCAN`, `EC`, `HOST`, CST marks,
and helper definitions exactly as current Pieces do. The switch cases contain function
expressions, not eagerly created declarations. A no-candidate allocation-free
preflight returns before constructing a regional plan or evaluating any factory
case. A selected plan asks the switch for each distinct selected executable key
lazily; unselected factories are never instantiated or retained by that
assembly. The generator owns the section and check mode rejects manual drift. It
does not use `Function`, dynamic import, eval, or runtime source generation.

At assembly time, a chunk key selects a factory once. Its call receives only
scalar operands and directly linked boundary Pieces (`c0`, `c1`, ...). The
returned Piece has direct calls and fixed structured control flow. It contains
no opcode switch, `pieces[ip]`, child/operand array, structural loop, template
lookup, or regional-versus-legacy branch. Template lookup and operand decoding
are assembly-only. Recursive boundaries capture the existing patched direct
stub; shared and rule boundaries capture their linked Piece.

Owned internal IPs are marked reached but are not independently lowered. A
plant that restores `link(ownedIp)` must make the reached/call counter tooth go
RED. Unselected roots use the byte-identical legacy Piece body and allocate no
regional maps, factories, cells, or closures. The global assembly source contains
the lazy factory switch, so source-file identity is asserted only for a build in
which the regional feature is excluded. For a feature-enabled build, the
per-program no-candidate **artifact body**, reached graph, runtime allocations,
and parser function source/hash must be identical to the legacy plan; tests must
not make the vacuous claim that the containing shared runtime bundle is
byte-identical.

## Planner authority and relocation

The evidence-only `src/compiler/region-ir.ts` is not imported by `parseman/table`
and is not the executable planner. Before binding, the exact ownership/cover
algorithm moves to a private **table-owned**, parser-free planner beside
`assemble.ts`. `RegionIR` becomes a compiler inspection facade over that shared
planner. The planner consumes only a final `ResolvedTable`, entry roots, and the
fully resolved `RunCfg`/node facts.

Planning happens after the final relocation boundary:

- normal compile and macro plan the final encoded program;
- compose plans only after winner resolution and final re-encoding;
- fold plans each selected unfolded/relocated variant, never the base offsets;
- emitted and precompiled factories are printed from that same final plan and
  carry its semantic digest; load validates the digest before invocation.

No RegionIR/plan is added to `TableProgram` in this tranche, and no compiler
module enters `parseman/table`, `parseman/run`, spec, language-service, or oracle
graphs. If deterministic post-relocation derivation cannot reproduce the exact
compiler inspection digest for compose, fold, and precompiled artifacts, the
no-wire design is refused rather than patched with an offset crosswalk.

## Opcode semantics in the first authority

The lowering below is a composition of the current table-opcode semantics. It
does not improve throw cleanup or diagnostics; preserving existing linear versus
`finally` restoration is part of the contract.

### `GATE`

Only the strict/non-probe form exists in a regional program. It captures the
decoded class and authored expected set. A class miss writes `ctx._fe = pos` and
`ctx._fx = expected`, then returns `FAIL`; a hit enters the owned node at the
same position. Tolerant/probe assemblies alias directly to the child before
RegionIR binding and contain no gate branch.

### eligible `NODE`

The first category admits only untracked builder nodes with no projection,
unwrap, trailing-trivia, or dynamic host-CST behavior. The exact node fact bits
select the template; they are never boolean strategy parameters in a parse
body. The program:

1. scalar-saves the parent capture sinks, capture flag, buffer, and fields;
2. installs the node-local buffer/field state and exact `captureWide` fact;
3. enters the owned child continuation;
4. performs the current linear field/capture restoration (not `finally`);
5. returns `FAIL` after restoration on ordinary child failure;
6. on success snapshots `EC.e`, derives children/raw/trivia/fields/state, applies
   the fixed collapse/build case, pushes into a saved parent collector when
   present, republishes `EC.e`, and returns the node value.

Builder reentry is safe because every value needed after the callback, including
the end cursor and saved parent sinks, is held in regional locals and `EC.e` is
republished after the callback. A throwing child or builder must expose exactly
the same partially restored state as the current Piece; the regional lowering
must not silently convert linear restoration to `try/finally`.

### stable `SCOPE` / `SCOPE_PLAIN`

Only policy-free, noncapturing scopes with encoded trivia `-1` are admitted.
The program scalar-saves `ctx.trivia`, trivia labels, and assembly-local `SCAN`,
installs `undefined`, `undefined`, and `null`, enters the owned continuation,
then restores all three linearly. Because a boundary child reads the same
lexical `SCAN`, no environment bridge or wrapper call is needed. Throw leakage
remains identical to the current scope Piece.

### `SEQ` / `SEQV` arity 2 or 3

Adjacency and recovery variants are refused. Term zero enters its owned
continuation directly at `pos`. Later terms use one inlined structured form of
the current `nextTerm` protocol. `A_U`/`A_T` labels are planning/context evidence,
not separate parse strategies: the same structural template preserves the real
dynamic `ctx.trivia` and sink-presence branches because a callback/reentry or a
captured boundary can observe the current context. The exact cases are:

- `ctx.trivia === undefined`: enter at `cur`;
- trivia defined and no live rollback sink: scan, enter at `scanEnd`, and retain `cur` for a
  zero-width success;
- trivia defined with any live CST/raw/trivia/root/field/error sink: scalar-mark
  the exact trivia sinks, enter at `scanEnd`, and roll back only
  the ambient scan when the admitted term succeeds zero-width.

Failure and commit state pass through unchanged. Values are regional scalar
locals, not `TERMV`, for owned terms. A captured boundary term may use the same
lowered term block around its direct call, so its value is copied immediately
before any reentry can overwrite assembly scratch. `SEQ` returns a fixed-size
array literal; `SEQV` returns `undefined`; both publish the exact final cursor.

### `OPT`

The program scalar-marks all current rollback sinks, clears `ctx._fc`, and enters
its direct captured child. A committed failure propagates unchanged. An ordinary
failure rolls back the marks, restores `EC.e = pos`, and returns `null`; success
returns the child value. When an owned optional is a later sequence term, its
transaction remains nested inside the sequence's ambient-trivia transaction:
an absent optional is a zero-width success, so the outer term block rolls back
only the preceding ambient trivia and keeps the pre-scan cursor.

## Review and implementation gates

Before runtime code is accepted, the generator/design tranche must prove:

- the three selected categories alone reproduce the exact 21.7912 / 23.0463 /
  22.4698% non-overlapping floors with full source/reference/closure identity;
- deleting any selected chunk, changing visit order, or hiding a shared or
  recursive edge changes the plan digest;
- generated factories have scalar parameters and their returned source contains
  no opcode/array/lookup/strategy branch;
- strict admitted roots reach one regional Piece and zero owned legacy Pieces,
  while probe/tolerant/CST/coverage/tracked/recovery and an unselected strict root
  reach exact legacy Pieces and zero regional state;
- gate miss/hit, node failure/success/collapse/fields/state, scope throw leakage,
  and the **same sequence template** with trivia undefined/defined, sinks
  absent/present, consuming/zero-width success, and ordinary/committed failure;
  optional commit/rollback, callback reentry, and
  CST/raw/trivia/root/error sinks match reference and legacy closure behavior;
- a planted effect mutation is caught by both the CSP template differential and
  the named renderer gate;
- exact generated executable identities include structural shape, complete
  assembly variant, and ordered node facts; context/callback/constants remain
  scalar captures and cannot mint site-specific bodies;
- built-package price is measured across every ESM/CJS public entry graph, plus
  cold import/startup and retained assembly-context allocations; the standalone
  gzip number is not package evidence;
- a grammar/program with no candidate has identical parser function source/hash,
  reached graph, allocation counters, and behavior to the feature-disabled
  build; the lazy factory switch constructs zero functions;
- generated source/package price is measured before any timing claim.

Until those gates pass, this branch is a design continuation of the compiler-only
RegionIR checkpoint, not an executable parser optimization.
