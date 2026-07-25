/**
 * The oracle exercised on the thing it exists for: an actual parseman grammar
 * refactor, digested through actual parseman parse entry points.
 *
 * The unit tests in `oracle-identity.test.ts` prove the projection. These prove
 * the PREMISE — that a duplicated-arm collapse of the kind an author reaches for
 * really does come out `identical`, that a subtly output-changing one really does
 * come out `moved`, and that the interpreter and the compiled artifact can be
 * declared as two SURFACES so a refactor is checked against both at once.
 *
 * That last one is not decoration. A grammar is authored against the interpreter
 * and ships as the compiled artifact, and a refactor that is neutral for one and
 * not the other is exactly the bug that is hardest to find by reading.
 */
import { describe, it, expect } from 'vitest'
import { choice, compile, literal, node, oneOrMore, oneOrMoreSep, parse, regex, rules, sequence } from '../../src/index.ts'
import { compareReports, digestCorpus, type CorpusEntry, type Surface } from '../../src/oracle/index.ts'
import type { Combinator } from '../../src/types.ts'

const corpus: CorpusEntry[] = [
  'a{color:red}',
  'a{color:red;background:blue}',
  '.x{width:10px}',
  '#y{margin:0}',
  'a{}',
  // Deliberate rejections. Error behaviour is part of the contract being frozen,
  // so a corpus with none of these in it under-tests the refactor.
  'a{color}',
  '{color:red}',
  'a{color:red',
  '',
].map((source, n) => ({ id: `case-${String(n).padStart(2, '0')}`, source }))

const ident = regex(/[a-z][\w-]*/)
const value = regex(/[^;}]+/)
const decl = node('decl', sequence(ident, literal(':'), value))

/** The starting point: three selector arms spelled out one by one. */
const duplicated = rules(() => ({
  sheet: oneOrMore(
    node('rule', sequence(
      choice(
        node('sel', sequence(literal('.'), ident)),
        node('sel', sequence(literal('#'), ident)),
        node('sel', ident),
      ),
      literal('{'),
      node('body', oneOrMoreSep(decl, literal(';'), { trailing: 'allow' })),
      literal('}'),
    )),
  ),
}))

/**
 * The candidate: one `sel` node wrapping a three-arm choice, instead of three
 * `sel` nodes inside one. Same language, same node shapes, same order — the
 * collapse an author wants to make and cannot currently prove is safe by reading.
 */
const collapsed = rules(() => ({
  sheet: oneOrMore(
    node('rule', sequence(
      node('sel', choice(
        sequence(literal('.'), ident),
        sequence(literal('#'), ident),
        ident,
      )),
      literal('{'),
      node('body', oneOrMoreSep(decl, literal(';'), { trailing: 'allow' })),
      literal('}'),
    )),
  ),
}))

/**
 * A near-miss: identical language, but the selector node is named differently.
 * Every input still parses, and every test asserting "does this parse" still
 * passes. Only the tree moved — which is the class of change the oracle is for.
 */
const renamed = rules(() => ({
  sheet: oneOrMore(
    node('rule', sequence(
      node('selector', choice(
        sequence(literal('.'), ident),
        sequence(literal('#'), ident),
        ident,
      )),
      literal('{'),
      node('body', oneOrMoreSep(decl, literal(';'), { trailing: 'allow' })),
      literal('}'),
    )),
  ),
}))

type Grammar = { sheet: Combinator<unknown> }

/**
 * Interpreted and compiled, declared side by side.
 *
 * `parse()` returns a result object rather than throwing, so the failure cases in
 * the corpus land on the OK: side of the discriminator — as themselves, with their
 * `expected` sets and offsets hashed. Either shape works; what matters is that the
 * same shape is used on both sides of the comparison.
 */
function surfaces(g: Grammar): Surface[] {
  const compiled = compile(g.sheet)
  return [
    { name: 'interpreted', parse: source => parse(g.sheet, source) },
    { name: 'compiled', parse: source => compiled.parse(source) },
  ]
}

describe('identity oracle over a real parseman grammar refactor', () => {
  it('is not vacuous — the corpus really does split into accepts and rejections', () => {
    // Without this, two grammars that both reject EVERYTHING would compare
    // `identical` and every assertion below would pass while proving nothing.
    const ok = corpus.filter(e => parse(collapsed.sheet, e.source).ok)
    expect(ok.length).toBeGreaterThan(2)
    expect(corpus.length - ok.length).toBeGreaterThan(2)
  })

  it('accepts a left-factoring that does not move the tree', () => {
    const c = compareReports(
      digestCorpus(surfaces(duplicated), corpus),
      digestCorpus(surfaces(collapsed), corpus),
    )
    expect(c.verdict).toBe('identical')
  })

  it('rejects a rename that every "does it parse" test would let through', () => {
    const c = compareReports(
      digestCorpus(surfaces(collapsed), corpus),
      digestCorpus(surfaces(renamed), corpus),
    )
    expect(c.verdict).toBe('moved')
    // Both surfaces moved, and the report names the successful parses that did.
    expect(c.surfaces.map(s => s.equal)).toEqual([false, false])
    expect(c.surfaces[0]!.moved.length).toBeGreaterThan(0)
  })

  it('digests the rejections, not just the accepts', () => {
    const report = digestCorpus(surfaces(collapsed), corpus)
    const failing = corpus.filter(e => !parse(collapsed.sheet, e.source).ok)
    expect(failing.length).toBeGreaterThan(0)
    for (const e of failing) expect(report.perEntry[e.id]!.interpreted).toMatch(/^[0-9a-f]{16}$/)
  })

  it('reads the interpreter and the compiled artifact as independent surfaces', () => {
    const report = digestCorpus(surfaces(collapsed), corpus)
    expect(report.surfaces.map(s => s.name)).toEqual(['interpreted', 'compiled'])
    // Two aggregates, each its own gate: a refactor neutral for one and not the
    // other fails here rather than in a consumer's build.
    expect(new Set(report.surfaces.map(s => s.aggregate)).size).toBe(2)
  })

  it('is reproducible across independently built parsers', () => {
    expect(digestCorpus(surfaces(collapsed), corpus).surfaces.map(s => s.aggregate))
      .toEqual(digestCorpus(surfaces(collapsed), corpus).surfaces.map(s => s.aggregate))
  })
})
