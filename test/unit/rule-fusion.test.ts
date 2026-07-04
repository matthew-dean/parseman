/**
 * Build-time fusion (RULE_ABI_PLAN §4): independently-compiled linkable
 * artifacts fuse into one closure of direct-call parse functions, with override
 * (open recursion), à la carte selection, and a name-closure check.
 */
import { describe, it, expect } from 'vitest'
import { rules, regex, choice, sequence, literal, optional, sepBy, compile, parse } from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import { compileLinkable } from '../../src/compiler/codegen.ts'
import { fuseRules, pick } from '../../src/compiler/linker.ts'

const link = (g: Record<string, Combinator<unknown>>, ns: string) =>
  compileLinkable([...Object.entries(g)], ns)!

const ok = (r: { ok: boolean; span: { end: number } }) => (r.ok ? r.span.end : -1)

describe('fusion — override (open recursion)', () => {
  it('overriding a rule reroutes a base rule’s own references to it', () => {
    const base = rules(g => ({ Value: choice(g.Num, g.Word), Num: regex(/[0-9]+/), Word: regex(/[a-z]+/) }))
    const over = rules(() => ({ Num: regex(/[0-9]+!/) })) // Num now needs a trailing '!'
    const R = fuseRules([link(base, '_a_'), link(over, '_b_')])
    const ctx = {}
    // base.Value calls the OVERRIDDEN Num (open recursion across artifacts):
    expect(ok(R.Value!('123!', 0, ctx))).toBe(4) // over.Num matches
    expect(ok(R.Value!('123', 0, ctx))).toBe(-1) // over.Num needs '!', Word fails → no match
    expect(ok(R.Value!('abc', 0, ctx))).toBe(3)  // Word still works
  })
})

describe('fusion — à la carte', () => {
  it('pick keeps selected rules + their dependency closure', () => {
    const g = rules(gg => ({
      A: sequence(gg.B, gg.C),
      B: regex(/b/),
      C: regex(/c/),
      Unused: regex(/z/),
    }))
    const p = link(g, '_g_')
    // Picking A pulls in B and C (deps), drops Unused.
    const picked = pick(p, ['A'])
    expect(new Set(picked.keys)).toEqual(new Set(['A', 'B', 'C']))
    const R = fuseRules([picked])
    expect(Object.keys(R).sort()).toEqual(['A', 'B', 'C'])
    expect(ok(R.A!('bc', 0, {}))).toBe(2)
  })

  it('name-closure check throws when a surviving rule references a missing rule', () => {
    // Pick only A but hand-drop its dep B → fuse must reject the dangling ref.
    const g = rules(gg => ({ A: sequence(gg.B, literal('x')), B: regex(/b/) }))
    const p = link(g, '_h_')
    const broken = { ...p, keys: ['A'], ruleFns: new Map([['A', p.ruleFns.get('A')!]]),
      wrappers: new Map([['A', p.wrappers.get('A')!]]), deps: new Map([['A', ['B']]]) }
    expect(() => fuseRules([broken])).toThrow(/missing rule "B"/)
  })
})

describe('fusion — parity with monolithic compile()', () => {
  it('a fused grammar parses identically to the same grammar compiled whole', () => {
    // Recursive nested-list grammar, compiled two ways.
    const mkList = () => rules(g => ({
      List: sequence(literal('['), optional(sepBy(g.Item, literal(','))), literal(']')),
      Item: choice(regex(/[0-9]+/), g.List),
    }))
    const whole = compile(mkList().List)
    const R = fuseRules([link(mkList(), '_l_')])
    const ctx = {}
    for (const s of ['[]', '[1]', '[1,2,3]', '[[1],[2,[3,4]]]', '[1,]', '[', 'x', '[1,[2]]']) {
      const a = whole.parse(s, 0)
      const b = R.List!(s, 0, ctx)
      expect(b.ok, s).toBe(a.ok)
      if (a.ok) expect(b.span.end, s).toBe(a.span.end)
    }
  })

  it('two independently-compiled grammars fuse and interoperate by name', () => {
    // Grammar 1 defines Digits; grammar 2 defines a rule that references Digits
    // by name — they only connect at fuse time.
    const g1 = rules(() => ({ Digits: regex(/[0-9]+/) }))
    const g2 = rules(gg => ({ Tagged: sequence(literal('#'), gg.Digits) }))
    const R = fuseRules([link(g1, '_p_'), link(g2, '_q_')])
    expect(ok(R.Tagged!('#42', 0, {}))).toBe(3)
    expect(ok(R.Tagged!('#', 0, {}))).toBe(-1)
  })
})
