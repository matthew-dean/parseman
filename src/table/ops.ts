/**
 * Opcodes for the TABLE lowering (design ledger row G5).
 *
 * The premise, stated so it can be falsified: today every rule's recognizer is
 * INLINED BESPOKE into its own emitted function, so an artifact pays the full
 * cost of the recognition machinery once PER RULE (measured: ~4.9 kB for a
 * `node()` rule; ~186 B for each additional call site). Emitting a rule as a
 * TABLE ROW interpreted by one shared driver moves that machinery out of the
 * artifact and into the runtime, where it is emitted ONCE for all grammars and
 * all variants.
 *
 * The instruction stream is a flat `number[]`: `code[ip]` is the opcode and the
 * operands follow it inline. Child instructions are referenced by ABSOLUTE code
 * offset, never by nesting, so the driver is a plain recursive read — no node
 * objects, no closures, no per-combinator allocation.
 *
 * Operand layouts are documented per opcode below and are the contract between
 * `encode.ts` and `exec.ts`. Nothing else may read the stream.
 */

/** `LIT k` — `k` indexes a string in the const pool. */
export const OP_LIT = 1
/** `RX k` — `k` indexes a STICKY `RegExp` in the const pool. */
export const OP_RX = 2
/** `SEQ n c1 … cn` — n child offsets; value is the array of their values. */
export const OP_SEQ = 3
/** `SEQV n c1 … cn` — `SEQ` with `valueUnused`: terms run, no tuple is built. */
export const OP_SEQV = 4
/** `CHOICE d n c1 … cn` — `d` indexes a dispatch table (or −1 for ordered try). */
export const OP_CHOICE = 5
/** `REP c min max sep trailing` — `sep` is a child offset or −1; `max` −1 = ∞. */
export const OP_REP = 6
/** `REPV …` — `REP` with `valueUnused`. */
export const OP_REPV = 7
/** `OPT c` — child, or `undefined` at the same position. */
export const OP_OPT = 8
/** `XFORM f c` — `f` indexes the reducer; called `(value, span)`. */
export const OP_XFORM = 9
/** `NODE b c raw` — `b` indexes the build reducer; `raw` 1 = capture rawChildren. */
export const OP_NODE = 10
/** `RULE r` — `r` indexes `prog.rules`. */
export const OP_RULE = 11
/** `GATE cc c` — first-char gate: `cc` indexes a char class; then run `c`. */
export const OP_GATE = 12
/** `NOT c` / `PEEK c` — zero-width. */
export const OP_NOT = 13
export const OP_PEEK = 14
/** `LEAF f c` — `leaf()`: reduce, then record as a spanned leaf. */
export const OP_LEAF = 15
/** `EMPTY` — matches the empty string. */
export const OP_EMPTY = 16
/**
 * Line-tracking twins of `LIT` / `RX` / `NODE`.
 *
 * This is the variant axis, made concrete. `trackLines` picks these rows when
 * the TABLE IS BUILT; the driver holds a case for each and never asks whether
 * line tracking is on. Same driver, different table contents — G5 exactly.
 */
export const OP_LIT_TRACK = 17
export const OP_RX_TRACK = 18
export const OP_NODE_TRACK = 19
/**
 * `SCOPE k c` — a `parser({ trivia })` / `rules({ trivia })` scope.
 *
 * `k` is the scope's trivia COMBINATOR in the const pool. The driver installs it
 * on `ctx.trivia` for the duration and restores the outer one after, which is
 * how the runtime's own `advanceTrivia` fast scanner gets reached — the same
 * shared machinery the interpreter uses, not a second copy of it.
 */
export const OP_SCOPE = 20
/**
 * `EXPECT c e` — `expect()`. Never fails: on a failed child it yields a
 * zero-width `ParseError` value carrying the expected set at `e`.
 */
export const OP_EXPECT = 21

export const OP_NAMES: Record<number, string> = {
  [OP_LIT]: 'LIT', [OP_RX]: 'RX', [OP_SEQ]: 'SEQ', [OP_SEQV]: 'SEQV',
  [OP_CHOICE]: 'CHOICE', [OP_REP]: 'REP', [OP_REPV]: 'REPV', [OP_OPT]: 'OPT',
  [OP_XFORM]: 'XFORM', [OP_NODE]: 'NODE', [OP_RULE]: 'RULE', [OP_GATE]: 'GATE',
  [OP_NOT]: 'NOT', [OP_PEEK]: 'PEEK', [OP_LEAF]: 'LEAF', [OP_EMPTY]: 'EMPTY',
  [OP_LIT_TRACK]: 'LIT_TRACK', [OP_RX_TRACK]: 'RX_TRACK', [OP_NODE_TRACK]: 'NODE_TRACK',
  [OP_SCOPE]: 'SCOPE', [OP_EXPECT]: 'EXPECT',
}
