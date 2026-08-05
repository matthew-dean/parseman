/**
 * `rebuildCombinator` — the reconstruction, the option threading it must not drop, and
 * every shape it REFUSES to reconstruct.
 *
 * The module has no throw path: its failure mode is to reuse a subtree verbatim and say
 * so, so the assertions below are on the reported `frozen` tag/rule and on the `unapplied`
 * substitutions that a verbatim reuse stranded — the two facts a caller renders as "why".
 */
import { describe, expect, it } from 'vitest'
import {
  attempt, choice, expect as expectC, field, gate, keywords, label, leaf, literal, many,
  node, not, oneOrMore, optional, parse, parser, peek, ref, regex, routed, rules, scanTo,
  sepBy, sequence, startsWith, token, transform, trivia, withCtx, dispatch, when, otherwise,
  type Combinator, type ParserDef,
} from '../../src/index.ts'
import { rebuildCombinator } from '../../src/analysis/rebuild.ts'

const asC = (c: Combinator<unknown>): Combinator<unknown> => c
const defOf = (c: Combinator<unknown>): ParserDef => c._def
const named = (c: Combinator<unknown>, name: string): Combinator<unknown> => {
  ;(c as { _ruleName?: string })._ruleName = name
  return c
}

/** Depth-first walk over the shapes this module rebuilds, collecting `_def.tag`s. */
function tags(root: Combinator<unknown>): string[] {
  const out: string[] = []
  const seen = new Set<Combinator<unknown>>()
  const walk = (c: Combinator<unknown>): void => {
    if (seen.has(c)) return
    seen.add(c)
    const d = c._def as unknown as Record<string, unknown>
    if (typeof d !== 'object') return
    out.push(String(d.tag))
    const kids: Combinator<unknown>[] = []
    if (Array.isArray(d.parsers)) kids.push(...(d.parsers as Combinator<unknown>[]))
    for (const k of ['parser', 'main', 'skipped', 'separator', 'sentinel'])
      if (d[k] !== undefined) kids.push(d[k] as Combinator<unknown>)
    if (d.tag === 'lazy') {
      try { kids.push((d as { thunk(): Combinator<unknown> }).thunk()) }
      catch { /* undefined ref: nothing below it */ }
    }
    for (const k of kids) walk(k)
  }
  walk(root)
  return out
}

describe('rebuildCombinator — the identity rebuild', () => {
  /** One grammar carrying every tag with a public factory the rebuilder reconstructs. */
  const wide = (): Combinator<unknown> => sequence(
    literal('a'),
    literal('B', { caseInsensitive: true }),
    regex(/[0-9]+/y),
    keywords(['if', 'else'], { caseInsensitive: true, boundary: '\\w' }),
    attempt(literal('x')),
    not(literal('!')),
    peek(literal('p')),
    optional(literal('o')),
    many(literal('m'), { max: 4 }),
    oneOrMore(literal('n'), { min: 2, max: 7 }),
    sepBy(literal('s'), literal(','), { min: 1, max: 5, trailing: 'allow' }),
    transform(literal('t'), (v: string) => v.toUpperCase()),
    label('L', literal('l')),
    field('f', literal('g')),
    token(literal('tok')),
    leaf(literal('lf'), (v: string) => v.length),
    expectC(literal('e'), 'an e'),
    expectC(literal('u')),
    node('Typed', literal('y'), { unwrap: true, tags: ['tag1'] }),
    node(literal('z'), { collapse: true }),
    choice(literal('c1'), literal('c2')),
  )

  it('rebuilds every tag through a public factory, freezing none of them', () => {
    const { root, frozen, unapplied } = rebuildCombinator(wide(), new Map())
    expect(frozen).toEqual([])
    expect(unapplied).toEqual([])
    const before = tags(wide())
    expect(tags(root)).toEqual(before)
    expect(before).toContain('sepBy')
    expect(before).toContain('leaf')
    expect(before).toContain('node')
  })

  it('produces a NEW graph rather than handing back the original nodes', () => {
    const g = wide()
    const { root } = rebuildCombinator(g, new Map())
    expect(root).not.toBe(g)
    const kidsBefore = (defOf(g) as { parsers: Combinator<unknown>[] }).parsers
    const kidsAfter = (defOf(root) as { parsers: Combinator<unknown>[] }).parsers
    expect(kidsAfter).toHaveLength(kidsBefore.length)
    for (let i = 0; i < kidsBefore.length; i++) expect(kidsAfter[i]).not.toBe(kidsBefore[i])
  })

  it('parses identically to the original', () => {
    const g = many(choice(regex(/[a-z]+/y), literal(' ')))
    const { root } = rebuildCombinator(asC(g), new Map())
    for (const text of ['abc def', 'a', '', 'zzz  q']) {
      expect(JSON.stringify(parse(root, text))).toBe(JSON.stringify(parse(asC(g), text)))
    }
  })
})

