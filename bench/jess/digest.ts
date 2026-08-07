/**
 * One engine's answer for every file in one dialect's corpus, as TSV.
 *
 * Split out from the comparison because the three engines cannot coexist in one
 * process: `composeLeaf()`'s interpreted fuse binds the shared recognition
 * pieces IN PLACE, and the macro lowering REPLACES the grammar module outright.
 * So each leg is its own process and `divergence.ts` joins their digests.
 *
 *   node --import ./bench/jess/register.mjs bench/jess/digest.ts <dialect> interpreted [variant]
 *   node --import ./bench/jess/register.mjs bench/jess/digest.ts <dialect> table [variant]
 *   PM_MACRO=1 node --import ./bench/jess/register.mjs bench/jess/digest.ts <dialect> compiled [variant]
 *
 * ENGINE TOKEN LEGEND — the `ENGINES` tokens are a WIRE CONTRACT (argv, and the
 * TSV `divergence.ts` joins on) and keep their historical spelling; this is what
 * each one actually binds:
 *   table        execRules()   the REFERENCE bytecode interpreter (NOT what ships)
 *   compiled     PM_MACRO=1    the shipped ASSEMBLER — the macro routes to it;
 *                              there is no source-lowering "codegen" engine,
 *                              because `src/compiler/codegen.ts` was DELETED in
 *                              `37c57b5`
 *   interpreted  the combinator graph
 *
 * `compiled` REQUIRES `PM_MACRO=1`; without it the grammar module is a
 * combinator graph and the leg would silently be the interpreter again.
 *
 * The VARIANT defaults to `ast`. It has to be a parameter rather than a
 * constant because `trackLines` and `hostMode` are exactly the axis a table is
 * built along, and an identity sweep that only ever ran the `ast` cell proves
 * nothing about the other three — which is how a dead-value analysis could stop
 * running on every tracking grammar without a single gate noticing.
 */
import { cstBuildHost } from '../../src/compiler/linker.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { run } from '../../src/functional/run.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import {
  corpus, DIALECTS, ENTRY, VARIANTS, VARIANT_SETTINGS, loadGrammar,
  type Dialect, type Variant,
} from './grammars.ts'

type RunnableLike = Parameters<typeof run>[0]

export const ENGINES = ['interpreted', 'compiled', 'table'] as const
export type Engine = (typeof ENGINES)[number]

/** The facets identity is decomposed into, most-severe first. */
export const FACETS = ['value', 'span', 'expected', 'expected-order', 'errors', 'rootTrivia'] as const
export type Facet = (typeof FACETS)[number]

/** Column order of one TSV row after the file name. `whole` is the identity. */
export const COLUMNS = ['whole', ...FACETS] as const

export function digestRow(r: ReturnType<typeof run>): string[] {
  const expected = [...(r.expected ?? [])]
  return [
    // IDENTITY IS THE WHOLE `RunResult`. A narrow digest is what let the last
    // defect class hide: `{ ok, value, unconsumedFrom }` agreed on files where
    // the engines had taken different paths to the same answer.
    digestValue(r),
    // Acceptance + the tree + where the parse stopped.
    digestValue({ ok: r.ok, value: r.value, unconsumedFrom: r.unconsumedFrom }),
    // The failure POSITION lives here: on a failed parse `span` is where it failed.
    digestValue(r.span),
    // As a SET — neither engine promises an order, so ordering is scored apart.
    digestValue([...expected].sort()),
    digestValue(expected),
    // Count, messages and spans — `ParseError` carries all three.
    digestValue(r.errors),
    digestValue(r.rootTrivia),
  ]
}

/** A reducer THROW is an answer too: jess's dialects reject illegal constructs
 * that way, and all three engines call the same reducer. */
const THREW = 'threw'

async function main(): Promise<void> {
  const dialect = process.argv[2] as Dialect
  const engine = process.argv[3] as Engine
  if (!DIALECTS.includes(dialect)) throw new Error(`unknown dialect '${String(process.argv[2])}'`)
  if (!ENGINES.includes(engine)) throw new Error(`unknown engine '${String(process.argv[3])}'`)
  const variant = (process.argv[4] ?? 'ast') as Variant
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant '${String(process.argv[4])}'`)
  const macro = process.env.PM_MACRO === '1'
  if ((engine === 'compiled') !== macro) {
    throw new Error(`engine '${engine}' with PM_MACRO=${macro ? '1' : 'unset'} — 'compiled' needs PM_MACRO=1 and the others need it unset`)
  }

  const { rules } = await loadGrammar(dialect, variant)
  const entry: RunnableLike = engine === 'table'
    ? execRules(encodeTable(rules, VARIANT_SETTINGS[variant]))[ENTRY] as RunnableLike
    : rules[ENTRY] as RunnableLike
  if (entry === undefined) throw new Error(`${engine}: no rule '${ENTRY}'`)
  // PROVE THE LEG IS THE LEG IT CLAIMS. `run()` accepts both shapes, so a
  // `compiled` run that silently got the combinator graph would produce a
  // perfect interpreted-vs-compiled agreement and prove nothing at all. The
  // macro lowers a rule to a FUNCTION; the interpreted fuse leaves an object.
  const isFn = typeof entry === 'function'
  if (engine === 'compiled' && !isFn) throw new Error("engine 'compiled' got a combinator, not an assembled rule — the macro did not run")
  if (engine === 'interpreted' && isFn) throw new Error("engine 'interpreted' got an assembled rule — PM_MACRO leaked in")

  // A `cst` GRAMMAR REFUSES TO RUN WITHOUT A HOST. `host-mode.ts` throws on the
  // first node, so every row of a hostless `cst`/`cst-lines` leg was the SAME
  // `threw:` string — 87 of 87 for css, and a leg whose every row is identical
  // agrees with any other leg that is equally dead. Two of the four variants
  // this file exists to cover were therefore vacuous in every engine, and a
  // planted defect in any of them would have moved zero rows. `emit-identity-one.ts`
  // has passed a host since the day it was written; this is the same line.
  // The `ast` variants take no host by construction.
  const opts = VARIANT_SETTINGS[variant].hostMode === 'cst' ? { build: cstBuildHost() } : {}

  // `--raw <substring>`: print the READABLE failure report for matching files
  // instead of digests. A digest says two engines disagree; only this says what
  // about, and every claim that one engine is the wrong one is argued from it.
  const rawAt = process.argv.indexOf('--raw')
  if (rawAt >= 0) {
    const needle = process.argv[rawAt + 1] ?? ''
    for (const f of corpus(dialect)) {
      if (!f.name.includes(needle)) continue
      try {
        const r = run(entry, f.input, opts)
        console.log(JSON.stringify({
          file: f.name, engine, ok: r.ok, span: r.span, unconsumedFrom: r.unconsumedFrom,
          expected: r.expected, errorCount: r.errors.length,
          errors: r.errors.map(e => ({ message: (e as { message?: string }).message, span: (e as { span?: unknown }).span })),
        }))
      } catch (e) { console.log(JSON.stringify({ file: f.name, engine, threw: (e as Error).message.split('\n')[0] })) }
    }
    return
  }

  const lines: string[] = [`# ${dialect}\t${engine}\t${variant}\t${COLUMNS.join('\t')}`]
  for (const f of corpus(dialect)) {
    let cells: string[]
    try { cells = digestRow(run(entry, f.input, opts)) }
    catch (e) { cells = [`${THREW}: ${(e as Error).message.split('\n')[0] ?? ''}`] }
    lines.push(`${f.name}\t${cells.join('\t')}`)
  }
  process.stdout.write(lines.join('\n') + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
