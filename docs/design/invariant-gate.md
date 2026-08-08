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

## The rules

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

### INV-12 — no descriptor installation or `WeakMap` side cache in table runtime

Decides: any `Object.defineProperty` / `Object.defineProperties` call or
`new WeakMap()` expression under `src/table/**`, **and** the full local static
import closure of `src/table/index.ts` — the exact public entry macro artifacts
import as `parseman/table`.

The shipped table architecture builds a stable registry once and then drives
parses through it. Descriptor mutation installs fields after construction;
`WeakMap` hides the same metadata behind an identity lookup. Both are the wrong
shape for that runtime. Table metadata must be present in the registry's
construction shape, and host specialization must use explicit fixed-shape
state. The closure check prevents moving a **module-scope** cache into a helper
outside `src/table/` and still loading it on every generated-parser import. A fresh-node
test imports the built `parseman/table-runtime` artifact with `WeakMap` and
`Object.defineProperty` counters, so the source graph and the published bundle
are both proven. Macro artifact tests additionally execute `rules`, `compose`, and
`composeLeaf` transforms and reject descriptor output or spread-visible metadata.

False-positive risk: **zero**. The scope is only the table runtime graph and both
forbidden forms are direct AST nodes. The gate has planted descriptor and
`WeakMap` fixtures, so CI proves each half fails.

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

### INV-11 — one engine, one public name

Decides two shapes, both read straight off a specifier node:

- **11a — cross-vocabulary rename.** A specifier binding a name from one table
  engine's vocabulary to a name from the other's. `tableRules` is the SHIPPED
  vocabulary (declared in `src/table/assemble.ts`, re-exported unrenamed by
  `src/table/index.ts`, and the name every emitted artifact imports);
  `execRules` / `execRulesBaseline` are the REFERENCE vocabulary
  (`src/table/exec.ts`, the bytecode interpreter the closure assembler
  replaced).
- **11b — renaming re-export from an entry point.** Any `export { X as Y }` with
  `X !== Y` in a `src/**/index.ts`. A published entry may **publish** a symbol;
  it may not **rename** one.

Why a rule and not a convention: the two engines have the **same signature and
the same return type**, so TypeScript cannot tell a consumer which one it bound.
For two releases both exported the identical name `tableRules` and the import
PATH was the only thing selecting an engine. Three modules picked the wrong one,
each type-checking clean and each running correctly, only slower or only
measuring the wrong thing:

- `src/compiler/linker.ts` — the whole `compose()`/`fuse()` composition path
- `src/table/fold.ts` — every folded artifact's variant load
- `bench/jess/fixture.ts` — the canonical fixture harness, whose column printed
  as `table` was the reference interpreter for the entire cycle its figures were
  quoted in

**11b exists because 11a alone would have missed the origin.** Nobody introduced
the collision by importing across vocabularies. It was introduced by
`src/table/index.ts` reading `export { assembledRules as tableRules,
assembledRules, … }` — one function published under two names. No rename crossed
engines there; a synonym was simply minted, and it happened to collide with a
name another module already exported. An `as` at a boundary whose both sides we
own is never a compatibility shim — it is a synonym, and a synonym is the seam a
wrong import slips through. So the rule bans the shape that **created** the
hazard, not only the shape that expressed it.

INV-3 covers the `src/` half by reachability, and `src/table/exec.ts` is
allowlisted BY-DESIGN precisely so a product import of it reappearing turns the
gate red. It cannot cover `bench/` or `test/`: those import the reference engine
legitimately, as the reference side of a differential. And `bench/` is where the
defect survived longest, because a harness that binds the wrong engine still
runs and still prints a number. So INV-11 is scoped to `src/`, `test/` and
`bench/`.

**It found a second instance on the commit that added it, and that instance is
now fixed.** `src/index.ts:36` read `export { compileTable as compile }`, so one
function had two public names — `compile` from `parseman`, `compileTable` from
`parseman/table` — the identical shape this rule was written for.

It was entered as DEBT only for as long as it took to get an owner ruling on
which name survives. The ruling: **`compile`**, on the same argument that settled
`assembledRules` → `tableRules` one level down — it names *what the function
does*, where `compileTable` named *how it currently does it*, and the table
lowering has itself already replaced one engine. `compileTable` is deleted, and
`compileRuleMapTable` → `compileRuleMap` followed it: the `*Table` pair was the
only argument for keeping the suffix, and with one gone the other had none.

The strongest evidence was in the call sites. Every consumer already wrote
`import { compileTable as compile }` — 27 files renaming the import to the name
they actually wanted. Several imported `compile` from `parseman` *and*
`compileTable` from `parseman/table` in the same file, i.e. the same function
twice under two names, which is what the rule exists to make visible. Those
collapsed to one import each. jess references neither name.