describe('rebuildCombinator — option threading', () => {
  const rebuiltDef = (c: Combinator<unknown>): Record<string, unknown> =>
    rebuildCombinator(c, new Map()).root._def as unknown as Record<string, unknown>

  it('keeps literal case-insensitivity, and does not invent it', () => {
    expect(rebuiltDef(literal('A', { caseInsensitive: true })).caseInsensitive).toBe(true)
    expect(rebuiltDef(literal('A')).caseInsensitive).toBeFalsy()
  })

  it('keeps the regex source and flags verbatim', () => {
    const d = rebuiltDef(regex(/ab+c/iy))
    expect(d.source).toBe('ab+c')
    expect(String(d.flags)).toContain('i')
  })

  it('keeps keyword words, case-insensitivity and boundary', () => {
    const opts = { caseInsensitive: true, boundary: '\\w' } as const
    const d = rebuiltDef(keywords(['if', 'else'], opts))
    // `keywords()` normalises its word order; the rebuild must reproduce that order
    // exactly rather than re-normalising an already-normalised list into a new one.
    expect(d.words).toEqual((keywords(['if', 'else'], opts)._def as unknown as { words: string[] }).words)
    expect(d.words).toContain('if')
    expect(d.words).toContain('else')
    expect(d.caseInsensitive).toBe(true)
    expect(d.boundary).toBe('\\w')
  })

  it('keeps repeat bounds', () => {
    expect(rebuiltDef(many(literal('m'), { max: 4 })).max).toBe(4)
    expect(rebuiltDef(many(literal('m'))).max).toBeUndefined()
    const o = rebuiltDef(oneOrMore(literal('n'), { min: 2, max: 7 }))
    expect(o.min).toBe(2)
    expect(o.max).toBe(7)
  })

  it('keeps sepBy bounds and the trailing-separator policy', () => {
    const d = rebuiltDef(sepBy(literal('s'), literal(','), { min: 1, max: 5, trailing: 'allow' }))
    expect(d.min).toBe(1)
    expect(d.max).toBe(5)
    expect(d.trailing).toBe('allow')
  })

  it('keeps label and field names', () => {
    expect(rebuiltDef(label('L', literal('l'))).label).toBe('L')
    expect(rebuiltDef(field('f', literal('g'))).name).toBe('f')
  })

  it('keeps the transform and leaf callbacks by identity', () => {
    const fn = (v: string): string => v.toUpperCase()
    expect(rebuiltDef(transform(literal('t'), fn)).fn).toBe(fn)
    const lf = (v: string): number => v.length
    expect(rebuiltDef(leaf(literal('lf'), lf)).fn).toBe(lf)
  })

  it('reproduces a LABELLED expect label exactly', () => {
    const d = rebuiltDef(expectC(literal('e'), 'an e') as Combinator<unknown>)
    expect(d.label).toBe('an e')
    expect(d.expected).toEqual(['an e'])
  })

  it('keeps node type, tags, unwrap and collapse', () => {
    const d = rebuiltDef(node('Typed', literal('y'), { unwrap: true, tags: ['tag1'] }))
    expect(d.type).toBe('Typed')
    expect(d.unwrap).toBe(true)
    expect(d.tags).toEqual(['tag1'])
    expect(rebuiltDef(node(literal('z'), { collapse: true })).collapse).toBe(true)
  })

  it('rebuilds an untyped node carrying a build but NO options', () => {
    const build = (): { k: number } => ({ k: 1 })
    const { root, frozen } = rebuildCombinator(node(literal('z'), build), new Map())
    expect(frozen).toEqual([])
    const d = root._def as unknown as Record<string, unknown>
    expect(d.tag).toBe('node')
    expect(d.build).toBe(build)
    expect(d.type).toBeUndefined()
  })

  it('threads grammar trivia and trackLines back through parser()', () => {
    const g = parser({ trivia: literal(' '), trackLines: true, captureTrivia: true }, literal('a'))
    const d = rebuiltDef(g as unknown as Combinator<unknown>)
    expect(d.tag).toBe('grammar')
    expect(d.trackLines).toBe(true)
    expect(d.captureTrivia).toBe(true)
    expect(d.triviaParser).toBeDefined()
  })

  it('threads a CLEARED grammar trivia scope back as trivia: null', () => {
    const g = parser({ trivia: null, trackLines: false }, literal('a'))
    const d = rebuiltDef(g as unknown as Combinator<unknown>)
    expect(d.clearTrivia).toBe(true)
    expect(d.triviaParser).toBeUndefined()
  })
})

