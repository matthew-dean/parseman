# The invariant gate

`scripts/check-invariants.mjs`, wired as a required CI step (`test-matrix` →
the `test` aggregate), as a `pre-commit` guard, and asserted by
`test/unit/invariant-gate.test.ts` so it runs under `pnpm test` too.

## Why it exists

This project has written invariants — numbered, argued, paid for in past
incidents — and until now nothing checked them. They were rules, not gates, and
a rule cannot stop a commit. Every defect in the list below landed in a repo
whose own documentation forbids it, with every existing gate green:

| Defect | Landed as | Cost |
|---|---|---|
| Throwing accessors installed on every `run()` result | a 0.44.0 migration aid | **36.9%** on small parses |
| A first-set analyzer registered by side effect from one module | five of eight export subpaths lost choice dispatch | four of them silent |
| A flag set and never read | `dispatch()` did not cut | parser accepted input both other engines rejected, returning a truncated document |
| Three copies of one ASCII fold | one of them wrong | silent wrong lowering |
| Two copies of `packInts` | one unbounded | — |
| 87 KB of lowering analysis | never imported by the code that needed it | reasoning the shipped code does not do |
| `delete ctx._triviaLog` per token and per leaf | the correct expression of "restore to absent" | one delete flips `%HasFastProperties` to false on the object every combinator reads on every step, and re-adding does not restore it |

The sharpest case is not a missing tool but an unwired one. In jess,
`pnpm lint:absolute` already detects the `as any` / `@ts-ignore` ban, has found
~500 violations across 52 files, and has never been gated. Somebody built the
detector and nothing runs it. **A gate nobody runs is the failure being fixed**,
so placement is part of the design here, not an afterthought.

## Precision policy

`docs/design/release-gates.md` makes the argument this file inherits: a gate
that fires on a comment typo gets bypassed, and then the gates that matter get
bypassed with it. So:

- Every rule is **source-decidable** — parsed with oxc, decided on the AST. No
  timings, no sampling, no similarity thresholds, no "probably hot".
- Where a rule could only be stated with a heuristic, it was **left out** and
  recorded below rather than shipped noisy.
- The read/reachability sets are deliberately **over-broad**, so the rules
  under-report. A finding you can argue with is worth less than a finding
  nobody can.

## The five rules

### INV-1 — no accessor descriptor installed with `Object.defineProperty`

Decides: a `get`/`set` key in an `Object.defineProperty` / `defineProperties`
descriptor anywhere in `src/**`.

Installing an accessor onto an object that already exists transitions its
hidden class and routes every later read through a call instead of an inline
cache slot. This is the exact shape of the 36.9% regression, and jess has the
same class recorded at 46% of CSS parse time.

**Not** banned: `get x() {}` in an object *literal*. That is part of the
object's shape from birth, it transitions nothing, and this repo uses it
deliberately for lazy materialization (`src/functional/doc.ts`,
`src/cst/trivia-entries.ts`). Banning it would be the false positive that gets
the gate turned off.

False-positive risk: **very low**. The distinction — imperative install versus
shape-at-construction — is syntactic, and every non-accessor
`Object.defineProperty` in the tree (there are ~25, all `value:` on
compile-time objects) is untouched.

### INV-2 — no field in a public `*Options` type that nothing reads

Decides: a property declared in an exported type/interface whose name ends in
`Options`, where that name occurs **nowhere** in `src/**` as a member access, a
destructuring key, a string literal, or an identifier inside a template.

This is the `dispatch()` bug in its general form, and it is exactly what a type
system cannot catch: the type is satisfied by *writing* the field.

False-positive risk: **very low by construction**. The read set is global and
over-broad — any `.name` on any object counts, as does the bare name in any
string. The rule fires only when the name appears nowhere in the
implementation at all, which is not a judgement call. It under-reports (a field
read only via a same-named property of something unrelated escapes); that is
the correct direction.

Scope note: `Pick<…>`/mapped-type aliases declare no members of their own and
contribute nothing — their fields are checked where they are declared.

