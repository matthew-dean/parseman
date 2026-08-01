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
export { emitTableModule, emitTableOnly } from './emit.ts'
export { opHistogram, reachableOps } from './inspect.ts'
export { resolveTable } from './program.ts'
export type { CompactProgram, TableProgram, TableRule } from './program.ts'
