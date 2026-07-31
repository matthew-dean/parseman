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

export type Divergence = {
  mode: string
  file: string
  /** Property path to the first differing value, e.g. `root.children[2].type`. */
  path: string
  a: string
  b: string
}

export type TreeIdentityResult = {
  files: number
  compared: number
  /** Pairs where at least one side produced a TREE. The number that matters. */
  realTrees: number
  /** Pairs where both sides threw the same error. Agreement, but weak evidence. */
  identicalThrows: number
  mismatched: number
  divergences: Divergence[]
}

/**
 * A declared rename map, for comparing grammars that are allowed to rename
 * productions. Identity then means byte-identity MODULO this map: node names are
 * projected through it, and everything else — structure, nesting, child order,
 * spans, trivia, tags, thrown-error behaviour — must still match exactly.
 *
 * INJECTIVITY IS ENFORCED, and that is the whole point. A non-injective map is a
 * structural merge wearing a rename's clothing: two distinct productions would
 * compare equal and the gate would hide the exact collapse it exists to catch.
 */
export type RenameMap = Readonly<Record<string, string>>

/** Keys whose string values name a production and are therefore renameable. */
const RENAMEABLE_KEYS = new Set(['type', 'grammarType'])

export function assertInjective(map: RenameMap): void {
  const seen = new Map<string, string>()
  for (const [from, to] of Object.entries(map)) {
    const prior = seen.get(to)
    if (prior !== undefined) {
      throw new Error(
        `rename map is NOT injective: "${prior}" and "${from}" both map to "${to}". ` +
        `That merges two productions into one and would make the gate pass on a structural collapse.`,
      )
    }
    seen.set(to, from)
  }
}

/**
 * Detect a build that silently fell back to the interpreter.
 *
 * A grammar with forward references can fail static macro evaluation and fall
 * back, and the build still succeeds and still exports normally — but a fallback
 * artifact is not AST-equivalent to a compiled one, so every tree compared
 * against it is compared against something that does not ship. The only visible
 * symptom is a RUNTIME import of `parseman` in the emitted file where an inlined
 * table belongs.
 *
 * Credit: the css grammar tournament's scorekeeper lane, which makes this a hard
 * precondition before ranking anyone. It is a precondition here for the same
 * reason — this oracle is only as sound as the artifacts it is handed.
 *
 * SCOPE IT TO THE EMITTED GRAMMAR. A package's runtime helpers (`cst-host.js`,
 * `chunks/parse-with.js`) import parseman legitimately and always will, so a
 * recursive search reports every healthy build as a fallback — a false positive
 * that gets the check disabled, which is worse than not having it. Only files
 * directly under `grammar/` are compiled output.
 */
