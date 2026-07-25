/**
 * Structural grammar-duplication diagnostic (src/analysis/duplication.ts) and its
 * OPT-IN wiring into every lowering path.
 *
 * The wiring tests are not ceremony. The gating diagnostic was default-on and
 * BLIND in the macro build for two minor versions, because `compileRuleMap` and
 * `compileLinkable` — the only paths a macro-built `rules()` grammar takes — never
 * called it, so grammars with dozens of findings reported zero. Each path here is
 * asserted to actually run the analysis.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  analyzeDuplication, analyzeDuplicationRules, formatDuplicationFindings,
  duplicationFindingCount, alternationGroups, charClassMembers, extractCharClasses,
  keywordRegexShape, siteToString,
  choice, sequence, literal, regex, many, optional, node, field, ref, withCtx, keywords, rules, compile,
} from '../../src/index.ts'
import { compileRuleMap, compileLinkable } from '../../src/compiler/codegen.ts'
import { compose } from '../../src/compiler/linker.ts'
import type { Combinator } from '../../src/types.ts'

const entries = (g: Record<string, Combinator<unknown>>): [string, Combinator<unknown>][] => Object.entries(g)

describe('exact duplicates', () => {
  it('reports N DISTINCT instances of one shape, ranked by nodes saved', () => {
    const mk = (): Combinator<unknown> => sequence(literal('('), regex(/\d+/), literal(')'))
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: sequence(literal('a'), mk()),
      B: sequence(literal('b'), mk()),
      C: sequence(literal('c'), mk()),
    }))))
    const f = r.duplicates.find(d => d.count === 3)
    expect(f).toBeDefined()
    expect(f!.size).toBe(4)
    expect(f!.savings).toBe(8)
    expect(f!.sites.map(s => s.rule).sort()).toEqual(['A', 'B', 'C'])
  })

  it('SHARED BY REFERENCE is not duplication — one object used thrice is one instance', () => {
    const shared = sequence(literal('('), regex(/\d+/), literal(')'))
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: sequence(literal('a'), shared),
      B: sequence(literal('b'), shared),
      C: sequence(literal('c'), shared),
    }))))
    expect(r.duplicates.filter(d => d.size === 4)).toHaveLength(0)
  })

  it('minSize keeps trivial two-node wrappers out of the ranking', () => {
    const g = rules(() => ({
      A: sequence(optional(literal('x')), literal('a')),
      B: sequence(optional(literal('x')), literal('b')),
    }))
    expect(analyzeDuplicationRules(entries(g)).duplicates).toHaveLength(0)
    expect(analyzeDuplicationRules(entries(g), { minSize: 2 }).duplicates.length).toBeGreaterThan(0)
  })
})

describe('near duplicates', () => {
  it('finds clones differing at exactly ONE slot and names the slot', () => {
    const scaffold = (value: Combinator<unknown>): Combinator<unknown> =>
      sequence(regex(/[a-z]+/), literal(':'), value, optional(literal(';')))
    const r = analyzeDuplicationRules(entries(rules(() => ({
      NumDecl: scaffold(regex(/\d+/)),
      StrDecl: scaffold(regex(/"[^"]*"/)),
    }))))
    expect(r.nearDuplicates).toHaveLength(1)
    const f = r.nearDuplicates[0]!
    expect(f.count).toBe(2)
    expect(f.slotPath).toBe('seq[2]')
    expect(f.variants).toEqual(['regex(/\\d+/)', 'regex(/"[^"]*"/)'])
    expect(f.shape).toContain('‹slot›')
    expect(f.suggestion).toContain('choice(')
  })

  it('a subtree wholly inside a bigger reported finding is not reported again', () => {
    const scaffold = (v: Combinator<unknown>): Combinator<unknown> =>
      sequence(regex(/[a-z]+/), literal(':'), sequence(literal('('), v, literal(')')), optional(literal(';')))
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: scaffold(regex(/\d+/)),
      B: scaffold(regex(/"[^"]*"/)),
    }))))
    expect(r.nearDuplicates).toHaveLength(1)
  })
})

describe('regex fragments and character classes', () => {
  it('alternationGroups sees branch lists at EVERY nesting depth', () => {
    expect(alternationGroups('a|b')).toEqual([['a', 'b']])
    expect(alternationGroups('x(?:a|b)y')).toEqual([['a', 'b']])
    expect(alternationGroups('[a|b]')).toEqual([])       // inside a class, `|` is a member
  })

  it('finds one alternation run re-spelled across several terminals', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: regex(/>=|<=|=>|=<|=~|[<>=]/),
      B: regex(/(?:>=|<=|=>|=<|=~|[<>=]|(?:and|or)(?![-\w]))/i),
      C: regex(/[ \t]*(?:>=|<=|=>|=<|=~|[<>=])[ \t]*/),
    }))))
    const f = r.regexFragments.find(x => x.fragment === '>=|<=|=>|=<|=~|[<>=]')
    expect(f).toBeDefined()
    expect(f!.count).toBe(3)
    expect(f!.branches).toBe(6)
    // Sub-runs of a maximal run are noise, not extra findings.
    expect(r.regexFragments.some(x => x.fragment === '>=|<=|=>|=<')).toBe(false)
  })

  it('a code-point ESCAPE and the raw character are the same class member', () => {
    expect(charClassMembers('a-z\\u0080-\\uffff')).toEqual(['a-z', '\\u0080-\\uffff'])
    expect(charClassMembers('a-z-￿')).toEqual(['a-z', '\\u0080-\\uffff'])
    expect(extractCharClasses('x[abc]y(?![-\\w])')).toEqual(['abc', '-\\w'])
  })

  it('groups NEAR-identical classes so the drift is visible side by side', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: regex(/[-_a-zA-Z0-9-￿]+/),
      B: regex(/[_a-zA-Z-￿]+/),
      C: regex(/[-_a-zA-Z0-9@$-￿]+/),
    }))))
    const f = r.regexClasses[0]!
    expect(f.drifted).toBe(true)
    expect(f.count).toBe(3)
    expect(f.variants).toHaveLength(3)
    expect(f.variants.map(v => v.delta).join(' ')).toContain('+`@`')
    expect(f.bmpCeiling).toBe(true)
  })

  it('a negated class never clusters with a positive one', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: regex(/[;{}]/), B: regex(/[^;{}]/),
    }))))
    expect(r.regexClasses.filter(f => f.drifted)).toHaveLength(0)
  })
})

