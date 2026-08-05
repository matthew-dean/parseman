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
export { tableRules } from './exec.ts'
export { encodeTable, UnsupportedConstruct, type TableSettings } from './encode.ts'
export { emitTableModule, emitFoldedModule } from './emit.ts'
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