export async function findInterpreterFallbacks(libDir: string): Promise<string[]> {
  const grammarDir = path.join(libDir, 'grammar')
  let names: string[]
  try {
    names = (await readdir(grammarDir, { withFileTypes: true }))
      .filter(e => e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.cjs')))
      .map(e => path.join(grammarDir, e.name))
  } catch {
    throw new Error(`no grammar/ directory under ${libDir} — point --assert-compiled at a built lib/ root`)
  }
  const hits: string[] = []
  for (const f of names) {
    let src: string
    try { src = readFileSync(f, 'utf8') } catch { continue }
    if (/\bfrom\s*["']parseman["']/.test(src) || /\brequire\(\s*["']parseman["']\s*\)/.test(src)) hits.push(f)
  }
  return hits
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
export function serializeTree(
  v: unknown,
  seen: Map<unknown, number> = new Map(),
  rename: RenameMap | null = null,
): string {
  if (typeof v === 'function') return '#fn'
  if (v === null || typeof v !== 'object') {
    return typeof v === 'string' ? JSON.stringify(v) : String(v)
  }
  if (seen.has(v)) return `#cyc${seen.get(v)}`
  seen.set(v, seen.size)
  if (Array.isArray(v)) return `[${v.map(x => serializeTree(x, seen, rename)).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map(k => {
    const raw = o[k]
    // Project only the production-NAME keys. Renaming anything else would let a
    // candidate declare its way past a real structural difference.
    const val = rename && RENAMEABLE_KEYS.has(k) && typeof raw === 'string'
      ? (rename[raw] ?? raw)
      : raw
    return `${k}:${serializeTree(val, seen, rename)}`
  }).join(',')}}`
}

/**
 * First differing property path between two parsed trees. Runs only on a
 * mismatch, so the fast path stays a single string comparison — but a scorer
 * needs to know WHERE two grammars diverged, not merely that they did.
 */
export function firstDivergence(
  a: unknown,
  b: unknown,
  rename: RenameMap | null = null,
  at = 'root',
  seen: Set<unknown> = new Set(),
): { path: string, a: string, b: string } | null {
  // `rename` projects the A side only, exactly as `compareTrees` does — B is
  // the candidate, already using its own names.
  const sa = serializeTree(a, new Map(), rename), sb = serializeTree(b, new Map(), null)
  if (sa === sb) return null
  const brief = (s: string): string => s.length > 120 ? `${s.slice(0, 120)}…` : s
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return { path: at, a: brief(sa), b: brief(sb) }
  }
  if (seen.has(a)) return { path: at, a: brief(sa), b: brief(sb) }
  seen.add(a)
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { path: `${at}.length`, a: String(a.length), b: String(b.length) }
    for (let i = 0; i < a.length; i++) {
      const d = firstDivergence(a[i], b[i], rename, `${at}[${i}]`, seen)
      if (d) return d
    }
    return { path: at, a: brief(sa), b: brief(sb) }
  }
  const oa = a as Record<string, unknown>, ob = b as Record<string, unknown>
  const keys = [...new Set([...Object.keys(oa), ...Object.keys(ob)])].sort()
  for (const k of keys) {
    if (!(k in oa) || !(k in ob)) return { path: `${at}.${k}`, a: k in oa ? 'present' : 'ABSENT', b: k in ob ? 'present' : 'ABSENT' }
    const va = rename && RENAMEABLE_KEYS.has(k) && typeof oa[k] === 'string' ? (rename[oa[k] as string] ?? oa[k]) : oa[k]
    const d = firstDivergence(va, ob[k], rename, `${at}.${k}`, seen)
    if (d) return d
  }
  return { path: at, a: brief(sa), b: brief(sb) }
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
  /** Declared rename map, applied to the `a` side (the incumbent/reference). */
  rename?: RenameMap | null
}): Promise<TreeIdentityResult> {
  const rename = opts.rename ?? null
  if (rename) assertInjective(rename)
  const ea = await entriesOf(opts.a)
  const eb = await entriesOf(opts.b)
  const modes = Object.keys(ea).filter(m => m in eb)
  const files = await collect(opts.corpus, opts.exts)
  const r: TreeIdentityResult = { files: files.length, compared: 0, realTrees: 0, identicalThrows: 0, mismatched: 0, divergences: [] }

  for (const f of files) {
    let src: string
    try { src = readFileSync(f, 'utf8') } catch { continue }
    if (src.length > (opts.maxBytes ?? 400_000)) continue
    for (const mode of modes) {
      const call = (fn: Entry): { ok: true, v: unknown } | { ok: false, v: string } => {
        try { return { ok: true, v: fn(src) } } catch (e) { return { ok: false, v: `THROW:${(e as Error)?.message}` } }
      }
      const ra = call(ea[mode]!), rb = call(eb[mode]!)
      // The rename map projects the A side only: A is the incumbent whose names
      // the candidate declared it was changing.
      const x = ra.ok ? serializeTree(ra.v, new Map(), rename) : ra.v
      const y = rb.ok ? serializeTree(rb.v, new Map()) : rb.v
      r.compared++
      if (x.startsWith('THROW:') && y.startsWith('THROW:')) {
        if (x === y) { r.identicalThrows++; continue }
      } else r.realTrees++
      if (x !== y) {
        r.mismatched++
        if (r.divergences.length < 50) {
          const d = ra.ok && rb.ok
            ? firstDivergence(ra.v, rb.v, rename)
            : { path: 'throw', a: x.slice(0, 160), b: y.slice(0, 160) }
          r.divergences.push({ mode, file: f, path: d?.path ?? 'root', a: d?.a ?? '', b: d?.b ?? '' })
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
  const renamePath = arg('renames')
  let rename: RenameMap | null = null
  if (renamePath) {
    rename = JSON.parse(readFileSync(renamePath, 'utf8')) as RenameMap
    try { assertInjective(rename) } catch (e) { console.error(`FAIL: ${(e as Error).message}`); process.exit(3) }
  }

  // Precondition, before any tree is compared: an artifact that fell back to the
  // interpreter is not the artifact that ships, so comparing against it proves
  // nothing about what ships.
  for (const side of [arg('assert-compiled'), arg('assert-compiled-b')].filter(Boolean) as string[]) {
    const hits = await findInterpreterFallbacks(side)
    if (hits.length > 0) {
      console.error(`FAIL: interpreter fallback — ${hits.length} emitted file(s) import parseman at runtime:\n  ${hits.slice(0, 5).join('\n  ')}`)
      process.exit(3)
    }
  }

  const modesA = Object.keys(await entriesOf(a))
  const r = await compareTrees({ a, b, corpus, exts, rename })

  console.log(`modes: ${modesA.join(', ')}${rename ? ` · rename map: ${Object.keys(rename).length} entries (injective)` : ''}`)
  console.log(`files: ${r.files}`)
  console.log(`compared ${r.compared} pairs · ${r.realTrees} REAL TREES · ${r.identicalThrows} identical-throw · ${r.mismatched} MISMATCHED`)
  for (const d of r.divergences) console.log(`\n${d.mode} ${d.file}\n  at ${d.path}\n  a: ${d.a}\n  b: ${d.b}`)

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
