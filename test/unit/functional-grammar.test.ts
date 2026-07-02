/**
 * Functional-grammar proof — rules() + node()/transform() with macro compilation.
 *
 * A grammar authored as a `rules()` factory where each node-rule is a
 * `transform()` that builds a NodeLike AST node directly — no class, no
 * buildNode/CST runtime. This validates the three things the functional
 * approach must deliver to retire the class:
 *
 *   1. AST construction inside transform() callbacks, with correct spans.
 *   2. Byte-identical output between the interpreter and the macro-compiled
 *      build (the same grammar source run both ways).
 *   3. Incremental re-parse via makeFunctionalDoc, driven by the rules() map as
 *      a rule registry.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import {
  literal, regex, sequence, optional, sepBy, transform, rules, parse, parser, trivia, node, oneOrMore, choice,
  makeFunctionalDoc,
} from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import type { Combinator, ParseContext, ParseResult } from '../../src/index.ts'
import type { NodeLike } from '../../src/index.ts'

// ---------------------------------------------------------------------------
// Node shape + builder (shared by interpreter and macro modes)
// ---------------------------------------------------------------------------

type Node = NodeLike & { children: Node[]; [k: string]: unknown }

/** Build a NodeLike AST node. Plain object so interpreter and macro match exactly. */
function mkNode(type: string, span: { start: number; end: number }, children: Node[], fields: Record<string, unknown>): Node {
  return { _tag: 'node', type, span: { start: span.start, end: span.end }, state: null, children, ...fields } as Node
}

// ---------------------------------------------------------------------------
// Interpreter grammar — the same source the macro string below compiles.
// Grammar (whitespace-free to keep the macro dependency-free):
//   Object = '{' (Pair (',' Pair)*)? '}'
//   Pair   = ident ':' Value
//   Value  = digits
// ---------------------------------------------------------------------------

const ident  = regex(/[a-z]+/)
const digits = regex(/[0-9]+/)

const interp = rules<{ Object: Combinator<Node>; Pair: Combinator<Node>; Value: Combinator<Node> }>(g => {
  const Value = transform(digits, (s, span) => mkNode('Value', span, [], { text: s }))
  const Pair  = transform(
    sequence(ident, literal(':'), g.Value),
    ([name, , value], span) => mkNode('Pair', span, [value as Node], { name })
  )
  const Object = transform(
    sequence(literal('{'), optional(sepBy(g.Pair, literal(','))), literal('}')),
    ([, pairs], span) => mkNode('Object', span, (pairs as Node[] | null) ?? [], {})
  )
  return { Object, Pair, Value }
})

// ---------------------------------------------------------------------------
// Macro mode — compile the identical grammar via the plugin and eval it.
// ---------------------------------------------------------------------------

const MACRO_CODE = `
import { literal, regex, sequence, optional, sepBy, transform, rules } from 'parseman' with { type: 'macro' }

const ident  = regex(/[a-z]+/)
const digits = regex(/[0-9]+/)

const { Object, Pair, Value } = rules(g => {
  const Value = transform(digits, (s, span) => mkNode('Value', span, [], { text: s }))
  const Pair  = transform(
    sequence(ident, literal(':'), g.Value),
    ([name, , value], span) => mkNode('Pair', span, [value], { name })
  )
  const Object = transform(
    sequence(literal('{'), optional(sepBy(g.Pair, literal(','))), literal('}')),
    ([, pairs], span) => mkNode('Object', span, pairs ?? [], {})
  )
  return { Object, Pair, Value }
})
`.trim()

type RuleFn = (input: string, pos: number, ctx: ParseContext) => ParseResult<Node>
let macroRegistry: Record<string, RuleFn>

beforeAll(() => {
  const result = transformMacro(MACRO_CODE, 'functional-grammar-test.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null — import not detected')
  if (result.code.includes("from 'parseman'")) {
    throw new Error('macro transform did not remove the import — compilation failed:\n' + result.code)
  }
  // Eval: const → var so new Function sees all names; return the rule map.
  const fnBody = result.code.replace(/\bconst\b/g, 'var') + '\nreturn { Object, Pair, Value }'
  macroRegistry = new Function('mkNode', fnBody)(mkNode) as Record<string, RuleFn>
})

// Adapt the interpreter combinators to the RuleFn shape so the same doc/parity
// helpers drive both modes.
const interpRegistry: Record<string, RuleFn> = {
  Object: (i, p, c) => interp.Object.parse(i, p, c),
  Pair: (i, p, c) => interp.Pair.parse(i, p, c),
  Value: (i, p, c) => interp.Value.parse(i, p, c),
}

// ---------------------------------------------------------------------------
// Parity: interpreter vs macro produce byte-identical ASTs (incl. spans)
// ---------------------------------------------------------------------------

