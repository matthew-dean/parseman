import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalize,
  compareReports,
  digestCorpus,
  formatComparison,
  loadCorpus,
  HARNESS_DIGEST,
  type CorpusEntry,
  type Surface,
} from '../../src/oracle/index.ts'

/**
 * THE self-check.
 *
 * `HARNESS_DIGEST` is a behavioural fingerprint of the projection, computed over
 * a frozen canary that touches every payload-shaping decision the oracle makes.
 * It is embedded in every report, and `compareReports` refuses to compare two
 * reports whose fingerprints differ — so a harness change can never silently
 * re-baseline a consumer's recorded digests.
 *
 * If this test fails you changed the projection. That is allowed, and the fix is
 * to update the literal below IN THE SAME DIFF — which is the point: the change
 * becomes visible to a reviewer, and every consumer's stored baseline is
 * invalidated LOUDLY rather than reinterpreted quietly. Before you do, be sure the
 * change was intended: the defect this whole mechanism exists to prevent was a
 * dropped prefix in the hashed payload, which moved every aggregate on a grammar
 * nobody had touched, and was caught only because someone happened to compare
 * against a number in an old commit message.
 */
const PINNED_HARNESS_DIGEST = 'e542b69ede393b0c90021c7c5710e3eab01a86f451fbd7124158f26e3721c0f0'

const corpus = (...ids: string[]): CorpusEntry[] => ids.map(id => ({ id, source: id }))
const identity = (name: string, parse: (source: string, id: string) => unknown): Surface => ({ name, parse })

describe('harness self-check', () => {
  it('pins the harness fingerprint to a reviewed constant', () => {
    expect(HARNESS_DIGEST).toBe(PINNED_HARNESS_DIGEST)
  })

  it('stamps the fingerprint into every report', () => {
    expect(digestCorpus([identity('s', s => s)], corpus('a')).harness).toBe(HARNESS_DIGEST)
  })

  it('refuses to compare reports from different harnesses, rather than guessing', () => {
    const before = digestCorpus([identity('s', s => s)], corpus('a'))
    const after = { ...digestCorpus([identity('s', s => s)], corpus('a')), harness: 'f'.repeat(64) }
    const c = compareReports(before, after)
    expect(c.verdict).toBe('incomparable')
    expect(c.reason).toMatch(/harness drift/)
    expect(formatComparison(c)).toMatch(/^INCOMPARABLE/)
  })

  it('refuses across digest formats', () => {
    const before = digestCorpus([identity('s', s => s)], corpus('a'))
    const c = compareReports(before, { ...before, format: before.format + 1 })
    expect(c.verdict).toBe('incomparable')
  })
})

describe('canonicalize', () => {
  const distinct = (a: unknown, b: unknown): void => {
    expect(canonicalize(a)).not.toBe(canonicalize(b))
  }

  it('separates what JSON.stringify collapses', () => {
    // Every pair below stringifies identically. A grammar refactor can move any
    // of them, so the projection must not.
    distinct({ a: undefined }, {})
    distinct(Number.NaN, null)
    distinct(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)
    distinct(-0, 0)
    distinct(new Map([['a', 1]]), new Map())
    distinct(new Set([1]), new Set())
    distinct(new Map([['a', 1]]), new Set(['a']))
  })

  it('tags class identity, so swapping node classes is visible', () => {
    class A {
      x: number
      constructor(x: number) {
        this.x = x
      }
    }
    class B {
      x: number
      constructor(x: number) {
        this.x = x
      }
    }
    distinct(new A(1), new B(1))
    distinct(new A(1), { x: 1 })
  })

  it('ignores property insertion order but not array order', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }))
    distinct([1, 2], [2, 1])
    distinct(new Map([['a', 1], ['b', 2]]), new Map([['b', 2], ['a', 1]]))
  })

  it('writes a shared subtree twice rather than calling it a cycle', () => {
    const shared = { v: 1 }
    // The naive "mark every repeat" projection makes these two equal, which
    // means a DAG's digest depends on traversal order.
    distinct({ l: shared, r: shared }, { l: shared, r: { seen: true } })
    expect(canonicalize({ l: shared, r: shared })).toBe(canonicalize({ l: { v: 1 }, r: { v: 1 } }))
  })

  it('terminates on a cycle and distinguishes which ancestor it points at', () => {
    // Both are one level deep with a back-edge; they differ only in WHICH
    // ancestor the edge points at, which a depth-blind cycle marker would lose.
    const toRoot: Record<string, unknown> = {}
    toRoot.a = { up: toRoot }
    const inner: Record<string, unknown> = {}
    inner.up = inner
    distinct(toRoot, { a: inner })
  })

  it('cannot be forged by token concatenation', () => {
    // `#1` `#2` must not read as `#12`.
    distinct([1, 2], [12])
    distinct(['a', 'b'], ['ab'])
  })

  it('escapes strings so no value can inject a delimiter', () => {
    distinct(['a\u0000b'], ['a', 'b'])
    distinct(['a b'], ['a', 'b'])
  })
})

