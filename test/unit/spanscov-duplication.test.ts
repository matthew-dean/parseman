/**
 * `src/analysis/duplication.ts` — the regex-source readers and the rendering, at the
 * edges.
 *
 * `duplication-diagnostic.test.ts` covers the happy shapes. What is asserted here is the
 * PARSING of a regex source — escapes, classes, group flavours, code-point escapes,
 * boundary guards — plus the one-line rendering of each finding family. Both are string
 * transforms with no other observable effect, so every case below fixes the exact output;
 * a "did not throw" assertion on any of them would be worthless.
 */
import { describe, it, expect } from 'vitest'
import {
  alternationGroups, charClassMembers, extractCharClasses, keywordRegexShape,
  keywordAlternationHazards, analyzeDuplication, analyzeDuplicationRules,
  formatDuplicationFindings, duplicationFindingCount, siteToString,
  choice, sequence, literal, regex, many, oneOrMore, optional, node, field, label,
  keywords, rules, sepBy, skip, scanTo, dispatch, when, otherwise,
  type Combinator,
} from '../../src/index.ts'

const entries = (g: Record<string, Combinator<unknown>>): [string, Combinator<unknown>][] => Object.entries(g)

describe('alternationGroups — reading a regex source', () => {
  it('an ESCAPED pipe is not an alternation', () => {
    expect(alternationGroups('a\\|b')).toEqual([])
    expect(alternationGroups('a\\|b|c')).toEqual([['a\\|b', 'c']])
  })

  it('an escaped bracket does not open a class', () => {
    expect(alternationGroups('\\[a|b\\]')).toEqual([['\\[a', 'b\\]']])
  })

  it('a leading `]` inside a class is a MEMBER, so the class does not end there', () => {
    expect(alternationGroups('[]|]x')).toEqual([])
    expect(alternationGroups('[^]|]x|y')).toEqual([['[^]|]x', 'y']])
  })

  it('an escape inside a class does not end the class', () => {
    expect(alternationGroups('[a\\]|b]')).toEqual([])
  })

  it('sees each group flavour: non-capturing, lookahead, lookbehind and named', () => {
    expect(alternationGroups('(?:a|b)')).toEqual([['a', 'b']])
    expect(alternationGroups('(?=a|b)')).toEqual([['a', 'b']])
    expect(alternationGroups('(?!a|b)')).toEqual([['a', 'b']])
    expect(alternationGroups('(?<=a|b)')).toEqual([['a', 'b']])
    expect(alternationGroups('(?<!a|b)')).toEqual([['a', 'b']])
    expect(alternationGroups('(?<n>a|b)')).toEqual([['a', 'b']])
    expect(alternationGroups('(a|b)')).toEqual([['a', 'b']])
  })

  it('an unrecognised `(?` form consumes only the `?`, so the branch keeps the rest', () => {
    // `(?P…` is not a JS group prefix. The reader skips the `?` alone rather than
    // guessing, which keeps the branch text honest about what it actually saw.
    expect(alternationGroups('(?Pa|b)')).toEqual([['Pa', 'b']])
  })

  it('reports the INNER run before the outer one, at every depth', () => {
    expect(alternationGroups('x|(?:a|b)|y')).toEqual([['a', 'b'], ['x', '(?:a|b)', 'y']])
  })

  it('ignores a group with a single branch', () => {
    expect(alternationGroups('(?:abc)')).toEqual([])
    expect(alternationGroups('abc')).toEqual([])
  })

  it('keeps an EMPTY branch, because `a|` and `a` are different patterns', () => {
    expect(alternationGroups('a|')).toEqual([['a', '']])
    expect(alternationGroups('|a')).toEqual([['', 'a']])
  })
})

describe('extractCharClasses', () => {
  it('finds classes at any position and inside a boundary lookahead', () => {
    expect(extractCharClasses('x[abc]y(?![-\\w])')).toEqual(['abc', '-\\w'])
  })

  it('keeps the negation marker as part of the body', () => {
    expect(extractCharClasses('[^a-z]')).toEqual(['^a-z'])
  })

  it('treats a leading `]` as a member, not as the end of the class', () => {
    expect(extractCharClasses('[]]')).toEqual([']'])
    expect(extractCharClasses('[^]]')).toEqual(['^]'])
  })

  it('an ESCAPED `[` opens nothing, and an escaped `]` does not close', () => {
    expect(extractCharClasses('\\[abc\\]')).toEqual([])
    expect(extractCharClasses('[a\\]b]')).toEqual(['a\\]b'])
  })

  it('an unterminated class runs to the end of the source', () => {
    expect(extractCharClasses('[abc')).toEqual(['abc'])
  })

  it('finds nothing in a source with no class', () => {
    expect(extractCharClasses('a|b(?:c)')).toEqual([])
  })
})

