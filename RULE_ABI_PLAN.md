# Composable compiled rules — linkable pieces + build-time fusion

Status: **plan.** Model settled: compile each package's rules to **linkable
pieces**, **fuse selected pieces into one closure at build time**. Zero runtime
dispatch cost, composable, no source dependency, one authoring API. Modes and
incremental ride on top.

## 1. The problem

Two things are in tension today:

1. **Speed** — the macro compiles a `rules()` map into a sealed IIFE closure
   (`charCodeAt` scans, `if`/`switch` dispatch, hoisted sticky regexes, direct
   sibling calls). Fast.
2. **Reusable pieces** — write a rule once, share it across packages
   (css → less → scss → jess), overriding a few rules per dialect.

The macro dissolves (2) to get (1). A compiled rule is an entry in one sealed
closure, bound at compile time to that closure's siblings — **not a value** you
can import, override, or re-enter by name. So sharing today means the consumer's
macro **re-reads the fragment's TS source and re-compiles it** into the
consumer's closure (the tier-2 machinery). It works and it's fast — but it
requires **macro source access** and **recompiles the base per consumer**.

## 2. The model: linkable pieces + build-time fusion

Emit each package's `rules()` as **splice-able compiled pieces**, and **fuse the
selected pieces into one closure at build time.** The fused closure is
byte-identical to today's fast output — direct local calls, zero dispatch — but
it's assembled by *stitching precompiled pieces*, not by re-reading source.

The one idea that makes it free: **sibling calls are emitted as bare names**
(`value(input, pos, ctx)`). Fusing all rules into one scope makes those names
**locals → direct calls (0%)**. (A *runtime* merge would make them object
*properties* → a ~5% dispatch; measured in §9. We do not do that — we fuse.)

## 3. What each package ships (the linkable form)

Not TS source, not a sealed IIFE — a **compiled linkable artifact**:

- **Named rule functions** — each rule compiled **once** as
  `function _r_<Name>(input, pos, ctx) { … }`, bodies identical to today's compiled
  output, **calling sibling rules by canonical name** (`_r_Dimension(input, p, ctx)`),
  never inlining them (inlining a rule would bake it and defeat override; private
  `const` helpers still inline).
- **Two calling conventions, on purpose (this is the speed guarantee).** Codegen
  today already emits internal sibling fns (`_pfN`) with a **sentinel + shared-end**
  convention that allocates **no result object per rule-to-rule call**, distinct
  from map entries which return the public `{ ok, value, span }`. The linkable form
  keeps that split: `_r_<Name>` are **sentinel-convention** fns (fusable, zero-alloc
  internal calls); the exported map holds **thin public wrappers**
  (`{ Num: (i,p,c) => adapt(_r_Num) }`) for external entry / incremental re-entry.
  Routing internal calls through the public entry fns instead would allocate a
  result per call and **break the zero-speed guarantee** — so we don't.
- **Namespaced names** — canonical rule fns are `_r_<Name>` (not bare `<Name>`) so a
  rule called `Object` / `value` / `input` can't shadow a global or a generated var
  (`Object.freeze`, `pos`, `_ctx`). Preludes get package-unique names (`_css_re0`)
  so fusion can't collide them. Still fully fusable-by-name.
- **A dependency manifest** — per rule, the set of rule names it references, for
  dep-closure selection and the compose-time name-check.