describe('digestCorpus', () => {
  it('is stable across runs and independent of the order entries are supplied in', () => {
    const surfaces = [identity('s', (_s, id) => ({ id, n: id.length }))]
    const a = digestCorpus(surfaces, corpus('x', 'y', 'z'))
    const b = digestCorpus(surfaces, corpus('z', 'x', 'y'))
    expect(a.surfaces[0]!.aggregate).toBe(b.surfaces[0]!.aggregate)
  })

  it('keeps a thrown error and a returned value in disjoint hash spaces', () => {
    // The regression this guards: dropping the OK:/ERR: discriminator makes a
    // surface that RETURNS the projected error shape hash the same as one that
    // THREW it — i.e. an error silently becoming an accept goes undetected.
    const thrower = digestCorpus([identity('s', () => { throw new TypeError('boom') })], corpus('a'))
    const returner = digestCorpus([identity('s', () => ({ name: 'TypeError', message: 'boom' }))], corpus('a'))
    expect(thrower.surfaces[0]!.aggregate).not.toBe(returner.surfaces[0]!.aggregate)
    expect(thrower.surfaces[0]!.threw).toBe(1)
    expect(returner.surfaces[0]!.threw).toBe(0)
  })

  it('moves when an error becomes an accept', () => {
    const before = digestCorpus([identity('s', () => { throw new Error('rejected') })], corpus('bad'))
    const after = digestCorpus([identity('s', () => ({ ok: true }))], corpus('bad'))
    const c = compareReports(before, after)
    expect(c.verdict).toBe('moved')
    expect(c.surfaces[0]!.moved).toEqual(['bad'])
  })

  it('hashes non-Error throws instead of losing them', () => {
    const a = digestCorpus([identity('s', () => { throw 'one' })], corpus('a'))
    const b = digestCorpus([identity('s', () => { throw 'two' })], corpus('a'))
    expect(a.surfaces[0]!.aggregate).not.toBe(b.surfaces[0]!.aggregate)
  })

  it('honours a projectError override, for messages carrying machine-specific text', () => {
    const surfaces = [identity('s', (_s, id) => { throw new Error(`/abs/path/${id}: bad`) })]
    const project = (thrown: unknown): unknown =>
      thrown instanceof Error ? { message: thrown.message.replace(/^\/\S+?: /, '') } : { thrown }
    const a = digestCorpus(surfaces, corpus('a'), { projectError: project })
    expect(a.surfaces[0]!.threw).toBe(1)
    expect(a.surfaces[0]!.aggregate).not.toBe(digestCorpus(surfaces, corpus('a')).surfaces[0]!.aggregate)
  })

  it('gives two surfaces distinct aggregates even when they agree on every entry', () => {
    const r = digestCorpus([identity('ast', s => s), identity('cst', s => s)], corpus('a', 'b'))
    expect(r.surfaces[0]!.aggregate).not.toBe(r.surfaces[1]!.aggregate)
  })

  it('rejects a nondeterministic surface instead of emitting a number', () => {
    let n = 0
    expect(() => digestCorpus([identity('s', () => ({ n: n++ }))], corpus('a')))
      .toThrow(/NOT DETERMINISTIC/)
  })

  it('rejects duplicate surface names and duplicate corpus ids', () => {
    expect(() => digestCorpus([identity('s', s => s), identity('s', s => s)], corpus('a')))
      .toThrow(/duplicate surface name/)
    expect(() => digestCorpus([identity('s', s => s)], [{ id: 'a', source: '1' }, { id: 'a', source: '2' }]))
      .toThrow(/duplicate corpus id/)
  })

  it('rejects an empty surface list', () => {
    expect(() => digestCorpus([], corpus('a'))).toThrow(/no surfaces/)
  })
})

