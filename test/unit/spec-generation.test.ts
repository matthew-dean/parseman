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
  not, peek, keywords, word, makeWord, trivia, transform, node, dispatch, endsWith, startsWith, when, otherwise, routed, token, type Combinator,
} from '../../src/index.ts'
import { toEBNF, toRailroadHtml, toRailroadSvg, RAILROAD_CSS, buildSpecModel } from '../../src/spec/index.ts'

function demoGrammar() {
  return rules(self => {
    const ident = regex(/[a-zA-Z_][a-zA-Z0-9_]*/)
    const number = regex(/[0-9]+/)
    return {
      expr: choice(self.call, self.list, ident, number),
      call: sequence(ident, literal('('), sepBy(self.expr as Combinator<unknown>, literal(',')), literal(')')),
      list: sequence(literal('['), sepBy(self.expr as Combinator<unknown>, literal(','), { min: 1 }), literal(']')),
      kw: keywords(['if', 'else', 'while']),
      stars: sequence(many(ident), oneOrMore(number)),
      neg: sequence(not(literal('#')), ident),
      pos: sequence(peek(literal('@')), ident),
      opt: sequence(optional(literal('-')), ident),
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

  it('sequence + nullable sepBy renders the empty alternative it really has', () => {
    expect(lines.call).toBe('/[a-zA-Z_][a-zA-Z0-9_]*/ "(" (expr ("," expr)*)? ")"')
  })

  it('sepBy { min: 1 } expands to item (sep item)* — no empty alternative', () => {
    expect(lines.list).toBe('"[" expr ("," expr)* "]"')
  })

  it('BOUNDED repeats render their real bounds instead of collapsing to * / +', () => {
    // 0.34.0 gave the whole repeat family { min, max } (and sepBy `trailing`), but
    // the spec model dropped every one of them: `many(x, { min: 3, max: 8 })` came
    // out as plain `x+`, and a `sepBy` with `min >= 2` came out wrapped in `( … )?`
    // — claiming a list that requires two items can match EMPTY, and that one item
    // would do. A generated spec that understates the grammar is worse than none.
    const item = regex(/[a-z]+/)
    const comma = literal(',')
    const lines = ebnfLines(toEBNF(rules(() => ({
      nullable: sepBy(item, comma),
      atLeast1: sepBy(item, comma, { min: 1 }),
      atLeast2: sepBy(item, comma, { min: 2 }),
      oneToThree: sepBy(item, comma, { min: 1, max: 3 }),
      trailAllow: sepBy(item, comma, { min: 1, trailing: 'allow' }),
      starMax: many(item, { max: 4 }),
      threeToEight: many(item, { min: 3, max: 8 }),
      exactly2: many(item, { min: 2, max: 2 }),
      plainStar: many(item),
      plainPlus: oneOrMore(item),
    }))))
    const I = '/[a-z]+/'
    expect(lines.nullable).toBe(`(${I} ("," ${I})*)?`)
    expect(lines.atLeast1).toBe(`${I} ("," ${I})*`)
    // The tail repeats ONE FEWER time than there are items: 2+ items → 1+ tails.
    expect(lines.atLeast2).toBe(`${I} ("," ${I})+`)
    expect(lines.oneToThree).toBe(`${I} ("," ${I}){0,2}`)
    expect(lines.trailAllow).toBe(`${I} ("," ${I})* ","?`)
    expect(lines.starMax).toBe(`${I}{0,4}`)
    expect(lines.threeToEight).toBe(`${I}{3,8}`)
    expect(lines.exactly2).toBe(`${I}{2}`)
    // The unbounded spellings are untouched.
    expect(lines.plainStar).toBe(`${I}*`)
    expect(lines.plainPlus).toBe(`${I}+`)
  })

  it('a non-empty sepBy is never wrapped in the OPTIONAL that means "can match empty"', () => {
    const item = regex(/[a-z]+/)
    for (const min of [1, 2, 5]) {
      const line = ebnfLines(toEBNF(rules(() => ({ r: sepBy(item, literal(','), { min }) })))).r!
      expect(line, `min ${min}`).not.toMatch(/^\(.*\)\?$/)
    }
    expect(ebnfLines(toEBNF(rules(() => ({ r: sepBy(item, literal(','), { min: 0 }) })))).r).toMatch(/^\(.*\)\?$/)
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

  it('peek → PEG positive-lookahead annotation', () => {
    expect(lines.pos).toBe('&"@" /[a-zA-Z_][a-zA-Z0-9_]*/')
  })

  it('optional → ? postfix', () => {
    expect(lines.opt).toBe('"-"? /[a-zA-Z_][a-zA-Z0-9_]*/')
  })
})

/**
 * A spec reader's vocabulary is the language's own — MDN and the CSS specs draw
 * `@import`, not the pattern that recognises it. A keyword must therefore render
 * as the keyword, whether it was authored as `word()`, `keywords()` or a
 * hand-written boundary-guarded `regex()`. Anything with real regex structure
 * still prints raw: the diagrams exist to make grammar complexity visible.
 */
describe('spec — authored terminals', () => {
  const BOUNDARY = '-_a-zA-Z0-9\\u0080-\\uFFFF'
  const line = (c: Combinator<unknown>): string => ebnfLines(toEBNF(rules(() => ({ r: c })))).r!

  it('word() renders as the keyword, not a one-arm alternation', () => {
    expect(line(word('@import', BOUNDARY, { caseInsensitive: true }))).toBe('"@import"')
    expect(line(makeWord(BOUNDARY)('@media'))).toBe('"@media"')
  })

  it('a one-word keywords() set is a terminal, not a choice', () => {
    expect(line(keywords(['@import']))).toBe('"@import"')
    expect(line(not(word('@import')))).toBe('!"@import"')
  })

  it('a multi-word keywords() set stays an alternation', () => {
    expect(line(keywords(['if', 'else'])).split(' | ').sort()).toEqual(['"else"', '"if"'])
  })

  it('a boundary-guarded regex renders as its keyword', () => {
    expect(line(regex(/@import(?![-_a-zA-Z0-9\u0080-\uFFFF])/i))).toBe('"@import"')
    expect(line(regex(/\bin\b/))).toBe('"in"')
    expect(line(regex(/url\(/))).toBe('"url("')
  })

  it('an alternation of fixed strings renders as those strings', () => {
    expect(line(regex(/>=|<=|>|<|=/))).toBe('">=" | "<=" | ">" | "<" | "="')
    expect(line(regex(/(?:and|or)(?![-_a-zA-Z0-9])/))).toBe('"and" | "or"')
  })

  it('a regex with real structure still prints raw', () => {
    for (const re of [
      /[-+]/, // character class
      /,[ \t\n\r\f]*/, // quantifier
      /\+(?=[ \t\n\r\f]*[$(])/, // POSITIVE lookahead — a real constraint, not a boundary
      /@import(?!x)/, // lookahead over something other than a class
      /nth-(?:last-)?child(?=\()/, // interior group
      /[a-zA-Z_][-\w]*/,
    ]) {
      expect(line(regex(re)), re.source).toBe(`/${re.source}/`)
    }
  })

  it('regexDisplay still wins over the derived form', () => {
    const ebnf = toEBNF(rules(() => ({ r: regex(/@import(?![-a-z])/) })), {
      regexDisplay: src => (src.startsWith('@import') ? 'AT-IMPORT' : undefined),
    })
    expect(ebnfLines(ebnf).r).toBe('AT-IMPORT')
  })

  it('the keyword reaches the rendered diagram as one Terminal box', () => {
    const g = rules(() => ({ ImportRule: sequence(word('@import', BOUNDARY), literal(';')) }))
    const html = toRailroadHtml(g)
    expect(html).toContain('Sequence(Terminal("@import"), Terminal(";"))')
    expect(html).not.toContain('(?!')
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

  it('throws (not silently empty) on an unknown rule name in root/order', () => {
    // Regression: an unknown name — or a stray string like order:'source' where a
    // string[] is meant — used to seed a phase that reached nothing and returned an
    // EMPTY model with no error. It must fail loudly, naming the offender.
    expect(() => buildSpecModel(demoGrammar(), { root: 'nope' })).toThrow(/unknown rule name.*root.*"nope"/)
    expect(() => buildSpecModel(demoGrammar(), { order: ['expr', 'nope'] })).toThrow(/unknown rule name.*order.*"nope"/)
    // A string passed where string[] is expected is normalized then rejected by name.
    expect(() => buildSpecModel(demoGrammar(), { order: 'source' as unknown as string[] })).toThrow(/unknown rule name.*order.*"source"/)
    // The error lists the known rules to guide the fix.
    expect(() => buildSpecModel(demoGrammar(), { root: 'nope' })).toThrow(/Known rules:.*"expr"/)
  })
})

describe('spec — ordering', () => {
  // `expr` is DECLARED first, but references `call`/`list`, so the rules() record's
  // own key order leads with `call` (a Proxy artifact). The spec must recover the
  // author's declaration order regardless.
  it('defaults to declaration order (entry rule leads)', () => {
    const model = buildSpecModel(demoGrammar())
    expect(model.productions.map(p => p.name)).toEqual(['expr', 'call', 'list', 'kw', 'stars', 'neg', 'pos', 'opt'])
  })

  it("sort: 'reachable' introduces each rule at its first reference; unreachable rules trail", () => {
    const g = rules(self => ({
      expr: sequence(self.term as Combinator<unknown>, optional(sequence(literal('+'), self.expr as Combinator<unknown>))),
      zzz: literal('z'), // declared 2nd, referenced by nobody
      term: regex(/[0-9]+/), // declared 3rd, referenced by expr
    }))
    expect(buildSpecModel(g).productions.map(p => p.name)).toEqual(['expr', 'zzz', 'term'])
    expect(buildSpecModel(g, { sort: 'reachable' }).productions.map(p => p.name)).toEqual(['expr', 'term', 'zzz'])
  })

  it('explicit order and root override sort', () => {
    const g = demoGrammar()
    expect(buildSpecModel(g, { sort: 'reachable', order: ['kw', 'expr'] }).productions[0]!.name).toBe('kw')
    expect(buildSpecModel(g, { sort: 'source', root: 'list' }).productions.map(p => p.name).sort())
      .toEqual(['call', 'expr', 'list'])
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

  it('node projection changes semantic values, not generated syntax specs', () => {
    const g = rules(() => ({
      paren: node('Paren', sequence(literal('('), regex(/[0-9]+/), literal(')')), { project: 1 }),
    }))
    const lines = ebnfLines(toEBNF(g))
    expect(lines.paren).toBe('"(" /[0-9]+/ ")"')

    const html = toRailroadHtml(g)
    expect(html).toContain('Terminal("(")')
    expect(html).toContain('Terminal("/[0-9]+/")')
    expect(html).toContain('Terminal(")")')

    const svg = toRailroadSvg(g)[0]!.svg
    expect(svg).toMatch(/^<svg class="railroad-diagram"/)
    expect(svg).toContain('/&#91;0-9&#93;+/')
    expect(svg).not.toContain('project')
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
    for (const name of ['expr', 'call', 'list', 'kw', 'stars', 'neg', 'pos', 'opt']) {
      expect(html).toContain(`data-rule="${name}"`)
    }
    expect(html).toContain('Diagram(')
    expect(html).toContain('OneOrMore(') // sepBy lowering
    expect(html).toContain('NonTerminal("expr")')
  })

  it('sets the page title', () => {
    expect(html).toContain('<title>Demo</title>')
  })

  it('does not wrap a non-empty sepBy in Optional, and labels a bounded repeat', () => {
    const item = regex(/[a-z]+/)
    const dsl = (r: Combinator<unknown>): string =>
      toRailroadHtml(rules(() => ({ r }))).match(/name: "r", dsl: function\(\)\{ return Diagram\((.*)\); \}/)![1]!
    // `Optional(` is the diagram's way of saying "this path can be skipped".
    expect(dsl(sepBy(item, literal(',')))).toContain('Optional(')
    expect(dsl(sepBy(item, literal(','), { min: 1 }))).not.toContain('Optional(')
    expect(dsl(sepBy(item, literal(','), { min: 2 }))).not.toContain('Optional(')
    // A real bound rides the loop-back path, since railroad has no count primitive.
    expect(dsl(sepBy(item, literal(','), { min: 2 }))).toContain('Comment("2+ times")')
    expect(dsl(many(item, { min: 3, max: 8 }))).toContain('Comment("3–8 times")')
    expect(dsl(many(item))).not.toContain('Comment(')
  })

  it('renders dispatch branches without exposing routed() as syntax', () => {
    const opener = token(sequence(regex(/[A-Za-z-]+/), optional(literal('('))))
    const grammar = rules(() => ({
      value: dispatch(
        opener,
        when('url(', sequence(routed(), literal('raw'), literal(')'))),
        otherwise(routed()),
      ),
    }))
    const ebnf = toEBNF(grammar)
    expect(ebnf.trim()).toBe('value ::= /[A-Za-z-]+/ "("? ("raw" ")" | /* empty */)')
    expect(ebnf).not.toContain('routed')

    const html = toRailroadHtml(grammar)
    expect(html).toContain('railroad-diagram')
    expect(html).toContain('Choice(')
    expect(html).toContain('Terminal("raw")')
    expect(html).not.toContain('routed')

    const svg = toRailroadSvg(grammar)[0]!.svg
    expect(svg).toMatch(/^<svg class="railroad-diagram"/)
    expect(svg).toContain('raw')
    expect(svg).not.toContain('routed')
  })

  it('renders dispatch matcher branches as syntax, not matcher helper calls', () => {
    const head = token(sequence(regex(/[A-Za-z-]+/), optional(literal('('))))
    const grammar = rules(() => ({
      value: dispatch(
        head,
        when('url(', literal('raw')),
        when(startsWith('--'), literal('custom')),
        when(endsWith('('), literal('generic')),
        otherwise(literal('ident')),
      ),
    }))
    const ebnf = toEBNF(grammar)
    expect(ebnf.trim()).toBe('value ::= /[A-Za-z-]+/ "("? ("raw" | "custom" | "generic" | "ident")')
    expect(ebnf).not.toContain('startsWith')
    expect(ebnf).not.toContain('endsWith')

    const html = toRailroadHtml(grammar)
    expect(html).toContain('Terminal("raw")')
    expect(html).toContain('Terminal("custom")')
    expect(html).toContain('Terminal("generic")')
    expect(html).toContain('Terminal("ident")')
    expect(html).not.toContain('startsWith')
    expect(html).not.toContain('endsWith')

    const svg = toRailroadSvg(grammar)[0]!.svg
    expect(svg).toContain('raw')
    expect(svg).toContain('custom')
    expect(svg).toContain('generic')
    expect(svg).toContain('ident')
    expect(svg).not.toContain('startsWith')
    expect(svg).not.toContain('endsWith')
  })
})

describe('spec — static railroad SVG', () => {
  const svgs = toRailroadSvg(demoGrammar())

  it('reuses the vendored builders across calls (a second render re-enters the memo)', () => {
    // Distinct grammar exercising star (many), plus (oneOrMore), opt (optional),
    // annotation (not) and sepBy in the live builder path — and a second call so
    // the cached `builders()` branch is taken.
    const g = rules(self => ({
      doc: sequence(many(self.word), oneOrMore(self.num), optional(literal('!')), not(literal('#')), sepBy(self.word, literal(','))),
      word: regex(/[a-z]+/),
      num: regex(/[0-9]+/),
    }))
    const out = toRailroadSvg(g)
    expect(out.map((s) => s.name)).toContain('doc')
    for (const { svg } of out) expect(svg).toMatch(/^<svg class="railroad-diagram"/)
  })

  it('renders one static SVG per production, headlessly (no DOM, no client script)', () => {
    expect(svgs.map((s) => s.name)).toEqual(['expr', 'call', 'list', 'kw', 'stars', 'neg', 'pos', 'opt'])
    for (const { svg } of svgs) {
      expect(svg).toMatch(/^<svg class="railroad-diagram"/)
      expect(svg).toContain('</svg>')
      expect(svg).not.toContain('data-rule') // fully rendered, not a client-built placeholder
    }
  })

  it('renders the grammar\'s terminals and non-terminals into the SVG', () => {
    const list = svgs.find((s) => s.name === 'list')!.svg
    expect(list).toContain('&#91;') // '[' literal terminal (the lib HTML-escapes brackets)
    expect(list).toContain('expr') // NonTerminal reference (sepBy element)
    expect(list).toContain('<text') // actual glyphs, i.e. the diagram was really rendered
  })

  it('exports the diagram CSS for styling embedded SVGs', () => {
    expect(RAILROAD_CSS).toContain('svg.railroad-diagram')
  })
})