const INPUTS = ['{a:1}', '{}', '{a:1,b:2}', '{abc:42,d:0}', '{x:1,y:2,z:3}']

describe('functional grammar — interpreter vs macro parity', () => {
  for (const input of INPUTS) {
    it(`identical AST for ${input}`, () => {
      const i = parse(interp.Object, input)
      const m = macroRegistry.Object!(input, 0, { trackLines: false })
      expect(i.ok).toBe(true)
      expect(m.ok).toBe(true)
      if (i.ok && m.ok) {
        expect(m.value).toEqual(i.value)
      }
    })
  }

  it('node spans are correct absolute offsets', () => {
    const r = macroRegistry.Object!('{ab:12}', 0, { trackLines: false })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const obj = r.value
    expect(obj.span).toEqual({ start: 0, end: 7 })
    const pair = obj.children[0]!
    expect(pair.type).toBe('Pair')
    expect(pair.name).toBe('ab')
    expect(pair.span).toEqual({ start: 1, end: 6 })
    const value = pair.children[0]!
    expect(value.type).toBe('Value')
    expect(value.text).toBe('12')
    expect(value.span).toEqual({ start: 4, end: 6 })
  })
})

// ---------------------------------------------------------------------------
// Incremental — run the SAME edit cases against both registries.
// ---------------------------------------------------------------------------

function pairsOf(tree: Node | null): Node[] {
  if (!tree) return []
  return (tree.children as Node[]).filter(c => c.type === 'Pair')
}

// ---------------------------------------------------------------------------
// Trivia: parser({ trivia }) bakes whitespace-skipping through the macro, and
// span gaps let a callback recover whitespace-sensitive structure (the
// functional answer to CSS descendant-vs-compound selectors).
// ---------------------------------------------------------------------------

const wsInterp = trivia(regex(/[ \t]+/))
const wordInterp = regex(/[a-z]+/)
const { Pair: interpPair } = rules<{ Pair: Combinator<Node> }>(g => {
  const Pair = parser({ trivia: wsInterp }, transform(
    sequence(wordInterp, literal(':'), wordInterp),
    ([a, , b], span) => mkNode('Pair', span, [], { a, b })
  ))
  return { Pair }
})

const TRIVIA_MACRO_CODE = `
import { literal, regex, sequence, transform, rules, parser, trivia } from 'parseman' with { type: 'macro' }
const ws = trivia(regex(/[ \\t]+/))
const word = regex(/[a-z]+/)
const { Pair } = rules(g => {
  const Pair = parser({ trivia: ws }, transform(
    sequence(word, literal(':'), word),
    ([a, , b], span) => mkNode('Pair', span, [], { a, b })
  ))
  return { Pair }
})
`.trim()

describe('functional grammar — trivia via parser() under the macro', () => {
  let triviaMacro: RuleFn

  beforeAll(() => {
    const result = transformMacro(TRIVIA_MACRO_CODE, 'trivia-test.ts', new Set(['parseman']))
    if (!result) throw new Error('macro transform returned null')
    if (result.code.includes("from 'parseman'")) {
      throw new Error('macro did not compile the trivia grammar:\n' + result.code)
    }
    const fnBody = result.code.replace(/\bconst\b/g, 'var') + '\nreturn Pair'
    triviaMacro = new Function('mkNode', fnBody)(mkNode) as RuleFn
  })

  for (const input of ['foo:bar', 'foo : bar', 'foo:  bar', 'foo\t:\tbar']) {
    it(`skips whitespace identically for ${JSON.stringify(input)}`, () => {
      const i = parse(interpPair, input)
      const m = triviaMacro(input, 0, { trackLines: false })
      expect(i.ok).toBe(true)
      expect(m.ok).toBe(true)
      if (i.ok && m.ok) expect(m.value).toEqual(i.value)
    })
  }

  it('macro mode actually skips the whitespace (a/b parsed across gaps)', () => {
    const m = triviaMacro('foo  :  bar', 0, { trackLines: false })
    expect(m.ok).toBe(true)
    if (m.ok) {
      expect(m.value.a).toBe('foo')
      expect(m.value.b).toBe('bar')
    }
  })
})

// ---------------------------------------------------------------------------
// node() — library-owned CST capture. Terminals and trivia are captured into
// children/rawChildren by parseman itself (no hand-wrapping/reconstruction),
// identically in the interpreter and the macro-compiled build.
// ---------------------------------------------------------------------------

