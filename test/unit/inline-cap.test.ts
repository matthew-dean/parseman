/**
 * INLINE EXPANSION CAP.
 *
 * `emitLazy` pastes a single-use, non-recursive private ref at its one call site
 * instead of hoisting a function nobody else calls. That is right per ref and
 * unbounded in aggregate — a chain of single-use helpers expands transitively with
 * no ceiling a grammar author can see. The cap bounds it per emitted function.
 *
 * What these tests pin, in order of importance:
 *  1. the cap does not change what the parser ACCEPTS or what it PRODUCES — a body
 *     that becomes a call must parse identically. This is the whole safety argument;
 *  2. the decision is deterministic — same grammar, same cap, byte-identical source;
 *  3. it actually binds, and it is VISIBLE when it does;
 *  4. the escape hatch restores the uncapped emission exactly.
 */
import { describe, it, expect } from 'vitest'
import { rules, regex, sequence, literal, optional, node, many, choice, ref } from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import {
  compileLinkable,
  resolveInlineMax,
  INLINE_MAX_NODES,
  beginInlineCapCapture,
  endInlineCapCapture,
  formatInlineCapSites,
} from '../../src/compiler/codegen.ts'
import { fuseRules } from '../../src/compiler/linker.ts'

/**
 * A rule whose body reaches `depth` PRIVATE single-use refs — the shape the cap exists
 * for. Private matters: a rule-map entry is canonical and is NEVER inlined (it has to
 * stay an addressable `_r_<Name>`), so only a `ref()` that is not a map key can take
 * the inline path at all.
 */
function chainGrammar(depth: number): Array<[string, Combinator<unknown>]> {
  const helpers = Array.from({ length: depth }, () => ref<unknown>())
  for (const h of helpers) {
    h.define(sequence(
      optional(literal('(')),
      regex(/[a-z]+/),
      optional(literal(')')),
      optional(regex(/[0-9]+/)),
    ))
  }
  return [...Object.entries(rules(() => ({
    Root: node('Root', many(choice(helpers[0]! as Combinator<unknown>, ...helpers.slice(1) as Array<Combinator<unknown>>)), (c: unknown) => ({ t: 'Root', c })),
  })))] as Array<[string, Combinator<unknown>]>
}

const link = (map: Array<[string, Combinator<unknown>]>, maxInline?: number) =>
  compileLinkable(map, '_t_', maxInline === undefined ? {} : { maxInline })!

/** The emitted rule bodies, which is what the cap changes. */
const src = (map: Array<[string, Combinator<unknown>]>, maxInline?: number): string =>
  [...link(map, maxInline).ruleFns.values()].join('\n')

describe('inline expansion cap', () => {
  it('parses identically whether a single-use ref is inlined or called', () => {
    const map = chainGrammar(6)
    // maxInline: 0 forbids every paste, so this is the maximal behaviour change.
    expect(src(map, 0)).not.toBe(src(map, Infinity))
    const uncapped = fuseRules([link(map, Infinity)])
    const capped = fuseRules([link(map, 0)])
    for (const input of ['abc', '(abc)12', 'abc def', '(a)1(b)2', '']) {
      expect(capped.Root!(input, 0, {})).toEqual(uncapped.Root!(input, 0, {}))
    }
  })

  it('is deterministic — same grammar and cap produce byte-identical source', () => {
    const a = src(chainGrammar(6), 4)
    const b = src(chainGrammar(6), 4)
    expect(a).toBe(b)
  })

  it('binds: a low cap emits fewer bytes than an uncapped compile', () => {
    const map = chainGrammar(8)
    expect(src(map, 0).length).toBeLessThan(src(map, Infinity).length)
  })

  it('does not bind on a grammar that fits, so the default costs nothing', () => {
    const map = chainGrammar(3)
    expect(src(map)).toBe(src(map, Infinity))
  })

  it('reports every function whose budget was spent, and says what to do', () => {
    beginInlineCapCapture()
    src(chainGrammar(8), 0)
    const sites = endInlineCapCapture()
    expect(sites.length).toBeGreaterThan(0)
    expect(sites.every(s => s.fn.length > 0 && s.nodes > 0)).toBe(true)
    const lines = formatInlineCapSites(sites, 0)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]).toContain('inline-cap')
    expect(lines[0]).toContain('maxInline')
  })

  it('collects nothing when the capture is closed', () => {
    expect(endInlineCapCapture()).toEqual([])
  })

  describe('resolveInlineMax', () => {
    const saved = process.env.PARSEMAN_MAX_INLINE
    const set = (v: string | undefined) => {
      if (v === undefined) delete process.env.PARSEMAN_MAX_INLINE
      else process.env.PARSEMAN_MAX_INLINE = v
    }

    it('prefers the explicit option over the environment', () => {
      set('7')
      expect(resolveInlineMax(3)).toBe(3)
      set(saved)
    })

    it('reads the environment escape hatch, including the off spellings', () => {
      set('42'); expect(resolveInlineMax()).toBe(42)
      set('off'); expect(resolveInlineMax()).toBe(Infinity)
      set('infinity'); expect(resolveInlineMax()).toBe(Infinity)
      set(saved)
    })

    it('falls back to the measured default on absent or unusable values', () => {
      for (const v of [undefined, '', 'banana', '-1']) {
        set(v)
        expect(resolveInlineMax()).toBe(INLINE_MAX_NODES)
      }
      set(saved)
    })
  })
})