Each package compiles **once** to this form. `_pfN` per-reference duplication
(a rule compiled once as its map entry and again as each caller's `_pfN`) goes
away — one `_r_<Name>` per rule, referenced by name.

## 4. The linker (build-time fusion)

Retarget the existing macro/plugin to consume **linkable artifacts** instead of
TS source. Given imported packages + a selection/override spec it:

1. **Selects** the winning rule per name (later package wins) and pulls the
   **dependency closure** of the selection (à la carte: include only chosen rules
   + their transitive name-deps).
2. **Dedupes / renames** preludes.
3. **Concatenates** the selected rule functions + preludes into **one closure**
   and returns `{ RuleName: fn, … }`.

Because all rules share one scope, `value` is a single local: overriding it
reroutes **every** call to it (open recursion), and calls stay **direct (0%)**.
This is *less* work than today's inliner — it stitches already-compiled JS, it
does **not** re-run combinator→JS compilation.

```js
// consumer build output — one fused closure, assembled from imported pieces
export const R = (() => {
  const _css_re0 = /…/y, _less_re0 = /…/y;                 // deduped, namespaced
  function Num(input, pos, ctx)   { … _css_re0 …; return ctx.build('Num', …) }
  function value(input, pos, ctx) { …; return Num(input, pos, ctx) }   // DIRECT, 0%
  function MixinCall(input, pos, ctx) { … }                            // picked from less
  return { Num, value, MixinCall, … };
})();
```

## 5. Composition surface

- **Merge / override** — later package wins per name; open recursion via the
  shared scope.
- **À la carte** — `pick(pkg, ['MixinCall', 'Guard'])`; the linker adds the
  dependency closure automatically. Jess assembling parts of Less + Sass is just
  a selection spec.
- **Name-dependency check** — the manifest lets the linker assert every
  referenced name resolves in the final set and list any missing (dev-time error,
  not a runtime surprise).

## 6. The rule ABI

Every rule: `(input, pos, ctx) => ParseResult`. All mode/driver state on `ctx`:

```js
ctx = {
  build,       // build host: eval-AST vs positioned-CST  (was a module singleton)
  recover,     // error policy: false = fail-fast, true = collect
  _triviaLog, _errors, …   // unchanged
}
```

No `ctx.R` in the hot path — siblings are fused locals. (`ctx` still carries the
map reference for the *incremental driver's* by-name re-entry; see §8.)

## 7. Modes = `ctx` settings over one fused map

| mode | driver | `ctx.recover` | `ctx.build` |
|---|---|---|---|
| eval | one-shot | `false` | eval-AST host |
| linter | one-shot | `true` | CST host |
| IDE | incremental `.edit` | `true` | positioned-CST host |

- `ctx.build` dissolves the module-singleton host (old Blocker B): per-parse,
  concurrency-safe. `node()` rules already end in `ctx.build(type, …)`.
- `ctx.recover` is the existing recover option (`recover()`/`expect()` read it).
- Same fused map; three `ctx`es. No hot-path change for any mode.

## 8. Incremental = the fused map is the registry

The fused closure returns `{ name: fn }`, so it's **by-name addressable**.
`parseDoc().edit()` re-enters a changed node by name: `R[node.type](input, pos, ctx)`
— **one property read per edit, not per call**; internal sibling calls stay
direct. So incremental adds ~nothing to the hot path. Relative-span storage +
queried-absolute positions (old Blocker C) live entirely in the driver.

**One artifact, four jobs:** the fused map is the composition target, the
mode-dispatch table (via `ctx`), the incremental registry, and the parse-entry
table.

## 9. Why not runtime merge (the ~5% path, rejected)

Measured (`bench/dispatch-ab.mjs` + `bench/dispatch-ab-alloc.mjs`, recursion-heavy
JSON, identical rule bodies): merging function *objects* at runtime and calling
siblings via `ctx.R.name` costs **~5–10%** (property lookup per call). Build-time
fusion avoids it entirely by making names **locals**. The only reason to keep a
runtime-merge path would be composition decided at **runtime** (dynamically loaded
rules) — not a current requirement, so it's out of scope.

## 10. What retires

- **Tier-2 fragment *source* resolution** + the self-contained-fragment
  constraint (docs/guide/extending.md) — the linker eats compiled pieces.
- **Per-consumer recompilation** of a base grammar.
- **The module-singleton build host** — replaced by `ctx.build`.
- Once landed, the docs' "the macro needs source access" caveats become false and
  come out. (Hold that doc edit until then — today they are accurate.)

## 11. Sequence

1. **Codegen: emit the linkable form** — restructure `compileRuleMap`:
   (a) build the `combinator → name` reverse map from the rule map;
   (b) emit each rule once as a `_r_<Name>` **sentinel-convention** fn, siblings
       called `_r_<Name>(…)` (deduped — no more per-reference `_pfN`);
   (c) export a map of **thin public wrappers** over the `_r_<Name>` fns;
   (d) namespace preludes; emit the dependency manifest.
   Default standalone build still produces a fused closure (link with only
   itself), so existing output/speed is preserved. **Parity-gated** (fused output
   parses identically) + perf-guard (no regression). ← start here
2. **Linker** — retarget the plugin to fuse imported linkable artifacts (select
   winner-per-name + dep-closure + prelude dedupe + name-check) instead of
   re-reading TS source.
3. **`ctx.build` host injection + `ctx.recover`** — unblock modes; retire the
   singleton (jess side).
4. **Incremental driver** — relative spans + queried absolute over the fused map
   (old Blocker C).
5. **Wire the three drivers** (eval / linter / IDE) over one fused map.
