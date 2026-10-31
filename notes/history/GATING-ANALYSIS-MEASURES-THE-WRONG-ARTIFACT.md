# The gating analysis measures the pre-fusion graph, and the shipped parser is not it

Status: **measured**, 2026-07-31, against jess `origin/dev` @ `0f45aa324` built with
`pnpm run build:release`, and parseman `release/0.46.0` @ `58d1079`.

## What was claimed

A diagnostics sweep over jess's four dialect grammars reported that **under 19% of
choices gate on the next character** (css 18/96, less 24/163, scss 16/110, jess 18/102),
that **`cross-artifact-ref` accounts for 48–62 ungated arms per dialect**, and that
css's byte-heaviest rules concentrate ungated choices.

Those numbers are reproducible and their provenance is exact: jess's
`scripts/parseman-diagnostics/run.mjs` calls `analyzeGatingRules(allEntries)` over the
**raw pre-compose pieces**, obtained from a vite server with the macro plugin left out.
`analyzeGatingRules` is called with **no `resolveRef`**, so every cross-piece `ref()`
whose thunk cannot be bound falls into `classifyBroadArm`'s unresolved branch
(`gating.ts` ~L373-380) and is labelled `cross-artifact-ref`.

## Why they do not describe the shipped parser

Cross-piece refs are resolved **at fuse time**, not before it. `fusedBody()`
(`src/compiler/linker.ts` L340-395) runs a least-fixpoint over the WINNING rules of all
contributing artifacts and substitutes every `/*@FS:<rule>:<codevar>@*/true` placeholder
(emitted by `codegen.ts` L2339-2345 for exactly these rule-ref arms) with a real
`firstSetCond`. The pre-fusion view cannot see any of that **by construction**: the
information does not exist yet.

Read out of jess's shipped `packages/syntax/less/less-parser/lib/grammar/ast.js` — the
arm the analysis reports as ungated via `g.Dimension → unresolved ref g.NumberToken`:

```js
if (!_crok1977) if (_chcode1978 === 43 || _chcode1978 >= 45 && _chcode1978 <= 46 || _chcode1978 >= 48 && _chcode1978 <= 57) {
  ...
  if (_r_Dimension(input, _pos, _ctx) === _pfFail) break _lbl2217;
```

`+`, `-`, `.`, `0`–`9`: `NumberToken`'s real first set, resolved across the boundary the
analysis called unresolvable. The arm is gated in the ship.

The same holds for the two at-rules the finding named. In
`packages/syntax/css/css-parser/lib/grammar/ast.js`, `_r_StylesheetAtRule`'s body-statement
choice emits three bare rule-ref arms, each guarded:

```js
const _chcode4533 = _np4528 < input.length ? input.codePointAt(_np4528) ?? -1 : -1;
if (!_crok4532) { if (_chcode4533 === 64) { ... _r_ConditionalBlock(input, _np4528, _ctx) ... } }
if (!_crok4532) { if (_chcode4533 === 64) { ... _r_StylesheetAtRule(input, _np4528, _ctx) ... } }
if (!_crok4532) { if (_chcode4533 === 35 || _chcode4533 === 42 || _chcode4533 >= 45 && _chcode4533 <= 46 || ...) { ... _r_TopLevelRuleset(...) } }
```

Cross-artifact references are also **inlined as direct calls** (`_r_<Name>(input, _pos, _ctx)`),
not preserved as indirections through a map or a thunk.

Measured over the whole shipped AST artifacts (a `_chcode` const is emitted per choice
that has at least one guarded arm; when every arm is unguarded the const is unused and
dead-code-eliminated to a bare `_pos < input.length && input.codePointAt(_pos);`):

| dialect | emitted choice sites | ≥1 first-char-guarded arm | fully ungated |
|---|---|---|---|
| css  | 208 | 184 (88.5%) | 24 |
| less | 229 | 211 (92.1%) | 18 |
| scss | 112 | 100 (89.3%) | 12 |
| jess |  94 |  89 (94.7%) |  5 |

Against a claimed "under 19%". (Emitted sites are not source choices — inlining
duplicates a source choice per call site — so the counts are not comparable one-to-one.
The *rate* is what was claimed, and the rate is off by roughly 5×.)

## What survives

`broad-recognizer` is real and unaffected: no fuse can invent a first character for an
arm that genuinely has none. Confirmed in the ship — css `RawParenValue`'s catch-all
regex arm is emitted with **no guard at all**, beside five sibling arms that have one:

```js
if (!_crok6464) {          // <- no `if (_chcode…)`; entered at every position
  ...
  while (_e6509 < input.length && !(input.charCodeAt(_e6509) === 40 || ... )) _e6509++;
```

Per-dialect split of the reported ungated ARMS by cause (pre-fusion view): css 51
broad-recognizer / 12 cross-artifact-ref; less 43 / 62; scss 17 / 59; jess 13 / 48. The
broad-recognizer half is evidence about the ship; the cross-artifact-ref half is an
artefact of looking before the fuse.

## The consequence for the tooling

The analysis can be run on three things, and today all three are wrong for this question:

1. **Pre-compose pieces** (what jess's shim does). Sound about `broad-recognizer`, void
   about `cross-artifact-ref`, and its *denominator* is not the shipped one either.
2. **A `compose()` result** via `analyzeGrammarGating`. It threads a `resolveRef`, which
   is the right idea, but on jess's grammars it recovers almost nothing — 4 choices for
   css/scss/jess and 0 for less, against 96–163 pre-compose.
3. **The shipped fused artifact.** Rules are compiled functions; every one comes back
   `unanalysable [fused-rule]` and `totalChoices: 0`.

The only place with both the real combinator graph AND the resolved cross-artifact
first-sets is **inside `fusedBody()`, after the fixpoint and before `resolveFS`
substitutes**. `finalFS` there is precisely the per-rule first-set table the analysis is
missing. Running the gating walk at that point — and emitting the report as a build
artifact — would make the numbers describe what ships, and would make them gateable in
CI, which they are not today.

Not done here: `fusedBody()` and the emitter are owned by another lane. Nothing in this
note is acted on beyond recording that the existing numbers must be re-derived.