Deliberately NOT covered: whether a bench column header matches the engine
beneath it. No source rule can read a string literal and know which `run()`
argument it describes, and a heuristic that guessed would fire on prose. What
this rule guarantees is narrower and checkable: one engine has one name, so a
reviewer reading an import knows which engine a harness bound.

False-positive risk: **nil**. Two set-membership tests and a string inequality
on a specifier node — no threshold, no dataflow.

## The naming rules — INV-8, INV-9, INV-10

These three were added together, for one reason.

Every duplicate-definition defect this project has paid for was **found by
accident**. Five of them, each hiding for months, each surfacing because somebody
happened to be reading the right two files on the right day. Finding a sixth by
hand is not progress; the discovery rate is set by luck, and luck does not
improve.

Three of the five are decidable **from names alone**. That is what these rules
decide.

### INV-8 — no exported name may resolve to two different declarations

Decides: for every value exported from `src/`, follow the export graph —
re-export specifiers, `export … as …`, `export *` — to the declaration it
originates at. A name with more than one origin across `src/` is the finding. A
barrel re-exporting one declaration resolves to one origin and stays silent,
which is what makes the rule usable in a codebase built almost entirely from
barrels.

`tableRules` named two different **engines** depending on which module you
imported it from: `src/table/exec.ts`'s own declaration (the reference
interpreter) and `src/table/index.ts`'s alias for `assembledRules` (the shipped
assembler). Three call sites picked one or the other by accident. It type-checked
either way — both are `Record<string, TableRule>` — so neither the compiler, nor
the linter, nor a reviewer's eye could tell them apart. **The type system cannot
see this. The export graph can.**

The failure is not "two functions are similar". It is that a reader who finds one
has no way to learn the other exists, and a reviewer reading a call site cannot
tell which one it got. Drift between them is undetectable by construction.

Types are excluded deliberately: structural typing makes two same-named aliases
interchangeable wherever they agree, so "these mean different things" is not
decidable without a judgement call, and a rule that needs one fires on innocent
code and gets switched off.

False-positive risk: **low**. Zero heuristics, no similarity threshold. A finding
means two exported declarations share a name. If that is deliberate it takes an
allowlist entry with the argument written down — which is strictly better than
the argument existing only in someone's head.

### INV-9 — no cross-module key string may be minted in more than one module

Decides: a `Symbol(<literal>)` or `Symbol.for(<literal>)` whose literal appears
in a second module under `src/`.

The two spellings are different defects:

- `Symbol(d)` mints a **fresh** symbol per call. Two modules that each write
  `Symbol('pm.fail')` hold symbols that are not equal, so a property one stores
  is invisible to the other. This shipped, in three modules, and was safe only
  because the `TableRule` ABI converted before they crossed — a property of the
  boundary, not of the design.
- `Symbol.for(d)` resolves through the global registry, so the two **are** equal
  and the code works. The defect is the duplicated **key**: the string is the
  contract, and renaming it at one site silently disconnects the other. No type
  error, no failing test — the property simply stops being found.

Both have the same fix: one owner, exported, imported at the other site.

False-positive risk: **low**. String literals only; a computed description is not
decidable and is not reported. Repeats *within* one module are not reported — a
rename there cannot desynchronise anything.

### INV-10 — no comment may name a repo path that does not exist

Decides: a `src/…`, `bench/…`, `test/…`, `scripts/…`, `docs/…` or `examples/…`
path with a source or doc extension, appearing in any comment, that is not a file
on disk. `test/fixtures/` is excluded — those trees are deliberately broken.

`bench/jess/fixture.ts` printed a column called `codegen` for a compiler module
deleted in `37c57b5`. The header comment describing what that column measured is
**why the mislabel survived**: the label documented an intent, the intent
outlived the code, and two separate lanes read the stale name and drew
conclusions from it. A comment that can go stale silently is worse than no
comment, because it actively misleads the next reader — and unlike code, nothing
ever executes it.

The rule does not check that prose is *true*. Nothing can. It checks the one part
of prose that is mechanically decidable — whether the code it points at still
exists — which is exactly the part that rots on **somebody else's** commit rather
than on the author's.

Scope is wider than every other rule on purpose: the motivating defect was in
`bench/`, and narrowing to `src/` would have missed it entirely. Only comments
are read from the non-`src` trees.

False-positive risk: **medium**, and this is the one rule where that is worth
stating plainly. Two shapes trip it without being defects:

1. **A hypothetical path in an example command.** `parseman diagnose
   src/grammar.ts` names a file the *user* would have, not one this repo has.
   Fixed at source by pointing the examples at `examples/css/parser.ts`, which
   exists — a doc example naming a real file is better anyway, because it can be
   run.
2. **A historical reference** — "`X` is DELETED at HEAD", "salvaged from `X`" —
   where naming the vanished file is the whole point of the sentence. These are
   not decidable from syntax, and inferring them from nearby words ("deleted",
   "was", "salvaged") is exactly the heuristic this gate refuses. They take
   allowlist entries; ten do today.

Listing them is not a shrug. It converts an ambiguous reference into a stated
one, and it arms a trap worth arming: if anyone re-creates a file named in an
entry, the entry goes stale and the gate fails, forcing a re-read of prose that
would otherwise have silently started describing something else.

### What these rules would NOT have caught — the honest limit

Five duplicate-definition defects motivated this work. Scoring each proposed
structural change by how many it would have caught is the only test that
separates a real rule from a decorative one.

| Change | Caught | Where the constraint sits |
| --- | --- | --- |
| **INV-8** (one name, one declaration) | **#2** `tableRules` | At the trap, in CI, on the author's commit |
| **INV-9** (one key, one owner) | **#3** `Symbol('pm.fail')` | At the trap |
| **INV-10** (prose names live code) | **#4** stale `codegen` column | At the trap |
| Nominal types for rule maps | **#2** only | **Before the trap — it would not compile** |
| A declared build-time/runtime twin registry | **none** | Nowhere: a registry nobody populates catches nothing |
| Strengthening INV-4 to token-normalized bodies | **none** of the five | At the trap |

Two of the five are caught by **none** of these, and that is the important row:

- **#1** `evaluateParserFactory` being a build-time reimplementation of `rules()`
  that never ran `markUnusedValues`.
- **#5** choice-arm gating computed without the resolver the emission path uses.

Both are *semantic* twins: two computations that must agree, where nothing about
their names, keys, or prose is wrong. **No naming rule can catch these.** The only
things that can are collapsing them into one definition, or a differential test
that computes both ways and asserts agreement. A gate cannot infer that two
functions are supposed to be the same thing; it has to be told, and being told is
what a shared definition already accomplishes.

So the ranking, by the sharper question — *does the change put the constraint
where the mistake happens, or where a correct reader would already be?*

1. **Collapse to one definition.** The mistake becomes unwritable. This is what
   was done here for `intersects`, `groupDigits` and `parseman.composedPieces`.
2. **Nominal types.** The mistake does not compile. Highest value of the
   remaining options and the only one that reaches *before* the trap — but it
   covers exactly one of the five, and costs a branded type threaded through
   every declaration and consumption site.
3. **These three rules.** The mistake compiles, runs, and then fails CI on the
   author's own commit, naming both sites. Detection, not prevention — but
   detection at the trap rather than a caveat in the file a correct reader would
   already have opened.
4. **Prose alone.** What we had. `src/table/index.ts` asserted `exec.ts` was
   unreachable while two `src/` modules imported it. The warning was posted on
   the safe path; the trap stayed unmarked.

A comment that states an invariant should either become an `INV-*` or stop
claiming to be a rule.

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

**24 allowlist entries** stand today — 20 `BY-DESIGN`, 1 `RULE-BUG`, and 3
`DEBT`. The three linker metadata debts left when their `delete` operations were
replaced with stable `undefined` assignments; the token-streaming groundwork
remains active, tracked debt until its planned compiler integration lands.

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
- `INV-3 src/compiler/token-alphabet.ts`, `INV-3 src/compiler/token-scanner.ts`,
  and `INV-3 src/compiler/token-dispatch.ts` — **`DEBT`**, ref
  `docs/design/derived-tokenization.md`. These are active 0.48 token-streaming
  groundwork, intentionally not wired into the 0.47 product path yet. Their
  entries leave when that planned integration makes them reachable.

`INV-4 childrenOf` (`analysis/choice-cost.ts` ↔ `analysis/duplication.ts`) and
`INV-4 intersects` (`analysis/duplication.ts` ↔ `analysis/gating.ts`) were also
in this group. Both were one import each, and both are now gone: the helpers
live once in `analysis/gating.ts`, the module every analysis pass already
imports.

The `INV-5` linker metadata debt is now paid. `repointRef()` and `fusePieces()`
clear `triviaKindLabels`, `disjoint`, and `grammarHostMode` with `= undefined`,
preserving the stable shape of the long-lived `_meta` objects without changing
the readers' absent-value semantics.

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