describe('charClassMembers — normalising a class body', () => {
  it('joins a range into ONE member', () => {
    expect(charClassMembers('a-z0-9')).toEqual(['a-z', '0-9'])
  })

  it('normalises \\uXXXX, \\u{…} and \\xNN to the SAME member as the raw character', () => {
    // Below 0x80 the escape becomes the literal character…
    expect(charClassMembers('\\x41')).toEqual(['A'])
    expect(charClassMembers('\\u0041')).toEqual(['A'])
    expect(charClassMembers('\\u{41}')).toEqual(['A'])
    expect(charClassMembers('A')).toEqual(['A'])
    // …and at or above it, everything is spelled as \uXXXX so two files agree.
    expect(charClassMembers('\\u00e9')).toEqual(['\\u00e9'])
    expect(charClassMembers('é')).toEqual(['\\u00e9'])
    expect(charClassMembers('\\u{e9}')).toEqual(['\\u00e9'])
  })

  it('keeps a class shorthand escape whole', () => {
    expect(charClassMembers('\\w\\d\\s')).toEqual(['\\w', '\\d', '\\s'])
    expect(charClassMembers('\\-\\\\')).toEqual(['\\-', '\\\\'])
  })

  it('a TRAILING hyphen is its own member, not half a range', () => {
    expect(charClassMembers('a-')).toEqual(['a', '-'])
    expect(charClassMembers('-a')).toEqual(['-', 'a'])
  })

  it('an empty body has no members', () => {
    expect(charClassMembers('')).toEqual([])
  })
})

describe('keywordRegexShape — which regexes are really keyword sets', () => {
  it('peels an anchor, a wrapping group and a trailing `$`', () => {
    expect(keywordRegexShape('^(?:red|green|blue)')).toEqual({ words: ['red', 'green', 'blue'], boundary: null })
    expect(keywordRegexShape('red|green|blue$')).toEqual({ words: ['red', 'green', 'blue'], boundary: null })
  })

  it('reads `\\b` as the DEFAULT word-character boundary', () => {
    expect(keywordRegexShape('not\\b')).toEqual({ words: ['not'], boundary: '_0-9A-Za-z' })
  })

  it('reads an explicit negative-lookahead class as the boundary, verbatim', () => {
    expect(keywordRegexShape('not(?![-\\w])')).toEqual({ words: ['not'], boundary: '-\\w' })
  })

  it('accepts a leading lookBEHIND guard and reports only the trailing one', () => {
    expect(keywordRegexShape('(?<![-\\w])not(?![-\\w])')).toEqual({ words: ['not'], boundary: '-\\w' })
  })

  it('REJECTS `(?![^…])`, which asserts the opposite of a boundary', () => {
    // Passing `^-\w` on as a boundary would invert every rescue verdict downstream,
    // which can invent or hide a reported BUG.
    expect(keywordRegexShape('not(?![^-\\w])')).toBeNull()
  })

  it('needs three words when there is no guard, but only one when there is', () => {
    expect(keywordRegexShape('red|green')).toBeNull()
    expect(keywordRegexShape('red|green|blue')).toEqual({ words: ['red', 'green', 'blue'], boundary: null })
    expect(keywordRegexShape('red\\b')).toEqual({ words: ['red'], boundary: '_0-9A-Za-z' })
  })

  it('accepts a vendor prefix and inner digits/underscores/hyphens', () => {
    expect(keywordRegexShape('-webkit-box|flex|grid_2')).toEqual({ words: ['-webkit-box', 'flex', 'grid_2'], boundary: null })
  })

  it('rejects anything with real regex machinery in it', () => {
    expect(keywordRegexShape('a+|b|c')).toBeNull()
    expect(keywordRegexShape('[abc]|d|e')).toBeNull()
    expect(keywordRegexShape('9lives|b|c')).toBeNull()
    expect(keywordRegexShape('(?:a|b)|c|d')).toBeNull()
  })
})

