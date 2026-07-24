# DX pass: first-char gating diagnostics + gate rename

Status: DESIGN + LANDED in this branch. This documents the design and what shipped.

## The problem, and why the fix is BUILD-TIME FEEDBACK, not docs

Parseman is scannerless PEG: a `choice` is correct regardless of whether it
first-char-gates. When a hot choice fails to gate, every non-matching input
position speculatively ENTERS a doomed arm (ctx save/restore + child array +
recognizer + rollback) instead of being skipped by a cheap first-char test — and
nothing tells the author, because the grammar still passes every test. The four
jess parsers were hand-optimized 25–48% by finding these in CPU profiles and
fixing the one arm that poisoned each choice's first-set. The compiler already
knew, statically, which choices don't gate and why (`choice.ts` `disjoint`,
`first-set.ts` `firstSetOf`).

**Self-demonstrated anti-pattern.** The primary grammar authors are LLMs, which
pattern-match from other parsers and do not reliably read docs. This was proven
*while building this very feature*: agents repeatedly hand-rolled
`regex(/@supports(?![-\w])/i)` and `not(not(literal))` for things that already
ship (`word()`/`keywords()`; automatic first-char gating), and twice proposed
"new primitives" that already existed. The conclusion: guidance must be
build-time feedback + good defaults that make the wrong path LOUD, not a plea to
read more. Since we control parseman, the API itself surfaces the cliff.

## What shipped

### Part 1 — static gating diagnostic, DEFAULT-ON (`src/analysis/gating.ts`)

- **`analyzeGating(entry, opts?): GatingReport`** — pure function over the
  combinator tree. Per reachable `choice`: a stable `id`, `gates: 'yes' |
  'recoverable' | 'no'`, combined shallow/deep first-set, `anyArms` (offending arm +
  cause + detail + fix suggestion), `overlaps` (shared-prefix pairs), and
  `accepted`. Plus grammar-wide `antiPatterns`. Built on `firstSetOf` (deep,
  ref-resolving) so it honors the **shallow-any vs deep-any** distinction: a choice
  built over `ref()`s is `disjoint:false` at construction but its compiled code
  still first-char-guards each arm via the deep first-set — `recoverable`, never
  warned.
- **Causes** (`FirstSetCause`): `broad-recognizer`, `leading-not`,
  `nullable-prefix`, `cross-artifact-ref`, `opaque-wrapper`, `ref-cycle` — the
  cause-attribution walk mirrors codegen's leading-term traversal.
- **Anti-pattern lints**: `double-not` (`not(not(...))` — miscompiles among
  shared-first-char siblings), `leading-not`, `keyword-regex` (a bare leading
  `regex(/kw/)` where `word()`/`keywords()` gives an exact first-set).
- **The snapshot allowlist is the SINGLE per-choice suppression mechanism.**
  `analyzeGating(entry, { accept })` / `compile(g, { gating: { level, accept } })`
  take a set of choice `id`s that are intentionally ungated: those move to
  `report.accepted` (silent, excluded from the `'error'` gate); the rest stay in
  `report.ungated` (warned + gate-failing); `report.acceptedUnused` flags stale
  entries. Choice `id` = the rule name (bare when the rule holds one choice, else
  `rule#N`). This replaces the earlier `cold()` marker — one mechanism drives both
  warn-suppression and the CI gate.
- **`compile()` is default-on.** `{ gating: 'off' | 'warn' | 'error' | { level,
  accept } }` (default resolves from `PARSEMAN_GATING` env, else `'warn'`). `'warn'`
  prints precise `formatGatingWarnings()` output via `console.warn` for
  non-accepted-ungated choices + anti-patterns; `'error'` throws; `'off'` skips. The
  `GatingReport` is attached to `CompiledParser.gating` for CI snapshots. Compiled
  output is byte-identical regardless of level (pure analysis).
- **CI budget snapshot** (design/stubbed, not wired into jess CI here): keep an
  `accept` allowlist and assert `report.ungated` is empty + `report.acceptedUnused`
  is empty, or `compile(g, undefined, { gating: { level: 'error', accept } })`.
  Documented in `docs/guide/first-char-gating.md`.

