# Composable compiled rules — the rule ABI

Status: **plan** — dispatch A/B measured (§9): by-name dispatch costs ~5–10% in
dispatch-saturated code. **Decision: fused (sealed, direct-call) is the DEFAULT;
composable (by-name map) is opt-in via a `composable` flag.**

## 1. The problem

Two things we want are in tension today:

1. **Speed** — the macro compiles a `rules()` map into generated JS (`charCodeAt`
   scans, `if`/`switch` dispatch, hoisted sticky regexes). Fast.
2. **Reusable pieces** — write a rule once, share it across packages
   (css → less → scss → jess), overriding a few rules per dialect.

The macro dissolves (1) at the cost of (2). When `rules()` compiles, every rule
becomes an entry in **one sealed IIFE closure**, referencing that closure's
hoisted state, with sibling calls bound at compile time to that closure's
siblings. In that form an individual compiled rule is **not a value** — you
can't import it, spread it, override it, or re-enter it by name. The only
surviving reusable form is the **combinator source**, which is why sharing today
means **re-inlining source and re-compiling into every consumer** (the tier-2
fragment machinery). The compiled artifact is a dead end for reuse.

**The fix:** make the *compiled rule* the reusable unit, by giving it a stable
identity (its name in a map) and **late-binding cross-rule references by name**
through a composed map. The combinator's composability is replaced by
*map composability + name late-binding*.

**But not by default.** By-name dispatch costs ~5–10% in dispatch-heavy code
(§9), and most grammars are standalone leaves compiled for eval. So the **default
compile output stays fused** (sealed closure, direct sibling calls — today's form
and speed). A grammar opts into the composable form with a **`composable` flag**;
only then does it pay the dispatch cost, and only then does it gain export/merge,
override, à la carte, and by-name re-entry (linter/IDE/incremental). The flag is
the single switch between the two output forms; authoring is one `rules()` API.

## 2. Goals / requirements

- **Modes over one grammar** — the same compiled grammar serves three drivers,
  no fork, no recompile:
  1. **eval** — parse once, fail on first error, build the eval AST.
  2. **linter** — parse once, recover + collect all errors, build a CST.
  3. **IDE** — incremental parse/edit, recover, positioned CST.
- **Cross-package reuse of *compiled* code** — a package ships its compiled rule
  map; consumers import and merge it. No consumer-side source resolution, no
  "self-contained fragment" constraint.
- **Open recursion / override** — overriding a rule (`value`, `parenBody`, …)
  reroutes *every* reference to it, including references inside the base
  package's own rules. This is what "Less extends CSS" actually needs.
