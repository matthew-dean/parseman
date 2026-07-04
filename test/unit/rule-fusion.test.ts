/**
 * Build-time fusion (RULE_ABI_PLAN §4): independently-compiled linkable
 * artifacts fuse into one closure of direct-call parse functions, with override
 * (open recursion), à la carte selection, and a name-closure check.
 */
import { describe, it, expect } from 'vitest'
import { rules, regex, choice, sequence, literal, optional, sepBy, node, compile, parseDoc } from '../../src/index.ts'
import type { Combinator, Registry, NodeLike } from '../../src/index.ts'
import { compose } from '../../src/index.ts'
import { compileLinkable } from '../../src/compiler/codegen.ts'
import { fuseRules, pick, cstBuildHost } from '../../src/compiler/linker.ts'

const link = (g: Record<string, Combinator<unknown>>, ns: string) =>
  compileLinkable([...Object.entries(g)], ns)!

const ok = (r: { ok: boolean; span: { end: number } }) => (r.ok ? r.span.end : -1)

describe('macro: compose() fuses to STATIC source (eval-free)', () => {
  it('compiles compose([...]) at build with no new Function, and it parses', async () => {
    const { transformMacro } = await import('../../src/plugin/index.ts')
    const src = `import { rules, regex, choice, compose } from 'parseman' with { type: 'macro' }
const cssRules = rules(g => ({ Value: choice(g.Num, g.Word), Num: regex(/[0-9]+/), Word: regex(/[a-z]+/) }))
const lessRules = rules(g => ({ Num: regex(/[0-9]+X/) }))
export const parser = compose([cssRules, lessRules])`
    const out = transformMacro(src, '/pkg/less.ts', new Set(['parseman']))!
    expect(out.warnings).toEqual([])
    // Build-time fused: no compose() call and NO new Function anywhere.
    expect(/\bcompose\s*\(/.test(out.code)).toBe(false)
    expect(/new Function/.test(out.code)).toBe(false)
    // The emitted parser works, and the override reroutes (open recursion).
    const parser = new Function(out.code.replace(/^import[^\n]*\n/m, '').replace(/export const/g, 'var') + '\nreturn parser')() as Record<string, (i: string, p: number, c: object) => { ok: boolean; span: { end: number } }>
    expect(parser.Value!('abc', 0, {}).span.end).toBe(3)    // css.Word
    expect(parser.Value!('12X', 0, {}).span.end).toBe(3)    // css.Value → less.Num (override)
    expect(parser.Value!('12', 0, {}).ok).toBe(false)       // less.Num needs 'X'
  })
})

describe('extending a grammar via compose() — no base source, no opt-in', () => {
  it('a consumer extends a base grammar with compose([base, ext]) — override reroutes', () => {
    // A base grammar (a plain rules() result — no `linkable()` wrapper, composable
    // by default) and an extension that overrides Num. compose() takes grammars
    // directly (linkable-ifies them internally).
    const cssRules = rules(g => ({
      Value: choice(g.Num, g.Word), Num: regex(/[0-9]+/), Word: regex(/[a-z]+/),
    }))
    const lessRules = rules(() => ({ Num: regex(/[0-9]+!/) }))
    const R = compose([cssRules, lessRules])
    expect(ok(R.Value!('abc', 0, {}))).toBe(3)   // css.Word
    expect(ok(R.Value!('12!', 0, {}))).toBe(3)   // css.Value reroutes to less.Num (open recursion)
    expect(ok(R.Value!('12', 0, {}))).toBe(-1)   // less.Num needs '!'; Word fails
  })
})

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

describe('fusion — modes over one grammar (RULE_ABI_PLAN §7)', () => {
  const mk = () => rules(g => ({
    Pair: node('Pair', sequence(regex(/[a-z]+/), literal(':'), regex(/[0-9]+/)),
      (_c, _r, s) => ({ kind: 'PairAST', span: s })),
  }))

  it('ctx.build host swaps eval-AST vs positioned-CST on the SAME fused grammar', () => {
    const R = fuseRules([link(mk(), '_m_')])
    // default (no host) → the grammar's own builder (eval AST):
    expect((R.Pair!('a:1', 0, {}).value as { kind: string }).kind).toBe('PairAST')
    // ctx.build host → positioned CST for every node type:
    const cstHost = (type: string, children: readonly unknown[]) =>
      ({ _tag: 'node', type, children: [...children] })
    const v = R.Pair!('a:1', 0, { build: cstHost }).value as { _tag: string; type: string; children: unknown[] }
    expect(v._tag).toBe('node')
    expect(v.type).toBe('Pair')
    expect(v.children).toHaveLength(3)
  })
})

describe('fusion — incremental over a fused map (the map IS the registry)', () => {
  it('parseDoc().edit() re-enters fused rules by name', () => {
    const g = rules(gg => ({
      Obj: node('Obj', sequence(literal('{'), optional(sepBy(gg.Pair, literal(','))), literal('}')),
        (c, _r, s) => ({ _tag: 'node', type: 'Obj', span: s, state: null, children: [...c] })),
      Pair: node('Pair', sequence(gg.Key, literal(':'), gg.Val),
        (c, _r, s) => ({ _tag: 'node', type: 'Pair', span: s, state: null, children: [...c] })),
      Key: node('Key', regex(/[a-z]+/), (c, _r, s) => ({ _tag: 'node', type: 'Key', span: s, state: null, children: [...c] })),
      Val: node('Val', regex(/[0-9]+/), (c, _r, s) => ({ _tag: 'node', type: 'Val', span: s, state: null, children: [...c] })),
    }))
    const R = fuseRules([link(g, '_i_')]) as unknown as Registry<NodeLike>
    const doc = parseDoc(R, 'Obj', '{a:1,b:2}')
    expect(doc.tree).toBeTruthy()
    // Overtype the value '2' at index 7 → '9' (same-length edit re-enters a fused
    // rule by name and grafts).
    const edited = doc.edit(7, 8, '9')
    expect(edited.input).toBe('{a:1,b:9}')
    const fresh = parseDoc(R, 'Obj', edited.input)
    expect(JSON.stringify(edited.tree)).toBe(JSON.stringify(fresh.tree))
  })
})

describe('fusion — the three drivers over one fused map (RULE_ABI_PLAN §7, step 5)', () => {
  // A grammar whose node() builder produces an EVAL AST (not a CST).
  const g = rules(gg => ({
    Sum: node('Sum', sequence(gg.Num, optional(sequence(literal('+'), gg.Num))),
      (c) => ({ kind: 'Sum', terms: c.filter(x => (x as { kind?: string }).kind === 'Num') })),
    Num: node('Num', regex(/[0-9]+/), (_c, _r, s) => ({ kind: 'Num', at: s.start })),
  }))
  const R = fuseRules([link(g, '_d_')]) as unknown as Registry<NodeLike>

  it('eval driver (default build) → the grammar’s eval AST', () => {
    const r = (R.Sum as unknown as (i: string, p: number, c: object) => { ok: boolean; value?: unknown })('1+2', 0, {})
    expect((r.value as { kind: string }).kind).toBe('Sum')
  })

  it('linter/IDE driver (cstBuildHost) → a positioned CST from the SAME grammar', () => {
    // One-shot CST (linter):
    const r = (R.Sum as unknown as (i: string, p: number, c: object) => { ok: boolean; value?: { _tag: string; type: string } })('1+2', 0, { build: cstBuildHost })
    expect(r.value!._tag).toBe('node')
    expect(r.value!.type).toBe('Sum')
    // Incremental CST (IDE): parseDoc threads the same host into every reparse.
    const doc = parseDoc(R, 'Sum', '1+2', { build: cstBuildHost })
    expect((doc.tree as unknown as { _tag: string })._tag).toBe('node')
    const edited = doc.edit(0, 1, '9') // 1+2 -> 9+2
    const fresh = parseDoc(R, 'Sum', '9+2', { build: cstBuildHost })
    expect(JSON.stringify(edited.tree)).toBe(JSON.stringify(fresh.tree))
  })
})