describe('keywordAlternationHazards — first-match ordering, and what rescues it', () => {
  it('names the pair and the exact character that follows the shorter word', () => {
    expect(keywordAlternationHazards(['red', 'redish'], null)).toEqual([
      { shorter: 'red', longer: 'redish', at: 'i', rescuedByBoundary: false },
    ])
  })

  it('reports nothing when the longer word comes first', () => {
    expect(keywordAlternationHazards(['redish', 'red'], null)).toEqual([])
    expect(keywordAlternationHazards(['red', 'blue'], null)).toEqual([])
    expect(keywordAlternationHazards(['red', 'red'], null)).toEqual([])
  })

  it('reports EVERY hazardous pair, not just the first', () => {
    expect(keywordAlternationHazards(['a', 'ab', 'abc'], null).map(h => `${h.shorter}<${h.longer}`))
      .toEqual(['a<ab', 'a<abc', 'ab<abc'])
  })

  it('a boundary containing \\w, \\d or \\s rescues the matching character', () => {
    expect(keywordAlternationHazards(['red', 'redish'], '\\w')[0]!.rescuedByBoundary).toBe(true)
    expect(keywordAlternationHazards(['a', 'a1'], '\\d')[0]!.rescuedByBoundary).toBe(true)
    expect(keywordAlternationHazards(['a', 'a b'], '\\s')[0]!.rescuedByBoundary).toBe(true)
    // …and does NOT rescue a character outside it.
    expect(keywordAlternationHazards(['a', 'a-b'], '\\d')[0]!.rescuedByBoundary).toBe(false)
    expect(keywordAlternationHazards(['a', 'a1'], '\\s')[0]!.rescuedByBoundary).toBe(false)
  })

  it('a boundary RANGE rescues inside it and not outside, including \\u-escaped bounds', () => {
    expect(keywordAlternationHazards(['a', 'ab'], 'a-z')[0]!.rescuedByBoundary).toBe(true)
    expect(keywordAlternationHazards(['a', 'a1'], 'a-z')[0]!.rescuedByBoundary).toBe(false)
    expect(keywordAlternationHazards(['a', 'ab'], '\\u0061-\\u007a')[0]!.rescuedByBoundary).toBe(true)
    expect(keywordAlternationHazards(['a', 'a1'], '\\u0061-\\u007a')[0]!.rescuedByBoundary).toBe(false)
  })

  it('a boundary LITERAL rescues exactly that character', () => {
    expect(keywordAlternationHazards(['x', 'x-y'], '-')[0]!.rescuedByBoundary).toBe(true)
    expect(keywordAlternationHazards(['x', 'xy'], '-')[0]!.rescuedByBoundary).toBe(false)
  })

  it('no boundary rescues nothing', () => {
    expect(keywordAlternationHazards(['x', 'xy'], null)[0]!.rescuedByBoundary).toBe(false)
  })
})

