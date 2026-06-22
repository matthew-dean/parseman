/**
 * Parser — class-based grammar with automatic CST construction.
 *
 * Rules with cross-references use the thunk form:
 *   Expr = (g: Refs<this>) => choice(g.Atom, sequence(g.Expr, literal('+')))
 *
 * Rules with no cross-references can be plain property initializers:
 *   digits = regex(/[0-9]+/)
 */
import { describe, it, expect } from 'vitest'
import {
  literal, regex, sequence, choice, many, optional, sepBy,
  parse, scanTo, balanced, guard, withCtx,
} from '../../src/index.ts'
import { Parser, IncrementalParser } from '../../src/index.ts'
import type { Refs } from '../../src/index.ts'
import type { CSTNode, CSTLeaf, CSTError, CSTTrivia, CSTRawChild } from '../../src/index.ts'
import type { Span } from '../../src/index.ts'

// ---------------------------------------------------------------------------
// A minimal expression grammar used across tests.
// ---------------------------------------------------------------------------
class ExprGrammar extends Parser {
  ws     = regex(/\s*/)
  digits = regex(/[0-9]+/)
  ident  = regex(/[a-zA-Z_]\w*/)

  Number = (g: Refs<ExprGrammar>) => g.digits
  Ident  = (g: Refs<ExprGrammar>) => g.ident
  Add    = (g: Refs<ExprGrammar>) => sequence(g.Number, many(sequence(literal('+'), g.Number)))
  Expr   = (g: Refs<ExprGrammar>) => choice(g.Add, g.Number, g.Ident)
}

function expr() { return new ExprGrammar() }

