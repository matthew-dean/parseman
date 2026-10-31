/**
 * AN OPTIONAL REPEAT ITEM THAT OPENS WITH A GAP (`OP_GAPGATE`).
 *
 * SCSS writes its operators as `sequence(pad, '*', pad)` with `pad` a regex that
 * may match empty, and a value chain has a repeat of them at every level. After
 * a value followed by a space, each level entered its operator, scanned the
 * space and failed on the character after it: the same gap read once per level,
 * and an operator node's frame opened each time.
 *
 * The repeat now reads the gap itself, ONCE, with the item's own regex, and
 * looks at the character after it: an item that opens with the gap must
 * continue with a character of `cls` there (and an arm without the gap must
 * start with one of `other` where the gap starts). Where neither holds the item
 * cannot match, so the repeat ends, exactly as it ends on a strict item whose
 * class excludes the lead. Otherwise it enters the item and leaves the gap's end
 * in the GAP SLOT, from which the regex row takes it instead of scanning again.
 *
 * The slot is a memo of one pure function: the end of regex row `row` matched
 * at `at` in `input`. A row reads it only when all three are its own, so a
 * different row, position or input cannot take it, and a slot left set can
 * only ever give a row the end it would have computed. Only rows the table
 * names as a gap (`gapRows`) test it at all. It is set for the item and cleared
 * when the item returns.
 *
 * Not under tolerant recovery or a completions probe, which observe an item's
 * failure: there the repeat enters the item as written. The reference driver
 * (`exec.ts`) always does, which is what makes it the ungated leg.
 */
import { childSlots } from './child-slots.ts'
import { OP_GAPGATE } from './ops.ts'

/** The gap slot one assembly shares between its closure and emitted pieces. */
export type GapSlot = { row: number; at: number; end: number; input: string | undefined }

export function newGapSlot(): GapSlot {
  return { row: -1, at: -1, end: -1, input: undefined }
}

/** The regex rows some reachable `OP_GAPGATE` names as its gap. */
export function gapRows(code: ArrayLike<number>, roots: Iterable<number>): Set<number> {
  const rows = new Set<number>()
  const seen = new Set<number>()
  const stack = [...roots]
  const kids: number[] = []
  while (stack.length > 0) {
    const ip = stack.pop()!
    if (seen.has(ip)) continue
    seen.add(ip)
    if (code[ip] === OP_GAPGATE) rows.add(code[ip + 2]!)
    kids.length = 0
    childSlots(code, ip, kids)
    for (const c of kids) stack.push(c)
  }
  return rows
}
