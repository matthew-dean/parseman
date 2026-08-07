/**
 * LOAD TIME: four independent tables vs one folded table, per dialect.
 *
 * *** THE TWO SIDES ARE DIFFERENT ENGINES. READ THE RATIO ACCORDINGLY. ***
 *
 * The unfolded side calls `execRules()` (`src/table/exec.ts`) — the REFERENCE
 * bytecode interpreter, which is NOT what ships. The folded side calls
 * `tableVariants()` (`src/table/fold.ts`), which since the assembler landed
 * builds through `tableRules()` — the SHIPPED engine. So the printed
 * "Nx FASTER" is NOT a like-for-like fold-vs-unfold figure: it folds the
 * fold's saving together with whatever the two build paths cost differently.
 * Which engines each side builds is an OWNER call and is deliberately left
 * alone here; only the claim is corrected.
 *
 * The table lowering's headline advantage over a source lowering was a far
 * faster cold import (`src/compiler/codegen.ts`, the source lowering, was
 * DELETED in `37c57b5` — nothing lowers to source any more), so a fold that
 * saved bytes by making load slower would be trading the thing the lowering is
 * for. It does the opposite, and this measures by how
 * much: every variant of a folded table shares the base's resolved char
 * classes, dispatch tables and rebuilt trivia, so four variants cost ONE of each
 * between them instead of four. Only the code stream is per variant.
 *
 * ENCODING IS NOT MEASURED. That is a build step; both sides start from
 * already-encoded programs, which is what an artifact ships.
 *
 * Each repetition uses FRESH program objects, because `resolveTable` and
 * `unfoldVariant` both memoize on object identity and a second repetition over
 * the same objects would measure a Map lookup.
 *
 * Usage: `pnpm fold:load`
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { tableVariants } from '../../src/table/fold.ts'
import { foldPrograms, type FoldedProgram, type TableProgram } from '../../src/table/program.ts'
import {
  DIALECTS, VARIANTS, VARIANT_SETTINGS, assertParseman, loadGrammar, loads, type Dialect,
} from './grammars.ts'

const WARMUP = 5
const REPS = 25

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]!
}

async function one(dialect: Dialect): Promise<void> {
  const { rules } = await loadGrammar(dialect, 'ast')
  const progs: Record<string, TableProgram> = {}
  for (const v of VARIANTS) progs[v] = encodeTable(rules, VARIANT_SETTINGS[v])
  const folded = foldPrograms(progs, 'ast')

  // Fresh objects per repetition: both paths cache on identity.
  const freshOld = (): Record<string, TableProgram> =>
    Object.fromEntries(VARIANTS.map(v => [v, { ...progs[v]! }]))
  const freshNew = (): FoldedProgram => ({ base: { ...folded.base }, variants: folded.variants })

  const old: number[] = []
  const neu: number[] = []
  for (let i = 0; i < WARMUP + REPS; i++) {
    const a = freshOld()
    let t = performance.now()
    for (const v of VARIANTS) execRules(a[v]!)
    const dOld = performance.now() - t
    const b = freshNew()
    t = performance.now()
    for (const v of VARIANTS) tableVariants(b, v)
    const dNew = performance.now() - t
    if (i >= WARMUP) { old.push(dOld); neu.push(dNew) }
  }
  const mo = median(old)
  const mn = median(neu)
  console.log(
    `  ${dialect.padEnd(6)} four tables (exec, reference) ${mo.toFixed(2)} ms   folded (assembled, shipped) ${mn.toFixed(2)} ms   `
    + `${mo > mn ? `${(mo / mn).toFixed(2)}x FASTER` : `${(mn / mo).toFixed(2)}x SLOWER`}`,
  )
}

const HERE = dirname(fileURLToPath(import.meta.url))
const REGISTER = resolvePath(HERE, 'register.mjs')
const SELF = resolvePath(HERE, 'fold-load.ts')

async function main(): Promise<void> {
  const arg = process.argv[2] as Dialect | undefined
  if (arg !== undefined) { await one(arg); return }
  const pm = await assertParseman()
  console.log(`parseman ${pm.version}   ${pm.root}`)
  console.log(`loadavg ${loads()} — a CONTENDED machine inflates both sides; the RATIO is the claim`)
  console.log('')
  console.log(`=== BUILDING ALL FOUR VARIANTS' rule maps from encoded programs`)
  console.log(`    median of ${REPS} reps after ${WARMUP} warmup, fresh objects each rep`)
  console.log('    CAVEAT: the two sides are DIFFERENT ENGINES — unfolded builds the REFERENCE')
  console.log('    bytecode interpreter (execRules), folded builds the SHIPPED assembler')
  console.log('    (tableVariants -> tableRules). The ratio is not like-for-like.')
  for (const d of DIALECTS) {
    process.stdout.write(execFileSync(process.execPath, ['--import', REGISTER, SELF, d], {
      encoding: 'utf8', maxBuffer: 1 << 28,
    }))
  }
}

await main()