// ---------------------------------------------------------------------------
// Basic CST construction
// ---------------------------------------------------------------------------
describe('Parser — basic CST', () => {
  it('capital rule produces a CSTNode', () => {
    const g = expr()
    const r = parse(g.rule('Number'), '42')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value._tag).toBe('node')
    expect(r.value.type).toBe('Number')
    expect(r.value.span).toEqual({ start: 0, end: 2 })
  })

  it('CSTNode span is correct for Ident', () => {
    const g = expr()
    const r = parse(g.rule('Ident'), 'foo')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.span).toEqual({ start: 0, end: 3 })
  })

  it('lowercase helper terminals appear as CSTLeaf in parent children', () => {
    const g = expr()
    const r = parse(g.rule('Number'), '123')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const leaf = r.value.children.find(c => c._tag === 'leaf') as CSTLeaf | undefined
    expect(leaf).toBeDefined()
    expect(leaf!.value).toBe('123')
  })

  it('nested capital rules appear as CSTNode children', () => {
    const g = expr()
    const r = parse(g.rule('Add'), '1+2')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const nodeChildren = r.value.children.filter(c => c._tag === 'node') as CSTNode[]
    expect(nodeChildren.length).toBeGreaterThanOrEqual(2)
    expect(nodeChildren[0]!.type).toBe('Number')
    expect(nodeChildren[1]!.type).toBe('Number')
  })

  it('children appear in parse order — nodes and leaves interleaved', () => {
    const g = expr()
    const r = parse(g.rule('Add'), '1+2')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const tags = r.value.children.map(c => c._tag)
    expect(tags).toContain('node')
    expect(tags).toContain('leaf')
    const leaves = r.value.children.filter(c => c._tag === 'leaf') as CSTLeaf[]
    expect(leaves.some(l => l.value === '+')).toBe(true)
  })

  it('failed parse returns ok:false, no CSTNode', () => {
    const g = expr()
    const r = parse(g.rule('Number'), 'abc')
    expect(r.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// savedContext
// ---------------------------------------------------------------------------
describe('Parser — savedContext', () => {
  it('savedContext is undefined when no user context is set', () => {
    const g = expr()
    const r = parse(g.rule('Number'), '1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.savedContext).toBeUndefined()
  })

  it('savedContext records ctx.user at parse entry', () => {
    const g = expr()
    const p = withCtx({ mode: 'strict' }, g.rule('Number'))
    const r = parse(p, '99')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.value as CSTNode).savedContext).toEqual({ mode: 'strict' })
  })

  it('savedContext is a shallow clone — original mutations do not propagate', () => {
    const g = expr()
    const userCtx = { count: 0 }
    const p = withCtx(userCtx, g.rule('Number'))
    const r = parse(p, '7')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const saved = (r.value as CSTNode).savedContext as { count: number }
    expect(saved.count).toBe(0)
    userCtx.count = 999
    expect(saved.count).toBe(0)
  })

  it('nested rules each record their own savedContext', () => {
    const g = expr()
    const p = withCtx({ phase: 'test' }, g.rule('Add'))
    const r = parse(p, '1+2')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const addCtx = r.value.savedContext as { phase: string }
    expect(addCtx.phase).toBe('test')
    const numChildren = r.value.children.filter(c => c._tag === 'node') as CSTNode[]
    expect(numChildren[0]!.savedContext).toEqual({ phase: 'test' })
  })
})

// ---------------------------------------------------------------------------
// Mutual recursion
// ---------------------------------------------------------------------------
describe('Parser — mutual recursion', () => {
  class ListGrammar extends Parser {
    sep   = literal(',')
    Item  = regex(/[a-z]+/)
    items = (g: Refs<ListGrammar>) => sepBy(g.Item, g.sep)
    List  = (g: Refs<ListGrammar>) => sequence(literal('['), g.items, literal(']'))
  }

  it('compiles recursive rules without stack overflow', () => {
    const g = new ListGrammar()
    const r = parse(g.rule('List'), '[foo,bar,baz]')
    expect(r.ok).toBe(true)
  })

  it('Item children appear directly in List (via transparent items helper)', () => {
    const g = new ListGrammar()
    const r = parse(g.rule('List'), '[a,b]')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const items = r.value.children.filter(c => c._tag === 'node' && (c as CSTNode).type === 'Item') as CSTNode[]
    expect(items.length).toBe(2)
    expect(items[0]!.span.start).toBeLessThan(items[1]!.span.start)
  })

  it('delimiters appear as leaves alongside Item nodes', () => {
    const g = new ListGrammar()
    const r = parse(g.rule('List'), '[x,y]')
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
describe('Parser — context-sensitive rules', () => {
  class LangGrammar extends Parser {
    Return = (g: Refs<LangGrammar>) => sequence(
      guard((u: unknown) => (u as { inFn?: boolean } | undefined)?.inFn === true),
      literal('return'),
    )
    Expr = regex(/[a-z]+/)
    Stmt = (g: Refs<LangGrammar>) => choice(g.Return, g.Expr)
    Body = (g: Refs<LangGrammar>) => withCtx({ inFn: true }, many(sequence(g.Stmt, literal(';'))))
  }

  it('Return fails without inFn context', () => {
    const g = new LangGrammar()
    const r = parse(g.rule('Return'), 'return')
    expect(r.ok).toBe(false)
  })

  it('Return succeeds when inFn context is set', () => {
    const g = new LangGrammar()
    const p = withCtx({ inFn: true }, g.rule('Return'))
    const r = parse(p, 'return')
    expect(r.ok).toBe(true)
  })

  it('Body enables Return for its contents', () => {
    const g = new LangGrammar()
    const r = parse(g.rule('Body'), 'return;')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const stmts = r.value.children.filter(c => c._tag === 'node' && (c as CSTNode).type === 'Stmt') as CSTNode[]
    expect(stmts.length).toBeGreaterThan(0)
    const hasReturn = stmts.some(s => s.children.some(c => c._tag === 'node' && (c as CSTNode).type === 'Return'))
    expect(hasReturn).toBe(true)
  })

  it('savedContext on nested Return records inFn:true', () => {
    const g = new LangGrammar()
    const r = parse(g.rule('Body'), 'return;')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const stmts = r.value.children.filter(c => c._tag === 'node' && (c as CSTNode).type === 'Stmt') as CSTNode[]
    const ret = stmts.flatMap(s => s.children).find(c => c._tag === 'node' && (c as CSTNode).type === 'Return') as CSTNode | undefined
    expect(ret).toBeDefined()
    expect((ret!.savedContext as { inFn?: boolean })?.inFn).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Custom AST via buildNode() override
// ---------------------------------------------------------------------------
describe('Parser — custom AST via buildNode()', () => {
  type MyNode = {
    _tag: 'node'
    type: string
    span: Span
    savedContext: unknown
    children: ReadonlyArray<{ _tag: string }>
    text: string
  }

  class MyGrammar extends IncrementalParser<MyNode> {
    constructor() { super('Num') }

    protected override buildNode(
      type: string,
      span: Span,
      children: ReadonlyArray<MyNode | CSTLeaf | CSTError>,
      savedContext: unknown,
    ): MyNode {
      return { _tag: 'node', type, span, children, savedContext, text: `[${type}:${span.start}-${span.end}]` }
    }

    digits = regex(/[0-9]+/)
    Num    = (g: Refs<MyGrammar>) => g.digits
  }

  it('rule() returns Combinator<MyNode>', () => {
    const g = new MyGrammar()
    const r = parse(g.rule('Num'), '42')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value._tag).toBe('node')
    expect(r.value.type).toBe('Num')
    expect((r.value as MyNode).text).toBe('[Num:0-2]')
  })

  it('IncrementalParser works with custom AST', () => {
    const ip = new MyGrammar()
    const tree = ip.parse('42')
    expect(tree).not.toBeNull()
    expect((tree as MyNode).text).toBe('[Num:0-2]')

    const tree2 = ip.edit('999', 0, 2)
    expect(tree2).not.toBeNull()
    expect((tree2 as MyNode).text).toBe('[Num:0-3]')
  })
})

// ---------------------------------------------------------------------------
// CSS-style scanner
// ---------------------------------------------------------------------------
describe('Parser — CSS-style scanner', () => {
  class CssGrammar extends Parser {
    ws           = regex(/\s*/)
    lineComment  = sequence(literal('//'), scanTo(literal('\n'), { orEOF: true }))
    blockComment = sequence(literal('/*'), scanTo(literal('*/'), { orEOF: false }), literal('*/'))
    dqString     = sequence(literal('"'), scanTo(literal('"'), { orEOF: false }), literal('"'))
    sqString     = sequence(literal("'"), scanTo(literal("'"), { orEOF: false }), literal("'"))

    comment      = (g: Refs<CssGrammar>) => choice(g.blockComment, g.lineComment)
    string       = (g: Refs<CssGrammar>) => choice(g.dqString, g.sqString)
    parenGroup   = (g: Refs<CssGrammar>) => balanced('(', ')', { skip: [g.string, g.comment] })
    bracketGroup = (g: Refs<CssGrammar>) => balanced('[', ']', { skip: [g.string] })

    Property = regex(/[a-z-]+/)

    Selector = (g: Refs<CssGrammar>) => scanTo(literal('{'), {
      skip: [g.comment, g.string, g.parenGroup, g.bracketGroup],
    })
    Value = (g: Refs<CssGrammar>) => scanTo(choice(literal(';'), literal('}')), {
      skip: [g.string, g.parenGroup],
    })
    Declaration = (g: Refs<CssGrammar>) => sequence(
      g.Property, g.ws, literal(':'), g.ws, g.Value, optional(literal(';')),
    )
    Rule = (g: Refs<CssGrammar>) => sequence(
      g.Selector, literal('{'), g.ws,
      many(sequence(g.Declaration, g.ws)),
      literal('}'),
    )
  }

  const css = new CssGrammar()

  it('Selector scan stops before the opening brace', () => {
    const r = parse(css.rule('Selector'), '.foo{')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.span.end).toBe(4)
  })

  it('Selector skips brackets containing {', () => {
    const r = parse(css.rule('Selector'), 'div[attr="{"] {')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.span.end).toBe(14)
  })

  it('Selector skips block comments containing {', () => {
    const r = parse(css.rule('Selector'), '.a /* { */ .b {')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.span.end).toBe(14)
  })

  it('Rule parses a full CSS rule', () => {
    const r = parse(css.rule('Rule'), '.foo{color:red;}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.type).toBe('Rule')
  })

  it('Rule node has Selector and Declaration children', () => {
    const r = parse(css.rule('Rule'), '.foo{color:red;}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const childTypes = r.value.children
      .filter(c => c._tag === 'node')
      .map(c => (c as CSTNode).type)
    expect(childTypes).toContain('Selector')
    expect(childTypes).toContain('Declaration')
  })

  it('Rule with multiple declarations', () => {
    const r = parse(css.rule('Rule'), 'div{color:red;background:blue;}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const decls = r.value.children.filter(c => c._tag === 'node' && (c as CSTNode).type === 'Declaration')
    expect(decls.length).toBe(2)
  })

  it('Rule handles url() values without confusing the sentinel', () => {
    const r = parse(css.rule('Rule'), 'div{background:url("http://x.com/a;b");}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const decls = r.value.children.filter(c => c._tag === 'node' && (c as CSTNode).type === 'Declaration')
    expect(decls.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// rawChildren — trivia visibility in buildNode
// ---------------------------------------------------------------------------
describe('Parser — rawChildren in buildNode', () => {
  type RichNode = { _tag: 'node'; type: string; span: Span; savedContext: unknown; children: CSTChild[]; rawChildren: CSTRawChild[] }
  type CSTChild = CSTNode | CSTLeaf | CSTError

  class SelectorParser extends Parser<RichNode> {
    ident = regex(/[a-zA-Z][a-zA-Z0-9-]*/)

    // No explicit ws — whitespace handled by global trivia
    Ident     = (g: Refs<SelectorParser>) => g.ident
    Selectors = (g: Refs<SelectorParser>) => sequence(g.Ident, g.Ident)

    protected buildNode(type: string, span: Span, children: ReadonlyArray<RichNode | CSTLeaf | CSTError>, savedContext: unknown, rawChildren: ReadonlyArray<CSTRawChild>): RichNode {
      return { _tag: 'node', type, span, savedContext, children: children as CSTChild[], rawChildren: [...rawChildren] }
    }
  }

  const ws = regex(/\s+/)
  const g  = new SelectorParser()

  it('children never contains trivia, rawChildren does', () => {
    // Parse with global trivia so the whitespace is auto-skipped between Ident Ident
    const r = parse(g.rule('Selectors'), 'div p', { trivia: ws })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.children.every(c => c._tag !== 'trivia')).toBe(true)
    const trivia = r.value.rawChildren.filter((c): c is CSTTrivia => c._tag === 'trivia')
    expect(trivia.length).toBe(1)
    expect(trivia[0]!.value).toBe(' ')
  })

  it('rawChildren has trivia interleaved between structural nodes', () => {
    const r = parse(g.rule('Selectors'), 'foo   bar', { trivia: ws })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // [Ident(foo), CSTTrivia("   "), Ident(bar)]
    expect(r.value.rawChildren[0]!._tag).toBe('node')
    expect(r.value.rawChildren[1]!._tag).toBe('trivia')
    expect((r.value.rawChildren[1] as CSTTrivia).value).toBe('   ')
    expect(r.value.rawChildren[2]!._tag).toBe('node')
  })

  it('no trivia node when terms are adjacent (no whitespace)', () => {
    class PairParser extends Parser<RichNode> {
      ident = regex(/[a-zA-Z]+/)
      Pair  = (g: Refs<PairParser>) => sequence(g.ident, literal(':'), g.ident)
      protected buildNode(type: string, span: Span, children: ReadonlyArray<RichNode | CSTLeaf | CSTError>, savedContext: unknown, rawChildren: ReadonlyArray<CSTRawChild>): RichNode {
        return { _tag: 'node', type, span, savedContext, children: children as CSTChild[], rawChildren: [...rawChildren] }
      }
    }
    const p = new PairParser()
    const r = parse(p.rule('Pair'), 'color:red', { trivia: ws })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const triviaNodes = r.value.rawChildren.filter(c => c._tag === 'trivia')
    expect(triviaNodes.length).toBe(0)
  })
})
