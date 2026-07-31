/**
 * TREE-IDENTITY ORACLE
 * ====================
 *
 * Parses a corpus with two built parsers and compares the resulting trees. The
 * gate is tree equality, not suite pass/fail: a suite asserts what someone
 * thought to assert, a tree diff asserts everything the parser produced.
 *
 * Use it to prove a codegen change is output-preserving, or to score candidate
 * grammars against a reference implementation.
 *
 *   node --import tsx/esm bench/tree-identity.ts \
 *     --a path/to/reference/lib --b path/to/candidate/lib \
 *     --corpus path/to/corpus --ext .css,.less [--min-real 500]
 *
 * `--a` and `--b` are directories holding a built parser: `index.js` exporting
 * `parse`, and optionally `cst.js` exporting CST/Doc entries. They must be
 * DISTINCT paths — module identity is by path, which is what lets both versions
 * load in one process.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS SO DEFENSIVE ABOUT ITS OWN COVERAGE
 *
 * Every failure this tool has had was the same failure: it reported a clean
 * result while silently examining far less than it claimed. A gate that shrinks
 * does not go red — it goes green, faster. The three concrete ways it shrank are
 * commented at the exact lines that would reintroduce them, and `--min-real`
 * exists so a shrunk run FAILS instead of passing quietly.
 *
 * Real incident: a wrong predicate in `emitFirstMatch` was invisible at 582
 * compared pairs and surfaced only after coverage was fixed to 8,328. The bug
 * did not change; the amount of corpus being looked at did.
 * ---------------------------------------------------------------------------
 */
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

export type TreeIdentityResult = {
  files: number
  compared: number
  /** Pairs where at least one side produced a TREE. The number that matters. */
  realTrees: number
  /** Pairs where both sides threw the same error. Agreement, but weak evidence. */
  identicalThrows: number
  mismatched: number
  failures: string[]
}

/**
 * Collect corpus files.
 *
 * FAILURE MODE 1 — the blanket dot-directory skip.
 * Skipping every entry beginning with `.` is the obvious way to avoid `.git`,
 * and it silently hid an entire 2,299-file corpus that lived in `.cache/`. The
 * run stayed green and the file count looked plausible. Skip dot-entries by NAME
 * against a known list; never by prefix.
 */
const SKIP_DIRS = new Set(['.git', '.svn', 'node_modules', 'lib', 'dist', 'coverage'])

export async function collect(dir: string, exts: readonly string[], out: string[] = []): Promise<string[]> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await collect(p, exts, out)
    else if (exts.some(x => e.name.endsWith(x))) out.push(p)
  }
  return out
}

/**
 * Deterministic, cycle-safe structural serialization.
 *
 * FAILURE MODE 3 — serializing functions.
 * A Doc/CST result can carry a reference to the compiled rule map, so
 * `String(fn)` compares the ARTIFACT'S OWN SOURCE, including generated variable
 * numbering (`_pfv12902` vs `_pfv12697`). Any change to emitted marks shifts
 * those numbers, so every Doc pair reports a mismatch and the tool looks broken
 * rather than informative — which invites someone to drop Doc mode entirely and
 * shrink the gate. A function is parser machinery, not tree data.
 */
export function serializeTree(v: unknown, seen: Map<unknown, number> = new Map()): string {
  if (typeof v === 'function') return '#fn'
  if (v === null || typeof v !== 'object') {
    return typeof v === 'string' ? JSON.stringify(v) : String(v)
  }
  if (seen.has(v)) return `#cyc${seen.get(v)}`
  seen.set(v, seen.size)
  if (Array.isArray(v)) return `[${v.map(x => serializeTree(x, seen)).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map(k => `${k}:${serializeTree(o[k], seen)}`).join(',')}}`
}

type Entry = (src: string) => unknown

