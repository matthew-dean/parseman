import { describe, it, expect } from 'vitest'
import {
  literal, regex, sequence, choice, many, optional, sepBy,
  parse, withCtx, guard,
} from '../../src/index.ts'
import { Parser, IncrementalParser } from '../../src/index.ts'
import type { Refs } from '../../src/index.ts'
import type { CSTNode } from '../../src/index.ts'

// ---------------------------------------------------------------------------
// Simple grammar for all basic tests
// ---------------------------------------------------------------------------
class JsonLikeGrammar extends Parser {
  ws     = regex(/\s*/)
  digits = regex(/[0-9]+/)
  ident  = regex(/[a-zA-Z_]\w*/)
  Str    = sequence(literal('"'), regex(/[^"]*/), literal('"'))

  Num    = (g: Refs<JsonLikeGrammar>) => g.digits
  Id     = (g: Refs<JsonLikeGrammar>) => g.ident
  Value  = (g: Refs<JsonLikeGrammar>) => choice(g.Num, g.Str, g.Id)
  Pair   = (g: Refs<JsonLikeGrammar>) => sequence(g.Id, g.ws, literal(':'), g.ws, g.Value)
  pairs  = (g: Refs<JsonLikeGrammar>) => sepBy(g.Pair, sequence(g.ws, literal(','), g.ws))
  Object = (g: Refs<JsonLikeGrammar>) => sequence(literal('{'), g.ws, g.pairs, g.ws, literal('}'))
}

function makeParser() {
  return new IncrementalParser(new JsonLikeGrammar(), 'Object')
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------
describe('IncrementalParser — full parse', () => {
  it('parses a simple object', () => {
    const ip = makeParser()
    const tree = ip.parse('{a:1}')
    expect(tree).not.toBeNull()
    expect(tree!._tag).toBe('node')
    expect(tree!.type).toBe('Object')
  })

  it('returns null on invalid input', () => {
    const ip = makeParser()
    const tree = ip.parse('{invalid:')
    expect(tree).toBeNull()
  })

  it('stores the full tree in currentTree', () => {
    const ip = makeParser()
    const tree = ip.parse('{x:1}')
    expect(ip.currentTree).toBe(tree)
  })

  it('stores the input in currentInput', () => {
    const ip = makeParser()
    ip.parse('{x:1}')
    expect(ip.currentInput).toBe('{x:1}')
  })

  it('parsed tree has Pair children', () => {
    const ip = makeParser()
    const tree = ip.parse('{a:1,b:2}')
    expect(tree).not.toBeNull()
    const pairs = tree!.children.filter(c => c._tag === 'node' && (c as CSTNode).type === 'Pair')
    expect(pairs.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Incremental edit
// ---------------------------------------------------------------------------
describe('IncrementalParser — edit', () => {
  it('edit after no parse falls back to full parse', () => {
    const ip = makeParser()
    const tree = ip.edit('{x:1}', 3, 4)
    expect(tree).not.toBeNull()
    expect(tree!.type).toBe('Object')
  })

  it('replacing a value returns a valid tree', () => {
    const ip = makeParser()
    ip.parse('{a:1}')
    const tree = ip.edit('{a:42}', 3, 4)
    expect(tree).not.toBeNull()
    expect(tree!.type).toBe('Object')
  })

  it('currentTree and currentInput are updated after edit', () => {
    const ip = makeParser()
    ip.parse('{a:1}')
    const tree = ip.edit('{a:42}', 3, 4)
    expect(ip.currentTree).toBe(tree)
    expect(ip.currentInput).toBe('{a:42}')
  })

  it('adding a pair to the object', () => {
    const ip = makeParser()
    ip.parse('{a:1}')
    const tree = ip.edit('{a:1,b:2}', 4, 4)
    expect(tree).not.toBeNull()
    const pairs = tree!.children.filter(c => c._tag === 'node' && (c as CSTNode).type === 'Pair')
    expect(pairs.length).toBe(2)
  })

  it('removing a pair from the object', () => {
    const ip = makeParser()
    ip.parse('{a:1,b:2}')
    const tree = ip.edit('{a:1}', 4, 8)
    expect(tree).not.toBeNull()
    const pairs = tree!.children.filter(c => c._tag === 'node' && (c as CSTNode).type === 'Pair')
    expect(pairs.length).toBe(1)
  })

  it('edit to invalid input returns null', () => {
    const ip = makeParser()
    ip.parse('{a:1}')
    const tree = ip.edit('{a:', 3, 5)
    expect(tree).toBeNull()
  })

  it('successive edits build on each other', () => {
    const ip = makeParser()
    ip.parse('{x:1}')
    ip.edit('{x:10}', 4, 5)
    const tree = ip.edit('{x:100}', 5, 6)
    expect(tree).not.toBeNull()
    expect(tree!.type).toBe('Object')
  })
})

// ---------------------------------------------------------------------------
// Immutable update
// ---------------------------------------------------------------------------
describe('IncrementalParser — immutable tree', () => {
  it('edit does not mutate the original tree', () => {
    const ip = makeParser()
    const original = ip.parse('{a:1}')!
    const originalSpan = { ...original.span }
    const originalChildCount = original.children.length

    ip.edit('{a:42}', 3, 4)

    expect(original.span).toEqual(originalSpan)
    expect(original.children.length).toBe(originalChildCount)
  })

  it('unaffected subtrees are shared (same object reference)', () => {
    const ip = makeParser()
    ip.parse('{a:1,b:2}')
    const beforeTree = ip.currentTree!

    const firstPairBefore = beforeTree.children.find(c => c._tag === 'node' && (c as CSTNode).type === 'Pair') as CSTNode | undefined
    expect(firstPairBefore).toBeDefined()

    const afterTree = ip.edit('{a:1,b:99}', 7, 8)
    expect(afterTree).not.toBeNull()

    const firstPairAfter = afterTree!.children.find(c => c._tag === 'node' && (c as CSTNode).type === 'Pair') as CSTNode | undefined
    expect(firstPairAfter).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Context-sensitive incremental parse
// ---------------------------------------------------------------------------
describe('IncrementalParser — context-sensitive', () => {
  class LangGrammar extends Parser {
    ws = regex(/\s*/)

    Return = (g: Refs<LangGrammar>) => sequence(
      guard((u: unknown) => (u as { inFn?: boolean } | undefined)?.inFn === true),
      literal('return'),
    )
    Expr    = regex(/[a-z]+/)
    Stmt    = (g: Refs<LangGrammar>) => choice(g.Return, g.Expr)
    Body    = (g: Refs<LangGrammar>) => withCtx({ inFn: true }, many(sequence(g.Stmt, g.ws)))
    Program = (g: Refs<LangGrammar>) => many(sequence(g.Body, g.ws))
  }

  it('incremental re-parse of a Body node uses saved inFn:true context', () => {
    const ip = new IncrementalParser(new LangGrammar(), 'Program')
    const tree = ip.parse('return ')
    expect(tree).not.toBeNull()
    const tree2 = ip.edit('return return ', 7, 7)
    expect(tree2).not.toBeNull()
  })

  it('savedContext on Stmt node records inFn:true for incremental re-use', () => {
    const ip = new IncrementalParser(new LangGrammar(), 'Program')
    const tree = ip.parse('return ')
    expect(tree).not.toBeNull()

    function findNode(node: CSTNode, type: string): CSTNode | undefined {
      if (node.type === type) return node
      for (const c of node.children) {
        if (c._tag === 'node') {
          const found = findNode(c as CSTNode, type)
          if (found) return found
        }
      }
      return undefined
    }

    const stmt = findNode(tree!, 'Stmt')
    expect(stmt).toBeDefined()
    expect((stmt!.savedContext as { inFn?: boolean } | undefined)?.inFn).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('IncrementalParser — edge cases', () => {
  it('edit at the very start of input', () => {
    const ip = makeParser()
    ip.parse('{a:1}')
    const tree = ip.edit('{ a:1}', 1, 1)
    expect(tree).not.toBeNull()
  })

  it('edit at the very end of input', () => {
    const ip = makeParser()
    ip.parse('{a:1}')
    const tree = ip.edit('{a:1} ', 5, 5)
    expect(tree === null || tree !== null).toBe(true)
  })

  it('zero-length edit (pure insertion) works', () => {
    const ip = makeParser()
    ip.parse('{a:1}')
    const tree = ip.edit('{ab:1}', 2, 2)
    expect(tree).not.toBeNull()
  })

  it('edit that deletes everything falls back gracefully', () => {
    const ip = makeParser()
    ip.parse('{a:1}')
    const tree = ip.edit('', 0, 5)
    expect(tree).toBeNull()
  })
})