describe('the one-line rendering of a duplicated shape', () => {
  it('renders each structural tag in its own call syntax', () => {
    const mk = (): Combinator<unknown> =>
      sequence(literal('('), many(regex(/\d/)), oneOrMore(literal('x')), sepBy(literal('a'), literal(',')))
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: sequence(literal('1'), mk()),
      B: sequence(literal('2'), mk()),
    }))))
    const f = r.duplicates.find(d => d.count === 2 && d.shape.startsWith('sequence(literal(\'(\')'))
    expect(f).toBeDefined()
    expect(f!.shape).toBe(
      "sequence(literal('('), many(regex(/\\d/)), oneOrMore(literal('x')), sepBy(literal('a'), literal(',')))",
    )
  })

  it('renders explicit repetition bounds and omits the default ones', () => {
    const mk = (): Combinator<unknown> =>
      sequence(literal('#'), many(literal('y'), { max: 4 }), oneOrMore(literal('z'), { max: 3 }))
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: sequence(literal('1'), mk()),
      B: sequence(literal('2'), mk()),
    }))))
    const f = r.duplicates.find(d => d.shape.startsWith("sequence(literal('#')"))
    expect(f).toBeDefined()
    expect(f!.shape).toBe(
      "sequence(literal('#'), many(literal('y'), { min: 0, max: 4 }), oneOrMore(literal('z'), { min: 1, max: 3 }))",
    )
  })

  it('renders node/label/field with their names, and a keywords() list truncated at four', () => {
    const mk = (): Combinator<unknown> =>
      node('Decl', label('lbl', field('fld', keywords(['a', 'b', 'c', 'd', 'e']))))
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: sequence(literal('1'), mk()),
      B: sequence(literal('2'), mk()),
    }))))
    const f = r.duplicates.find(d => d.shape.startsWith('node('))
    expect(f).toBeDefined()
    expect(f!.shape).toBe("node('Decl', label('lbl', field('fld', keywords(['a', 'b', 'c', 'd', …]))))")
  })

  it('renders a dispatch with its keys and its otherwise tail', () => {
    const mk = (): Combinator<unknown> => sequence(literal('{'), literal('}'))
    const r = analyzeDuplication(dispatch(
      regex(/@[a-z]+/),
      when('@media', mk()),
      otherwise(mk()),
    ))
    const f = r.duplicates.find(d => d.count === 2)
    expect(f).toBeDefined()
    expect(f!.shape).toBe("sequence(literal('{'), literal('}'))")
    expect(f!.sites.map(siteToString)).toEqual(['<entry> › dispatch.when[0]', '<entry> › dispatch.otherwise'])
  })

  it('names the structural path of each site — sequence, choice, skip, sepBy and scanTo', () => {
    const mk = (): Combinator<unknown> => sequence(literal('('), regex(/\d\d/), literal(')'))
    const r = analyzeDuplicationRules(entries(rules(() => ({
      Seq: sequence(literal('a'), mk()),
      Cho: choice(literal('b'), mk()),
      Skp: skip(mk(), literal(' ')),
      Sep: sepBy(mk(), literal(',')),
      Scn: scanTo(mk(), { skip: [literal('"')] }),
    }))))
    const f = r.duplicates.find(d => d.count === 5)
    expect(f).toBeDefined()
    expect(f!.sites.map(siteToString).sort()).toEqual([
      'Cho › choice[1]',
      'Scn › scanTo.sentinel',
      'Sep › sepBy.item',
      'Seq › seq[1]',
      'Skp › skip.main',
    ])
  })

  it('renders a REFERENCE as `g.Name`, not as the rule it points at', () => {
    const mk = (ref: Combinator<unknown>): Combinator<unknown> => sequence(literal('<'), ref, literal('>'))
    const g = rules(gg => ({
      Ident: regex(/[a-z]+/),
      A: sequence(literal('1'), mk(gg.Ident)),
      B: sequence(literal('2'), mk(gg.Ident)),
    }))
    const r = analyzeDuplicationRules(entries(g))
    expect(r.duplicates.some(d => d.shape === "sequence(literal('<'), g.Ident, literal('>'))")).toBe(true)
  })

  it('clamps a very long shape with an ellipsis', () => {
    const wide = (): Combinator<unknown> =>
      sequence(...(Array.from({ length: 40 }, (_, i) => literal(`token-number-${i}`)) as [Combinator<unknown>, ...Combinator<unknown>[]]))
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: sequence(literal('1'), wide()),
      B: sequence(literal('2'), wide()),
    }))))
    const f = r.duplicates.find(d => d.count === 2 && d.shape.startsWith('sequence(literal(\'token-number-0\')'))
    expect(f).toBeDefined()
    expect(f!.shape.length).toBe(160)
    expect(f!.shape.endsWith('…')).toBe(true)
  })

  it('stops descending at depth and says so with `tag(…)`', () => {
    const deep = (): Combinator<unknown> =>
      sequence(sequence(sequence(sequence(literal('deepest')))))
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: sequence(literal('1'), deep()),
      B: sequence(literal('2'), deep()),
    }))))
    expect(r.duplicates.some(d => d.shape.includes('sequence(…)'))).toBe(true)
  })
})

