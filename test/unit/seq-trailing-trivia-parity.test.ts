/**
 * Interpreter vs compile() span parity for a sequence whose trailing term
 * (optional/many) matches EMPTY after trivia.
 *
 * `sequence(x, trivia, optional/many)`: when the following term matches nothing,
 * the trivia scanned between terms must NOT be folded into the sequence's span —
 * it belongs to the enclosing rule. The interpreter (sequence.ts) scans trivia to
 * a temp position and only commits it if the term consumes content past it, else
 * rolls back. The non-capturing compiled codegen used to advance the cursor over
 * that trivia unconditionally, so a compiled node's span end included the trailing
 * whitespace the interpreter excluded.
 *
 * Regression: on `a * b + c`, the `a*b` binary node's span ended at 6 (compiled,
 * including the space before `+`) instead of 5 (interpreter). This locks them equal.
 */
import { describe, it, expect } from 'vitest'
import {
  rules, sequence, many, optional, regex, literal, transform, choice, compile,
  type Combinator,
} from '../../src/index.ts'

const ws = regex(/[ \t\r\n]*/)

interface Bin { type: 'bin'; op: string; end: number; left: unknown; right: unknown }
type E = { type: 'id'; name: string; end: number } | Bin

// base (op base)* → left-nested; the transform span is the OUTER sequence span,
// so a rolled-back-vs-committed trailing trivia shows up directly as `span.end`.
function leftAssoc(base: Combinator<E>, op: Combinator<string>): Combinator<E> {
  return transform(
    sequence(base, many(sequence(op, base))),
    ([left, rest], span) => {
      let node: E = left
      for (const [o, right] of rest as [string, E][]) {
        node = { type: 'bin', op: o, left: node, right, end: span.end }
      }
      return node
    },
  )
}

const { expr, tail } = rules<{ expr: Combinator<E>; tail: Combinator<E> }>({ trivia: ws }, () => {
  // Operand = word with an OPTIONAL trailing `!` that matches empty here — mirrors
  // `call = atom optional(callArgs)` in examples/lang. It is this empty-matching
  // trailing optional (after the trivia between operator terms) that drives the
  // span bug: a bare `regex(/[a-z]+/)` operand would not reproduce it.
  const id: Combinator<E> = transform(
    sequence(regex(/[a-z]+/), optional(literal('!'))),
    ([name], span) => ({ type: 'id', name: name as string, end: span.end }),
  )
  const mul = leftAssoc(id, choice(literal('*'), literal('/')) as Combinator<string>)
  const add = leftAssoc(mul, choice(literal('+'), literal('-')) as Combinator<string>)

  // A trailing optional() that matches empty after trivia — the simplest shape.
  const tailR = transform(
    sequence(id, optional(literal('!'))),
    ([, bang], span) => ({ type: 'id', name: bang ?? '', end: span.end }),
  )

  return { expr: add, tail: tailR }
})

const compiledExpr = compile(expr)
const compiledTail = compile(tail)

function findBin(n: unknown, op: string): Bin | null {
  if (!n || typeof n !== 'object') return null
  const node = n as Record<string, unknown>
  if (node.type === 'bin' && node.op === op) return node as unknown as Bin
  for (const k of Object.keys(node)) {
    const r = findBin(node[k], op)
    if (r) return r
  }
  return null
}

describe('sequence trailing empty-match trivia: interpreter vs compile() span parity', () => {
  it('nested binary node span excludes the trailing space before the next operator', () => {
    const input = 'a * b + c'
    const i = expr.parse(input, 0, { trivia: ws } as never)
    const c = compiledExpr.parse(input)
    expect(i.ok && c.ok).toBe(true)

    const iMul = findBin(i.ok ? i.value : null, '*')
    const cMul = findBin(c.ok ? c.value : null, '*')
    expect(iMul?.end).toBe(5)          // interpreter: 'a * b' ends at 5
    expect(cMul?.end).toBe(iMul?.end)  // compiled must agree (was 6 pre-fix)
  })

  it('trailing optional() that matches empty leaves the trailing space out of the span', () => {
    const input = 'x '   // trailing whitespace, optional('!') matches empty
    const i = tail.parse(input, 0, { trivia: ws } as never)
    const c = compiledTail.parse(input)
    expect(i.ok && c.ok).toBe(true)
    expect((i.ok ? i.value : null as never).end).toBe(1)  // span ends at 'x', not the space
    expect((c.ok ? c.value : null as never).end).toBe((i.ok ? i.value : null as never).end)
  })
})
