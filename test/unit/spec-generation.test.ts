/**
 * Grammar spec generation (`parseman/spec`).
 *
 * Verifies that walking the same `_def` combinator tree the interpreter/compiler
 * consume yields faithful EBNF + railroad output — combinator → EBNF mappings,
 * precedence-correct parenthesization, reachability closure, and self-contained
 * railroad HTML.
 */
import { describe, it, expect } from 'vitest'
import {
  rules, choice, sequence, literal, regex, optional, sepBy, many, oneOrMore,
  not, keywords, trivia, transform, node, type Combinator,
} from '../../src/index.ts'
import { toEBNF, toRailroadHtml, buildSpecModel } from '../../src/spec/index.ts'

function demoGrammar() {
  return rules(self => {
    const ident = regex(/[a-zA-Z_][a-zA-Z0-9_]*/)
    const number = regex(/[0-9]+/)
    return {
      expr: choice(self.call, self.list, ident, number),
      call: sequence(ident, literal('('), optional(sepBy(self.expr as Combinator<unknown>, literal(','))), literal(')')),
      list: sequence(literal('['), sepBy(self.expr as Combinator<unknown>, literal(',')), literal(']')),
      kw: keywords(['if', 'else', 'while']),
      stars: sequence(many(ident), oneOrMore(number)),
      neg: sequence(not(literal('#')), ident),
    }
  })
}

function ebnfLines(ebnf: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of ebnf.trim().split('\n')) {
    const m = line.match(/^(\S+) ::= (.*)$/)
    if (m) map[m[1]!] = m[2]!
  }
  return map
}

describe('spec — combinator → EBNF mapping', () => {
  const lines = ebnfLines(toEBNF(demoGrammar()))

  it('choice → alternation, refs → non-terminals', () => {
    expect(lines.expr).toBe('call | list | /[a-zA-Z_][a-zA-Z0-9_]*/ | /[0-9]+/')
  })

  it('sequence + optional + sepBy, with precedence parens', () => {
    expect(lines.call).toBe('/[a-zA-Z_][a-zA-Z0-9_]*/ "(" (expr ("," expr)*)? ")"')
  })

  it('sepBy expands to item (sep item)*', () => {
    expect(lines.list).toBe('"[" expr ("," expr)* "]"')
  })

  it('keywords → alternation of quoted literals', () => {
    // keywords() sorts internally; assert set membership, not order.
    const alts = lines.kw!.split(' | ').sort()
    expect(alts).toEqual(['"else"', '"if"', '"while"'])
  })

  it('star / plus postfix operators', () => {
    expect(lines.stars).toBe('/[a-zA-Z_][a-zA-Z0-9_]*/* /[0-9]+/+')
  })

  it('not → negation annotation', () => {
    expect(lines.neg).toBe('!"#" /[a-zA-Z_][a-zA-Z0-9_]*/')
  })
})

describe('spec — options', () => {
  it('regexDisplay renders readable terminals', () => {
    const ebnf = toEBNF(demoGrammar(), {
      regexDisplay: src => (src === '[0-9]+' ? 'INTEGER' : src.startsWith('[a-zA-Z_]') ? 'IDENT' : undefined),
    })
    expect(ebnf).toContain('expr ::= call | list | IDENT | INTEGER')
  })

  it('terminals pins a whole rule to a display name', () => {
    const lines = ebnfLines(toEBNF(demoGrammar(), { terminals: { list: 'LIST' } }))
    expect(lines.list).toBe('LIST')
  })

  it('root restricts output to reachable rules', () => {
    const model = buildSpecModel(demoGrammar(), { root: 'expr' })
    const names = model.productions.map(p => p.name).sort()
    expect(names).toEqual(['call', 'expr', 'list'])
  })

  it('order controls emission order', () => {
    const model = buildSpecModel(demoGrammar(), { order: ['list', 'expr'] })
    // list is first; expr and its reachable deps follow.
    expect(model.productions[0]!.name).toBe('list')
    expect(model.productions.map(p => p.name)).toContain('call')
  })
})

describe('spec — trivia handling', () => {
  const g = rules(self => ({
    ws: trivia(regex(/\s+/)),
    doc: sequence(literal('a'), self.ws as Combinator<unknown>, literal('b')),
  }))

  it('elides trivia rules by default', () => {
    const model = buildSpecModel(g)
    expect(model.productions.map(p => p.name)).not.toContain('ws')
  })

  it('includeTrivia keeps them', () => {
    const model = buildSpecModel(g, { includeTrivia: true })
    expect(model.productions.map(p => p.name)).toContain('ws')
  })
})

describe('spec — node() rules are transparent', () => {
  it('a node("Type", ...) rule expands to its inner syntax', () => {
    const g = rules(self => ({
      pair: node('Pair', sequence(regex(/[a-z]+/), literal(':'), self.pair as Combinator<unknown>)),
    }))
    const lines = ebnfLines(toEBNF(g))
    expect(lines.pair).toBe('/[a-z]+/ ":" pair')
  })
})

describe('spec — single combinator input', () => {
  it('accepts a lone combinator, keyed by rule name or "start"', () => {
    const c = transform(regex(/[0-9]+/), s => Number(s))
    expect(toEBNF(c).trim()).toBe('start ::= /[0-9]+/')
  })
})

describe('spec — railroad HTML', () => {
  const html = toRailroadHtml(demoGrammar(), { title: 'Demo' })

  it('is self-contained (inlines the diagram library + CSS, no external refs)', () => {
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('railroad-diagram') // vendored CSS class
    expect(html).toContain('function Diagram') // vendored library source
    expect(html).not.toMatch(/src=["']https?:/)
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/)
  })

  it('emits one diagram container + DSL builder per production', () => {
    for (const name of ['expr', 'call', 'list', 'kw', 'stars', 'neg']) {
      expect(html).toContain(`data-rule="${name}"`)
    }
    expect(html).toContain('Diagram(')
    expect(html).toContain('OneOrMore(') // sepBy lowering
    expect(html).toContain('NonTerminal("expr")')
  })

  it('sets the page title', () => {
    expect(html).toContain('<title>Demo</title>')
  })
})