describe('algebraic rewrites', () => {
  it('choice(sequence(A, B), B) is sequence(optional(A), B)', () => {
    const r = analyzeDuplication(node('Rest', choice(sequence(regex(/@\w+/), literal('...')), literal('...'))))
    const f = r.rewrites.find(x => x.rewrite === 'optional-prefix')
    expect(f).toBeDefined()
    expect(f!.to).toBe("sequence(optional(regex(/@\\w+/)), literal('...'))")
    // The rewrite changes the child array, so it is a candidate, never a "fix this".
    expect(f!.astNeutral).toBe(false)
    expect(f!.suggestion).toContain('verify AST identity')
    expect(f!.suggestion).toContain("node('Rest')")
    expect(f!.perf).toContain('speculative arm')
  })

  it('the SHORTER arm first is flagged as an order question', () => {
    const r = analyzeDuplication(choice(literal('...'), sequence(regex(/@\w+/), literal('...'))))
    const f = r.rewrites.find(x => x.rewrite === 'optional-prefix')
    expect(f!.suggestion).toContain('NOTE THE ORDER')
  })

  it('sequence(X, many(sequence(S, X))) is sepBy(X, S)', () => {
    const item = regex(/\w+/)
    const r = analyzeDuplication(sequence(item, many(sequence(literal(','), item))))
    const f = r.rewrites.find(x => x.rewrite === 'hand-rolled-sepby')
    expect(f).toBeDefined()
    expect(f!.to).toContain('sepBy(regex(/\\w+/)')
    expect(f!.to).toContain('min: 1')
  })

  it('a trailing optional separator becomes sepBy(..., { trailing: \'allow\' })', () => {
    const item = regex(/\w+/)
    const r = analyzeDuplication(sequence(item, many(sequence(literal(','), item)), optional(literal(','))))
    const f = r.rewrites.find(x => x.rewrite === 'hand-rolled-sepby')
    expect(f!.to).toContain("trailing: 'allow'")
  })

  it('a duplicated arm is reported as a BUG and is AST-neutral to delete', () => {
    const r = analyzeDuplication(choice(sequence(literal('a'), literal('b')), literal('z'), sequence(literal('a'), literal('b'))))
    const f = r.rewrites.find(x => x.rewrite === 'duplicate-arm')
    expect(f).toBeDefined()
    expect(f!.bug).toBe(true)
    expect(f!.astNeutral).toBe(true)
  })

  it('an arm shadowed by an earlier prefix arm is reported as a BUG', () => {
    const r = analyzeDuplication(choice(sequence(literal('a')), sequence(literal('a'), literal('b'))))
    const f = r.rewrites.find(x => x.rewrite === 'shadowed-arm')
    expect(f).toBeDefined()
    expect(f!.bug).toBe(true)
    expect(f!.suggestion).toContain('never be selected')
  })

  it('idempotent nesting collapses, and many(optional(X)) is called out as a hazard', () => {
    expect(analyzeDuplication(optional(optional(literal('x')))).rewrites[0]!.to).toBe('optional(X)')
    const f = analyzeDuplication(many(optional(literal('x')))).rewrites.find(x => x.rewrite === 'idempotent-nesting')!
    expect(f.to).toBe('many(X)')
    expect(f.bug).toBe(true)
  })

  it('left-factoring says whether sharedPrefix already handles it at runtime', () => {
    const r = analyzeDuplication(choice(
      sequence(literal('('), literal('a'), literal(')')),
      sequence(literal('('), literal('b'), literal(')')),
    ))
    const f = r.rewrites.find(x => x.rewrite === 'left-factor')!
    expect(f.perf).toContain('sharedPrefix')
    expect(f.suggestion).toContain('readability')
  })
})