describe('rebuildCombinator — the absent-option side of every option', () => {
  const rebuiltDef = (c: Combinator<unknown>): Record<string, unknown> =>
    rebuildCombinator(c, new Map()).root._def as unknown as Record<string, unknown>

  it('leaves keyword options unset when none were given', () => {
    const d = rebuiltDef(keywords(['if', 'else']))
    expect(d.caseInsensitive).toBe(false)
    expect(d.boundary).toBeUndefined()
  })

  it('leaves sepBy max and trailing unset when none were given', () => {
    const d = rebuiltDef(sepBy(literal('s'), literal(',')))
    expect(d.max).toBeUndefined()
    expect(d.trailing).toBeUndefined()
    expect(d.min).toBe(0)
  })

  it('leaves oneOrMore max unset while keeping its implicit min of 1', () => {
    const d = rebuiltDef(oneOrMore(literal('n')))
    expect(d.min).toBe(1)
    expect(d.max).toBeUndefined()
  })

  it('reproduces an UNLABELLED expect by re-deriving its expected set', () => {
    const d = rebuiltDef(expectC(literal('e')) as Combinator<unknown>)
    expect(d.label).toBeUndefined()
    expect(d.expected).toEqual(['"e"'])
  })

  it('keeps node projection, trivia capture and declared build arity', () => {
    const d = rebuiltDef(node(sequence(literal('a'), literal('b')), { project: 1 }))
    expect(d.project).toBe(1)
    const d2 = rebuiltDef(node('T', literal('a'), { captureTrivia: true, trailingTrivia: true, buildArity: 3 }))
    expect(d2.captureTrivia).toBe(true)
    expect(d2.trailingTrivia).toBe(true)
    expect(d2.buildArity).toBe(3)
  })

  it('keeps a grammar rootCapture', () => {
    const d = rebuiltDef(parser(
      { rootCapture: 'opaque', trivia: literal(' '), trackLines: false },
      literal('a'),
    ) as unknown as Combinator<unknown>)
    expect(d.rootCapture).toBe('opaque')
    expect(d.trackLines).toBe(false)
  })

  it('inherits the enclosing trivia scope when the grammar declared none', () => {
    const d = rebuiltDef(parser({ trackLines: false }, literal('a')) as unknown as Combinator<unknown>)
    expect(d.triviaParser).toBeUndefined()
    expect(d.clearTrivia).toBeFalsy()
    expect(d.captureTrivia).toBeFalsy()
    expect(d.rootCapture).toBeUndefined()
  })
})

describe('rebuildCombinator — reaching a target through every child slot', () => {
  it('finds one buried in a scanTo skip list', () => {
    const target = literal('/*')
    const s = scanTo(literal('{'), { skip: [target] })
    const { unapplied } = rebuildCombinator(asC(s), new Map([[target, asC(literal('//'))]]))
    expect(unapplied).toEqual([target])
  })

  it('finds one buried in a dispatch MATCHER arm and in its otherwise arm', () => {
    const inMatcher = literal('m')
    const inOtherwise = literal('o')
    const d = dispatch(
      regex(/[a-z]+/y),
      when(startsWith('a'), sequence(inMatcher)),
      otherwise(sequence(inOtherwise)),
    )
    const { unapplied } = rebuildCombinator(asC(d), new Map([
      [inMatcher, asC(literal('x'))],
      [inOtherwise, asC(literal('y'))],
    ]))
    expect(unapplied).toContain(inMatcher)
    expect(unapplied).toContain(inOtherwise)
    expect(unapplied).toHaveLength(2)
  })

  it('finds one buried in a routed fallback', () => {
    const target = literal('f')
    const r = routed(target)
    const { frozen, unapplied } = rebuildCombinator(asC(r), new Map([[target, asC(literal('g'))]]))
    expect(frozen).toEqual([{ tag: 'routed', rule: '<entry>' }])
    expect(unapplied).toEqual([target])
  })
})

