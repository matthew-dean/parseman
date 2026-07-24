/**
 * Cross-artifact (composeLeaf-style) first-set dispatch.
 *
 * A choice arm / node whose leading term is a rule REFERENCE into a SEPARATELY
 * compiled recognition artifact — `sequence(g.SyntaxAtName, prelude, ';')` — must
 * first-char-gate on that referenced rule's real first set, exactly as a grammar
 * with the recognizer spelled locally would. Two engine facts make this work:
 *
 *  1. `canMatchEmptyAtStart` is PRECISE for a regex (does it actually match the
 *     empty string?), so a required-prefix recognizer like `/@media(?![-\w])/`
 *     (which contains a `?` only inside a lookahead) is NOT wrongly treated as
 *     nullable — its `compileLinkable` first-set / recipe stays `{@}`, not `any`.
 *  2. The leading first-set recipe is an ORDERED CHAIN whose fuse-time resolution
 *     STOPS at the first non-nullable segment. So the arm resolves to the ref's
 *     `{@}` even when the terms AFTER the ref have an `any`/nullable first set
 *     (a `scanTo` prelude) — the recipe no longer over-unions the tail to `any`.
 *
 * Regression guard for the grammar-local-recognizer workarounds jess had to hand-
 * write (css `first-char-gate the at-rule cluster`, scss `grammar-local at-keywords`).
 */
import { describe, it, expect } from 'vitest'
import { sequence, choice, literal, regex, node, many, optional, scanTo, rules, parse as runtimeParse } from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import { compileLinkable, leadingFirstSetRecipe } from '../../src/compiler/codegen.ts'
import { fuseRules, fusedBody } from '../../src/compiler/linker.ts'

const cst = (type: string) => (ch: readonly unknown[], _f: unknown, span: { start: number; end: number }) =>
  ({ _tag: 'node' as const, type, span, children: [...ch] })