describe('formatDuplicationFindings — the lines a reader acts on', () => {
  it('produces nothing at all for a clean grammar, and counts zero', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({ A: literal('a') }))))
    expect(formatDuplicationFindings(r)).toEqual([])
    expect(duplicationFindingCount(r)).toBe(0)
  })

  it('renders a duplicate as headline / at: / fix:, in that order', () => {
    const mk = (): Combinator<unknown> => sequence(literal('('), regex(/\d+/), literal(')'))
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: sequence(literal('a'), mk()),
      B: sequence(literal('b'), mk()),
      C: sequence(literal('c'), mk()),
    }))))
    const lines = formatDuplicationFindings(r)
    const head = lines.findIndex(l => l.startsWith('parseman duplication:'))
    expect(head).toBeGreaterThanOrEqual(0)
    expect(lines[head]).toBe(
      "parseman duplication: 3× identical 4-node shape (saves 8 nodes) — sequence(literal('('), regex(/\\d+/), literal(')'))",
    )
    expect(lines[head + 1]).toBe('     at: A › seq[1]\n      B › seq[1]\n      C › seq[1]')
    expect(lines[head + 2]!.startsWith('   fix: ')).toBe(true)
  })

  it('truncates the site list at six and says how many more there are', () => {
    const mk = (): Combinator<unknown> => sequence(literal('('), regex(/\d+/), literal(')'))
    const g: Record<string, Combinator<unknown>> = {}
    for (let i = 0; i < 8; i++) g[`R${i}`] = sequence(literal(String(i)), mk())
    const lines = formatDuplicationFindings(analyzeDuplicationRules(entries(rules(() => g))))
    const at = lines.find(l => l.startsWith('     at: '))!
    expect(at.split('\n')).toHaveLength(7)
    expect(at.endsWith('… and 2 more')).toBe(true)
  })

  it('renders a regex fragment with its branch count and its sites', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: regex(/>=|<=|=>|=</),
      B: regex(/(?:>=|<=|=>|=<)x/),
      C: regex(/y(?:>=|<=|=>|=<)/),
    }))))
    const lines = formatDuplicationFindings(r)
    const head = lines.findIndex(l => l.startsWith('parseman regex-fragment:'))
    expect(head).toBeGreaterThanOrEqual(0)
    expect(lines[head]).toBe('parseman regex-fragment: `>=|<=|=>|=<` (4 branches) re-spelled in 3 regex() terminals')
    expect(lines[head + 1]).toBe('     at: A\n      B\n      C')
    expect(lines[head + 2]!.startsWith('   fix: ')).toBe(true)
  })

  it('renders a near-duplicate with the differing slot and its variants', () => {
    const scaffold = (value: Combinator<unknown>): Combinator<unknown> =>
      sequence(regex(/[a-z]+/), literal(':'), value, optional(literal(';')))
    const r = analyzeDuplicationRules(entries(rules(() => ({
      NumDecl: scaffold(regex(/\d+/)),
      StrDecl: scaffold(regex(/"[^"]*"/)),
      IdDecl: scaffold(regex(/[A-Z]+/)),
    }))))
    const lines = formatDuplicationFindings(r)
    const head = lines.findIndex(l => l.startsWith('parseman near-duplication:'))
    expect(head).toBeGreaterThanOrEqual(0)
    expect(lines[head]).toContain('3 clones of a')
    expect(lines[head]).toContain('differing at ONE slot')
    expect(lines[head + 1]!.startsWith('   slot: ')).toBe(true)
    expect(lines[head + 1]).toContain(' ∈ { ')
    expect(lines[head + 2]!.startsWith('     at: ')).toBe(true)
  })

  it('renders a regex class, flagging DRIFT and the BMP ceiling, one line per variant', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: regex(/[-_a-zA-Z0-9-￿]+/),
      B: regex(/[_a-zA-Z-￿]+/),
      C: regex(/[-_a-zA-Z0-9@$-￿]+/),
    }))))
    const lines = formatDuplicationFindings(r)
    const head = lines.findIndex(l => l.startsWith('parseman regex-class'))
    expect(lines[head]!.startsWith('parseman regex-class DRIFT: [')).toBe(true)
    expect(lines[head]).toContain('across 3 regex() terminals')
    expect(lines[head]).toContain('[BMP ceiling]')
    // One variant line per distinct spelling, each carrying its ×count and its delta.
    const variants = r.regexClasses[0]!.variants.length
    expect(variants).toBe(3)
    for (let i = 1; i <= variants; i++) expect(lines[head + i]).toMatch(/^ {6}\[.*\] {2}×1 {2}/)
    expect(lines[head + variants + 1]!.startsWith('   fix: ')).toBe(true)
  })

  it('renders a keyword regex, naming the vocabulary size, the hazards and the case-fold risk', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: regex(/red|redish|blue/i),
    }))))
    const lines = formatDuplicationFindings(r)
    const head = lines.findIndex(l => l.includes('keyword-regex @'))
    expect(head).toBeGreaterThanOrEqual(0)
    expect(lines[head]!.startsWith('parseman BUG keyword-regex @ A: /red|redish|blue/i')).toBe(true)
    expect(lines[head]).toContain('[3 literal words, NOT longest-first]')
    expect(lines[head]).toContain('[1 prefix hazard(s), UNRESCUED]')
    expect(lines[head]).toContain('[CASE-FOLD RISK]')
    expect(lines[head + 1]!.startsWith('   fix: ')).toBe(true)
  })

  it('drops the BUG marker and the risk markers when the alternation is safe', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: regex(/redish|blue|red/),
    }))))
    const head = formatDuplicationFindings(r).find(l => l.includes('keyword-regex @'))!
    expect(head.startsWith('parseman keyword-regex @ A: /redish|blue|red/')).toBe(true)
    expect(head).not.toContain('BUG')
    expect(head).not.toContain('prefix hazard')
    expect(head).not.toContain('CASE-FOLD RISK')
    expect(head).not.toContain('NOT longest-first')
  })

  it('truncates a very long regex source at 88 characters', () => {
    const words = Array.from({ length: 40 }, (_, i) => `colour-name-${i}`)
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: regex(new RegExp(words.join('|'))),
    }))))
    const head = formatDuplicationFindings(r).find(l => l.includes('keyword-regex @'))!
    expect(head).toContain('…/')
    expect(head).toContain('[40 literal words')
  })

  it('renders a rewrite with from:/to:/fix:, and a perf line only when there is one', () => {
    const r = analyzeDuplication(choice(sequence(literal('a'), literal('b')), literal('b')))
    const lines = formatDuplicationFindings(r)
    const head = lines.findIndex(l => l.startsWith('parseman rewrite ['))
    expect(head).toBeGreaterThanOrEqual(0)
    expect(lines[head + 1]!.startsWith('  from: ')).toBe(true)
    expect(lines[head + 2]!.startsWith('    to: ')).toBe(true)
    expect(lines[head + 3]!.startsWith('   fix: ')).toBe(true)
  })

  it('marks a duplicated arm as a BUG and carries the perf sentence', () => {
    const r = analyzeDuplication(choice(literal('a'), literal('b'), literal('a')))
    const lines = formatDuplicationFindings(r)
    const head = lines.findIndex(l => l.startsWith('parseman BUG ['))
    expect(head).toBeGreaterThanOrEqual(0)
    expect(lines.some(l => l.startsWith('  perf: removes a speculative arm'))).toBe(true)
  })

  it('renders a REWRITE whose from/to name the two shapes', () => {
    const r = analyzeDuplication(choice(sequence(literal('a'), literal('b')), literal('b')))
    const lines = formatDuplicationFindings(r)
    const head = lines.findIndex(l => l.startsWith('parseman rewrite ['))
    expect(lines[head + 1]).toBe("  from: choice(sequence(literal('a'), literal('b')), literal('b'))")
    expect(lines[head + 2]).toBe("    to: sequence(optional(literal('a')), literal('b'))")
  })

  it('counts findings ACROSS families, not just the biggest one', () => {
    const mk = (): Combinator<unknown> => sequence(literal('('), regex(/\d+/), literal(')'))
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: sequence(literal('a'), mk()),
      B: sequence(literal('b'), mk()),
      K: regex(/red|redish|blue/i),
    }))))
    // One exact duplicate, one near-duplicate and one keyword regex — three findings,
    // drawn from three different lists. A count that read only `duplicates` says 1.
    expect(r.duplicates).toHaveLength(1)
    expect(r.nearDuplicates).toHaveLength(1)
    expect(r.keywordRegexes).toHaveLength(1)
    expect(duplicationFindingCount(r)).toBe(3)
  })
})

