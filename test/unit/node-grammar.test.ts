/**
 * node() + rules() — CST construction, state, trivia capture, and incremental docs.
 */
import { describe, it, expect } from 'vitest'
import {
  literal, regex, sequence, choice, many, optional, sepBy,
  parse, parser, scanTo, balanced, gate, withCtx, node, rules,
  parseDoc,
} from '../../src/index.ts'
import type { CSTNode, CSTLeaf, CSTError, CSTTrivia, CSTRawChild, Span } from '../../src/index.ts'

function mkCst(
  type: string,
  children: CSTNode['children'],
  span: Span,
  state: unknown,
): CSTNode {
  return { _tag: 'node', type, span, state, children: [...children] }
}

const digits = regex(/[0-9]+/)
const ident = regex(/[a-zA-Z_]\w*/)

function makeExprGrammar() {
  return rules(g => {
    const Number = node('Number', digits, (ch, _fields, span, _r, _tl, state) =>
      mkCst('Number', ch as CSTNode['children'], span, state))
    const Ident = node('Ident', ident, (ch, _fields, span, _r, _tl, state) =>
      mkCst('Ident', ch as CSTNode['children'], span, state))
    const Add = node(
      'Add',
      sequence(g.Number, many(sequence(literal('+'), g.Number))),
      (ch, _fields, span, _r, _tl, state) => mkCst('Add', ch as CSTNode['children'], span, state),
    )
    const Expr = node(
      'Expr',
      choice(g.Add, g.Number, g.Ident),
      (ch, _fields, span, _r, _tl, state) => mkCst('Expr', ch as CSTNode['children'], span, state),
    )
    return { Number, Ident, Add, Expr }
  })
}