### INV-3 — every module under `src/` is reachable from a published entry point

Decides: import-graph reachability from the targets of `package.json` `exports`
and `bin`, mapped `dist/*.js` → `src/*.ts`. Static imports, re-exports,
`export *`, and `import()` with a literal specifier are all edges; a type-only
import counts.

An unreachable module is not just dead weight in the artifact — it is a piece
of reasoning the shipped code is **not doing**, while looking from the outside
as though it does. That is the 87 KB case.

False-positive risk: **zero heuristics**. A genuinely bench-only module goes in
the allowlist with a reason (two are there today).

### INV-4 — no declaration body duplicated across modules

Decides: two top-level declarations in *different* files whose initializer or
function body is byte-identical once comments and whitespace are removed, and
whose normalized form is at least 160 characters.

A copy that drifts is worse than no copy, and the drift is invisible to every
behavioural test because each copy has its own callers — three copies of one
ASCII fold, one wrong; two copies of `packInts`, one unbounded; a decoder left
duplicated after its encoder was deduplicated.

False-positive risk: **low**. Byte-identity after comment/whitespace removal
leaves no similarity threshold to argue about. The length floor exists only so
that one-line idioms (`return x.length`) do not collide by coincidence.

### INV-5 — no `delete` on an object the enclosing function did not construct

Decides: a `delete X.p` / `delete X[e]` whose root identifier is not bound,
anywhere inside the enclosing function, by a declaration whose initializer is a
fresh object (`{…}`, `[…]`, `new …`, `Object.create(…)`). Parameters, closure
variables, and aliases of someone else's object (`const m = slot._meta`) all
fail that test; a scratch object built and discarded in the same call passes it.

One `delete` flips `%HasFastProperties` to false on an object of this shape,
and **re-adding the property does not restore it**. On a scratch object that
dies at the end of the call, that is survivable. On a long-lived one it is a
catastrophe: `delete ctx._triviaLog` runs **per token and per leaf** on `ctx`,
the single object every combinator reads on every step, so the first `token()`
in a parse can leave it in dictionary mode for the remainder.

This is deliberately *not* a blanket "no `delete`". A blanket ban would fire on
the scratch case, which is fine and common — the same mistake that got the
conditional-spread rule rejected below.

It is also not a claim that the code is wrong. Restoration at the `ctx` sites is
by **presence** — readers test whether the property exists — so `delete` is the
semantically correct expression of "restore to absent" and `= undefined` is not
a drop-in. It is correct code with a catastrophic shape consequence, which is
exactly the kind no test suite can see.

False-positive risk: **low**, and zero on this tree. All 15 findings are
genuinely long-lived objects; not one is a scratch local. The `clean` fixture
carries the scratch case specifically to pin that it stays silent.

Known under-report, stated rather than hidden: the "constructed here" test
searches the whole enclosing function subtree, so an object built in an outer
function and **escaping** it is exempt — `src/combinators/ref.ts:47,49` deletes
from a `meta` built in `ref()` that outlives the call. Catching that needs
escape analysis. The rule under-reports rather than over-reports, on purpose.

## The allowlist

`ALLOW` in `scripts/invariant-allowlist.mjs`. **It may only get shorter.** Adding
an entry to unblock new code is the failure this whole file exists to stop.

For one release that sentence was only a sentence. Nothing enforced it, and
nothing required an entry to say who owned it or when it expired — so
`INV-3 token-alphabet.ts` / `token-scanner.ts`, a *correctly detected* live
finding of the built-but-never-wired shape this project has now hit six times,
was converted by its own allowlist entry into a permanent accepted state. An
entry with no owner and no expiry is a silent decision to never do the work.

Four mechanical properties keep the rule honest rather than aspirational. Each
of the first three is proven to FIRE in `test/unit/invariant-gate.test.ts`,
against fixture trees that ship their own allowlist:

1. **The ratchet.** `ALLOW_COUNT` is the committed entry count and the gate
   fails unless `ALLOW.size` matches it exactly. An added entry can no longer
   hide as one more line in a list — it costs a deliberate edit to a single
   numbered line, which a reviewer sees as its own hunk. A *removed* entry costs
   the same edit, which is what keeps the ratchet tight instead of leaving slack
   for a later commit to spend for free. It is a **ratchet, not a wall**: a real
   architectural change that retires modules from the export graph raises
   `ALLOW_COUNT` in the same commit and the gate goes green. A ratchet that
   cannot be raised is a hard block, and a hard block gets bypassed, taking the
   rules that matter with it.
2. **Structure.** Every entry declares a `category`, machine-checked against
   exactly three values, and a reason:
   - `RULE-BUG` — the rule is wrong and the code is right; the fix is to refine
     the rule, and the entry leaves when it is refined.
   - `BY-DESIGN` — a finished argument. The code is staying in this shape, and
     the entry leaves only if the design changes. Not debt.
   - `DEBT` — an unfinished obligation. Must be fixed, and must carry a `ref`
     naming the lane, doc, or issue that owes it.

   **`BY-DESIGN` vs `DEBT` is the distinction that failed**, and the reason the
   category is machine-checked rather than trusted to prose. The two look
   identical on the day they are written. `INV-3 token-alphabet.ts` /
   `token-scanner.ts` was real debt with a stated obligation — "wire into the
   compiler or delete" — and nothing enforced it and nothing restated it, so it
   came to read exactly like the frozen-control entries above it: a permanent,
   accepted exemption. Debt decays into by-design by neglect, never the other
   way round.
3. A **stale entry fails the gate**. If the violation an entry names is gone,
   the entry is now a standing licence to reintroduce it, so the gate goes red
   until it is deleted.
4. Keys are **name-based, not line-based** (`file:enclosingFunction`,
   `file:declName`). A line-numbered key would go stale on any edit above it and
   turn the allowlist into a source of unrelated red.

Every `DEBT` entry is **printed on every run, including green ones**, with its
ref. Debt that is never restated is debt that is never paid.

There is deliberately no wildcard syntax and no per-rule blanket.

**16 allowlist entries covering 24 finding sites** stand today — 7 `BY-DESIGN`,
1 `RULE-BUG`, 9 `DEBT` — in three groups. (18 covering 26 at the commit that
added the gate; the ratchet's first act was to take the two `INV-4` analysis
duplications below off the list by fixing them.)

Five are the **frozen ablation controls** — `src/table/exec-baseline.ts` and
`src/table/encode-baseline.ts`, deliberate frozen copies kept in process so
`bench/table-alloc-ablation.ts` can measure a change against a same-path
control. Being unimported (INV-3) and byte-identical to the live helpers
(INV-4) *is* the control. `vitest.config.ts` excludes them from coverage for
the same reason. They leave when the ablation does.

Four cover the findings the gate was built to catch, left standing so the gate
could land separately from the fixes:

- `INV-1 src/functional/run.ts:<module>` — **`RULE-BUG`.** This
  `Object.defineProperty` runs once at module load, on a PROTOTYPE, and that is
  exactly the fix that replaced the per-instance installation the rule was
  written against. INV-1 fires on the correct pattern here; it should exempt
  module-scope prototype installation, and the entry leaves when it does.
- `INV-1 src/compiler/linker.ts:composeLeaf` — **`BY-DESIGN`.** One accessor per
  rule, once per `composeLeaf()`, so the grammar you actually use is fused on
  first access and a second conflicting one fails loudly. Argued at the site,
  and listed rather than carved out of the rule so that if the site changes the
  entry goes stale and someone has to look again.
- `INV-3 src/compiler/token-alphabet.ts`, `INV-3 src/compiler/token-scanner.ts`
  — **`DEBT`**, ref `docs/design/derived-tokenization.md`. The lane landed its
  alphabet and scanner before the consumer that reads them: precisely the
  "analysis nothing imports" shape, caught this time. A design lane decides
  whether they get wired or deleted; either way the entries go.