describe('rebuildCombinator — refs and cycles', () => {
  it('rebuilds a self-referential rule without recursing forever', () => {
    const g = rules<{ List: Combinator<unknown> }>(r => ({
      List: choice(sequence(literal('('), r.List as Combinator<unknown>, literal(')')), literal('x')),
    }))
    const { root, frozen } = rebuildCombinator(g.List, new Map())
    expect(frozen).toEqual([])
    expect(parse(root, '((x))').ok).toBe(true)
    expect(JSON.stringify(parse(root, '((x))'))).toBe(JSON.stringify(parse(g.List, '((x))')))
  })

  it('replaces a lazy slot with a fresh ref that resolves to the rebuilt body', () => {
    const slot = ref<string>()
    slot.define(literal('a'))
    const { root } = rebuildCombinator(sequence(slot, literal('b')), new Map())
    const first = (defOf(root) as { parsers: Combinator<unknown>[] }).parsers[0]!
    expect(first._def.tag).toBe('lazy')
    expect(first).not.toBe(slot)
    expect(parse(root, 'ab').ok).toBe(true)
  })

  it('reuses an UNDEFINED ref verbatim instead of throwing through its thunk', () => {
    const dangling = ref<string>()
    const { root, frozen, unapplied } = rebuildCombinator(sequence(dangling, literal('b')), new Map())
    expect(frozen).toEqual([])
    expect(unapplied).toEqual([])
    expect((defOf(root) as { parsers: Combinator<unknown>[] }).parsers[0]).toBe(dangling)
  })

  it('rebuilds a shared child exactly once, preserving the sharing', () => {
    const shared = literal('s')
    const { root } = rebuildCombinator(sequence(shared, sequence(shared, literal('t'))), new Map())
    const kids = (defOf(root) as { parsers: Combinator<unknown>[] }).parsers
    const inner = (kids[1]!._def as unknown as { parsers: Combinator<unknown>[] }).parsers
    expect(kids[0]).toBe(inner[0])
    expect(kids[0]).not.toBe(shared)
  })
})

describe('rebuildCombinator — substitution', () => {
  it('splices the replacement in without descending into the original target', () => {
    const inner = literal('deep')
    const target = not(not(inner))
    const g = sequence(target, literal('y'))
    const { root, unapplied } = rebuildCombinator(g, new Map([[target, asC(peek(inner))]]))
    expect(unapplied).toEqual([])
    const first = (defOf(root) as { parsers: Combinator<unknown>[] }).parsers[0]!
    expect(first._def.tag).toBe('peek')
    // The replacement is spliced BY IDENTITY: nothing inside it was rebuilt.
    expect((first._def as { parser: Combinator<unknown> }).parser).toBe(inner)
  })

  it('replaces the root itself when the root is the target', () => {
    const target = literal('a')
    const sub = literal('b')
    const { root } = rebuildCombinator(target, new Map([[target, asC(sub)]]))
    expect(root).toBe(sub)
  })

  it('applies one replacement to every occurrence of a shared target', () => {
    const target = literal('a')
    const sub = literal('b')
    const { root } = rebuildCombinator(sequence(target, target), new Map([[target, asC(sub)]]))
    const kids = (defOf(root) as { parsers: Combinator<unknown>[] }).parsers
    expect(kids[0]).toBe(sub)
    expect(kids[1]).toBe(sub)
    expect(parse(root, 'bb').ok).toBe(true)
  })

  it('leaves unapplied empty when a target is simply not in the graph', () => {
    const stranger = literal('nowhere')
    const { unapplied, frozen } = rebuildCombinator(
      sequence(literal('a')), new Map([[stranger, asC(literal('z'))]]))
    expect(unapplied).toEqual([])
    expect(frozen).toEqual([])
  })
})