describe('compareReports', () => {
  const surfaces = [identity('a', (_s, id) => ({ id })), identity('b', (_s, id) => ({ id }))]

  it('accepts an output-neutral change', () => {
    const before = digestCorpus(surfaces, corpus('x', 'y'))
    const after = digestCorpus(surfaces, corpus('x', 'y'))
    const c = compareReports(before, after)
    expect(c.verdict).toBe('identical')
    expect(formatComparison(c)).toMatch(/IDENTICAL/)
  })

  it('localises a move to the entries and the surface that moved', () => {
    const after = [identity('a', (_s, id) => ({ id, extra: 1 })), surfaces[1]!]
    const c = compareReports(digestCorpus(surfaces, corpus('x', 'y')), digestCorpus(after, corpus('x', 'y')))
    expect(c.verdict).toBe('moved')
    expect(c.surfaces.find(s => s.name === 'a')!.moved).toEqual(['x', 'y'])
    // The untouched surface is the control: if it moved too, the harness or the
    // corpus moved, not the rule you edited.
    expect(c.surfaces.find(s => s.name === 'b')!.equal).toBe(true)
  })

  it('reports a shrunken corpus as such, and never as a pass', () => {
    const c = compareReports(digestCorpus(surfaces, corpus('x', 'y')), digestCorpus(surfaces, corpus('x')))
    expect(c.verdict).toBe('moved')
    expect(c.removedEntries).toEqual(['y'])
    expect(formatComparison(c)).toMatch(/corpus LOST 1 entries/)
    // The aggregate moves too — a smaller corpus cannot masquerade as unchanged.
    expect(c.surfaces[0]!.equal).toBe(false)
  })

  it('reports added and removed surfaces', () => {
    const c = compareReports(digestCorpus(surfaces, corpus('x')), digestCorpus([surfaces[0]!], corpus('x')))
    expect(c.verdict).toBe('moved')
    expect(c.surfaces.find(s => s.name === 'b')!.after).toBeNull()
    expect(formatComparison(c)).toMatch(/- surface b \(removed\)/)
  })

  it('truncates a long move list in the formatted output', () => {
    const ids = Array.from({ length: 25 }, (_, n) => `f${String(n).padStart(2, '0')}`)
    const c = compareReports(
      digestCorpus([identity('a', (_s, id) => ({ id }))], corpus(...ids)),
      digestCorpus([identity('a', (_s, id) => ({ id, v: 1 }))], corpus(...ids)),
    )
    expect(formatComparison(c, { maxMoved: 3 })).toMatch(/… and 22 more/)
  })
})

