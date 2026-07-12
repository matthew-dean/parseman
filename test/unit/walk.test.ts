/**
 * walk() / createVisitor() — generic CST/AST traversal.
 *
 * Covers the default CST shape (no generic), a custom AST shape via the generic
 * override, an end-to-end parse→walk over a real node() grammar, and the
 * createVisitor dispatch/fallthrough behavior.
 */
import { describe, it, expect } from 'vitest'
import {
  walk, createVisitor,
  node, rules, regex, sequence, choice, many, literal, parse,
} from '../../src/index.ts'
import type { CSTNode, CSTLeaf, CSTError, CSTChild, Span } from '../../src/index.ts'

// ---------------------------------------------------------------------------
// Hand-built CST fixtures (the default shape — no generic needed)
// ---------------------------------------------------------------------------

const sp = (start: number, end: number): Span => ({ start, end })
const leaf = (value: string, span: Span = sp(0, 0)): CSTLeaf => ({ _tag: 'leaf', value, span })
const cnode = (type: string, children: CSTChild[], span: Span = sp(0, 0)): CSTNode =>
  ({ _tag: 'node', type, span, state: null, children })
const cerror = (_label = '', span: Span = sp(0, 0)): CSTError =>
  ({ _tag: 'parseError', span, expected: [] })

// Add(Num[1], Add(Num[2], Num[3]))
const cstTree: CSTChild = cnode('Add', [
  cnode('Num', [leaf('1')]),
  cnode('Add', [
    cnode('Num', [leaf('2')]),
    cnode('Num', [leaf('3')]),
  ]),
])

describe('walk() — default CST shape', () => {
  it('pre-order: parents before children', () => {
    const order: string[] = []
    walk(cstTree, {
      enter(n) { if (n._tag === 'node') order.push(n.type) },
    })
    expect(order).toEqual(['Add', 'Num', 'Add', 'Num', 'Num'])
  })

  it('post-order: leave fires after children', () => {
    const order: string[] = []
    walk(cstTree, {
      leave(n) { if (n._tag === 'node') order.push(n.type) },
    })
    expect(order).toEqual(['Num', 'Num', 'Num', 'Add', 'Add'])
  })

  it('enter → false prunes the subtree (leave still runs for that node)', () => {
    const entered: string[] = []
    const left: string[] = []
    let seenAdd = 0
    walk(cstTree, {
      enter(n) {
        if (n._tag === 'node') {
          entered.push(n.type)
          if (n.type === 'Add' && ++seenAdd === 2) return false
        }
      },
      leave(n) { if (n._tag === 'node') left.push(n.type) },
    })
    // Nested Add's children (Num 2, Num 3) are skipped.
    expect(entered).toEqual(['Add', 'Num', 'Add'])
    expect(left).toEqual(['Num', 'Add', 'Add'])
  })

  it('threads a ctx accumulator; visits leaves', () => {
    const acc: string[] = []
    walk<CSTChild, string[]>(cstTree, {
      enter(n, _p, ctx) { if (n._tag === 'leaf') ctx.push(n.value) },
    }, acc)
    expect(acc).toEqual(['1', '2', '3'])
  })

  it('passes the correct parent', () => {
    const parents: Array<string | null> = []
    walk(cstTree, {
      enter(n, parent) {
        if (n._tag === 'node' && n.type === 'Num') {
          parents.push(parent && parent._tag === 'node' ? parent.type : null)
        }
      },
    })
    expect(parents).toEqual(['Add', 'Add', 'Add'])
  })

  it('visits an embedded parseError node as a terminal', () => {
    const withErr = cnode('List', [
      cnode('Num', [leaf('1')]),
      cerror('Item'),
    ])
    const tags: string[] = []
    walk(withErr, { enter(n) { tags.push(n._tag) } })
    expect(tags).toEqual(['node', 'node', 'leaf', 'parseError'])
  })

  it('handles a single leaf root (no children)', () => {
    const seen: string[] = []
    walk(leaf('solo'), { enter(n) { seen.push(n._tag) } })
    expect(seen).toEqual(['leaf'])
  })

  it('handles deep nesting without stack surprises', () => {
    let deep: CSTChild = cnode('L', [leaf('x')])
    for (let i = 0; i < 500; i++) deep = cnode('L', [deep])
    let count = 0
    walk(deep, { enter(n) { if (n._tag === 'node') count++ } })
    expect(count).toBe(501)
  })
})

// ---------------------------------------------------------------------------
// Custom AST shape via the generic override
// ---------------------------------------------------------------------------