describe('rebuildCombinator — frozen subtrees', () => {
  const frozenOf = (c: Combinator<unknown>): { tag: string; rule: string }[] =>
    rebuildCombinator(c, new Map()).frozen

  it('freezes a dispatch and names it', () => {
    const d = dispatch(regex(/[ab]/y), when('a', literal('a')), otherwise(literal('b')))
    expect(frozenOf(named(sequence(asC(d)), 'Doc'))).toEqual([{ tag: 'dispatch', rule: 'Doc' }])
  })

  it('freezes scanTo, guard, withCtx, routed and trivia', () => {
    for (const [tag, c] of [
      ['scanTo', scanTo(literal('{'))],
      ['guard', gate(() => true)],
      ['withCtx', withCtx({ k: 1 }, literal('a'))],
      ['routed', routed()],
      ['trivia', trivia(literal(' '))],
    ] as const) {
      expect(frozenOf(named(sequence(asC(c)), 'Doc'))).toEqual([{ tag, rule: 'Doc' }])
    }
  })

  it('returns a frozen node BY IDENTITY, so nothing inside it can drift', () => {
    const g = gate(() => true)
    const { root } = rebuildCombinator(sequence(asC(g), literal('a')), new Map())
    expect((defOf(root) as { parsers: Combinator<unknown>[] }).parsers[0]).toBe(g)
  })

  it('freezes a GATED choice under its own tag rather than rebuilding it wrong', () => {
    const gated = choice({ gate: () => true, combinator: literal('a') }, literal('b'))
    const g = named(sequence(asC(gated)), 'Doc')
    const { root, frozen } = rebuildCombinator(g, new Map())
    expect(frozen).toEqual([{ tag: 'choice(gated)', rule: 'Doc' }])
    expect((defOf(root) as { parsers: Combinator<unknown>[] }).parsers[0]).toBe(gated)
  })

  it('rebuilds an UNGATED choice normally', () => {
    const plain = choice(literal('a'), literal('b'))
    const { root, frozen } = rebuildCombinator(asC(plain), new Map())
    expect(frozen).toEqual([])
    expect(root).not.toBe(plain)
    expect(root._def.tag).toBe('choice')
  })

  // NOTE: the `node(untyped+build+opts)` freeze branch in rebuild.ts is UNREACHABLE
  // through the public `node()` overloads — that arity never records the options on the
  // def in the first place (src/combinators/node.ts:157), so `Object.keys(opts).length`
  // is always 0 here. The assertion below is on what the rebuild must therefore be:
  // faithful, because there is nothing to lose.
  it('rebuilds the untyped node(combinator, build, opts) arity, which records no options', () => {
    const build = (): { k: number } => ({ k: 1 })
    const n = node(literal('z'), build, { unwrap: true })
    const before = n._def as unknown as Record<string, unknown>
    expect(before.unwrap).toBeFalsy()
    const { root, frozen } = rebuildCombinator(asC(n), new Map())
    expect(frozen).toEqual([])
    const after = root._def as unknown as Record<string, unknown>
    expect(after.tag).toBe('node')
    expect(after.build).toBe(before.build)
    expect(after.unwrap).toBe(before.unwrap)
    expect(after.collapse).toBe(before.collapse)
    expect(after.tags).toEqual(before.tags)
  })

  it('does NOT freeze the same arity once the node carries an explicit type', () => {
    const build = (): { k: number } => ({ k: 1 })
    const { frozen } = rebuildCombinator(node('T', literal('z'), build, { unwrap: true }), new Map())
    expect(frozen).toEqual([])
  })

  it('deduplicates by (rule, tag) and reports each pair once', () => {
    const g = named(sequence(asC(gate(() => true)), asC(gate(() => false)), asC(routed())), 'Doc')
    expect(frozenOf(g)).toEqual([
      { tag: 'guard', rule: 'Doc' },
      { tag: 'routed', rule: 'Doc' },
    ])
  })

  it('sorts frozen notes by rule, then by tag', () => {
    const g = rules<{ A: Combinator<unknown>; B: Combinator<unknown>; Z: Combinator<unknown> }>(r => ({
      Z: sequence(r.B as Combinator<unknown>, r.A as Combinator<unknown>),
      B: sequence(asC(routed()), asC(gate(() => true))),
      A: asC(gate(() => true)),
    }))
    expect(rebuildCombinator(g.Z, new Map()).frozen).toEqual([
      { tag: 'guard', rule: 'A' },
      { tag: 'guard', rule: 'B' },
      { tag: 'routed', rule: 'B' },
    ])
  })

  it('attributes a frozen note to <entry> when no rule name is in scope', () => {
    expect(frozenOf(sequence(asC(gate(() => true))))).toEqual([{ tag: 'guard', rule: '<entry>' }])
  })
})