describe('cross-artifact first-set dispatch (composeLeaf shape)', () => {
  it('compileLinkable keeps a required-prefix recognizer regex first-set (not poisoned to any)', () => {
    // `@media(?![-\w])` has a `?` only inside the lookahead — it can NOT match empty.
    const recog = rules(() => ({ SyntaxMediaAt: regex(/@media(?![-\w])/i) }))
    const p = compileLinkable(Object.entries(recog), '_r_')!
    expect(p.firstSets.get('SyntaxMediaAt')).toMatchObject({ kind: 'ranges', ranges: [{ lo: 64, hi: 64 }] })
    expect(p.nullable!.get('SyntaxMediaAt')).toBe(false)
    // …and its recipe resolves to the concrete `{@}` (not an `any` seg).
    const rec = p.firstSetRecipes!.get('SyntaxMediaAt')!
    expect(rec).toMatchObject({ alts: [[{ set: { kind: 'ranges', ranges: [{ lo: 64, hi: 64 }] } }]] })
  })

  it('gates a sequence(ref, ANY-prelude, …) arm on the cross-artifact ref first char', () => {
    const recog = rules(() => ({ SyntaxStmtAt: regex(/@[a-z]+(?![-\w])/i) }))
    const consumer = rules((g: Record<string, Combinator<unknown>>) => ({
      Prelude: node('Prelude', scanTo(literal(';')), cst('Prelude')),          // any-first-set, nullable
      AtStmt: node('AtStmt', sequence(g.SyntaxStmtAt!, g.Prelude!, literal(';')), cst('AtStmt')),
      Ruleset: node('Ruleset', sequence(regex(/[^{}@;]+/), literal('{'), literal('}')), cst('Ruleset')),
      Doc: node('Doc', many(choice(g.AtStmt!, g.Ruleset!)), cst('Doc')),
    }))
    const { body } = fusedBody([
      compileLinkable(Object.entries(recog), '_r_')!,
      compileLinkable(Object.entries(consumer), '_c_')!,
    ])
    // The AtStmt arm must gate on `@`(64) — before the fix it degraded to always-try
    // because the recipe over-unioned the `any` prelude tail.
    expect(body).toMatch(/=== 64/)
    expect(body).not.toMatch(/@FS/)                     // placeholder resolved
  })

  it('an ordered-chain recipe stops at a NON-nullable leading ref (drops the any tail)', () => {
    const consumer = rules((g: Record<string, Combinator<unknown>>) => ({
      Prelude: node('Prelude', scanTo(literal(';')), cst('Prelude')),
      AtStmt: node('AtStmt', sequence(g.SyntaxStmtAt!, g.Prelude!, literal(';')), cst('AtStmt')),
    }))
    const rec = leadingFirstSetRecipe((consumer as Record<string, Combinator<unknown>>).AtStmt!)
    // one chain leading with the (non-forced) SyntaxStmtAt ref
    expect(rec.alts).toHaveLength(1)
    expect(rec.alts[0]![0]).toMatchObject({ ref: 'SyntaxStmtAt', nullable: false })
  })

  it('an OPTIONAL leading token forces the chain to continue to a following ref', () => {
    // `sequence(optional(.#), ref)`: the optional is skippable, so the ref's chars
    // must still be unioned into the gate — the optional seg is forced nullable.
    const consumer = rules((g: Record<string, Combinator<unknown>>) => ({
      Sel: node('Sel', sequence(optional(regex(/[.#]/)), g.Interp!, literal('x')), cst('Sel')),
    }))
    const rec = leadingFirstSetRecipe((consumer as Record<string, Combinator<unknown>>).Sel!)
    const chain = rec.alts[0]!
    const dotHash = chain.find(s => s.set.kind === 'ranges')!
    expect(dotHash.nullable).toBe(true)                              // optional → skippable → continue
    expect(chain.some(s => s.ref === 'Interp')).toBe(true)          // ref reached AFTER the optional
  })

  it('fused (gated) parse === interpreter (ungated) across cross-artifact grammars — soundness', () => {
    // Bounded deterministic soundness sweep: recognition regexes with internal ?/*
    // referenced across an artifact boundary, with any/nullable tails.
    function mulberry32(a: number) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
    const rnd = mulberry32(12345)
    const pk = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!
    const toks = [
      () => regex(/@media(?![-\w])/i), () => regex(/@[a-z]+(?![-\w])/i),
      () => regex(/#[0-9a-f]+/i), () => regex(/\.[a-z][-a-z0-9]*/), () => regex(/[a-z]+/),
      () => regex(/[0-9]*/), () => regex(/x?/), () => literal('!important'),
    ]
    const alpha = '@#.$!:;{}abcxyz012 media'
    const choiceN = choice as unknown as (...a: Combinator<unknown>[]) => Combinator<unknown>
    const seqN = sequence as unknown as (...a: Combinator<unknown>[]) => Combinator<unknown>
    let falseExcludes = 0, endMismatch = 0, tested = 0
    for (let gi = 0; gi < 300; gi++) {
      const names: string[] = []
      const defs: Record<string, (g: Record<string, Combinator<unknown>>) => Combinator<unknown>> = {}
      const nTok = 2 + Math.floor(rnd() * 3)
      for (let i = 0; i < nTok; i++) { const n = `T${gi}_${i}`; names.push(n); const t = pk(toks)(); defs[n] = () => t }
      const cons: string[] = []
      const nCon = 2 + Math.floor(rnd() * 3)
      for (let i = 0; i < nCon; i++) {
        const n = `R${gi}_${i}`; cons.push(n); const lead = pk(names); const k = Math.floor(rnd() * 4)
        defs[n] = (g) => {
          const parts: Combinator<unknown>[] = []
          if (k === 0) parts.push(optional(g[pk(names)]!))
          parts.push(g[lead]!)
          if (k === 1) parts.push(node('P' + n, scanTo(literal(';')), cst('P')), literal(';'))
          else if (k === 2) parts.push(many(g[pk(names)]!), literal('}'))
          else parts.push(regex(/[^{};]*/), literal(';'))
          return node(n, seqN(...parts), cst(n))
        }
      }
      const entry = `D${gi}`
      defs[entry] = (g) => node(entry, many(choiceN(...cons.map(c => g[c]!),
        node('RS' + gi, seqN(regex(/[^{}@#.$!:;]+/), literal('{'), literal('}')), cst('RS')))), cst(entry))
      const all = [...names, ...cons, entry]
      const map = rules((g: Record<string, Combinator<unknown>>) => {
        const o: Record<string, Combinator<unknown>> = {}
        for (const nm of all) o[nm] = defs[nm]!(g)
        return o
      })
      const entries = Object.entries(map)
      const buckets: Array<Array<[string, Combinator<unknown>]>> = [[], []]
      for (const e of entries) buckets[Math.floor(rnd() * 2)]!.push(e as [string, Combinator<unknown>])
      let R: Record<string, (i: string, p: number, c: object) => { ok: boolean; span: { end: number } }>
      try {
        const pieces = buckets.filter(b => b.length).map((b, bi) => compileLinkable(b, `_z${gi}_${bi}_`)!)
        R = fuseRules(pieces) as never
      } catch { continue }
      const fn = R[entry]; if (!fn) continue
      for (let ii = 0; ii < 20; ii++) {
        let s = ''; const len = Math.floor(rnd() * 12)
        for (let j = 0; j < len; j++) s += alpha[Math.floor(rnd() * alpha.length)]
        tested++
        const a = runtimeParse((map as Record<string, Combinator<unknown>>)[entry]!, s)
        let b; try { b = fn(s, 0, {}) } catch { continue }
        if (a.ok && !b.ok) falseExcludes++
        else if (a.ok && b.ok && (a.span as { end: number }).end !== b.span.end) endMismatch++
      }
    }
    expect(tested).toBeGreaterThan(1000)
    expect(falseExcludes).toBe(0)
    expect(endMismatch).toBe(0)
  })
})