/**
 * Resolve the AST / CST / Doc entry points of a built parser.
 *
 * FAILURE MODE 2 — assuming one naming convention.
 * Entry names are dialect-prefixed in every parser but one: `parseCst` on css,
 * but `parseLessCst` / `parseScssCst` / `parseJessCst` elsewhere. Gating on the
 * css names meant three of four parsers silently ran AST-only — a two-thirds
 * coverage loss that reported as a clean pass. Resolve by SHAPE, and report the
 * modes actually found so a missing one is visible in the output.
 */
export async function entriesOf(dir: string): Promise<Record<string, Entry>> {
  const out: Record<string, Entry> = {}
  const main = await import(path.resolve(dir, 'index.js'))
  if (typeof main.parse === 'function') out['ast'] = main.parse as Entry
  try {
    const cst = await import(path.resolve(dir, 'cst.js'))
    const pick = (re: RegExp): Entry | null => {
      const k = Object.keys(cst).find(k => re.test(k) && typeof cst[k] === 'function')
      return k ? (cst[k] as Entry) : null
    }
    const c = pick(/Cst$/), d = pick(/Doc$/)
    if (c) out['cst'] = c
    if (d) out['doc'] = d
  } catch { /* package ships no cst entry */ }
  return out
}

export async function compareTrees(opts: {
  a: string
  b: string
  corpus: string
  exts: readonly string[]
  maxBytes?: number
}): Promise<TreeIdentityResult> {
  const ea = await entriesOf(opts.a)
  const eb = await entriesOf(opts.b)
  const modes = Object.keys(ea).filter(m => m in eb)
  const files = await collect(opts.corpus, opts.exts)
  const r: TreeIdentityResult = { files: files.length, compared: 0, realTrees: 0, identicalThrows: 0, mismatched: 0, failures: [] }

  for (const f of files) {
    let src: string
    try { src = readFileSync(f, 'utf8') } catch { continue }
    if (src.length > (opts.maxBytes ?? 400_000)) continue
    for (const mode of modes) {
      const run = (fn: Entry): string => {
        try { return serializeTree(fn(src)) } catch (e) { return `THROW:${(e as Error)?.message}` }
      }
      const x = run(ea[mode]!), y = run(eb[mode]!)
      r.compared++
      if (x.startsWith('THROW:') && y.startsWith('THROW:')) {
        if (x === y) { r.identicalThrows++; continue }
      } else r.realTrees++
      if (x !== y) {
        r.mismatched++
        if (r.failures.length < 10) {
          let i = 0
          while (i < x.length && i < y.length && x[i] === y[i]) i++
          r.failures.push(`${mode} ${f}\n  a: …${x.slice(Math.max(0, i - 60), i + 90)}\n  b: …${y.slice(Math.max(0, i - 60), i + 90)}`)
        }
      }
    }
  }
  return r
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = arg('a'), b = arg('b'), corpus = arg('corpus')
  if (!a || !b || !corpus) {
    console.error('usage: tree-identity.ts --a <dir> --b <dir> --corpus <dir> [--ext .css,.less] [--min-real N]')
    process.exit(2)
  }
  const exts = (arg('ext') ?? '.css').split(',')
  const minReal = Number(arg('min-real') ?? 0)
  const modesA = Object.keys(await entriesOf(a))
  const r = await compareTrees({ a, b, corpus, exts })

  console.log(`modes: ${modesA.join(', ')}`)
  console.log(`files: ${r.files}`)
  console.log(`compared ${r.compared} pairs · ${r.realTrees} REAL TREES · ${r.identicalThrows} identical-throw · ${r.mismatched} MISMATCHED`)
  for (const f of r.failures) console.log('\n' + f)

  // Coverage is part of the result, not a footnote. A run that examined almost
  // nothing must not exit 0 just because what it examined agreed.
  if (r.realTrees < minReal) {
    console.error(`\nFAIL: ${r.realTrees} real trees is below --min-real ${minReal}. The gate shrank; the corpus, the extensions or the entry resolution is wrong.`)
    process.exit(3)
  }
  if (r.files === 0) {
    console.error('\nFAIL: the corpus matched no files. Check --corpus and --ext.')
    process.exit(3)
  }
  process.exit(r.mismatched === 0 ? 0 : 1)
}
