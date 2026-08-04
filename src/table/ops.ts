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
/**
 * `CHOICE d n fx c1 … cn` — `d` indexes a dispatch table (or −1 for ordered
 * try); `fx` indexes the choice's OWN expected set.
 *
 * Both shipped engines report the UNION of the arms' expectations when a choice
 * fails. The driver reported whatever the last attempted arm left behind — or,
 * on a dispatch miss with no arm claiming the lead character, NOTHING, so a user
 * got an error naming nothing at all.
 */
export const OP_CHOICE = 5
/**
 * `REP c min max sep flags` — `sep` is a child offset or −1; `max` −1 = ∞.
 * `flags` bit 0 = trailing separator allowed, bit 1 = `keepSeparators`.
 */
export const OP_REP = 6
/** `REPV …` — `REP` with `valueUnused`. */
export const OP_REPV = 7
/** `OPT c` — child, or `null` at the same position. NOT `undefined`: `optional()`
 * yields `null` on no-match (src/combinators/repeat.ts:269,277) and grammars TEST for
 * it — examples/lang's `call` reducer is `if (args === null) return callee`, so
 * `undefined` there turned a bare identifier into a call node with `args: undefined`.
 * The parse succeeded and only the tree moved. */
export const OP_OPT = 8
/** `XFORM f c` — `f` indexes the reducer; called `(value, span)`. */
export const OP_XFORM = 9
/**
 * `NODE b c flags proj type tags` — SEVEN words. `b` indexes the build reducer
 * (−1 = none), `c` is the child offset, `proj` the projected child index (−1 =
 * none), `type` and `tags` index the const pool (`tags` −1 = none).
 *
 * `flags` is a BIT FIELD, not a boolean: bit 2 (`&4`) = the builder reads
 * `triviaLog`, bit 3 (`&8`) = it reads `ctx.state`, bit 4 (`&16`) = the node has
 * read fields, bit 5 (`&32`) = `collapse`, bit 6 (`&64`) = `unwrap`, bit 7
 * (`&128`) = `trailingTrivia`. Bits 2 and 3 are resolved at ENCODE time from the
 * reducer's declared arity by the same analysis codegen runs, and forced on under
 * `hostMode: 'cst'`. The driver reads the bits and re-derives nothing.
 *
 * TWO ENCODERS SHARE THIS OPCODE and they do NOT agree on its length. The layout
 * above is `encode.ts` / `exec.ts`. `encode-baseline.ts` / `exec-baseline.ts` emit
 * the FOUR-word form `NODE b c flags` with bits 2 and 3 only, and refuse
 * `collapse` / `unwrap` / `project` outright. Neither driver walks the stream by
 * instruction length, so the divergence is contained — but read the pair you are
 * in, not this comment alone. */
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
/**
 * `SEQX f n c1 … cn` — a `transform()` whose child is a `sequence()`.
 *
 * That pair is the dominant shape in every grammar here (json is nine of them),
 * and running it as two rows costs two switch dispatches and two JS call frames
 * per rule invocation where the emitted code pays neither. Fusing them into one
 * row halves that for the shape that occurs most.
 */
export const OP_SEQX = 22
/**
 * `SCAN s` — the scanning constructs. `s` indexes a `ScanSpec` in `prog.scans`.
 *
 * WAS `OP_CALL k`, which parked the LIVE combinator in the const pool. That ran
 * correctly and made the program unprintable — `emitConst` refuses a live object
 * — so no shipping grammar could be emitted at all: all four jess dialects use
 * `scanTo()`, three of them also `balanced()`. The number is reused because
 * `OP_CALL` has no other user and nothing in the const pool may be a live object
 * any more; that is now an invariant rather than a convention.
 *
 * Neither construct needs a live object. Both are DESCRIBED by data:
 *
 *   `scanTo()`   is a sentinel, an ordered skipper list, and two flags. Sentinel
 *                and skippers are ordinary grammar-graph combinators, so they are
 *                encoded as ordinary table SUBTREES and referenced by offset.
 *   `balanced()` is an open string, a close string, an own-skip list and two
 *                flags. Its `_def` is its EAGER interior (per-call skip only) and
 *                its ambient re-resolution lives on `.parse`, so encoding it from
 *                `_def` builds the wrong parser — the spec carries the
 *                CONSTRUCTOR ARGUMENTS instead, and `balanced()` itself rebuilds.
 *
 * The driver does not re-implement either scan. `resolveTable`'s pool rebuilds
 * each spec with the SHARED constructor (`scanTo`/`balanced`), handing it
 * subtree-backed combinators, exactly as `triviaSpecs` rebuilds trivia with the
 * shared `classifiedTrivia`. So there is one implementation of each, and the
 * table carries only its arguments.
 */