describe('loadCorpus', () => {
  const fixture = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'oracle-corpus-'))
    mkdirSync(join(root, 'a', 'nested'), { recursive: true })
    mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true })
    writeFileSync(join(root, 'a', 'one.less'), 'one')
    writeFileSync(join(root, 'a', 'nested', 'two.LESS'), 'two')
    writeFileSync(join(root, 'a', 'skip.txt'), 'nope')
    writeFileSync(join(root, 'a', 'big.less'), 'x'.repeat(4096))
    writeFileSync(join(root, 'node_modules', '.cache', 'junk.less'), 'junk')
    return root
  }

  it('produces sorted, base-relative, POSIX ids', () => {
    const root = fixture()
    const { entries } = loadCorpus({ base: root, roots: ['a'], extensions: ['.less'] })
    expect(entries.map(e => e.id)).toEqual(['a/big.less', 'a/nested/two.LESS', 'a/one.less'])
    expect(entries.find(e => e.id === 'a/one.less')!.source).toBe('one')
  })

  it('follows symlinked roots without looping', () => {
    const root = fixture()
    symlinkSync(join(root, 'a'), join(root, 'link'), 'dir')
    symlinkSync(join(root, 'link'), join(root, 'a', 'nested', 'loop'), 'dir')
    const { entries } = loadCorpus({ base: root, roots: ['link'], extensions: ['.less'] })
    expect(entries.length).toBeGreaterThan(0)
  })

  it('skips oversized files and says which', () => {
    const root = fixture()
    const { entries, skippedLarge } = loadCorpus({ base: root, roots: ['a'], extensions: ['.less'], maxBytes: 100 })
    expect(skippedLarge).toEqual(['a/big.less'])
    expect(entries.map(e => e.id)).not.toContain('a/big.less')
  })

  it('throws on a missing root rather than quietly shrinking the corpus', () => {
    const root = fixture()
    expect(() => loadCorpus({ base: root, roots: ['a', 'gone'], extensions: ['.less'] }))
      .toThrow(/does not resolve to a directory/)
  })

  it('reports a missing root back when the caller opts in', () => {
    const root = fixture()
    const { entries, missingRoots } = loadCorpus({
      base: root,
      roots: ['a', 'gone'],
      extensions: ['.less'],
      allowMissingRoots: true,
    })
    expect(missingRoots).toEqual(['gone'])
    expect(entries.length).toBe(3)
  })

  // The default ignore list reads `node_modules/.cache`, and the walk used to test it
  // against a BASENAME — which a path never equals, so the exclusion matched nothing
  // and every cache file entered the corpus. A digest that moves with the local build
  // cache is precisely the filesystem-dependent reading this module exists to stop, so
  // it is pinned here rather than left to the default's wording.
  it('applies a PATH-valued ignore, not just a directory name', () => {
    const root = fixture()
    writeFileSync(join(root, 'node_modules', 'dep.less'), 'dep')
    const { entries } = loadCorpus({ base: root, roots: ['.'], extensions: ['.less'] })
    expect(entries.map(e => e.id)).not.toContain('node_modules/.cache/junk.less')
    // and it is a suffix match on the path, so the package tree it names is still walked
    expect(entries.map(e => e.id)).toContain('node_modules/dep.less')
  })

  it('still honours a bare directory NAME in the ignore list', () => {
    const root = fixture()
    const { entries } = loadCorpus({
      base: root, roots: ['.'], extensions: ['.less'], ignoreDirs: ['node_modules'],
    })
    expect(entries.map(e => e.id).filter(id => id.startsWith('node_modules/'))).toEqual([])
  })

  // Two roots that alias one directory used to share a cycle-detection set, so the
  // second returned immediately and contributed nothing — and because the id comes
  // from the path as REACHED, swapping the root order renamed every entry. The corpus
  // must be a function of the files and the base, never of the order of `roots`.
  it('gives the same corpus whichever order aliased roots are listed in', () => {
    const root = mkdtempSync(join(tmpdir(), 'oracle-alias-'))
    mkdirSync(join(root, 'actual'), { recursive: true })
    writeFileSync(join(root, 'actual', 'x.less'), 'x')
    symlinkSync(join(root, 'actual'), join(root, 'alias'), 'dir')

    const ids = (roots: string[]): string[] =>
      loadCorpus({ base: root, roots, extensions: ['.less'] }).entries.map(e => e.id)

    expect(ids(['actual', 'alias'])).toEqual(ids(['alias', 'actual']))
    // one physical file is one entry, under the lexicographically smaller id
    expect(ids(['alias', 'actual'])).toEqual(['actual/x.less'])
  })

  it('does not drop a second root that merely overlaps the first', () => {
    const root = mkdtempSync(join(tmpdir(), 'oracle-overlap-'))
    mkdirSync(join(root, 'outer', 'inner'), { recursive: true })
    writeFileSync(join(root, 'outer', 'o.less'), 'o')
    writeFileSync(join(root, 'outer', 'inner', 'i.less'), 'i')
    const { entries } = loadCorpus({ base: root, roots: ['outer', 'outer/inner'], extensions: ['.less'] })
    expect(entries.map(e => e.id)).toEqual(['outer/inner/i.less', 'outer/o.less'])
  })
})
