/**
 * THE PROTOCOL THE THREE ENGINES SHARE — the failure sentinel and the
 * end-position out-parameter.
 *
 * `exec.ts`, `assemble.ts` and `emit-assembly.ts` each ran a private copy of
 * both: three `Symbol('pm.fail')` calls and three `let END = 0` closure slots.
 * That was sound while an assembly picked ONE engine and ran it for the whole
 * parse, which is what every shipped configuration does.
 *
 * It stops being sound the moment two engines are live in one parse. A piece
 * from engine A returning A's `FAIL` to a caller in engine B is a VALUE to B —
 * `!== FAIL` is true — so a failed match reads as a successful one carrying a
 * symbol, and the parse continues from a position nobody wrote. Neither a type
 * nor a test would catch it: the sentinels have the same description, and the
 * three-way identity sweep only ever exercised one engine per process.
 *
 * So both halves move here:
 *
 * - `FAIL` is ONE symbol, module-level, imported by every engine. There is no
 *   per-assembly variation possible in a sentinel, so there is no reason for it
 *   to be per-assembly state.
 * - `EndCell` is per-ASSEMBLY, not per-module. Two assemblies for two grammars
 *   may be live in one process and must not share a slot; the engines *within*
 *   one assembly must. `assemble()` mints one and hands it to whichever engines
 *   that assembly builds.
 *
 * A one-property object rather than an `Int32Array`: the store is monomorphic
 * either way, and `e` reads in emitted text as `EC.e`, which is the same shape
 * the closure engine writes.
 */

/** The failure sentinel. ONE per process, shared by every engine. */
export const FAIL: unique symbol = Symbol('pm.fail')
export type Fail = typeof FAIL

/**
 * The end-position out-parameter — `_pfEnd` in emitted text, `END` in the
 * closure walk and the driver. One per assembly.
 */
export type EndCell = { e: number }

export const newEndCell = (): EndCell => ({ e: 0 })