- **À la carte assembly** — a grammar can pick *individual* rules from several
  compiled maps at runtime (e.g. Jess uses PARTS of Less and PARTS of Sass), not
  just merge whole packages. Because each rule is a named map entry, selection is
  per-name. Impossible with the sealed closure (rules are hard-bound to their own
  package's siblings); by-name binding is what unlocks it. The one obligation: a
  picked rule's referenced names must all resolve in the final `R` — a
  **name-dependency contract** checkable at compose time (§5).
- **Lightning-fast** — rule bodies unchanged; only cross-rule dispatch changes,
  and it stays within a few % of a direct call.
- **Incremental for free** — the composed map *is* the re-entry registry.

## 3. The rule ABI

Every compiled rule is a free-standing function, same signature combinators use:

```js
// (input, pos, ctx) => ParseResult
function Num(input, pos, ctx) { … }
```

All mode/composition state rides on `ctx`:

```js
ctx = {
  R,           // composed rule map — the late-binding table
  build,       // build host: eval-AST vs positioned-CST (was a module singleton)
  recover,     // error policy: false = fail-fast, true = collect
  _triviaLog, _errors, …   // unchanged
}
```

The single structural change from today: a reused / cross-package sibling
reference compiles to a **by-name lookup through `ctx.R`**:

```js
// today (sealed): direct closure-var call, bound at compile time
return value(input, p, ctx)
// ABI: resolved by name at call time, against the composed map
return ctx.R.value(input, p, ctx)
```

Single-use, intra-package refs still **inline** (unchanged) — the `ctx.R` hop is
paid only at reused / cross-package boundaries, exactly where late binding is
required.

## 4. The compiled artifact per package

A `rules()` call compiles to a **map factory** — hoisted state inside, rules out
as a plain object of `(input,pos,ctx)` functions:

```js
// @jesscss/css-parser/rules — shipped COMPILED
export function makeCssRules() {
  const _re0 = /…/y, _re1 = /…/y, _EMPTY_TL = Object.freeze([]);   // hoisted, per-instance
  return {
    Num(input, pos, ctx)   { …; return ctx.build('Num', c, r, s) },
    value(input, pos, ctx) { …; return ctx.R.Dimension(input, p, ctx) },
    // …
  };
}
```

Byte-identical rule bodies to today — just lifted out of the sealed IIFE, with
reused sibling calls routed through `ctx.R`.

## 5. Composition (spread — build once, never mutate the key set)

```js
import { makeCssRules }  from '@jesscss/css-parser/rules';   // compiled artifact
import { makeLessRules } from './rules';

const R = { ...makeCssRules(), ...makeLessRules() };   // spread order = override
```

- **No `Object.freeze`.** Monomorphic dispatch comes from **shape stability**
  (build once, never add/delete keys), not immutability. Freeze adds write-guard
  cost with zero read benefit. (Optional dev-only freeze behind a debug flag.)
- **Open recursion:** because every reference is `ctx.R.value`, the fixpoint is
  taken over the *merged* map. Override `value` in Less → CSS's rules that call
  `value` now call Less's. The sealed closure cannot do this.
- **À la carte:** compose from cherry-picked names across maps —
  `const R = { ...makeCss(), ...pick(makeLess(), ['MixinCall','Guard']), ...pick(makeSass(), ['EachFor']), ...makeJess() }`.
  A `pick(map, names)` is a trivial key filter. **Name-dependency contract:** each
  rule reaches siblings via `ctx.R.name`, so every referenced name must exist in
  the final `R`. Emit each rule's set of referenced names (codegen knows them) so
  a dev-only compose-time check can assert closure and list any missing names.

## 6. Why it stays lightning-fast

- `R` is shape-stable → `ctx.R.name` is **monomorphic** → V8 inline-caches it to
  a fixed-offset field load, not a hash lookup. Load + call ≈ direct call.
- **Merge once** at construction; zero per-parse composition cost.
- **Intra-package single-use inlining preserved** — hot inner loops unchanged.
- **Rule bodies identical** — scannable-regex / dispatch-table / trivia fast-path
  all intact.

The one measurable delta: a monomorphic field load at rule-call boundaries that
were already function calls. See §9.

## 7. Modes = `ctx` settings over one map

| mode | driver | `ctx.recover` | `ctx.build` |
|---|---|---|---|
| eval | one-shot | `false` | eval-AST host |
| linter | one-shot | `true` | CST host |
| IDE | incremental `.edit` | `true` | positioned-CST host |

- `ctx.build` on `ctx` dissolves the module-singleton host (old Blocker B):
  per-parse, concurrency-safe.
- `ctx.recover` is the existing recover option (`recover()`/`expect()` read it).
- Same `R`, three `ctx`es.

## 8. Incremental = the map is the registry

`parseDoc().edit()` already re-parses a changed node **by name**:
`registry[node.type](input, pos, ctx)`. Under the ABI, `registry` **is** `R`.
Every compiled rule is addressable and re-enterable by name → incremental works
over compiled grammars with no extra machinery. Relative-span storage +
queried-absolute positions (old Blocker C) live entirely in the *driver*,
orthogonal to the ABI.

**One artifact, four jobs:** composition unit = mode-dispatch table = incremental
registry = parse-entry table.

## 9. Risk & the gating prototype

**Measured** (`bench/dispatch-ab.mjs + bench/dispatch-ab-alloc.mjs`, recursion-heavy JSON, identical rule
bodies, only the sibling-call mechanism differs):

- dispatch-only (near-zero work/rule): B/A ≈ **1.01–1.06×**
- with node allocation (realistic work): B/A ≈ **1.08–1.11×**

So by-name dispatch (B) costs **~5–10%** in dispatch-saturated code — real, modest,
and an upper bound (JSON is dispatch-dominated; regex-heavy real grammars dilute
it). A pure-runtime "link pass" back to direct calls does **not** work: recursion
makes destructure-to-local circular, so the only route to direct calls is a
codegen-time fused closure — i.e. form A itself.

**Decision:** fused (A) is the default output; `composable: true` opts into B.
You pay the ~5–10% only when you need export/merge, override, à la carte, or
by-name re-entry (linter/IDE/incremental) — none of which A can do at all.

## 10. Codegen changes (behind the `composable` flag)

Default (no flag) → **unchanged**: today's sealed IIFE, direct sibling calls.

`composable: true` →
1. Emit `makeXRules()` **factory returning `{name: fn}`** instead of a sealed IIFE.
2. Compile a **named-rule** `ref` to **`ctx.R.name(…)`** (local/private `const`
   refs still inline — the `ctx.R` hop is only for the map's own named rules).
3. Emit each rule's **referenced-name set** for the compose-time name-dependency
   check (§5). Cross-package consumers import compiled `make*Rules` and spread.

**Only in composable mode does** tier-2 fragment source resolution + the
self-contained-fragment constraint become unnecessary; the module-singleton build
host is replaced by `ctx.build` regardless of form.

## 11. Sequence

1. ~~Dispatch A/B prototype (§9)~~ — **done**; ~5–10% → fused default + `composable` flag.
2. Codegen: emit the `composable` form (factory + `ctx.R` dispatch + referenced-name
   sets) behind the flag; **default output unchanged**. Parity tests (fused vs
   composable produce structurally identical parses) + perf-guard on the default.
3. Composition surface: `pick(map, names)`, spread merge, dev-only name-closure check.
4. `ctx.build` host injection; retire the module singleton (jess side).
5. Incremental driver on relative spans + queried absolute (old Blocker C), over a
   composed map (`R` = the registry).
6. Wire the three drivers (eval / linter / IDE) over one composed map.
