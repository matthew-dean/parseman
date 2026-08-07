/**
 * Is the FOLDED artifact the same parser as the four it replaces?
 *
 * Bytes saved by a fold that changes a tree are not a saving, so this is the
 * gate the size figure is only readable behind. For every dialect, every
 * variant and every file in the real corpus, it compares the whole `RunResult`
 * digest of
 *
 *   tableVariants(foldPrograms({...}), v)     the ONE folded table, run on the
 *                                             shipped ASSEMBLER (`tableVariants`
 *                                             calls `tableRules`)
 *   execRules(encodeTable(rules, S[v]))       each of the four tables encoded
 *                                             SEPARATELY, run on the REFERENCE
 *                                             bytecode interpreter — nothing
 *                                             ships on that engine; it is the
 *                                             identity reference
 *
 * So this gates TWO things at once, and that is deliberate: the fold must not
 * change the parse, and the assembler must agree with the reference interpreter.
 * A difference here does not by itself say which of the two moved.
 *
 * ONE process per dialect, and that is itself the finding: the four
 * `trackLines` x `hostMode` artifacts are four ENCODINGS of a single grammar
 * export. `composeLeaf`'s fuse only ever let one export be realised per process,
 * and one is all this needs.
 *
 * Usage: `pnpm fold:identity`
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digestValue } from '../../src/oracle/index.ts'
import { run } from '../../src/functional/run.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { tableVariants } from '../../src/table/fold.ts'
import { foldPrograms, type TableProgram } from '../../src/table/program.ts'
import { cstBuildHost } from '../../src/compiler/linker.ts'
import {
  DIALECTS, ENTRY, VARIANTS, VARIANT_SETTINGS, assertParseman, corpus, corpusTotal,
  loadGrammar, type Dialect, type Variant,
} from './grammars.ts'

type Runnable = Parameters<typeof run>[0]

/** A `cst` artifact refuses to run without a positioned-CST build host. */
function optsFor(v: Variant): Record<string, unknown> {
  return v.startsWith('cst') ? { build: cstBuildHost } : {}
}

function digest(entry: Runnable, input: string, v: Variant): string {
  try { return digestValue(run(entry, input, optsFor(v) as never)) }
  catch (e) { return `threw:${(e as Error).message.split('\n')[0] ?? ''}` }
}

async function one(dialect: Dialect): Promise<void> {
  const { rules } = await loadGrammar(dialect, 'ast')
  const progs: Record<string, TableProgram> = {}
  for (const v of VARIANTS) progs[v] = encodeTable(rules, VARIANT_SETTINGS[v])
  const folded = foldPrograms(progs, 'ast')
  const files = corpus(dialect)
  const total = corpusTotal(dialect)
  for (const v of VARIANTS) {
    const viaFold = tableVariants(folded, v)[ENTRY] as Runnable
    const direct = execRules(progs[v]!)[ENTRY] as Runnable
    let same = 0
    const differing: string[] = []
    for (const f of files) {
      if (digest(viaFold, f.input, v) === digest(direct, f.input, v)) same++
      else if (differing.length < 5) differing.push(f.name)
    }
    const bounded = files.length === total ? '' : `  (BOUNDED: ${total - files.length} of ${total} NOT compared)`
    const verdict = same === files.length ? 'IDENTICAL' : `${files.length - same} DIFFER`
    console.log(`  ${dialect}/${v.padEnd(10)} ${same}/${files.length} of ${total}${bounded}  ${verdict}`)
    for (const n of differing) console.log(`      differs: ${n}`)
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const REGISTER = resolvePath(HERE, 'register.mjs')
const SELF = resolvePath(HERE, 'fold-identity.ts')

async function main(): Promise<void> {
  const arg = process.argv[2] as Dialect | undefined
  if (arg !== undefined) { await one(arg); return }
  const pm = await assertParseman()
  console.log(`parseman ${pm.version}   ${pm.root}`)
  console.log('')
  console.log('=== FOLDED (assembled) vs four SEPARATE tables (exec, reference) — whole RunResult digest, real corpora')
  for (const d of DIALECTS) {
    process.stdout.write(execFileSync(process.execPath, ['--import', REGISTER, SELF, d], {
      encoding: 'utf8', maxBuffer: 1 << 28,
    }))
  }
}

await main()