export const OP_SCAN = 23
/**
 * `FIELD k c` — `field(name, parser)`. `k` indexes the NAME in the const pool.
 *
 * Runs the child and, on success, records `{ name, value, span }` into
 * `ctx._fields` for the nearest enclosing `node()` to assemble. The recording is
 * conditional on `ctx._fields` being live, exactly as `src/combinators/map.ts`
 * has it — a field outside any field-reading node costs nothing.
 */
export const OP_FIELD = 24
/**
 * `LIT_CI k fx` — a case-insensitive `literal()`.
 *
 * Its own row rather than a flag on `LIT`, so the hot exact-match path keeps a
 * bare `startsWith`. NOTE it yields the INPUT's casing, not the literal's —
 * `literal.ts:86` returns `input.slice(pos, end)` — so a node built from it
 * carries the source text. Returning the literal would silently normalise case.
 */
export const OP_LIT_CI = 27
/** `LIT_CI_TRACK k fx` — the line-tracking twin of `LIT_CI`. */
export const OP_LIT_CI_TRACK = 28
/**
 * `TOKEN c` — `token()`. Clears trivia AND every capture sink for the child,
 * then contributes ONE leaf spanning the whole match.
 *
 * Was `OP_CALL` (a live combinator in the const pool), which ran correctly but
 * made the table unprintable — `emitConst` refuses non-serialisable entries, so
 * no grammar using `token()` could be emitted as a module. Nothing about it
 * needs a live object: it is save / clear / run / restore / one leaf.
 */
export const OP_TOKEN = 29
/**
 * `DISPATCH sel d other otherRouted n a1 … an` — `dispatch()`.
 *
 * `sel` is the selector's offset, `d` indexes a dispatch table in `prog.dsp`,
 * `other` is the `otherwise()` offset (or −1), `otherRouted` is 1 when the
 * fallback consumes the routed token, and `a1…an` are the arm offsets. Arm
 * `usesRouted` bits live in the `dsp` entry beside the key maps.
 *
 * The selector runs ONCE; the key it returns picks the arm. That is the whole
 * point of `dispatch()` over a `choice()` of arms that each re-parse the opener.
 */
export const OP_DISPATCH = 25
/**
 * `ROUTED fallback` — `routed()`. Yields the token the enclosing `dispatch()`
 * already consumed, so the selected branch can own it. `fallback` is an offset
 * or −1; it runs when there is no routed token at this position.
 */
export const OP_ROUTED = 26

export const OP_NAMES: Record<number, string> = {
  [OP_LIT]: 'LIT', [OP_RX]: 'RX', [OP_SEQ]: 'SEQ', [OP_SEQV]: 'SEQV',
  [OP_CHOICE]: 'CHOICE', [OP_REP]: 'REP', [OP_REPV]: 'REPV', [OP_OPT]: 'OPT',
  [OP_XFORM]: 'XFORM', [OP_NODE]: 'NODE', [OP_RULE]: 'RULE', [OP_GATE]: 'GATE',
  [OP_NOT]: 'NOT', [OP_PEEK]: 'PEEK', [OP_LEAF]: 'LEAF', [OP_EMPTY]: 'EMPTY',
  [OP_LIT_TRACK]: 'LIT_TRACK', [OP_RX_TRACK]: 'RX_TRACK', [OP_NODE_TRACK]: 'NODE_TRACK',
  [OP_SCOPE]: 'SCOPE', [OP_EXPECT]: 'EXPECT', [OP_SEQX]: 'SEQX', [OP_SCAN]: 'SCAN',
  [OP_FIELD]: 'FIELD', [OP_LIT_CI]: 'LIT_CI', [OP_LIT_CI_TRACK]: 'LIT_CI_TRACK', [OP_DISPATCH]: 'DISPATCH', [OP_ROUTED]: 'ROUTED',
  [OP_TOKEN]: 'TOKEN',
}
