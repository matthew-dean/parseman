/**
 * DUPLICATE-FUNCTION GATE — no function printed twice in what parseman emits.
 *
 * Bar 2 of an engine refactor: a piece of the engine is one function in the output,
 * not a copy per site. A copy costs bytes in every process that loads it and splits
 * one piece's JIT profile across several functions; a "reuse" refactor can add copies
 * while the size gate reads a few percent.
 *
 * WHAT IT READS
 *   emitted/<grammar>   every `new Function` body runtime `compile()` generates for
 *                       parseman's workload grammars (`bench/workloads/`), captured as
 *                       the Function constructor receives it
 *   macro/<dialect>/<variant>
 *                       the printed output: jess's grammars, macro-built and bundled
 *                       as jess ships them — the same bytes `size:guard:jess` measures
 *
 * Every function in an artifact is normalised (`functionShapes` in
 * `scripts/function-shapes.mjs`: comments, whitespace and the function's own
 * binding names dropped) and hashed. A shape that occurs n times is n−1 duplicates.
 * Bodies under 60 characters are not counted, so `() => FAIL` is not a copy.
 *
 * RATCHET: `bench/dup-function-baseline.json` holds each artifact's duplicate count.
 * More fails. Fewer also fails until it is banked (`pnpm dupfn:baseline`), so the
 * headroom a fix creates is not budget for the next copy. The function count is
 * printed beside it and not gated: `size-gate` gates bytes.
 *
 *   pnpm dupfn:guard
 *   pnpm dupfn:baseline
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fail, summary } from './ab-harness.ts'
import { duplicateCount, functionShapes, type FunctionShape } from '../scripts/function-shapes.mjs'

const GATE = 'dup-function'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = path.join(HERE, 'dup-function-baseline.json')

export type Artifact = { id: string; code: string }
export type Row = { functions: number; duplicates: number }

/** The artifacts, built from the parseman whose root is `root`. */
export async function collectArtifacts(root: string): Promise<Artifact[]> {
  const out: Artifact[] = []
  const { buildWorkloads } = await import(path.join(root, 'bench', 'workloads', 'index.ts')) as {
    buildWorkloads: () => Array<{ id: string; make: () => { parse: () => unknown } }>
  }

  // The emitted assembly is built at the first parse, so capture across one.
  const RealFunction = Function
  const captured: string[] = []
  const capture = (args: unknown[]): unknown => {
    captured.push(`(function(${args.slice(0, -1).map(String).join(',')}){${String(args.at(-1) ?? '')}\n})`)
    return Reflect.construct(RealFunction, args.map(String))
  }
  globalThis.Function = new Proxy(RealFunction, {
    construct: (_t, args: unknown[]) => capture(args) as object,
    apply: (_t, _self, args: unknown[]) => capture(args),
  }) as FunctionConstructor
  try {
    const seen = new Set<string>()
    for (const w of buildWorkloads()) {
      const grammar = w.id.split('/')[0]!
      captured.length = 0
      w.make().parse()
      if (seen.has(grammar)) continue
      seen.add(grammar)
      if (captured.length === 0) throw new Error(`${w.id}: compile() emitted no code, so there is nothing to read`)
      out.push({ id: `emitted/${grammar}`, code: captured.join('\n;\n') })
    }
  } finally {
    globalThis.Function = RealFunction
  }

  const { withBuiltSnapshot, DIALECTS, VARIANTS } = await import(path.join(root, 'bench', 'jess', 'real-grammars.ts')) as {
    DIALECTS: readonly string[]
    VARIANTS: Readonly<Record<string, string>>
    withBuiltSnapshot: <T>(fn: (snap: { shipped: (d: string, v: string) => Promise<{ file: string }> }) => Promise<T>) => Promise<T>
  }
  await withBuiltSnapshot(async snap => {
    for (const d of DIALECTS) {
      for (const v of Object.keys(VARIANTS)) {
        const { file } = await snap.shipped(d, v)
        out.push({ id: `macro/${d}/${v}`, code: readFileSync(file, 'utf8') })
      }
    }
  })
  return out
}