describe('siteToString', () => {
  it('omits the separator when the finding sits on the rule itself', () => {
    expect(siteToString({ rule: 'A', path: '' })).toBe('A')
    expect(siteToString({ rule: 'A', path: 'seq[1]' })).toBe('A › seq[1]')
  })
})

// ── the ALGEBRA: which rewrites fire, and which deliberately do not ──────────
//
// Each rewrite family below is asserted BOTH ways — the shape that fires it and the
// near-miss that must not. A one-sided test passes just as well against a predicate
// that always returns true, which is exactly how a rewrite family becomes noise.

describe('idempotent nesting — every pair the algebra names, and the ones it refuses', () => {
  const collapsed = (entry: Combinator<unknown>): { from: string; to: string; bug: boolean }[] =>
    analyzeDuplication(entry).rewrites
      .filter(r => r.rewrite === 'idempotent-nesting')
      .map(r => ({ from: r.from, to: r.to, bug: r.bug }))

  it('optional(optional(X)) collapses to optional(X)', () => {
    expect(collapsed(optional(optional(literal('a')))))
      .toEqual([{ from: "optional(optional(literal('a')))", to: 'optional(X)', bug: false }])
  })

  it('optional(many(X)) and many(many(X)) collapse to many(X)', () => {
    expect(collapsed(optional(many(literal('a')))))
      .toEqual([{ from: "optional(many(literal('a')))", to: 'many(X)', bug: false }])
    expect(collapsed(many(many(literal('a')))))
      .toEqual([{ from: "many(many(literal('a')))", to: 'many(X)', bug: false }])
  })

  it('many(optional(X)) collapses to many(X) and is the ONLY one flagged as a hazard', () => {
    expect(collapsed(many(optional(literal('a')))))
      .toEqual([{ from: "many(optional(literal('a')))", to: 'many(X)', bug: true }])
    expect(collapsed(many(optional(literal('a'))))[0]!.bug).toBe(true)
    expect(collapsed(optional(many(literal('a'))))[0]!.bug).toBe(false)
  })

  it('optional(oneOrMore(X)) and many(oneOrMore(X)) collapse to many(X)', () => {
    expect(collapsed(optional(oneOrMore(literal('a')))).map(r => r.to)).toEqual(['many(X)'])
    expect(collapsed(many(oneOrMore(literal('a')))).map(r => r.to)).toEqual(['many(X)'])
  })

  it('refuses a BOUNDED oneOrMore — a bound is not idempotent', () => {
    expect(collapsed(optional(oneOrMore(literal('a'), { max: 3 })))).toEqual([])
    expect(collapsed(many(oneOrMore(literal('a'), { min: 2 })))).toEqual([])
    expect(collapsed(optional(oneOrMore(literal('a'), { min: 2, max: 4 })))).toEqual([])
  })

  it('does not fire on a repeat over something that is not a repeat', () => {
    expect(collapsed(many(literal('a')))).toEqual([])
    expect(collapsed(optional(sequence(literal('a'), literal('b'))))).toEqual([])
  })
})