describe('divergent node productions', () => {
  it('one node type built by two different productions sharing terms', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      Declaration: choice(
        node('Declaration', sequence(regex(/[a-z]+/), literal(':'), regex(/\d+/), optional(literal(';')))),
        node('Declaration', sequence(regex(/[a-z-]+/), literal(':'), regex(/[^;]+/), optional(literal(';')))),
      ),
    }))))
    expect(r.divergentNodes).toHaveLength(1)
    const f = r.divergentNodes[0]!
    expect(f.nodeType).toBe('Declaration')
    expect(f.count).toBe(2)
    expect(f.sharedTerms).toContain("literal(':')")
    expect(f.suggestion).toContain('has to land in all 2')
  })

  it('two productions of a node type that share nothing are NOT reported', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: node('V', sequence(literal('a'), literal('b'))),
      B: node('V', sequence(literal('x'), literal('y'))),
    }))))
    expect(r.divergentNodes).toHaveLength(0)
  })
})

describe('hand-rolled keyword regexes', () => {
  it('keywordRegexShape recognizes a word plus a boundary guard, and only that', () => {
    expect(keywordRegexShape('not(?![-\\w])')).toEqual({ words: ['not'], boundary: '-\\w' })
    expect(keywordRegexShape('(?:and|or)(?![-\\w])')).toEqual({ words: ['and', 'or'], boundary: '-\\w' })
    expect(keywordRegexShape('not')).toBeNull()               // no boundary: an ordinary regex
    expect(keywordRegexShape('\\d+(?![-\\w])')).toBeNull()     // not a word
  })

  it('names the exact call, and reports /i without /u as a CASE-FOLD bug', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      Not: regex(/not(?![-\w])/i),
      And: regex(/and(?![-\w])/i),
      Or: regex(/or(?![-\w])/i),
    }))))
    expect(r.keywordRegexes).toHaveLength(3)
    const notK = r.keywordRegexes.find(f => f.words[0] === 'not')!
    expect(notK.caseFoldRisk).toBe(true)
    expect(notK.suggestion).toContain("word('not', '-\\\\w', { caseInsensitive: true })")
    expect(notK.suggestion).toContain('CORRECTNESS, not style')
  })

  it('sibling keyword arms of one choice are cross-referenced', () => {
    const r = analyzeDuplication(choice(regex(/and(?![-\w])/i), regex(/or(?![-\w])/i), literal('!')))
    const f = r.keywordRegexes.find(x => x.words[0] === 'and')!
    expect(f.siblingArms).toEqual([1])
    expect(f.suggestion).toContain('longest-match dispatch')
  })

  it('no /i means no case-fold claim', () => {
    const r = analyzeDuplication(regex(/all(?![-\w])/))
    expect(r.keywordRegexes[0]!.caseFoldRisk).toBe(false)
    expect(r.keywordRegexes[0]!.suggestion).not.toContain('CORRECTNESS')
  })
})

