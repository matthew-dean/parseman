/**
 * AST construction tests.
 *
 * Verifies that transform() builds typed AST nodes correctly, including
 * recursive grammars via parser(), operator precedence, and span tracking.
 */
import { describe, it, expect } from 'vitest'
import { parseExpr } from '../../examples/lang/parser.ts'
import type { Expr, BinaryExpr } from '../../examples/lang/ast.ts'

function parseOk(input: string): Expr {
  const r = parseExpr(input)
  if (!r.ok) throw new Error(`Parse failed on ${JSON.stringify(input)}: expected ${r.expected.join(', ')}`)
  return r.value
}

describe('AST — literals', () => {
  it('integer number', () => {
    const n = parseOk('42')
    expect(n).toMatchObject({ type: 'number', value: 42 })
  })

  it('negative number is unary minus + literal', () => {
    // In an expression grammar, -1 is unary(-) applied to number(1)
    const n = parseOk('-1')
    expect(n).toMatchObject({ type: 'unary', op: '-', operand: { type: 'number', value: 1 } })
  })

  it('float', () => {
    const n = parseOk('3.14')
    expect(n).toMatchObject({ type: 'number', value: 3.14 })
  })

  it('true / false', () => {
    expect(parseOk('true')).toMatchObject({ type: 'bool', value: true })
    expect(parseOk('false')).toMatchObject({ type: 'bool', value: false })
  })

  it('identifier', () => {
    expect(parseOk('foo')).toMatchObject({ type: 'ident', name: 'foo' })
  })

  it('keywords are not identifiers', () => {
    // 'true' and 'false' parse as bool nodes, not ident
    expect(parseOk('true').type).toBe('bool')
    expect(parseOk('false').type).toBe('bool')
  })
})

describe('AST — binary operators', () => {
  it('addition', () => {
    const n = parseOk('1 + 2') as BinaryExpr
    expect(n).toMatchObject({ type: 'binary', op: '+', left: { type: 'number', value: 1 }, right: { type: 'number', value: 2 } })
  })

  it('left-associativity: 1 + 2 + 3 → (1 + 2) + 3', () => {
    const n = parseOk('1 + 2 + 3') as BinaryExpr
    expect(n.type).toBe('binary')
    expect(n.op).toBe('+')
    expect((n.left as BinaryExpr).op).toBe('+')
    expect((n.left as BinaryExpr).left).toMatchObject({ type: 'number', value: 1 })
    expect((n.left as BinaryExpr).right).toMatchObject({ type: 'number', value: 2 })
    expect(n.right).toMatchObject({ type: 'number', value: 3 })
  })

  it('multiplication has higher precedence than addition', () => {
    const n = parseOk('1 + 2 * 3') as BinaryExpr
    // Should be: 1 + (2 * 3), not (1 + 2) * 3
    expect(n.op).toBe('+')
    expect(n.left).toMatchObject({ type: 'number', value: 1 })
    expect((n.right as BinaryExpr).op).toBe('*')
  })

  it('parentheses override precedence', () => {
    const n = parseOk('(1 + 2) * 3') as BinaryExpr
    expect(n.op).toBe('*')
    expect((n.left as BinaryExpr).op).toBe('+')
  })

  it('comparison operators', () => {
    expect(parseOk('x < y')).toMatchObject({ type: 'binary', op: '<' })
    expect(parseOk('x >= y')).toMatchObject({ type: 'binary', op: '>=' })
    expect(parseOk('x == y')).toMatchObject({ type: 'binary', op: '==' })
    expect(parseOk('x != y')).toMatchObject({ type: 'binary', op: '!=' })
  })

  it('logical operators', () => {
    expect(parseOk('a && b')).toMatchObject({ type: 'binary', op: '&&' })
    expect(parseOk('a || b')).toMatchObject({ type: 'binary', op: '||' })
  })

  it('&& has higher precedence than ||', () => {
    const n = parseOk('a || b && c') as BinaryExpr
    expect(n.op).toBe('||')
    expect((n.right as BinaryExpr).op).toBe('&&')
  })
})

describe('AST — unary operators', () => {
  it('unary minus', () => {
    const n = parseOk('-x')
    expect(n).toMatchObject({ type: 'unary', op: '-', operand: { type: 'ident', name: 'x' } })
  })

  it('logical not', () => {
    const n = parseOk('!done')
    expect(n).toMatchObject({ type: 'unary', op: '!', operand: { type: 'ident', name: 'done' } })
  })
})

describe('AST — function calls', () => {
  it('zero-arg call', () => {
    expect(parseOk('foo()')).toMatchObject({ type: 'call', callee: 'foo', args: [] })
  })

  it('single-arg call', () => {
    expect(parseOk('abs(x)')).toMatchObject({
      type: 'call', callee: 'abs',
      args: [{ type: 'ident', name: 'x' }],
    })
  })

  it('multi-arg call', () => {
    const n = parseOk('max(1, 2, 3)')
    expect(n).toMatchObject({
      type: 'call', callee: 'max',
      args: [{ value: 1 }, { value: 2 }, { value: 3 }],
    })
  })

  it('call in expression', () => {
    const n = parseOk('f(x) + 1') as BinaryExpr
    expect(n.op).toBe('+')
    expect(n.left).toMatchObject({ type: 'call', callee: 'f' })
  })
})

describe('AST — if expression', () => {
  it('basic if/then/else', () => {
    const n = parseOk('if x then 1 else 2')
    expect(n).toMatchObject({
      type: 'if',
      condition: { type: 'ident', name: 'x' },
      then: { type: 'number', value: 1 },
      else: { type: 'number', value: 2 },
    })
  })

  it('nested if', () => {
    const n = parseOk('if a then if b then 1 else 2 else 3')
    expect(n.type).toBe('if')
    expect((n as any).then.type).toBe('if')
  })
})

describe('AST — spans', () => {
  it('number span is correct', () => {
    const n = parseOk('42')
    expect(n.span).toEqual({ start: 0, end: 2 })
  })

  it('ident span is correct', () => {
    const n = parseOk('foo')
    expect(n.span).toEqual({ start: 0, end: 3 })
  })

  it('binary expr span covers both operands', () => {
    const n = parseOk('1 + 2')
    expect(n.span.start).toBe(0)
    expect(n.span.end).toBe(5)
  })
})
