/**
 * createVisitor() — grammar-aware CST traversal.
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import {
  choice,
  compose,
  createVisitor,
  cstBuildHost,
  literal,
  node,
  parse,
  regex,
  rules,
  run,
  sequence,
} from '../../src/index.ts'
import type { CSTChild, CSTLeaf, CSTNode, Span } from '../../src/index.ts'

const sp = (start: number, end: number): Span => ({ start, end })
const leaf = (value: string, span: Span = sp(0, 0)): CSTLeaf => ({ _tag: 'leaf', value, span })
const cnode = (type: string, children: CSTChild[], span: Span = sp(0, 0)): CSTNode =>
  ({ _tag: 'node', type, span, state: null, children })

const toyGrammar = rules(g => ({
  Root: node('Root', choice(g.AtRuleWithBlock, g.Declaration), { tags: ['DocumentPart'] }),
  AtRuleWithBlock: node('AtRuleWithBlock', sequence(literal('@media'), literal('{'), literal('}')), {
    tags: ['AtRule', 'Statement'],
  }),
  Declaration: node('Declaration', sequence(regex(/[a-z]+/), literal(':'), regex(/[0-9]+/)), {
    tags: ['Statement'],
  }),
}))

describe('createVisitor(grammar, spec)', () => {
  it('type-checks concrete node types and declared tags from the grammar', () => {
    createVisitor(toyGrammar, {
      type: {
        AtRuleWithBlock(node) {
          expectTypeOf(node.type).toEqualTypeOf<'AtRuleWithBlock'>()
        },
      },
      tag: {
        AtRule(node) {
          expectTypeOf(node.type).toMatchTypeOf<'Root' | 'AtRuleWithBlock' | 'Declaration'>()
        },
      },
    })

    createVisitor(toyGrammar, {
      type: {
        // @ts-expect-error UnknownRule is not a CST node type in this grammar.
        UnknownRule() {},
      },
      tag: {},
    })

    createVisitor(toyGrammar, {
      tag: {
        // @ts-expect-error UnknownTag is not declared by any node in this grammar.
        UnknownTag() {},
      },
    })
  })

  it('dispatches by concrete CST node type and walks children', () => {
    const root = cnode('Root', [
      cnode('Declaration', [leaf('color'), leaf(':'), leaf('1')]),
      cnode('AtRuleWithBlock', [leaf('@media'), leaf('{'), leaf('}')]),
    ])
    const seen: string[] = []
    const visit = createVisitor(toyGrammar, {
      type: {
        Root(node) { seen.push(`type:${node.type}`) },
        Declaration(node) { seen.push(`type:${node.type}`) },
        AtRuleWithBlock(node) { seen.push(`type:${node.type}`) },
      },
    })

    visit(root)

    expect(seen).toEqual(['type:Root', 'type:Declaration', 'type:AtRuleWithBlock'])
  })

  it('dispatches by tags without copying tags onto CST nodes', () => {
    const root = cnode('Root', [
      cnode('AtRuleWithBlock', [leaf('@media'), leaf('{'), leaf('}')]),
    ])
    const seen: string[] = []
    const visit = createVisitor(toyGrammar, {
      tag: {
        AtRule(node) { seen.push(`tag:AtRule:${node.type}`) },
        Statement(node) { seen.push(`tag:Statement:${node.type}`) },
      },
    })

    visit(root)

    expect(seen).toEqual(['tag:AtRule:AtRuleWithBlock', 'tag:Statement:AtRuleWithBlock'])
    expect('tags' in root.children[0]!).toBe(false)
  })

  it('runs enter before handlers, leave after children, and can prune descent', () => {
    const root = cnode('Root', [
      cnode('Declaration', [leaf('color'), leaf(':'), leaf('1')]),
    ])
    const order: string[] = []
    const visit = createVisitor(toyGrammar, {
      enter(node) {
        order.push(`enter:${node._tag === 'node' ? node.type : node._tag}`)
        if (node._tag === 'node' && node.type === 'Declaration') return false
      },
      type: {
        Declaration() { order.push('type:Declaration') },
      },
      leave(node) {
        order.push(`leave:${node._tag === 'node' ? node.type : node._tag}`)
      },
    })

    visit(root)

    expect(order).toEqual([
      'enter:Root',
      'enter:Declaration',
      'type:Declaration',
      'leave:Declaration',
      'leave:Root',
    ])
  })

  it('visits a parsed interpreted CST', () => {
    const result = parse(toyGrammar.Declaration, 'color:1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const seen: string[] = []
    createVisitor(toyGrammar, {
      type: {
        Declaration(node) { seen.push(node.type) },
      },
      tag: {
        Statement(node) { seen.push(`statement:${node.type}`) },
      },
    })(result.value as CSTChild)

    expect(seen).toEqual(['Declaration', 'statement:Declaration'])
  })

  it('uses the same reflection on a composed compiled grammar', () => {
    const compiled = compose([toyGrammar], { hostMode: 'cst' })
    const parsed = run(compiled.AtRuleWithBlock!, '@media{}', { build: cstBuildHost() })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const seen: string[] = []
    createVisitor(compiled, {
      tag: {
        AtRule(node) { seen.push(`at:${node.type}`) },
        Statement(node) { seen.push(`stmt:${node.type}`) },
      },
    })(parsed.value as CSTChild)

    expect(seen).toEqual(['at:AtRuleWithBlock', 'stmt:AtRuleWithBlock'])
  })
})