describe('choice-arm overlap', () => {
  it('reports WHICH arms overlap, on what, and the shared leading terms', () => {
    const r = analyzeDuplication(choice(
      sequence(literal('a'), literal('b'), literal('c')),
      sequence(literal('a'), literal('b'), literal('d')),
    ))
    const f = r.overlaps[0]!
    expect(f.a).toBe(0)
    expect(f.b).toBe(1)
    expect(f.sharedLeadingTerms).toBe(2)
    expect(f.sharedPrefix).toBe("literal('a'), literal('b')")
    expect(f.handledByStrategy).toBe(true)
    expect(f.suggestion).toContain('READABILITY')
  })

  it('two regex arms whose classes intersect are flagged as a regex pair', () => {
    const r = analyzeDuplication(choice(regex(/[a-m]+/), regex(/[h-z]+/)))
    const f = r.overlaps[0]!
    expect(f.regexPair).toBe(true)
    expect(f.sharedLeadingTerms).toBe(0)
    expect(f.suggestion).toContain('usually one terminal')
  })

  it('disjoint arms produce no overlap finding', () => {
    expect(analyzeDuplication(choice(literal('a'), literal('b'), literal('c'))).overlaps).toHaveLength(0)
  })
})

describe('a composed artifact is REJECTED loudly, never analyzed silently', () => {
  // `analyzeGating()` handed a compose()d grammar throws deep in its walker on the
  // first descriptor-less node — and on the four jess grammars that is 129 of 129
  // rules. The failure that matters is not the throw: it is that a diagnostic which
  // sees nothing reports "no findings". So the boundary is checked at the door.
  const piece = (): Record<string, Combinator<unknown>> => rules(() => ({
    Rest: node('Rest', choice(sequence(regex(/@\w+/), literal('...')), literal('...'))),
  }))

  it('compose() returns compiled parse functions, not combinators', () => {
    const fused = compose([piece()]) as Record<string, unknown>
    expect(typeof fused.Rest).toBe('function')
    expect((fused.Rest as { _def?: unknown })._def).toBeUndefined()
  })

  it('analyzing a composed artifact THROWS with an actionable message', () => {
    const fused = compose([piece()]) as unknown as Record<string, Combinator<unknown>>
    expect(() => analyzeDuplicationRules(Object.entries(fused)))
      .toThrow(/is not a combinator \(no _def\)[\s\S]*rules\(\) map/)
  })

  it('the SAME grammar analyzed as its rules() map produces real findings', () => {
    // Silence is not a possible outcome: either the input is analyzable and the
    // findings are real, or the call fails loudly. This is the analyzable half.
    const r = analyzeDuplicationRules(entries(piece()))
    expect(r.stats.nodes).toBeGreaterThan(0)
    expect(r.rewrites.some(f => f.rewrite === 'optional-prefix')).toBe(true)
  })
})

describe('hand-rolled sepBy gives a VERDICT per site, not a count', () => {
  const listOf = (sep: Combinator<unknown>): Combinator<unknown> => {
    const item = regex(/\w+/)
    return sequence(item, many(sequence(sep, item)))
  }

  it('a plain list with no capture and no reducer is convertible', () => {
    const f = analyzeDuplication(listOf(literal(','))).rewrites.find(x => x.rewrite === 'hand-rolled-sepby')!
    expect(f.sepByVerdict).toBe('convertible')
    expect(f.to).not.toContain('NOT APPLICABLE')
  })

  it('a CAPTURED separator is blocked — sepBy cannot express it', () => {
    const f = analyzeDuplication(listOf(field('separator', literal(',')))).rewrites.find(x => x.rewrite === 'hand-rolled-sepby')!
    expect(f.sepByVerdict).toBe('blocked-by-capture')
    expect(f.to).toContain('NOT APPLICABLE')
    expect(f.suggestion).toContain('parseman gap')
    expect(f.perf).toBe('')
  })

  it('an enclosing reducer means review, not conversion — the stride changes', () => {
    const f = analyzeDuplication(node('Operation', listOf(literal('+')), (children: readonly unknown[]) => children))
      .rewrites.find(x => x.rewrite === 'hand-rolled-sepby')!
    expect(f.sepByVerdict).toBe('reducer-stride-review')
    expect(f.suggestion).toContain('STRIDES BY TWO')
  })
})