type Ast =
  | { readonly _tag: 'node'; readonly type: 'Add'; readonly children: readonly Ast[] }
  | { readonly _tag: 'num'; readonly type: 'Num'; readonly value: number; readonly children?: readonly Ast[] }

const astTree: Ast = {
  _tag: 'node', type: 'Add', children: [
    { _tag: 'num', type: 'Num', value: 1 },
    { _tag: 'node', type: 'Add', children: [
      { _tag: 'num', type: 'Num', value: 2 },
      { _tag: 'num', type: 'Num', value: 3 },
    ] },
  ],
}

describe('walk<CustomShape>()', () => {
  it('walks a custom AST when given as a generic', () => {
    let sum = 0
    walk<Ast>(astTree, {
      enter(n) { if (n._tag === 'num') sum += n.value },
    })
    expect(sum).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// createVisitor()
// ---------------------------------------------------------------------------

describe('createVisitor() — default CST shape', () => {
  it('dispatches on type and recurses via api.visitChildren', () => {
    const evalExpr = createVisitor<number>({
      Num: (n) => Number(((n as CSTNode).children[0] as CSTLeaf).value),
      Add: (n, api) => api.visitChildren(n).reduce((a, b) => a + b, 0),
    })
    expect(evalExpr(cstTree)).toBe(6)
  })

  it('unhandled type falls through to children (top returns undefined)', () => {
    const collectNums = createVisitor<number>({
      Num: (n) => Number(((n as CSTNode).children[0] as CSTLeaf).value),
    })
    // Top node is Add (no handler) → undefined, but a lone Num resolves.
    expect(collectNums(cstTree)).toBeUndefined()
    expect(collectNums(cnode('Num', [leaf('7')]))).toBe(7)
  })

  it('visitChildren collects only defined results, in order', () => {
    const seen: string[] = []
    const v = createVisitor<string>({
      Num: (n) => {
        const val = ((n as CSTNode).children[0] as CSTLeaf).value
        seen.push(val)
        return val
      },
      Add: (n, api) => api.visitChildren(n).join('+'),
    })
    expect(v(cstTree)).toBe('1+2+3')
    expect(seen).toEqual(['1', '2', '3'])
  })

  it('leaf / error nodes (no matching type) yield undefined at the root', () => {
    const v = createVisitor<number>({ Num: () => 1 })
    expect(v(leaf('x'))).toBeUndefined()
    expect(v(cerror('Broken'))).toBeUndefined()
  })
})

describe('createVisitor<R, CustomShape>()', () => {
  it('evaluates a custom AST', () => {
    const evalAst = createVisitor<number, Ast>({
      Num: (n) => (n as Extract<Ast, { _tag: 'num' }>).value,
      Add: (n, api) => api.visitChildren(n).reduce((a, b) => a + b, 0),
    })
    expect(evalAst(astTree)).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// End-to-end: parse a real node() grammar, then walk the produced CST
// ---------------------------------------------------------------------------

describe('walk() over a parsed CST', () => {
  const mk = (type: string, ch: CSTNode['children'], span: Span): CSTNode =>
    ({ _tag: 'node', type, span, state: null, children: [...ch] })

  const { Expr } = rules(g => {
    const Num = node('Num', regex(/[0-9]+/), (ch, _r, s) => mk('Num', ch as CSTNode['children'], s))
    const Add = node('Add',
      sequence(g.Num, many(sequence(literal('+'), g.Num))),
      (ch, _r, s) => mk('Add', ch as CSTNode['children'], s))
    const Expr = node('Expr', choice(g.Add, g.Num), (ch, _r, s) => mk('Expr', ch as CSTNode['children'], s))
    return { Num, Add, Expr }
  })

  it('counts node types produced by a real parse', () => {
    const r = parse(Expr, '1+2+3')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const counts: Record<string, number> = {}
    walk(r.value as CSTChild, {
      enter(n) { if (n._tag === 'node') counts[n.type] = (counts[n.type] ?? 0) + 1 },
    })
    expect(counts.Expr).toBe(1)
    expect(counts.Add).toBe(1)
    expect(counts.Num).toBe(3)
  })

  it('createVisitor evaluates the parsed CST', () => {
    const r = parse(Expr, '10+20+12')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const evalExpr = createVisitor<number>({
      Expr: (n, api) => api.visitChildren(n)[0] ?? 0,
      Add: (n, api) => api.visitChildren(n).reduce((a, b) => a + b, 0),
      Num: (n) => Number(((n as CSTNode).children[0] as CSTLeaf).value),
    })
    expect(evalExpr(r.value as CSTChild)).toBe(42)
  })
})
