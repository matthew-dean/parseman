/**
 * Sweeps `assemblyBudget` in small steps over all four Jess grammars and reports the
 * sites each step lost. It should report 0. The sweep takes minutes, so it runs by hand:
 * `node --import ./bench/jess/register.mjs bench/jess/selection-sweep.ts`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { transformMacro } from '../../src/plugin/index.ts'
import { withBuiltSnapshot } from './real-grammars.ts'

const STEPS = 40
const SWEEPS = { css: [2.4, 0.01], less: [0.3, 0.01], scss: [0.4, 0.01], jess: [0.5, 0.05] } as const

await withBuiltSnapshot(async ({ root }) => {
  for (const [dialect, [from, step]] of Object.entries(SWEEPS)) {
    const id = join(root, dialect, 'grammar.ts')
    const code = readFileSync(id, 'utf8')
    let last = new Set<number>()
    let lost = 0
    for (let i = 0; i < STEPS; i++) {
      const share = from + i * step
      const now = new Set(transformMacro(code, id, new Set(['parseman']), false, false, false, undefined, share)!.assemblySites)
      lost += [...last].filter(ip => !now.has(ip)).length
      last = now
    }
    console.log(`${dialect}: ${from} to ${from + (STEPS - 1) * step} in ${STEPS} steps, ${last.size} sites at the top, ${lost} lost`)
  }
})