describe('payload coverage for the less-common node kinds', () => {
  it('withCtx / keywords payloads take part in structural identity', () => {
    const mk = (): Combinator<unknown> =>
      sequence(withCtx({ mode: 'math' }, keywords(['and', 'or', 'not'], { boundary: '-\\w' })), literal('!'))
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: sequence(literal('a'), mk()),
      B: sequence(literal('b'), mk()),
    }))))
    const f = r.duplicates.find(d => d.count === 2 && d.shape.includes('keywords'))
    expect(f).toBeDefined()
    expect(f!.shape).toContain("'and'")
  })

  it('a differing withCtx payload makes two otherwise-identical shapes distinct', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: sequence(withCtx({ mode: 'math' }, literal('x')), literal('!')),
      B: sequence(withCtx({ mode: 'plain' }, literal('x')), literal('!')),
    }))))
    expect(r.duplicates).toHaveLength(0)
  })

  it('two UNNAMED unresolvable refs are distinct slots — nothing can bind them alike', () => {
    const mk = (): Combinator<unknown> => sequence(literal('('), ref<unknown>(), literal(')'))
    const r = analyzeDuplicationRules(entries(rules(() => ({ A: mk(), B: mk() }))))
    expect(r.duplicates.filter(d => d.size === 4)).toHaveLength(0)
  })
})

describe('ranking and rendering across several findings', () => {
  it('every list is ranked, and every finding renders', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      P: node('D', sequence(regex(/[a-z]+/), literal(':'), regex(/\d+/), optional(literal(';')))),
      Q: node('D', sequence(regex(/[a-z-]+/), literal(':'), regex(/[^;]+/), optional(literal(';')))),
      R: node('E', sequence(literal('#'), regex(/[0-9a-fA-F]+/), literal(';'))),
      S: node('E', sequence(literal('#'), regex(/[0-9A-Fa-f?]+/), literal(';'))),
      T: sequence(regex(/[a-z]+/), literal('='), regex(/\d+/), optional(literal('!'))),
      U: sequence(regex(/[a-z]+/), literal('='), regex(/"[^"]*"/), optional(literal('!'))),
      V: choice(regex(/[a-m]+/), regex(/[h-z]+/), regex(/[c-f]+/)),
    }))))
    expect(r.divergentNodes.length).toBeGreaterThanOrEqual(2)
    expect(r.nearDuplicates.length).toBeGreaterThanOrEqual(1)
    expect(r.overlaps.length).toBeGreaterThanOrEqual(2)
    const text = formatDuplicationFindings(r).join('\n')
    expect(text).toContain('parseman divergent-node:')
    expect(text).toContain('unique to it:')
    expect(text).toContain('parseman near-duplication:')
    expect(text).toContain('parseman overlap @')
    const shared = r.overlaps.map(o => o.sharedLeadingTerms)
    expect(shared).toEqual([...shared].sort((a, b) => b - a))
    const rank = r.divergentNodes.map(d => d.sharedTerms.length * d.count)
    expect(rank).toEqual([...rank].sort((a, b) => b - a))
  })

  it('the site list is truncated once it gets long', () => {
    const mk = (): Combinator<unknown> => sequence(literal('('), regex(/\d+/), literal(')'))
    const g: Record<string, Combinator<unknown>> = {}
    for (let i = 0; i < 9; i++) g[`R${i}`] = sequence(literal(String(i)), mk())
    const r = analyzeDuplicationRules(entries(rules(() => g)))
    expect(r.duplicates[0]!.count).toBe(9)
    expect(formatDuplicationFindings(r).join('\n')).toContain('and 3 more')
  })

  it('a class re-spelled identically (no drift) is reported, ranked below drift', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: regex(/[abc]+/), B: regex(/[abc]*/),
      C: regex(/[xyz1]+/), D: regex(/[xyz]+/),
    }))))
    expect(r.regexClasses.length).toBeGreaterThanOrEqual(2)
    expect(r.regexClasses[0]!.drifted).toBe(true)
    expect(r.regexClasses.at(-1)!.drifted).toBe(false)
    expect(formatDuplicationFindings(r).join('\n')).toContain('parseman regex-class')
  })
})

describe('accept allowlist', () => {
  it('an accepted id is suppressed, and a stale one is reported for pruning', () => {
    const g = rules(() => ({ A: choice(sequence(literal('a')), sequence(literal('a'), literal('b'))) }))
    const base = analyzeDuplicationRules(entries(g))
    const id = base.rewrites.find(f => f.rewrite === 'shadowed-arm')!.id
    const r = analyzeDuplicationRules(entries(g), { accept: [id, 'no-such-finding'] })
    expect(r.rewrites.some(f => f.id === id)).toBe(false)
    expect(r.acceptedUnused).toEqual(['no-such-finding'])
  })
})