`INV-4 childrenOf` (`analysis/choice-cost.ts` ↔ `analysis/duplication.ts`) and
`INV-4 intersects` (`analysis/duplication.ts` ↔ `analysis/gating.ts`) were also
in this group. Both were one import each, and both are now gone: the helpers
live once in `analysis/gating.ts`, the module every analysis pass already
imports.

Seven entries — all `DEBT` — cover the **`delete`-on-long-lived-object findings**, 15 sites:

- `INV-5 ctx._triviaLog` / `ctx._rootTriviaLog` in `combinators/token.ts` (6
  sites) and `table/exec.ts` (6 sites) — **the sharpest instance in the
  catalogue**, running per token and per leaf on the object every combinator
  reads on every step. The driver copies exist because the table driver is
  deliberately *mirrored* from the combinator for behavioural fidelity, which is
  what three-way identity rewards: one shape defect became two. A separate lane
  is measuring what these cost end to end and may remove them; when it lands,
  these entries go stale and the gate will REQUIRE their deletion. That is the
  intended interaction, not a conflict. Ref `lane/ctx-shape`.
- `INV-5 meta.triviaKindLabels`, `meta.disjoint`, `meta.grammarHostMode` in
  `compiler/linker.ts` (3 sites) — `const meta = slot._meta` is an alias of a
  combinator's long-lived meta, which is read during interpreted parses. Cold
  sites, so the cost is the shape the object carries afterwards. Unlike `ctx`,
  these readers test `!== undefined` rather than presence, so `= undefined` IS a
  drop-in here. **No lane owns these three yet**; the `ref` points back at this
  section, which is where the available fix is written down. That is the weakest
  ref on the list and the next one that should get a real owner.

## Candidate checks that were REJECTED

Knowing which invariants are *not* mechanisable is worth as much as automating
the rest. These were implemented or specified and then dropped:

**Conditional spread into an object literal** (`{ ...(c ? {a} : {}) }`) — the
hidden-class-split rule, and jess's 46% incident. Decidable, implemented,
measured: **177 pre-existing hits across `src/`**, concentrated in
`plugin/index.ts` (28), `compiler/codegen.ts` (19), `combinators/grammar.ts`
(18) — overwhelmingly cold code that assembles strings or descriptors once per
compile, where a second hidden class costs nothing. Source carries no notion of
call frequency, so the rule cannot separate the hot case from the idiom, and
177 findings is the definition of crying wolf. *Recommended follow-up:* a
two-sided count ratchet against a committed baseline over a declared hot-module
set, in the shape of `choicecost:guard` — growing fails, and an unbanked win
also fails, so it shrinks.

**Conditional property assignment** (`if (c) o.p = v`) — the general form of
the same invariant. Not decidable at all: on a builder-local object that has
not escaped, it is fine and idiomatic. Judgement.

**Side-effect registration reachability** — the analyzer registered from one
module, so five of eight export subpaths silently lost dispatch. The general
rule ("a module whose import has an observable side effect must be imported by
every entry point") needs a notion of *which* side effects are load-bearing,
which source does not carry. The narrow instance is dead on this branch. INV-3
catches its neighbour (a module nothing imports) but not this (a module
something imports, from only one place). **Not mechanisable; reviewer
obligation.**

**Allocation and complexity-class invariants** (jess V8-ARCHITECTURE 3, 4, 5,
11: no full-tree walk in a hot path, complexity class preserved across
rewrites, no per-iteration allocation, no restart-at-zero scan) — none is
source-decidable. These belong to counting instruments, not lints: operation
counters and allocation counts against a committed named baseline, which is
what `choicecost:guard` already is for one axis. jess reaches the same
conclusion: "counts, not timings."

**Monomorphic node shapes** (invariant 1) — decidable only at runtime, by
recording each node type's field-key signature at construction over a corpus.
jess implements it that way (`pnpm verify:shape-stability`) and notes the
limit honestly: a green run is evidence about the corpus, not a proof about the
factories.

**"Every hot `choice` first-char-gates"** (AGENTS.md's headline rule) — already
mechanised and *not* duplicated here. `diagnoseGrammar()` decides it, fails
closed, and is usable directly as a CI exit code.
