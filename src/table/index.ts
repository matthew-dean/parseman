/**
 * `parseman/table` — the shared driver for the TABLE lowering (ledger row G5).
 *
 * A grammar lowered to a table contributes only DATA to a bundle; every line of
 * recognition logic lives here and ships once, shared by every grammar and every
 * `(grammar, settings)` variant. An emitted module's whole runtime dependency is
 * `tableRules` from this entry.
 *
 * Its own entry point for the same reason `parseman/run` is: a package that
 * SHIPS a table parser should not drag the combinator set, `compile()` and the
 * first-set analysis along with it.
 */
/**
 * THE DRIVER (G5) — `tableRules` IS the assembler. The program is LINKED into
 * closures at run start, so the parse path holds no opcode read, no operand
 * decode and no option test.
 *
 * It replaced the bytecode interpreter here rather than shipping beside it. Two
 * live drivers is two places for behaviour to drift, and that already happened
 * once: the ambient `scanSkip` write had to move into the shared `stamp.ts`
 * envelope because each driver was installing it separately. The gate for the
 * swap was `exec === assembled` on the identity sweep, which it clears.
 *
 * `exec.ts` stays REFERENCE — the sweep still gates the assembler against it,
 * and it is what a divergence gets bisected against. Nothing under `src/` binds
 * it; only `bench/` and `test/` do, as the reference side of a differential.
 *
 * THAT SENTENCE WAS FALSE FOR TWO RELEASES, and the shape of the failure is
 * worth keeping. `63666b6` made the assembler `tableRules` by editing THIS FILE
 * and nothing else. `exec.ts` exported its own function ALSO called `tableRules`
 * with the identical signature, so any module reaching PAST this entry bound the
 * interpreter, type-checked clean and ran correctly — just slower. THREE modules
 * did: `table/fold.ts` (predating the swap), `compiler/linker.ts` (added after
 * it, in `37c57b5`), and `bench/jess/fixture.ts` — the CANONICAL fixture
 * harness, whose column printed as `table` was the reference interpreter for the
 * whole cycle its figures were quoted in. Between them they put the entire
 * `compose()`/`fuse()` composition path, every folded artifact's `tableVariants`
 * load, and the repo's headline parse-time figure on the reference engine.
 *
 * BOTH HALVES OF THE MECHANISM ARE GONE, AND ONLY REMOVING BOTH WAS ENOUGH.
 *
 * Half one: `exec.ts` now exports `execRules`. The reference driver no longer
 * answers to the shipped engine's name.
 *
 * Half two, and the one that made the class EXPRESSIBLE: this line used to read
 * `export { assembledRules as tableRules, assembledRules, … }` — ONE function
 * published under TWO names. An `as` re-export across a boundary we own both
 * sides of is not a compatibility shim; it is a second name for a thing that
 * needs one, and it is exactly the seam a wrong import slips through. The
 * function in `assemble.ts` is now NAMED `tableRules` at its declaration and
 * re-exported unrenamed. `assembledRules` no longer exists anywhere.
 *
 * WHY `tableRules` WON AND `assembledRules` DIED:
 *
 *   1. It is the name EMITTED ARTIFACTS import. `emit.ts:emitTableModule` writes
 *      `import { <ref> } from 'parseman/table'` with `ref` defaulting to
 *      `tableRules`; `compile.ts` and `compile-rule-map.ts` default `runtimeRef`
 *      to the same; `plugin/index.ts` prepends that exact import into every
 *      consumer bundle it rewrites. Unifying on this name changes NO emitted
 *      byte — the alternative direction would have rewritten four emit sites and
 *      every artifact they have ever produced, for no gain.
 *   2. It names WHAT THE THING IS at a public boundary — the rule map of a table
 *      lowering — where `assembledRules` named HOW it is currently built.
 *      Closure assembly is an implementation that has already replaced one
 *      engine and may be replaced again; the boundary name has now outlived one
 *      such swap and should outlive the next.
 *
 * `scripts/check-invariants.mjs` INV-11 fails any `as` rename across the two
 * engines' vocabularies, and any renaming re-export from a `src/**` entry point,
 * across `src/`, `test/` and `bench/`. The rule exists because the alias above
 * was not a mistake anyone made twice — it was a shape that made the mistake
 * available.
 */
export { tableRules, assemble, AssemblyCache, type Assembly, type RunCfg } from './assemble.ts'
export { encodeTable, UnsupportedConstruct, type TableSettings } from './encode.ts'
/**
 * `compile()` for the table lowering — same `CompiledParser` contract, a table
 * artifact instead of generated source. A root combinator is a one-rule map, so
 * this is a drop-in for the source-lowering `compile()` rather than a second API.
 */
export { compile, type TableCompileOptions } from './compile.ts'
export { emitTableModule, emitTableExpression, emitFoldedModule } from './emit.ts'
/**
 * `compileRuleMap()` for the table lowering — the MAIN macro path. `compile`
 * only ever covered `compile()`, the single-root entry, so a `rules()` grammar had
 * no table counterpart to point the build at at all.
 */
export { compileRuleMap, type TableRuleMapOptions, type CompiledRuleMapTable } from './compile-rule-map.ts'
/**
 * THE VARIANT FOLD (G4). One base table plus per-variant row edits, selected at
 * load. Additive: `tableRules` and every existing entry are untouched, and the
 * driver still reads no option on the parse path.
 */
export { tableVariants, variantNames } from './fold.ts'
export { foldPrograms, unfoldVariant, expandCompactFolded } from './program.ts'
export type { FoldedProgram, CompactFolded, TableDelta } from './program.ts'
/*
 * `emitTableOnly` is NOT re-exported here. It is a SIZE PROBE: it emits the
 * table with an EMPTY reducer pool so the machinery's byte count is comparable
 * to codegen's per-rule cost. The module it produces is not loadable — the code
 * stream still references `fns[i]`, so the first parse throws
 * `build is not a function`. That is fine for a measurement and wrong for a
 * public entry, where it reads like "emit just the table" and fails open.
 * `test/unit/table-emit-roundtrip.test.ts` imports it from `./emit.ts` directly.
 */
export { opHistogram, reachableOps } from './inspect.ts'
export { resolveTable } from './program.ts'
export type { CompactProgram, TableProgram, TableRule } from './program.ts'