export function measure(artifacts: readonly Artifact[]): { rows: Record<string, Row>; shapes: Record<string, FunctionShape[]> } {
  const rows: Record<string, Row> = {}
  const shapes: Record<string, FunctionShape[]> = {}
  for (const a of artifacts) {
    const s = functionShapes(a.code, `${a.id}.mjs`)
    shapes[a.id] = s
    rows[a.id] = { functions: s.length, duplicates: duplicateCount(s) }
  }
  return { rows, shapes }
}

/** Every failure, named. Empty means green. */
export function dupFailures(baseline: Readonly<Record<string, number>>, rows: Readonly<Record<string, Row>>): string[] {
  const failures: string[] = []
  for (const id of [...new Set([...Object.keys(baseline), ...Object.keys(rows)])].sort()) {
    const b = baseline[id]
    const r = rows[id]
    if (b === undefined || r === undefined) {
      failures.push(`${id}: ${b === undefined ? 'not in the baseline' : 'in the baseline but not built'}`)
      continue
    }
    if (r.duplicates > b) failures.push(`${id}: ${r.duplicates} duplicated functions, baseline ${b}`)
    else if (r.duplicates < b) failures.push(`${id}: ${r.duplicates} duplicated functions, baseline ${b} — bank the win (pnpm dupfn:baseline)`)
  }
  return failures
}

/** The largest repeated shapes in one artifact, for the failure message. */
function worst(shapes: readonly FunctionShape[], n = 5): string[] {
  const groups = new Map<string, FunctionShape[]>()
  for (const s of shapes) groups.set(s.hash, [...(groups.get(s.hash) ?? []), s])
  return [...groups.values()].filter(g => g.length > 1)
    .sort((a, b) => b[0]!.chars * (b.length - 1) - a[0]!.chars * (a.length - 1))
    .slice(0, n)
    .map(g => `${g.length}x ${g[0]!.chars} chars \`${g[0]!.name}\` at lines ${g.map(s => s.line).join(', ')}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const ROOT = path.resolve(HERE, '..')
  let artifacts: Artifact[]
  try {
    artifacts = await collectArtifacts(ROOT)
  } catch (error) {
    fail(GATE, (error as Error).message)
  }
  const { rows, shapes } = measure(artifacts)
  if (process.argv.includes('--update')) {
    const counts = Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, r.duplicates]))
    writeFileSync(BASELINE_PATH, `${JSON.stringify(counts, null, 2)}\n`)
    console.log(`${GATE}: wrote ${Object.keys(counts).length} artifacts to ${path.relative(ROOT, BASELINE_PATH)}`)
    process.exit(0)
  }
  if (!existsSync(BASELINE_PATH)) fail(GATE, `${BASELINE_PATH} is missing; write it with pnpm dupfn:baseline.`)
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, number>
  summary([
    `#### ${GATE}: functions printed more than once`,
    '',
    '| artifact | functions | duplicated | baseline |',
    '| --- | ---: | ---: | ---: |',
    ...Object.entries(rows).map(([id, r]) => `| ${id} | ${r.functions.toLocaleString('en-US')} | ${r.duplicates} | ${baseline[id] ?? 'none'} |`),
  ].join('\n'))
  const failures = dupFailures(baseline, rows)
  if (failures.length > 0) {
    const detail = failures.flatMap(f => {
      const id = f.slice(0, f.indexOf(':'))
      const s = shapes[id]
      return s === undefined ? [f] : [f, ...worst(s).map(w => `    ${w}`)]
    })
    fail(GATE, `FAILED\n  ${detail.join('\n  ')}`)
  }
  console.log(`\n${GATE}: ok — ${Object.keys(rows).length} artifacts, no new duplicated function`)
}
