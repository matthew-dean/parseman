/**
 * A static selective-assembly selection is stable under small edits: a site
 * whose emitted body grows or shrinks by a few bytes does not reshuffle which
 * sites the budget buys (`select-hot.ts`). Every change to a grammar or to the
 * emitter moves some bodies by a few bytes, and a selection that churns with
 * them makes whole-file measurements unattributable.
 */
import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable } from '../../src/table/program.ts'
import { selectHotSites } from '../../src/table/select-hot.ts'
import { cssRules } from '../../examples/css/parser.ts'
import type { Combinator } from '../../src/types.ts'

describe('static site selection', () => {
  it('selects the same sites when a few bodies change size a little', () => {
    const prog = encodeTable(cssRules as unknown as Record<string, Combinator<unknown>>, {})
    const cfg = defaultAssemblyCfgs(prog)[0]!
    const { siteBytes } = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true)
    const entries = Object.values(prog.rules)
    const total = [...siteBytes.values()].reduce((a, b) => a + b, 0)
    const ips = [...siteBytes.keys()].sort((a, b) => a - b)
    // What an unrelated emitter or grammar change does to an artifact: some
    // bodies a few bytes, or a few percent, larger.
    const edits: Array<[every: number, grow: (bytes: number) => number]> = [
      [7, b => b + 3], [3, b => Math.round(b * 1.03)], [2, b => Math.round(b * 1.05)], [5, b => Math.round(b * 1.1)],
    ]
    for (const [every, grow] of edits) {
      for (const budget of [total / 8, total / 4, total / 2]) {
        const before = selectHotSites(prog.code, entries, siteBytes, budget)
        const edited = new Map(siteBytes)
        ips.forEach((ip, i) => { if (i % every === 0) edited.set(ip, grow(siteBytes.get(ip)!)) })
        const after = selectHotSites(prog.code, entries, edited, budget)
        const moved = [...before].filter(ip => !after.has(ip)).length + [...after].filter(ip => !before.has(ip)).length
        expect(moved, `every ${every}th body, budget ${Math.round(budget)}`).toBeLessThanOrEqual(2)
      }
    }
  })
})