describe('rebuildCombinator — substitutions stranded inside a frozen subtree', () => {
  it('reports a target buried in a dispatch as unapplied rather than dropping it', () => {
    const target = not(not(literal('a')))
    const d = dispatch(
      regex(/[ab]/y),
      when('a', sequence(target, literal('a'))),
      otherwise(literal('b')),
    )
    const { root, frozen, unapplied } = rebuildCombinator(
      named(sequence(asC(d)), 'Doc'), new Map([[target, asC(peek(literal('a')))]]))
    expect(frozen).toEqual([{ tag: 'dispatch', rule: 'Doc' }])
    expect(unapplied).toEqual([target])
    expect((defOf(root) as { parsers: Combinator<unknown>[] }).parsers[0]).toBe(d)
  })

  it('reports a target buried in a GATED choice as unapplied', () => {
    const target = literal('deep')
    const gated = choice({ gate: () => true, combinator: sequence(target) }, literal('b'))
    const { frozen, unapplied } = rebuildCombinator(
      named(sequence(asC(gated)), 'Doc'), new Map([[target, asC(literal('other'))]]))
    expect(frozen).toEqual([{ tag: 'choice(gated)', rule: 'Doc' }])
    expect(unapplied).toEqual([target])
  })

  it('reports a target buried in a scanTo sentinel as unapplied', () => {
    const target = literal('{')
    const s = scanTo(target)
    const { frozen, unapplied } = rebuildCombinator(
      named(sequence(asC(s)), 'Doc'), new Map([[target, asC(literal('[')) ]]))
    expect(frozen).toEqual([{ tag: 'scanTo', rule: 'Doc' }])
    expect(unapplied).toEqual([target])
  })

  it('lists a stranded target once, however many times it occurs inside the frozen subtree', () => {
    const target = literal('deep')
    const g = withCtx({ k: 1 }, sequence(target, target))
    const { unapplied } = rebuildCombinator(asC(g), new Map([[target, asC(literal('x'))]]))
    expect(unapplied).toEqual([target])
  })

  it('still applies substitutions OUTSIDE the frozen subtree', () => {
    const stranded = literal('inside')
    const reachable = literal('outside')
    const sub = literal('applied')
    const g = sequence(asC(withCtx({ k: 1 }, stranded)), reachable)
    const { root, unapplied } = rebuildCombinator(g, new Map([
      [stranded, asC(literal('never'))],
      [reachable, asC(sub)],
    ]))
    expect(unapplied).toEqual([stranded])
    expect((defOf(root) as { parsers: Combinator<unknown>[] }).parsers[1]).toBe(sub)
  })
})

describe('rebuildCombinator — carried stamps', () => {
  it('carries the rule name onto the rebuilt node', () => {
    const g = named(sequence(literal('a')), 'Doc')
    const { root } = rebuildCombinator(g, new Map())
    expect((root as { _ruleName?: string })._ruleName).toBe('Doc')
  })

  it('carries the rule name onto a rebuilt ref slot', () => {
    const g = rules<{ Doc: Combinator<unknown>; Item: Combinator<unknown> }>(r => ({
      Doc: sequence(r.Item as Combinator<unknown>),
      Item: literal('i'),
    }))
    const { root } = rebuildCombinator(g.Doc, new Map())
    const slot = (defOf(root) as { parsers: Combinator<unknown>[] }).parsers[0]!
    expect(slot._def.tag).toBe('lazy')
    expect((slot as { _ruleName?: string })._ruleName).toBe('Item')
  })

  it('attributes a nested frozen note to the NEAREST enclosing rule', () => {
    const g = rules<{ Doc: Combinator<unknown>; Item: Combinator<unknown> }>(r => ({
      Doc: sequence(r.Item as Combinator<unknown>),
      Item: sequence(asC(gate(() => true))),
    }))
    expect(rebuildCombinator(g.Doc, new Map()).frozen).toEqual([{ tag: 'guard', rule: 'Item' }])
  })
})
