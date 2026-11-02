/**
 * The `_errors` marks a whole-token `balanced()` adds to the sites that reach it
 * (`table-lex-program-scan-errors.test.ts`) are budget-neutral: a budgeted
 * assembly selection is priced on the lowering without them (`scanSinkNeutral`),
 * so they move no site in or out of the selection.
 */
import { describe, expect, it } from 'vitest'
import { balanced, choice, literal, many, optional, regex, sequence } from '../../src/index.ts'
import { compileRuleMap } from '../../src/table/compile-rule-map.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { resolveTable, assemblyExtraIps } from '../../src/table/program.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { selectHotSites } from '../../src/table/select-hot.ts'
import type { Combinator } from '../../src/types.ts'

const group = balanced('(', ')')
const item = (c: string): Combinator<unknown> => choice(sequence(group, literal(c)), sequence(literal(c), optional(group)), regex(/[a-z]+/))
const entries = [['Entry', many(choice(item('!'), item('?'), item(';'), sequence(literal('{'), many(item(',')), literal('}'))))]] as const

describe('the _errors marks of a lexical program over a scan move no site in or out of a budgeted selection', () => {
  it('prices sites on a lowering without them, which differs in size from the marked one', () => {
    const artifact = encodeTable(Object.fromEntries(entries))
    const table = resolveTable(artifact)
    const cfg = defaultAssemblyCfgs(artifact)[0]!
    const roots = assemblyExtraIps(artifact)
    const neutral = emitAssemblySource(table, artifact, cfg, roots, true, undefined, true)
    const marked = emitAssemblySource(table, artifact, cfg, roots, true)
    // The marks are there, and they cost bytes the neutral pricing does not see.
    expect(marked.source).toMatch(/ctx\._errors\.length/)
    expect(neutral.source).not.toMatch(/ctx\._errors\.length/)
    const fixed = emitAssemblySource(table, artifact, cfg, roots, true, new Set(), true).source.length
    const compiled = compileRuleMap(entries, {})!
    let moved = 0
    for (let budget = fixed + 200; budget < marked.source.length * 1.2; budget += 97) {
      const want = selectHotSites(artifact.code, Object.values(artifact.rules), neutral.siteBytes, budget - fixed)
      const priced = selectHotSites(artifact.code, Object.values(artifact.rules), marked.siteBytes, budget - fixed)
      if ([...want].sort().join() !== [...priced].sort().join()) moved++
    }
    // Priced with the marks, the selection would move somewhere in this range.
    expect(moved).toBeGreaterThan(0)
    // The rule map's selection is the neutral one wherever it fits as it is.
    const span = marked.source.length * 1.2 - fixed
    for (let step = 1; step <= 6; step++) {
      const budget = Math.floor(fixed + (span * step) / 6)
      const want = selectHotSites(artifact.code, Object.values(artifact.rules), neutral.siteBytes, budget / 1.05 - fixed)
      const got = compiled.selectAssembly(budget)
      if (got.sites.size === 0) continue
      const neutralBytes = emitAssemblySource(table, artifact, cfg, roots, true, want, true).source.length
      if (neutralBytes > budget / 1.05) continue
      expect([...got.sites].sort().join(), `budget ${budget}`).toBe([...want].sort().join())
    }
  })
})
