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
 * and it is what a divergence gets bisected against. It is not on the product
 * path and nothing emitted imports it.
 */
export { assembledRules as tableRules, assembledRules, assemble, AssemblyCache, type Assembly, type RunCfg } from './assemble.ts'
export { encodeTable, UnsupportedConstruct, type TableSettings } from './encode.ts'
/**
 * `compile()` for the table lowering — same `CompiledParser` contract, a table
 * artifact instead of generated source. A root combinator is a one-rule map, so
 * this is a drop-in for the source-lowering `compile()` rather than a second API.
 */
export { compileTable, type TableCompileOptions } from './compile.ts'
export { emitTableModule, emitTableExpression, emitFoldedModule } from './emit.ts'
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