describe('a one-element wrapper — choice(X) and sequence(X) are NOT the same finding', () => {
  it('choice(X) is AST-neutral, names the dispatch cost and says it is safe to unwrap', () => {
    const found = analyzeDuplication(choice(sequence(literal('a'), literal('b')))).rewrites
      .filter(r => r.rewrite === 'single-element')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      astNeutral: true,
      to: "sequence(literal('a'), literal('b'))",
      perf: 'a one-arm choice still emits its dispatch scaffolding.',
    })
    expect(found[0]!.suggestion).toContain('a `choice` with one arm IS that arm')
    expect(found[0]!.suggestion).not.toContain('1-tuple')
  })

  it('sequence(X) is NOT AST-neutral, carries no perf claim and warns about the 1-tuple', () => {
    const found = analyzeDuplication(sequence(choice(literal('a'), literal('b')))).rewrites
      .filter(r => r.rewrite === 'single-element')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ astNeutral: false, perf: '' })
    expect(found[0]!.to)
      .toBe("choice(literal('a'), literal('b')) (note: sequence() of one still wraps its value in a 1-tuple)")
    expect(found[0]!.suggestion).toContain('CANDIDATE, verify AST identity first')
  })

  it('omits the perf line entirely for the sequence case', () => {
    const lines = formatDuplicationFindings(analyzeDuplication(sequence(choice(literal('a'), literal('b')))))
    const idx = lines.findIndex(l => l.includes('[single-element]'))
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(lines.slice(idx, idx + 4).some(l => l.startsWith('  perf:'))).toBe(false)
  })
})

describe('left-factoring says whether the compiler already paid for it', () => {
  it('claims a REAL saving when the arms do not qualify for the sharedPrefix strategy', () => {
    // `sharedPrefix` deliberately refuses a case-INSENSITIVE literal as a shareable
    // left factor, so the arms still spell an identical leading term while the
    // strategy does not apply — and the speculative arm is really paid for at runtime.
    const ci = (): Combinator<string> => literal('a', { caseInsensitive: true })
    const found = analyzeDuplication(choice(
      sequence(ci(), literal('b'), literal('c')),
      sequence(ci(), literal('b'), literal('d')),
    )).rewrites.filter(r => r.rewrite === 'left-factor')
    expect(found).toHaveLength(1)
    expect(found[0]!.perf).toContain('removes a speculative arm')
    expect(found[0]!.perf).not.toContain('NONE')
    expect(found[0]!.suggestion).toContain('Left-factor to `sequence(prefix, choice(tailA, tailB))`')
    expect(found[0]!.suggestion).not.toContain('already collapses this AT RUNTIME')
  })
})

describe('hand-rolled sepBy detection — the near misses it must refuse', () => {
  const sepBys = (entry: Combinator<unknown>): string[] =>
    analyzeDuplication(entry).rewrites.filter(r => r.rewrite === 'hand-rolled-sepby').map(r => r.to)

  it('accepts the canonical shape', () => {
    expect(sepBys(sequence(literal('a'), many(sequence(literal(','), literal('a')))))).toHaveLength(1)
  })

  it('refuses a repetition whose body is not a TWO-element sequence', () => {
    expect(sepBys(sequence(literal('a'), many(literal(','))))).toEqual([])
    expect(sepBys(sequence(literal('a'), many(sequence(literal(','), literal('a'), literal('!')))))).toEqual([])
  })

  it('refuses a repetition whose repeated item is not the leading item', () => {
    expect(sepBys(sequence(literal('a'), many(sequence(literal(','), literal('b')))))).toEqual([])
  })

  it('refuses a third term that is not `optional(sep)`', () => {
    expect(sepBys(sequence(literal('a'), many(sequence(literal(','), literal('a'))), literal(';')))).toEqual([])
    expect(sepBys(sequence(literal('a'), many(sequence(literal(','), literal('a'))), optional(literal(';')))))
      .toEqual([])
  })

  it('accepts the trailing form when the third term IS optional(sep)', () => {
    expect(sepBys(sequence(literal('a'), many(sequence(literal(','), literal('a'))), optional(literal(',')))))
      .toEqual(["sepBy(literal('a'), literal(','), { trailing: 'allow' }, { min: 1 })"])
  })

  it('refuses a sequence of more than three terms', () => {
    expect(sepBys(sequence(
      literal('a'), many(sequence(literal(','), literal('a'))), optional(literal(',')), literal('!'),
    ))).toEqual([])
  })
})