describe('sites', () => {
  it('a finding is located by rule name and structural path', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      Value: choice(sequence(literal('a')), sequence(literal('a'), literal('b'))),
    }))))
    expect(siteToString(r.rewrites[0]!.site)).toBe('Value')
    const nested = analyzeDuplicationRules(entries(rules(() => ({
      Outer: sequence(literal('x'), choice(sequence(literal('a')), sequence(literal('a'), literal('b')))),
    }))))
    expect(siteToString(nested.rewrites[0]!.site)).toBe('Outer › seq[1]')
  })
})

describe('formatting', () => {
  it('every finding renders a located, actionable line', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({
      A: choice(sequence(regex(/@\w+/), literal('...')), literal('...')),
      B: regex(/not(?![-\w])/i),
    }))))
    const text = formatDuplicationFindings(r).join('\n')
    expect(text).toContain('parseman rewrite [optional-prefix] @ A')
    expect(text).toContain('candidate — verify AST identity')
    expect(text).toContain('parseman keyword-regex @ B')
    expect(duplicationFindingCount(r)).toBeGreaterThan(0)
  })

  it('a clean grammar produces no lines at all', () => {
    const r = analyzeDuplicationRules(entries(rules(() => ({ A: literal('a'), B: literal('b') }))))
    expect(formatDuplicationFindings(r)).toHaveLength(0)
    expect(duplicationFindingCount(r)).toBe(0)
  })
})

// ── the wiring: it must RUN on every lowering path that offers the option ──

const dupGrammar = (): Record<string, Combinator<unknown>> => rules(() => ({
  Rest: node('Rest', choice(sequence(regex(/@\w+/), literal('...')), literal('...'))),
}))

describe('compile-time wiring', () => {
  it('is OFF by default — a compile with findings is silent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      compile(node('Rest', choice(sequence(regex(/@\w+/), literal('...')), literal('...'))))
      expect(warn.mock.calls.flat().join('\n')).not.toContain('parseman rewrite')
    } finally { warn.mockRestore() }
  })

  it('compile() runs it when asked', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      compile(node('Rest', choice(sequence(regex(/@\w+/), literal('...')), literal('...'))), undefined, { duplication: 'warn' })
      expect(warn.mock.calls.flat().join('\n')).toContain('parseman rewrite [optional-prefix]')
    } finally { warn.mockRestore() }
  })

  it('compileRuleMap() runs it — the path the macro build actually takes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      compileRuleMap(entries(dupGrammar()), { duplication: 'warn' })
      expect(warn.mock.calls.flat().join('\n')).toContain('parseman rewrite [optional-prefix] @ Rest')
    } finally { warn.mockRestore() }
  })

  it('compileLinkable() runs it — the compose path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      compileLinkable(entries(dupGrammar()), '_dup_', { duplication: 'warn' })
      expect(warn.mock.calls.flat().join('\n')).toContain('parseman rewrite [optional-prefix] @ Rest')
    } finally { warn.mockRestore() }
  })

  it("level 'error' throws with the findings in the message", () => {
    expect(() => compileRuleMap(entries(dupGrammar()), { duplication: 'error' }))
      .toThrow(/duplication\/overlap finding/)
  })

  it('PARSEMAN_DUPLICATION selects the level when no option is passed', () => {
    const prev = process.env.PARSEMAN_DUPLICATION
    process.env.PARSEMAN_DUPLICATION = 'warn'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      compileRuleMap(entries(dupGrammar()))
      expect(warn.mock.calls.flat().join('\n')).toContain('parseman rewrite [optional-prefix]')
    } finally {
      warn.mockRestore()
      if (prev === undefined) delete process.env.PARSEMAN_DUPLICATION; else process.env.PARSEMAN_DUPLICATION = prev
    }
  })

  it('the accept allowlist reaches the compile-time gate', () => {
    const id = analyzeDuplicationRules(entries(dupGrammar())).rewrites.find(f => f.rewrite === 'optional-prefix')!.id
    expect(() => compileRuleMap(entries(dupGrammar()), { duplication: { level: 'error', accept: [id] } })).not.toThrow()
  })

  it('a diagnostic failure never breaks a correct compile', () => {
    // The analysis is advisory: if it throws for any reason, the compile it was
    // attached to must still produce its artifact.
    const hostile = { [Symbol.iterator](): never { throw new Error('boom') } }
    expect(() => compileRuleMap(entries(dupGrammar()), { duplication: { level: 'error', accept: hostile } }))
      .not.toThrow()
  })
})
