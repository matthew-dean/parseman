import type { Combinator, ParseContext, ParseResult, ParserMeta, FirstSet, Span } from '../types.ts'
import { firstSetOf } from './first-set.ts'
import { saveTriviaMark, scanTrivia, consumeTrivia, rollbackTrivia } from './trivia-skip.ts'
import { choice } from './choice.ts'
import { literal } from './literal.ts'

/**
 * Fold step for one precedence level: given the accumulated left node, the
 * operator value, the right operand, and the `left..right` span, build the node.
 */
export type Combine = (left: unknown, op: unknown, right: unknown, span: Span) => unknown

/** Default binary-node builder — the 99% case. Kept in sync with `DEFAULT_COMBINE_SRC`. */
const defaultCombine: Combine = (left, op, right, span) => ({ type: 'binary', op, left, right, span })
const DEFAULT_COMBINE_SRC = '(left, op, right, span) => ({ type: "binary", op, left, right, span })'

/** A row in a precedence table. Bare `string[]` = left-assoc infix operators. */
export type PrecRow =
  | Array<string | Combinator<unknown>>
  | {
      ops: Array<string | Combinator<unknown>>
      /** `'left'` (default) repeatable left fold; `'none'` non-associative (one op max); `'right'` right fold. */
      assoc?: 'left' | 'right' | 'none'
      /** When `false`, a run may repeat but every operator must equal the first (jess `and`/`or`, CSS media). */
      mixing?: boolean
    }
  | { prefix: Array<string | Combinator<unknown>> }

function firstSetHasCp(fs: FirstSet, cp: number): boolean {
  if (fs.kind === 'any') return true
  if (fs.kind === 'empty') return false
  for (const r of fs.ranges) if (cp >= r.lo && cp <= r.hi) return true
  return false
}

const litOrComb = (x: string | Combinator<unknown>): Combinator<unknown> =>
  typeof x === 'string' ? (literal(x) as Combinator<unknown>) : x

/** Build the operator parser for a row: single op direct, multiple via `choice`. */
function rowOperator(ops: Array<string | Combinator<unknown>>): Combinator<unknown> {
  const parsers = ops.map(litOrComb)
  if (parsers.length === 1) return parsers[0]!
  return choice(...(parsers as [Combinator<unknown>, ...Combinator<unknown>[]]))
}

/** One left-associative infix level: `operand (operator operand)*`. */
function leftLevel(
  operand: Combinator<unknown>,
  operator: Combinator<unknown>,
  combine: Combine,
  combineSrc: string | undefined,
): Combinator<unknown> {
  const opFirst = firstSetOf(operator)
  const meta: ParserMeta = {
    firstSet: operand._meta.firstSet,
    canMatchNewline: operand._meta.canMatchNewline || operator._meta.canMatchNewline,
    isTrivia: false,
  }
  return {
    _tag: 'precedence',
    _meta: meta,
    _def: { tag: 'precedence', operand, operator, assoc: 'left', mixing: true, combine, ...(combineSrc ? { combineSrc } : {}) },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<unknown> {
      const first = operand.parse(input, pos, ctx)
      if (!first.ok) return first
      let acc: unknown = first.value
      let cur = first.span.end
      for (;;) {
        // Peek trivia + operator first char WITHOUT committing — the hot no-operator
        // case returns here having touched no capture state and allocated nothing.
        const scan = ctx.trivia ? scanTrivia(input, cur, ctx) : null
        const opPos = scan ? scan.end : cur
        if (opPos >= input.length || !firstSetHasCp(opFirst, input.codePointAt(opPos)!)) break

        const mark = saveTriviaMark(ctx)
        if (scan) scan.commit()
        const opR = operator.parse(input, opPos, ctx)
        if (!opR.ok) { rollbackTrivia(ctx, mark); break }
        const rhsPos = consumeTrivia(input, opR.span.end, ctx)
        const rhs = operand.parse(input, rhsPos, ctx)
        if (!rhs.ok) { rollbackTrivia(ctx, mark); break }
        acc = combine(acc, opR.value, rhs.value, { start: pos, end: rhs.span.end })
        cur = rhs.span.end
      }
      return { ok: true, value: acc, span: { start: pos, end: cur } }
    },
  }
}

/**
 * A precedence table over `base`, tightest-binding row first. Each row is a set
 * of operators at one binding level; stacking is handled internally so the whole
 * ladder reads as one declarative list.
 *
 *   precedence(unary, [
 *     ['*', '/'],
 *     ['+', '-'],
 *   ])
 *
 * Bare operator strings auto-wrap to `literal`. Pass `combine` to build a custom
 * AST node; the default builds `{ type: 'binary', op, left, right, span }`.
 */
export function precedence(
  base: Combinator<unknown>,
  rows: PrecRow[],
  combine: Combine = defaultCombine,
): Combinator<unknown> {
  const combineSrc = combine === defaultCombine ? DEFAULT_COMBINE_SRC : undefined
  let level = base
  for (const row of rows) {
    if (Array.isArray(row)) {
      level = leftLevel(level, rowOperator(row), combine, combineSrc)
      continue
    }
    if ('prefix' in row) {
      throw new Error('precedence(): prefix rows are not implemented yet')
    }
    const assoc = row.assoc ?? 'left'
    const mixing = row.mixing ?? true
    if (assoc !== 'left' || !mixing) {
      throw new Error(`precedence(): assoc='${assoc}' / mixing=${mixing} not implemented yet`)
    }
    level = leftLevel(level, rowOperator(row.ops), combine, combineSrc)
  }
  return level
}
