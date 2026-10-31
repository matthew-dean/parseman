/**
 * A gap gate (`gap-gate.ts`) is budget-neutral: a budgeted assembly selection is
 * priced on the lowering with every gate lowered as its item, so adding the
 * gates moves no site in or out of the selection.
 */
import { describe, expect, it } from 'vitest'
import { literal, many, noTrivia, regex, sequence } from '../../src/index.ts'
import { compileRuleMap } from '../../src/table/compile-rule-map.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { resolveTable, assemblyExtraIps } from '../../src/table/program.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { selectHotSites } from '../../src/table/select-hot.ts'
import type { Combinator } from '../../src/types.ts'

const pad = regex(/[ \t]*/)
const op = (c: string): Combinator<unknown> => noTrivia(sequence(pad, literal(c), pad))
const atom = regex(/[0-9]+/)
const level = (_name: string, inner: Combinator<unknown>, c: string): Combinator<unknown> =>
  noTrivia(sequence(inner, many(sequence(op(c), inner))))
const product = level('Product', atom, '*')
const sum = level('Sum', product, '+')
const entries = [['Entry', level('Cmp', sum, '<')]] as const

describe('a gap gate moves no site in or out of a budgeted selection', () => {
  it('prices sites on a lowering without the gates, which differ in size from the gated one', () => {
    const artifact = encodeTable(Object.fromEntries(entries))
    const table = resolveTable(artifact)
    const cfg = defaultAssemblyCfgs(artifact)[0]!
    const roots = assemblyExtraIps(artifact)
    const neutral = emitAssemblySource(table, artifact, cfg, roots, true, undefined, true)
    const gated = emitAssemblySource(table, artifact, cfg, roots, true)
    // The gates are there, and they cost bytes the neutral pricing does not see.
    expect(gated.source).toMatch(/GAP\.row=/)
    expect(neutral.source).not.toMatch(/GAP\./)
    const fixed = emitAssemblySource(table, artifact, cfg, roots, true, new Set(), true).source.length
    // Priced with the gates, the selection would move somewhere in this range:
    // which is why `compileRuleMap`'s `selectAssembly` prices the neutral one.
    let moved = 0
    for (let budget = fixed + 200; budget < gated.source.length * 1.2; budget += 97) {
      const want = selectHotSites(artifact.code, Object.values(artifact.rules), neutral.siteBytes, budget - fixed)
      const priced = selectHotSites(artifact.code, Object.values(artifact.rules), gated.siteBytes, budget - fixed)
      if ([...want].sort().join() !== [...priced].sort().join()) moved++
    }
    expect(moved).toBeGreaterThan(0)
    // And a compiled rule map's selection runs on it without refusing.
    const refusals: string[] = []
    const compiled = compileRuleMap(entries, { refusals })
    expect(refusals).toEqual([])
    expect(compiled!.selectAssembly(gated.source.length * 2).sites.size).toBeGreaterThan(0)
  })
})