// ---------------------------------------------------------------------------
// Basic CST construction
// ---------------------------------------------------------------------------
describe('node() — basic CST', () => {
  it('node rule produces a CSTNode', () => {
    const { Number } = makeExprGrammar()
    const r = parse(Number, '42')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value._tag).toBe('node')
    expect(r.value.type).toBe('Number')
    expect(r.value.span).toEqual({ start: 0, end: 2 })
  })

  it('CSTNode span is correct for Ident', () => {
    const { Ident } = makeExprGrammar()
    const r = parse(Ident, 'foo')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.span).toEqual({ start: 0, end: 3 })
  })

  it('terminals appear as CSTLeaf in parent children', () => {
    const { Number } = makeExprGrammar()
    const r = parse(Number, '123')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const leaf = r.value.children.find(c => c._tag === 'leaf') as CSTLeaf | undefined
    expect(leaf).toBeDefined()
    expect(leaf!.value).toBe('123')
  })

  it('nested node rules appear as CSTNode children', () => {
    const { Add } = makeExprGrammar()
    const r = parse(Add, '1+2')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const nodeChildren = r.value.children.filter(c => c._tag === 'node') as CSTNode[]
    expect(nodeChildren.length).toBeGreaterThanOrEqual(2)
    expect(nodeChildren[0]!.type).toBe('Number')
    expect(nodeChildren[1]!.type).toBe('Number')
  })

  it('children appear in parse order — nodes and leaves interleaved', () => {
    const { Add } = makeExprGrammar()
    const r = parse(Add, '1+2')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const tags = r.value.children.map(c => c._tag)
    expect(tags).toContain('node')
    expect(tags).toContain('leaf')
    const leaves = r.value.children.filter(c => c._tag === 'leaf') as CSTLeaf[]
    expect(leaves.some(l => l.value === '+')).toBe(true)
  })

  it('failed parse returns ok:false, no CSTNode', () => {
    const { Number } = makeExprGrammar()
    const r = parse(Number, 'abc')
    expect(r.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
describe('node() — state', () => {
  it('state is undefined when no user context is set', () => {
    const { Number } = makeExprGrammar()
    const r = parse(Number, '1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.state).toBeUndefined()
  })

  it('state records ctx.state at parse entry', () => {
    const { Number } = makeExprGrammar()
    const p = withCtx({ mode: 'strict' }, Number)
    const r = parse(p, '99')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.state).toEqual({ mode: 'strict' })
  })

  it('state is a shallow clone — original mutations do not propagate', () => {
    const { Number } = makeExprGrammar()
    const userCtx = { count: 0 }
    const p = withCtx(userCtx, Number)
    const r = parse(p, '7')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const saved = r.value.state as { count: number }
    expect(saved.count).toBe(0)
    userCtx.count = 999
    expect(saved.count).toBe(0)
  })

  it('nested rules each record their own state', () => {
    const { Add } = makeExprGrammar()
    const p = withCtx({ phase: 'test' }, Add)
    const r = parse(p, '1+2')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const addCtx = r.value.state as { phase: string }
    expect(addCtx.phase).toBe('test')
    const numChildren = r.value.children.filter(c => c._tag === 'node') as CSTNode[]
    expect(numChildren[0]!.state).toEqual({ phase: 'test' })
  })
})

// ---------------------------------------------------------------------------
// Mutual recursion
// ---------------------------------------------------------------------------
describe('node() — mutual recursion', () => {
  const listGrammar = rules(g => {
    const Item = node('Item', regex(/[a-z]+/), (ch, _fields, span, _r, _tl, state) =>
      mkCst('Item', ch as CSTNode['children'], span, state))
    const items = sepBy(g.Item, literal(','))
    const List = node(
      'List',
      sequence(literal('['), items, literal(']')),
      (ch, _fields, span, _r, _tl, state) => mkCst('List', ch as CSTNode['children'], span, state),
    )
    return { Item, List }
  })

  it('compiles recursive rules without stack overflow', () => {
    const r = parse(listGrammar.List, '[foo,bar,baz]')
    expect(r.ok).toBe(true)
  })

  it('Item children appear directly in List', () => {
    const r = parse(listGrammar.List, '[a,b]')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const items = r.value.children.filter(c => c._tag === 'node' && (c as CSTNode).type === 'Item') as CSTNode[]
    expect(items.length).toBe(2)
    expect(items[0]!.span.start).toBeLessThan(items[1]!.span.start)
  })

  it('delimiters appear as leaves alongside Item nodes', () => {
    const r = parse(listGrammar.List, '[x,y]')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const leaves = r.value.children.filter(c => c._tag === 'leaf') as CSTLeaf[]
    expect(leaves.some(l => l.value === '[')).toBe(true)
    expect(leaves.some(l => l.value === ']')).toBe(true)
    expect(leaves.some(l => l.value === ',')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Context-sensitive parsing
// ---------------------------------------------------------------------------
describe('node() — context-sensitive rules', () => {
  const langGrammar = rules(g => {
    const Return = node(
      'Return',
      sequence(
        gate((u: unknown) => (u as { inFn?: boolean } | undefined)?.inFn === true),
        literal('return'),
      ),
      (ch, _fields, span, _r, _tl, state) => mkCst('Return', ch as CSTNode['children'], span, state),
    )
    const Expr = node('Expr', regex(/[a-z]+/), (ch, _fields, span, _r, _tl, state) =>
      mkCst('Expr', ch as CSTNode['children'], span, state))
    const Stmt = node('Stmt', choice(g.Return, g.Expr), (ch, _fields, span, _r, _tl, state) =>
      mkCst('Stmt', ch as CSTNode['children'], span, state))
    const Body = node(
      'Body',
      withCtx({ inFn: true }, many(sequence(g.Stmt, literal(';')))),
      (ch, _fields, span, _r, _tl, state) => mkCst('Body', ch as CSTNode['children'], span, state),
    )
    return { Return, Expr, Stmt, Body }
  })

  it('Return fails without inFn context', () => {
    const r = parse(langGrammar.Return, 'return')
    expect(r.ok).toBe(false)
  })

  it('Return succeeds when inFn context is set', () => {
    const p = withCtx({ inFn: true }, langGrammar.Return)
    const r = parse(p, 'return')
    expect(r.ok).toBe(true)
  })

  it('Body enables Return for its contents', () => {
    const r = parse(langGrammar.Body, 'return;')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const stmts = r.value.children.filter(c => c._tag === 'node' && (c as CSTNode).type === 'Stmt') as CSTNode[]
    expect(stmts.length).toBeGreaterThan(0)
    const hasReturn = stmts.some(s => s.children.some(c => c._tag === 'node' && (c as CSTNode).type === 'Return'))
    expect(hasReturn).toBe(true)
  })

  it('state on nested Return records inFn:true', () => {
    const r = parse(langGrammar.Body, 'return;')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const stmts = r.value.children.filter(c => c._tag === 'node' && (c as CSTNode).type === 'Stmt') as CSTNode[]
    const ret = stmts.flatMap(s => s.children).find(c => c._tag === 'node' && (c as CSTNode).type === 'Return') as CSTNode | undefined
    expect(ret).toBeDefined()
    expect((ret!.state as { inFn?: boolean })?.inFn).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Custom AST + parseDoc
// ---------------------------------------------------------------------------
describe('node() — custom AST via build callback', () => {
  type MyNode = {
    _tag: 'node'
    type: string
    span: Span
    state: unknown
    children: ReadonlyArray<{ _tag: string }>
    text: string
  }

  const { Num } = rules(() => {
    const Num = node('Num', digits, (ch, _fields, span, _r, _tl, state) => ({
      _tag: 'node',
      type: 'Num',
      span,
      children: ch as MyNode['children'],
      state,
      text: `[Num:${span.start}-${span.end}]`,
    }))
    return { Num }
  })

  const registry = {
    Num: (input: string, pos: number, ctx: Parameters<typeof Num.parse>[2]) =>
      Num.parse(input, pos, ctx) as import('../../src/index.ts').ParseResult<MyNode>,
  } satisfies import('../../src/index.ts').Registry<MyNode>

  it('returns custom node shape', () => {
    const r = parse(Num, '42')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value._tag).toBe('node')
    expect(r.value.type).toBe('Num')
    expect((r.value as MyNode).text).toBe('[Num:0-2]')
  })

  it('parseDoc edit works with custom AST', () => {
    const doc = parseDoc<MyNode>(registry, 'Num', '42')
    expect(doc.tree).not.toBeNull()
    expect(doc.tree!.text).toBe('[Num:0-2]')

    const doc2 = doc.edit(0, 2, '999')
    expect(doc2.tree).not.toBeNull()
    expect(doc2.tree!.text).toBe('[Num:0-3]')
  })
})

// ---------------------------------------------------------------------------
// CSS-style scanner (integration over scanTo/balanced — details in scan-to.test.ts)
// ---------------------------------------------------------------------------
describe('node() — CSS-style scanner', () => {
  const cssGrammar = rules(g => {
    const lineComment = sequence(literal('//'), scanTo(literal('\n'), { orEOF: true }))
    const blockComment = sequence(literal('/*'), scanTo(literal('*/'), { orEOF: false }), literal('*/'))
    const dqString = sequence(literal('"'), scanTo(literal('"'), { orEOF: false }), literal('"'))
    const sqString = sequence(literal("'"), scanTo(literal("'"), { orEOF: false }), literal("'"))
    const comment = choice(blockComment, lineComment)
    const string = choice(dqString, sqString)
    const parenGroup = balanced('(', ')', { skip: [string, comment] })
    const bracketGroup = balanced('[', ']', { skip: [string] })
    const Property = regex(/[a-z-]+/)
    const Selector = node('Selector', scanTo(literal('{'), {
      skip: [comment, string, parenGroup, bracketGroup],
    }), (ch, _fields, span, _r, _tl, state) => mkCst('Selector', ch as CSTNode['children'], span, state))
    const Value = node('Value', scanTo(choice(literal(';'), literal('}')), {
      skip: [string, parenGroup],
    }), (ch, _fields, span, _r, _tl, state) => mkCst('Value', ch as CSTNode['children'], span, state))
    const Declaration = node(
      'Declaration',
      sequence(g.Property, regex(/\s*/), literal(':'), regex(/\s*/), g.Value, optional(literal(';'))),
      (ch, _fields, span, _r, _tl, state) => mkCst('Declaration', ch as CSTNode['children'], span, state),
    )
    const Rule = node(
      'Rule',
      sequence(g.Selector, literal('{'), regex(/\s*/), many(sequence(g.Declaration, regex(/\s*/))), literal('}')),
      (ch, _fields, span, _r, _tl, state) => mkCst('Rule', ch as CSTNode['children'], span, state),
    )
    return { Selector, Value, Declaration, Rule, Property }
  })

  it('Selector scan stops before the opening brace', () => {
    const r = parse(cssGrammar.Selector, '.foo{')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.span.end).toBe(4)
  })

  it('Selector skips brackets containing {', () => {
    const r = parse(cssGrammar.Selector, 'div[attr="{"] {')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.span.end).toBe(14)
  })

  it('Rule parses a full CSS rule', () => {
    const r = parse(cssGrammar.Rule, '.foo{color:red;}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.type).toBe('Rule')
  })
})

// ---------------------------------------------------------------------------
// rawChildren / triviaLog
// ---------------------------------------------------------------------------
describe('node() — rawChildren/triviaLog', () => {
  type RichNode = {
    _tag: 'node'
    type: string
    span: Span
    state: unknown
    children: Array<CSTNode | CSTLeaf | CSTError>
    rawChildren: CSTRawChild[]
    triviaLog: readonly number[]
  }
  type CSTChild = CSTNode | CSTLeaf | CSTError

  function mkRich(
    type: string,
    children: ReadonlyArray<CSTChild>,
    rawChildren: ReadonlyArray<CSTRawChild>,
    span: Span,
    triviaLog: readonly number[],
    state: unknown,
  ): RichNode {
    return { _tag: 'node', type, span, state, children: [...children], rawChildren: [...rawChildren], triviaLog }
  }

  const identRe = regex(/[a-zA-Z][a-zA-Z0-9-]*/)
  const { Ident, Selectors } = rules(g => {
    const Ident = node('Ident', identRe, (ch, _fields, span, raw, tl, state) =>
      mkRich('Ident', ch as CSTChild[], raw as CSTRawChild[], span, tl, state))
    const Selectors = node('Selectors', sequence(g.Ident, g.Ident), (ch, _fields, span, raw, tl, state) =>
      mkRich('Selectors', ch as CSTChild[], raw as CSTRawChild[], span, tl, state))
    return { Ident, Selectors }
  })

  const ws = regex(/\s+/)

  it('children never contains trivia; triviaLog holds trivia spans', () => {
    const r = parser({ trivia: ws, captureTrivia: true }, Selectors).parse('div p')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.children.every(c => (c as { _tag: string })._tag !== 'trivia')).toBe(true)
    expect(r.value.triviaLog.length).toBe(3)
    const [start, end] = r.value.triviaLog
    expect('div p'.slice(start, end)).toBe(' ')
  })

  it('rawChildren has structural nodes only; triviaLog encodes position', () => {
    const r = parser({ trivia: ws, captureTrivia: true }, Selectors).parse('foo   bar')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.rawChildren.length).toBe(2)
    expect(r.value.rawChildren[0]!._tag).toBe('node')
    expect(r.value.rawChildren[1]!._tag).toBe('node')
    expect(r.value.triviaLog).toEqual([3, 6, 1])
    expect('foo   bar'.slice(r.value.triviaLog[0]!, r.value.triviaLog[1]!)).toBe('   ')
  })

  it('triviaLog is empty when terms are adjacent (no whitespace)', () => {
    const { Pair } = rules(() => {
      const Pair = node(
        'Pair',
        sequence(regex(/[a-zA-Z]+/), literal(':'), regex(/[a-zA-Z]+/)),
        (ch, _fields, span, raw, tl, state) => mkRich('Pair', ch as CSTChild[], raw as CSTRawChild[], span, tl, state),
      )
      return { Pair }
    })
    const r = parser({ trivia: ws }, Pair).parse('color:red')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.triviaLog.length).toBe(0)
  })
})
