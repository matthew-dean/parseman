import { OP_FIELD } from './ops.ts'
import { FIELD_LEADING_TRIVIA } from '../combinators/field-trivia.ts'

/**
 * An `OP_FIELD` name slot: the name, or `[name, bits]` for a field that
 * attributes trivia (`FIELD_LEADING_TRIVIA` / `FIELD_TRAILING_TRIVIA`). A
 * program printed before those options existed carries only names, and reads
 * as bits 0.
 */
export function fieldSpec(slot: unknown): { readonly name: string; readonly bits: number } {
  return Array.isArray(slot) ? { name: slot[0] as string, bits: slot[1] as number } : { name: slot as string, bits: 0 }
}

/** Is the instruction at `ip` a `field(…, { leadingTrivia: true })`? */
export function leadingTriviaFieldAt(code: ArrayLike<number>, k: readonly unknown[], ip: number): boolean {
  return code[ip] === OP_FIELD && (fieldSpec(k[code[ip + 1]!]).bits & FIELD_LEADING_TRIVIA) !== 0
}