describe('functional grammar — node() CST capture', () => {
  // Grammar: Pair = ident ':' Num ; with whitespace+comment trivia.
  const ws = trivia(oneOrMore(choice(regex(/[ \t\n]+/), regex(/\/\*(?:[^*]|\*(?!\/))*\*\//))))
  const summarize = (children: readonly any[], raw: readonly any[], _s: any, tlog: readonly number[]) => ({
    ch: children.map(c => c._tag === 'node' ? `<${c.type}>` : c.value),
    raw: raw.map(c => c._tag === 'node' ? `<${c.type}>` : (c as any).value),
    tlog: Array.from(tlog),
  })

  const { Pair: interpPair } = rules<{ Pair: Combinator<any> }>(g => {
    const Num = node('Num', regex(/[0-9]+/), (c, r, s, tl) => ({ _tag: 'node', type: 'Num', span: s, ...summarize(c, r, s, tl) }))
    const Pair = node('Pair', parser({ trivia: ws }, sequence(regex(/[a-z]+/), literal(':'), g.Num)),
      (c, r, s, tl) => ({ _tag: 'node', type: 'Pair', span: s, ...summarize(c, r, s, tl) }))
    return { Pair, Num }
  })

  const MACRO = `
import { node, regex, literal, sequence, parser, trivia, oneOrMore, choice, rules } from 'parseman' with { type: 'macro' }
const ws = trivia(oneOrMore(choice(regex(/[ \\t\\n]+/), regex(/\\/\\*(?:[^*]|\\*(?!\\/))*\\*\\//))))
const { Pair } = rules(g => {
  const Num = node('Num', regex(/[0-9]+/), (c, r, s, tl) => ({ _tag: 'node', type: 'Num', span: s, ...summarize(c, r, s, tl) }))
  const Pair = node('Pair', parser({ trivia: ws }, sequence(regex(/[a-z]+/), literal(':'), g.Num)),
    (c, r, s, tl) => ({ _tag: 'node', type: 'Pair', span: s, ...summarize(c, r, s, tl) }))
  return { Pair, Num }
})
`.trim()

  let macroPair: RuleFn
  beforeAll(() => {
    const result = transformMacro(MACRO, 'node-test.ts', new Set(['parseman']))
    if (!result) throw new Error('macro returned null')
    if (result.code.includes("from 'parseman'")) throw new Error('node() grammar not compiled:\n' + result.code)
    const fnBody = result.code.replace(/\bconst\b/g, 'var') + '\nreturn Pair'
    macroPair = new Function('summarize', fnBody)(summarize) as RuleFn
  })

  for (const input of ['a:1', 'a : 1', 'ab /*x*/ : /*y*/ 12', 'a:\t5']) {
    it(`captures children + trivia identically for ${JSON.stringify(input)}`, () => {
      const i = parse(interpPair, input)
      const m = macroPair(input, 0, { trackLines: false })
      expect(i.ok).toBe(true)
      expect(m.ok).toBe(true)
      if (i.ok && m.ok) expect(m.value).toEqual(i.value)
    })
  }

  it('sub-node appears in children; trivia in triviaLog (not rawChildren)', () => {
    const input = 'a /*c*/ : 1'
    const r = parse(interpPair, input)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // children: structural only — ident leaf, ':' leaf, <Num> sub-node
    expect(r.value.ch).toEqual(['a', ':', '<Num>'])
    // rawChildren: structural only (no trivia objects)
    expect(r.value.raw).toEqual(['a', ':', '<Num>'])
    // triviaLog: [start, end, insertIdx] per trivia entry
    // ' /*c*/ ' is at 1..8, before rawChildren[1] (':' at offset 8)
    // ' ' is at 9..10, before rawChildren[2] (<Num> at offset 10)
    expect(r.value.tlog).toEqual([1, 8, 1, 9, 10, 2])
    expect(input.slice(r.value.tlog[0], r.value.tlog[1])).toBe(' /*c*/ ')
    expect(input.slice(r.value.tlog[3], r.value.tlog[4])).toBe(' ')
  })
})

// ---------------------------------------------------------------------------
// not() / scanTo() / balanced() compile under the macro (CSS needs all three).
// ---------------------------------------------------------------------------

describe('functional grammar — not/scanTo/balanced under the macro', () => {
  it('compiles a grammar using not(), scanTo() and balanced()', () => {
    const CODE = `
import { regex, literal, sequence, not, scanTo, balanced, transform, rules } from 'parseman' with { type: 'macro' }
const digits = regex(/[0-9]+/)
const { Num, Body } = rules(g => {
  // a Num is digits NOT followed by a letter (so '12' but not '12px')
  const Num = transform(sequence(digits, not(regex(/[a-z]/))), ([n]) => n)
  // a Body scans to ')' skipping balanced parens
  const Body = transform(scanTo(literal(')'), { skip: [balanced('(', ')')] }), s => s)
  return { Num, Body }
})
`.trim()
    const result = transformMacro(CODE, 'not-scan-test.ts', new Set(['parseman']))
    expect(result).not.toBeNull()
    // fully compiled → import removed, no runtime fallback combinators left
    expect(result!.code).not.toContain("from 'parseman'")
    expect(result!.code).not.toContain('scanTo(')
    expect(result!.code).not.toContain('not(')

    const fnBody = result!.code.replace(/\bconst\b/g, 'var') + '\nreturn { Num, Body }'
    const reg = new Function(fnBody)() as Record<string, RuleFn>

    // not(): '12' parses, '12px' fails (digit followed by letter)
    expect(reg['Num']!('12', 0, { trackLines: false }).ok).toBe(true)
    expect(reg['Num']!('12px', 0, { trackLines: false }).ok).toBe(false)
    // scanTo()+balanced(): stops just before the matching outer ')', having
    // skipped the inner '(b)' pair so its ')' isn't mistaken for the sentinel.
    const b = reg['Body']!('a(b)c)', 0, { trackLines: false })
    expect(b.ok).toBe(true)
    if (b.ok) {
      expect(b.span.end).toBe(5)   // 'a(b)c' consumed; sentinel ')' not included
      expect(b.value).toBe('a(b)c')
    }
  })
})

for (const [mode, registry] of [['interpreter', () => interpRegistry], ['macro', () => macroRegistry]] as const) {
  describe(`functional grammar — incremental (${mode})`, () => {
    it('full parse produces an Object root', () => {
      const doc = makeFunctionalDoc<Node>(registry(), 'Object', '{a:1}')
      expect(doc.tree).not.toBeNull()
      expect(doc.tree!.type).toBe('Object')
      expect(doc.input).toBe('{a:1}')
    })

    it('same-length value edit grafts and equals a full reparse', () => {
      // delta 0 → spans line up, so the incremental tree must equal a fresh parse.
      const doc = makeFunctionalDoc<Node>(registry(), 'Object', '{a:1,b:2}').edit(7, 8, '9')
      expect(doc.input).toBe('{a:1,b:9}')
      const fresh = makeFunctionalDoc<Node>(registry(), 'Object', '{a:1,b:9}')
      expect(doc.tree).toEqual(fresh.tree)
      // and the edited value really changed
      const bVal = pairsOf(doc.tree)[1]!.children[0]!
      expect(bVal.text).toBe('9')
    })

    it('growing value edit re-parses the containing rule', () => {
      const doc = makeFunctionalDoc<Node>(registry(), 'Object', '{a:1,b:2}').edit(3, 4, '42')
      expect(doc.input).toBe('{a:42,b:2}')
      expect(doc.tree).not.toBeNull()
      const aVal = pairsOf(doc.tree)[0]!.children[0]!
      expect(aVal.text).toBe('42')
    })

    it('length-changing edit shifts ancestor + following-sibling spans (== full reparse)', () => {
      // Grow the first value by one char: the Object root span and the second
      // pair (which sits after the edit) must both shift, matching a fresh parse.
      const edited = makeFunctionalDoc<Node>(registry(), 'Object', '{a:1,b:2}').edit(3, 4, '42')
      const fresh = makeFunctionalDoc<Node>(registry(), 'Object', '{a:42,b:2}')
      expect(edited.tree).toEqual(fresh.tree)
    })

    it('shrinking edit also yields spans identical to a full reparse', () => {
      const edited = makeFunctionalDoc<Node>(registry(), 'Object', '{a:42,b:2}').edit(3, 5, '1')
      const fresh = makeFunctionalDoc<Node>(registry(), 'Object', '{a:1,b:2}')
      expect(edited.tree).toEqual(fresh.tree)
    })

    it('unaffected sibling subtree is shared by reference', () => {
      const doc1 = makeFunctionalDoc<Node>(registry(), 'Object', '{a:1,b:2}')
      const firstPairBefore = pairsOf(doc1.tree)[0]!
      const doc2 = doc1.edit(7, 8, '9')
      const firstPairAfter = pairsOf(doc2.tree)[0]!
      expect(firstPairAfter).toBe(firstPairBefore)
    })

    it('edit does not mutate the original doc', () => {
      const doc1 = makeFunctionalDoc<Node>(registry(), 'Object', '{a:1,b:2}')
      const before = JSON.stringify(doc1.tree)
      doc1.edit(7, 8, '9')
      expect(JSON.stringify(doc1.tree)).toBe(before)
    })

    it('edit to invalid input falls back to a null tree with errors', () => {
      const doc = makeFunctionalDoc<Node>(registry(), 'Object', '{a:1}').edit(3, 5, '')
      expect(doc.tree).toBeNull()
      expect(doc.errors.length).toBeGreaterThan(0)
    })

    it('edit on a failed parse re-parses from scratch', () => {
      const doc = makeFunctionalDoc<Node>(registry(), 'Object', '').edit(0, 0, '{x:1}')
      expect(doc.tree).not.toBeNull()
      expect(doc.tree!.type).toBe('Object')
    })
  })
}