describe('an ANONYMOUS node is named "(anonymous)" everywhere it is mentioned', () => {
  it('names it in the AST-neutrality caveat of an optional-prefix rewrite', () => {
    const found = analyzeDuplication(node(choice(
      sequence(literal('a'), literal('b')),
      sequence(literal('b')),
    ))).rewrites.filter(r => r.rewrite.startsWith('optional-'))
    expect(found).toHaveLength(1)
    expect(found[0]!.suggestion).toContain("this sits under `node('(anonymous)')`")
  })
})

describe('structure loss — an earlier arm that flattens what a later arm structures', () => {
  const grammar = rules(g => ({
    Entry: choice(
      // Flat: builds Decl over bare leaves.
      node('Decl', sequence(literal('a'), regex(/[a-z]+/))),
      // Rich: builds Decl with child nodes under it.
      node('Decl', sequence(literal('a'), g.Value)),
    ),
    Value: node('Value', sequence(regex(/[a-z]+/), literal('!'))),
  }))

  it('names the flattening arm, the structuring arm and the node types lost', () => {
    const found = analyzeDuplicationRules(entries(grammar)).structureLoss
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      kind: 'structure-loss',
      nodeType: 'Decl',
      earlier: 0,
      later: 1,
      lostNodeTypes: ['Value'],
    })
    expect(found[0]!.earlierShape).toBe("node('Decl', sequence(literal('a'), regex(/[a-z]+/)))")
    expect(found[0]!.laterShape).toBe("node('Decl', sequence(literal('a'), g.Value))")
  })

  it('renders the flat / rich / lost triple in that order, as a BUG', () => {
    const lines = formatDuplicationFindings(analyzeDuplicationRules(entries(grammar)))
    expect(lines[0]).toContain('parseman BUG [structure-loss]')
    expect(lines[0]).toContain('arm[0] flattens `Decl` where arm[1] structures it')
    expect(lines[1]!.startsWith('  flat: ')).toBe(true)
    expect(lines[2]!.startsWith('  rich: ')).toBe(true)
    expect(lines[3]).toBe('  lost: `Value`')
    expect(lines[4]!.startsWith('   fix: ')).toBe(true)
  })

  it('is NOT reported when the earlier arm also builds a nested node', () => {
    const structured = rules(g => ({
      Entry: choice(
        node('Decl', sequence(literal('a'), g.Value)),
        node('Decl', sequence(literal('a'), g.Value, literal('?'))),
      ),
      Value: node('Value', sequence(regex(/[a-z]+/), literal('!'))),
    }))
    expect(analyzeDuplicationRules(entries(structured)).structureLoss).toEqual([])
  })

  it('is NOT reported when the two arms build DIFFERENT node types', () => {
    const differing = rules(g => ({
      Entry: choice(
        node('Flat', sequence(literal('a'), regex(/[a-z]+/))),
        node('Rich', sequence(literal('a'), g.Value)),
      ),
      Value: node('Value', sequence(regex(/[a-z]+/), literal('!'))),
    }))
    expect(analyzeDuplicationRules(entries(differing)).structureLoss).toEqual([])
  })

  it('sees THROUGH a label wrapper to the node the arm really builds', () => {
    const labelled = rules(g => ({
      Entry: choice(
        label('flat', node('Decl', sequence(literal('a'), regex(/[a-z]+/)))),
        label('rich', node('Decl', sequence(literal('a'), g.Value))),
      ),
      Value: node('Value', sequence(regex(/[a-z]+/), literal('!'))),
    }))
    expect(analyzeDuplicationRules(entries(labelled)).structureLoss.map(f => f.nodeType)).toEqual(['Decl'])
  })
})

describe('divergent-node productions and their unique terms', () => {
  const grammar = rules(() => ({
    Entry: choice(
      node('D', sequence(literal('a'), literal('b'))),
      node('D', sequence(literal('a'), literal('b'), literal('c'))),
    ),
  }))

  it('writes "(none)" for the production that has no term of its own', () => {
    const lines = formatDuplicationFindings(analyzeDuplicationRules(entries(grammar)))
      .filter(l => l.includes('unique to it:'))
    expect(lines).toHaveLength(2)
    expect(lines.some(l => l.includes('unique to it: (none)'))).toBe(true)
    expect(lines.some(l => l.includes("unique to it: `literal('c')`"))).toBe(true)
  })

  it('lists the terms every production shares, which is the evidence they are one shape', () => {
    const found = analyzeDuplicationRules(entries(grammar)).divergentNodes
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ nodeType: 'D', count: 2 })
    expect(found[0]!.sharedTerms).toEqual(["literal('a')", "literal('b')"])
    expect(found[0]!.productions.map(p => p.distinctTerms)).toEqual([[], ["literal('c')"]])
  })
})