### Part 2 — `guard()` → `gate()` rename (API-surface only)

- `src/combinators/gate.ts` is the primary; `guard.ts` re-exports `gate as guard`
  with an `@deprecated` JSDoc (`guard === gate`). The name now matches the `gate:`
  gated-arm field: **arm field SELECTS a branch, `gate()` combinator ASSERTS**.
- Internal `_def.tag` stays `'guard'` and the failure label stays `['guard']` — so
  compiled output and IR are byte-identical; this is purely the exported function
  name. Internal call sites (`coverage.ts`), the macro evaluator (recognizes both
  `gate` and `guard` callee names), and tests updated to `gate()`; one macro test
  and `compose-withctx-ir` keep the `guard` alias to pin it.

### Part 3 — docs that lead to the good path

- New guide **`docs/guide/first-char-gating.md`**: the principle, the poisons, the
  default-warning output, the fixes, the accept allowlist, CI budgeting, and the
  Chevrotain-vs-scannerless framing.
- **`docs/guide/combinators.md`**: gated-arm docs, a "Choosing between similar
  combinators" section with when-to-use tables (`word` vs `literal` vs `regex`;
  gated-arm field vs `gate()` combinator; `scanTo` vs `balanced`), `gate`
  rows.
- **`docs/guide/context.md`**, **`docs/reference/api.md`**, keywords/comparison/
  spec-gen: `guard`→`gate` rename + SELECT-vs-ASSERT framing; api entries for
  `gate`, deprecated `guard`, `analyzeGating`, the accept allowlist.
- **`AGENTS.md`** (repo root): a crisp, machine-readable DO/DON'T rule sheet for
  LLM grammar authors, keyed to the exact warnings the build emits.

## Prototype → production evidence

The Part-1 prototype (pre-implementation) ran on `examples/css`: 10 choices, 2
gated, 8 ungated, and it reproduced the hand-found grinds — `value` arm[7] =
`g.anyValue` (`cross-artifact-ref`) + the `Dimension`∩`Num` numeric overlap, the
`scanTo` poisoners, and correctly classified `simpleSelector` as **recoverable**
(deep-disjoint, shallow-ungated). The shipped `analyzeGating` reproduces this
exactly and is asserted in `test/unit/gating-diagnostic.test.ts`.

## Owner review flag: default-on aggressiveness

Per the elevation, the diagnostic is DEFAULT-ON (`compile()` warns unless
`{ gating: 'off' }` or `PARSEMAN_GATING=off`). This is the intended statement —
make the wrong path loud — but it is a behavioural default worth an owner call:

- The repo's own test suite sets `PARSEMAN_GATING=off` in `vitest.config.ts` (it
  compiles hundreds of grammars, many deliberately ungated for coverage).
- Real consumers get warnings on `console.warn`, accept a choice per-id via the snapshot allowlist,
  globally with `{ gating: 'off' }` / the env var, or escalate with `'error'`.
- **Decision for the owner:** keep default `'warn'`, or ship default `'off'` with
  warnings opt-in? Recommendation: keep `'warn'` — it is the whole point — but this
  PR is where to overrule it.

## Non-goals / not done here

- No jess-side CI wiring, no jess `parseman` dep bump, no npm publish.
- No version bump: this branch is rebased onto the merged 0.32.0 engine work
  (cross-artifact composeLeaf first-set fix + the version-lock invariant) and
  FOLDS INTO the same unreleased 0.32.0 — the additive surface (`gate` alias,
  `analyzeGating`, `compile({ gating })`) ships as part of 0.32.0.
  `package.json` and `src/version.ts` stay at 0.32.0; `version-sync.test.ts` green.
- No new gating PRIMITIVE. A positive-lookahead commit combinator was considered
  and rejected: leading first-sets already union through to the first consuming
  term and resolve refs at fuse time, so leading an arm with its terminal already
  gates — nothing to add.
