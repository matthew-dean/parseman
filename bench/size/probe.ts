/**
 * PARSEMAN CANONICAL SIZE PROBE
 * =============================
 *
 * A FIXED RULER for parseman's generated-code size, kept OUTSIDE the repo.
 *
 * WHY OUTSIDE THE REPO
 * --------------------
 * If the probe grammar and the measuring script live in the tree, stepping back
 * through history changes the ruler along with the thing being measured, and the
 * resulting size curve is worthless. This file is copied INTO a checkout, run,
 * and deleted. The grammar text and the measurement code both travel with it, so
 * every point in a historical series is measured by the same instrument.
 *
 * CANONICAL LOCATION:  ~/parseman-size-probe/size-probe.ts
 *
 * USAGE
 * -----
 *   cp ~/parseman-size-probe/size-probe.ts <checkout>/size-probe.ts
 *   cd <checkout> && pnpm install --frozen-lockfile
 *   node --import tsx/esm ./size-probe.ts --json out.json     # machine-readable
 *   node --import tsx/esm ./size-probe.ts --csv  out.csv      # for plotting a series
 *   rm <checkout>/size-probe.ts
 *
 * Never commit this file into a historical checkout.
 *
 * ============================ API FLOOR ============================
 * This probe deliberately restricts itself to LONG-STABLE parseman API.
 * Adding a newer combinator BREAKS THE SERIES: older checkouts stop compiling
 * and the curve silently loses its left-hand side.
 *
 *   Combinators used:  rules, literal, regex, sequence, choice, many,
 *                      oneOrMore, optional, sepBy, node, transform, trivia
 *   Entry points used: compile, compose, composeLeaf, parser
 *   Options used:      compile(g, { hostMode }), compose(items, { hostMode })
 *   Lowering entry:    transformMacro from 'parseman/plugin' (src/plugin/index.ts)
 *
 *   MEASURED API FLOOR: see FLOOR_NOTE below.
 *
 * If you need a construct that is newer than the floor, express it the OLD way
 * instead of widening the floor. If you must widen it, say so here, and re-run
 * the whole series — do not append new-floor points to an old-floor curve.
 * ===================================================================
 *
 * WHAT IT MEASURES AND WHY
 * ------------------------
 * The three example grammars in the repo (json/csv/graphql) are blind to the
 * mechanism that actually produces the size: they are small, they declare few
 * node() sites, and none of them compose. This probe isolates the cost drivers
 * as SEPARATELY ATTRIBUTABLE units:
 *
 *   node-scaling   4/8/16/32 node() sites, identical otherwise  -> bytes per node site
 *   compose depth  1/2/3 levels of compose()                    -> cost of composition
 *   composeLeaf    terminal composition                          -> leaf overlay cost
 *   trivia         same grammar with and without trivia()        -> trivia machinery
 *   hostMode       same grammar as 'ast' and as 'cst'            -> unexecuted machinery
 *   variant        a grammar derived from a base (jsonc pattern) -> variant overhead
 *
 * THE RULER IS THE MACRO LOWERING, NOT compile().
 * `compose()`/`composeLeaf()` at run time return fused FUNCTIONS built through
 * `new Function` — they have no source text to weigh, and `composeLeaf()` throws
 * outright at run time because it is macro-only. What actually ships (and what
 * made 45 MB of ESM across jess's four parsers) is the MACRO-LOWERED MODULE. So
 * every unit here is a real source module, lowered with `transformMacro`, and we
 * weigh the emitted module. That is the artifact V8 parses at import.
 *
 * FAILS LOUDLY, NEVER SILENTLY DEGRADES
 * -------------------------------------
 * A missing API, a lowering failure, an empty emission, or a unit that returns
 * null is a hard error with a non-zero exit. A silently-degraded data point
 * poisons the whole curve, so there is no "skip" path anywhere in this file.
 */

import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

/**
 * FLOOR_NOTE — the oldest parseman version this probe is known to compile against.
 * Update ONLY together with a full re-run of the series.
 */
const FLOOR_NOTE = 'API floor: see README.md in ~/parseman-size-probe/ for the measured floor version.'

// ---------------------------------------------------------------------------
// Probe grammar units. Each is a real source module, lowered as-is.
// Kept intentionally plain: no clever helpers, so the text means the same thing
// at every version in the range.
// ---------------------------------------------------------------------------

const MACRO = `import { rules, literal, regex, sequence, choice, many, oneOrMore, optional, sepBy, node, transform, trivia, compose, composeLeaf, parser } from 'parseman' with { type: 'macro' }`

/** N node() sites, otherwise identical. The per-node fixed preamble is the
 *  dominant term, so this is the bytes-per-node instrument. */
function nodeScale(n: number): string {
  const defs: string[] = []
  for (let i = 0; i < n; i++) {
    defs.push(
      `  N${i}: node('N${i}', sequence(regex(/[a-z]+/), literal('${String.fromCharCode(97 + (i % 26))}'), optional(literal(';'))), (c) => ({ t: 'N${i}', c })),`,
    )
  }
  defs.push(`  Root: node('Root', many(choice(${Array.from({ length: n }, (_, i) => `g.N${i}`).join(', ')})), (c) => ({ t: 'Root', c })),`)
  return `${MACRO}
export const g = rules((g) => ({
${defs.join('\n')}
}))
`
}

/**
 * Base grammar reused by the compose / variant / hostMode units.
 *
 * `hostMode` must be declared ON THE GRAMMAR (`rules({ hostMode }, …)`), because
 * the ruler here is the macro lowering and `transformMacro` takes no host-mode
 * argument — passing it beside the source would silently do nothing and make the
 * two host-mode units byte-identical.
 */
function baseModule(hostMode?: 'ast' | 'cst'): string {
  const opts = hostMode ? `{ hostMode: '${hostMode}' }, ` : ''
  return `${MACRO}
export const base = rules(${opts}(g) => ({
  Word: node('Word', regex(/[A-Za-z_][A-Za-z0-9_]*/), (c) => ({ t: 'Word', c })),
  Num: node('Num', regex(/[0-9]+/), (c) => ({ t: 'Num', c })),
  Atom: node('Atom', choice(g.Word, g.Num), (c) => ({ t: 'Atom', c })),
  List: node('List', sequence(literal('('), sepBy(g.Atom, literal(',')), literal(')')), (c) => ({ t: 'List', c })),
  Doc: node('Doc', many(choice(g.List, g.Atom)), (c) => ({ t: 'Doc', c })),
}))
`
}

const BASE_MODULE = `${MACRO}
export const base = rules((g) => ({
  Word: node('Word', regex(/[A-Za-z_][A-Za-z0-9_]*/), (c) => ({ t: 'Word', c })),
  Num: node('Num', regex(/[0-9]+/), (c) => ({ t: 'Num', c })),
  Atom: node('Atom', choice(g.Word, g.Num), (c) => ({ t: 'Atom', c })),
  List: node('List', sequence(literal('('), sepBy(g.Atom, literal(',')), literal(')')), (c) => ({ t: 'List', c })),
  Doc: node('Doc', many(choice(g.List, g.Atom)), (c) => ({ t: 'Doc', c })),
}))
`

/** compose() at depth 1/2/3. Each level adds a small rules() layer over the
 *  previous fused map — the shape jess's css -> less -> scss -> jess chain uses. */
function composeDepth(depth: number): { files: Record<string, string>; entry: string } {
  const files: Record<string, string> = { 'base.ts': BASE_MODULE }
  let prev = 'base'
  let prevFile = './base.js'
  for (let d = 1; d <= depth; d++) {
    files[`layer${d}.ts`] = `${MACRO}
import { ${prev} } from '${prevFile}'
export const layer${d} = compose([${prev}, rules((g) => ({
  Extra${d}: node('Extra${d}', sequence(literal('@${d}'), g.Atom), (c) => ({ t: 'Extra${d}', c })),
  Doc: node('Doc${d}', many(choice(g.Extra${d}, g.List, g.Atom)), (c) => ({ t: 'Doc${d}', c })),
}))])
`
    prev = `layer${d}`
    prevFile = `./layer${d}.js`
  }
  return { files, entry: depth === 0 ? 'base.ts' : `layer${depth}.ts` }
}

/**
 * composeLeaf() — terminal composition, macro-only.
 *
 * NOTE the base here is RECOGNITION-ONLY: no node() builders. That is
 * composeLeaf's contract, not an accident — it overlays local semantic
 * reductions on reusable recognition rules, and a base carrying its own build
 * reducers cannot be carried as re-lowerable IR ("runtime composition is
 * forbidden"). Giving it a node()-bearing base makes it throw.
 */
const RECOGNITION_MODULE = `${MACRO}
export const recognition = rules((g) => ({
  Word: regex(/[A-Za-z_][A-Za-z0-9_]*/),
  Num: regex(/[0-9]+/),
  Atom: choice(g.Word, g.Num),
  List: sequence(literal('('), sepBy(g.Atom, literal(',')), literal(')')),
}))
`

const COMPOSE_LEAF = {
  files: {
    'recognition.ts': RECOGNITION_MODULE,
    'leaf.ts': `${MACRO}
import { recognition } from './recognition.js'
export const leaf = composeLeaf([recognition, rules((g) => ({
  Doc: node('LeafDoc', many(choice(g.List, g.Atom)), (c) => ({ t: 'LeafDoc', c })),
}))])
`,
  },
  entry: 'leaf.ts',
}

/** trivia present vs absent, same grammar otherwise. */
const TRIVIA_ON = `${MACRO}
const ws = trivia(oneOrMore(regex(/[ \\t\\n\\r]+/)))
export const g = rules({ trivia: ws }, (g) => ({
  Word: node('Word', regex(/[A-Za-z_][A-Za-z0-9_]*/), (c) => ({ t: 'Word', c })),
  Num: node('Num', regex(/[0-9]+/), (c) => ({ t: 'Num', c })),
  Atom: node('Atom', choice(g.Word, g.Num), (c) => ({ t: 'Atom', c })),
  Doc: node('Doc', many(g.Atom), (c) => ({ t: 'Doc', c })),
}))
`

const TRIVIA_OFF = `${MACRO}
export const g = rules((g) => ({
  Word: node('Word', regex(/[A-Za-z_][A-Za-z0-9_]*/), (c) => ({ t: 'Word', c })),
  Num: node('Num', regex(/[0-9]+/), (c) => ({ t: 'Num', c })),
  Atom: node('Atom', choice(g.Word, g.Num), (c) => ({ t: 'Atom', c })),
  Doc: node('Doc', many(g.Atom), (c) => ({ t: 'Doc', c })),
}))
`

/** A variant derived from a base grammar — the jsonc/jsonl pattern, which the
 *  in-repo size bench never measures. */
const VARIANT = {
  files: {
    'base.ts': BASE_MODULE,
    'variant.ts': `${MACRO}
import { base } from './base.js'
export const variant = compose([base, rules((g) => ({
  Doc: node('VariantDoc', sepBy(choice(g.List, g.Atom), literal(';')), (c) => ({ t: 'VariantDoc', c })),
}))])
`,
  },
  entry: 'variant.ts',
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export type Unit = {
  id: string
  group: string
  /** Oldest parseman version at which this unit's API exists. Measured, not guessed. */
  floor: string
  /** node() call sites declared across all files of the unit. */
  nodes: number
  files: Record<string, string>
  entry: string
}

export type Row = {
  id: string
  group: string
  nodes: number
  srcBytes: number
  genBytes: number
  gzipBytes: number
  srcLines: number
  genLines: number
  bytesRatio: number
  locMultiplier: number
  compression: number
  bytesPerNode: number
}

function die(msg: string): never {
  console.error(`\nsize-probe: FATAL — ${msg}`)
  console.error('size-probe: refusing to emit a number. A degraded data point poisons the series.')
  process.exit(1)
}

function countNodeSites(files: Record<string, string>): number {
  let n = 0
  for (const text of Object.values(files)) n += (text.match(/\bnode\(/g) ?? []).length
  return n
}

function unit(id: string, group: string, floor: string, files: Record<string, string>, entry: string): Unit {
  return { id, group, floor, nodes: countNodeSites(files), files, entry }
}

/** Numeric compare for `major.minor.patch`. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * TIERS — the probe's API floor is NOT uniform, so a single floor would either
 * throw away most of the history or silently drop units on old checkouts.
 * Measured introduction points (walked over origin/main):
 *
 *   compose  0.14.0  |  composeLeaf  0.28.0  |  hostMode  0.37.0
 *
 * A history walk runs the widest tier the checkout supports. Units above the
 * checkout's version are NEVER silently skipped — the probe refuses to run and
 * names the tier to ask for, because a series that quietly loses columns is
 * exactly the degraded data this file exists to prevent.
 */
export const TIERS: Record<string, string> = { core: '0.14.0', leaf: '0.28.0', full: '0.37.0' }

export function buildUnits(): Unit[] {
  const units: Unit[] = []

  for (const n of [4, 8, 16, 32]) {
    const files = { 'g.ts': nodeScale(n) }
    units.push(unit(`node-scale-${n}`, 'node-scaling', '0.14.0', files, 'g.ts'))
  }

  for (const d of [1, 2, 3]) {
    const { files, entry } = composeDepth(d)
    units.push(unit(`compose-depth-${d}`, 'compose', '0.14.0', files, entry))
  }

  units.push(unit('compose-leaf', 'compose', '0.28.0', COMPOSE_LEAF.files, COMPOSE_LEAF.entry))
  units.push(unit('trivia-on', 'trivia', '0.14.0', { 'g.ts': TRIVIA_ON }, 'g.ts'))
  units.push(unit('trivia-off', 'trivia', '0.14.0', { 'g.ts': TRIVIA_OFF }, 'g.ts'))
  units.push(unit('hostmode-ast', 'hostmode', '0.37.0', { 'g.ts': baseModule('ast') }, 'g.ts'))
  units.push(unit('hostmode-cst', 'hostmode', '0.37.0', { 'g.ts': baseModule('cst') }, 'g.ts'))
  units.push(unit('variant', 'variant', '0.14.0', VARIANT.files, VARIANT.entry))

  return units
}

export type Lowerer = (src: string, file: string, pkgs: Set<string>) => { code: string } | string | null

export async function loadLowerer(): Promise<Lowerer> {
  // src/ first (works in a checkout without a build), then the built entry.
  const candidates = ['./src/plugin/index.ts', './dist/plugin/index.js', 'parseman/plugin']
  const failures: string[] = []
  for (const spec of candidates) {
    try {
      const mod = (await import(spec.startsWith('.') ? path.resolve(process.cwd(), spec) : spec)) as Record<string, unknown>
      const fn = mod.transformMacro
      if (typeof fn === 'function') return fn as Lowerer
      failures.push(`${spec}: loaded but exports no transformMacro`)
    } catch (e) {
      failures.push(`${spec}: ${(e as Error).message.split('\n')[0]}`)
    }
  }
  die(`could not load transformMacro (the macro lowering entry point).\n  tried:\n    ${failures.join('\n    ')}\n  This probe measures the macro-lowered module, which is what actually ships.\n  If this version predates src/plugin/index.ts, it is BELOW THE API FLOOR — exclude it from the series rather than substituting a different ruler.`)
}

export function measure(u: Unit, lower: Lowerer): Row {
  // DETERMINISTIC directory name, deliberately NOT mkdtemp.
  //
  // The lowered module embeds its own source path, so a random temp directory
  // makes the emitted bytes differ run-to-run. Raw byte COUNT stays constant
  // (the random suffix is fixed-length) but the CONTENT changes, and gzip of
  // equal-length-but-different content differs by a byte or two. That showed up
  // as a phantom +-1 B gzip wobble that would otherwise have been mistaken for a
  // noise floor and used to justify a looser tolerance. With a fixed path the
  // probe is byte-identical across processes.
  const dir = path.join(tmpdir(), `pm-size-probe-${u.id}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  try {
    // The macro lowering resolves sibling imports off disk; it needs a package
    // boundary to treat the temp dir as a module root.
    writeFileSync(path.join(dir, 'package.json'), '{}')
    for (const [name, text] of Object.entries(u.files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
      writeFileSync(path.join(dir, name), text)
    }

    const entryPath = path.join(dir, u.entry)
    const entrySrc = u.files[u.entry]
    if (entrySrc === undefined) die(`unit ${u.id}: entry ${u.entry} is not among its files`)

    let out: { code: string } | string | null
    try {
      out = lower(entrySrc, entryPath, new Set(['parseman']))
    } catch (e) {
      die(`unit ${u.id}: macro lowering THREW: ${(e as Error).message.split('\n')[0]}\n  This usually means the unit uses API newer than this checkout — i.e. the API floor is breached here.`)
    }

    if (out === null) die(`unit ${u.id}: macro lowering returned null (nothing was lowered). The unit is not exercising the macro path at all.`)
    const code = typeof out === 'string' ? out : out.code
    if (typeof code !== 'string') die(`unit ${u.id}: lowering result has no string 'code'`)
    if (code.trim().length === 0) die(`unit ${u.id}: lowering produced EMPTY output`)

    // Weigh the whole unit's source, not just the entry: for composing units the
    // base module is genuinely part of the input.
    const srcText = Object.values(u.files).join('\n')
    const srcBytes = Buffer.byteLength(srcText, 'utf8')
    const genBytes = Buffer.byteLength(code, 'utf8')
    if (srcBytes === 0) die(`unit ${u.id}: source is empty`)
    if (u.nodes === 0) die(`unit ${u.id}: declares zero node() sites — bytes-per-node would be meaningless`)

    const gzipBytes = gzipSync(code).length
    if (gzipBytes === 0) die(`unit ${u.id}: gzip produced zero bytes`)

    return {
      id: u.id,
      group: u.group,
      nodes: u.nodes,
      srcBytes,
      genBytes,
      gzipBytes,
      srcLines: srcText.split('\n').length,
      genLines: code.split('\n').length,
      bytesRatio: +(genBytes / srcBytes).toFixed(3),
      locMultiplier: +(code.split('\n').length / srcText.split('\n').length).toFixed(3),
      compression: +(genBytes / gzipBytes).toFixed(2),
      bytesPerNode: Math.round(genBytes / u.nodes),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function argValue(flag: string): string | undefined {
  const hit = process.argv.find(a => a.startsWith(`${flag}=`))
  if (hit) return hit.slice(flag.length + 1)
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const lower = await loadLowerer()

  let version = 'unknown'
  try {
    const pkg = (await import(path.resolve(process.cwd(), 'package.json'), { with: { type: 'json' } })) as { default: { version?: string } }
    version = pkg.default.version ?? 'unknown'
  } catch {
    // Version is metadata for the series, not a measurement. Absent is reported, not fatal.
  }

  const tier = argValue('--tier')
  if (tier !== undefined && TIERS[tier] === undefined) {
    die(`unknown --tier=${tier}. Valid: ${Object.keys(TIERS).join(', ')}`)
  }
  const tierFloor = tier ? TIERS[tier]! : null

  let units = buildUnits()
  if (units.length === 0) die('zero probe units — nothing to measure')

  if (tierFloor) {
    units = units.filter(u => cmpVersion(u.floor, tierFloor) <= 0)
    if (units.length === 0) die(`--tier=${tier} selected ZERO units`)
  } else if (version !== 'unknown') {
    // No tier asked for: every unit must be in range, or we stop. Silently
    // dropping the units a checkout cannot support is how a size series loses
    // its most interesting columns without anyone noticing.
    const tooNew = units.filter(u => cmpVersion(u.floor, version) > 0)
    if (tooNew.length > 0) {
      const widest = Object.entries(TIERS)
        .filter(([, f]) => cmpVersion(f, version) <= 0)
        .sort((a, b) => cmpVersion(b[1], a[1]))[0]
      die(
        `this checkout is parseman ${version}, but ${tooNew.length} unit(s) need newer API:\n    ` +
        tooNew.map(u => `${u.id} (needs >= ${u.floor})`).join('\n    ') +
        `\n  Ask for a tier explicitly: ${widest ? `--tier=${widest[0]}` : 'no tier is supported at this version'}\n` +
        '  Units are never skipped silently — a series that quietly drops columns is not comparable.',
      )
    }
  }

  const rows = units.map(u => measure(u, lower))
  if (rows.length === 0) die('zero rows measured')

  console.log(`\nparseman canonical size probe — version ${version}${tier ? ` (tier: ${tier}, floor ${tierFloor})` : ''}`)
  console.log(FLOOR_NOTE)
  console.log('\n  unit                 nodes    src B     gen B    bytes/node   ratio    gzip B   comp')
  for (const r of rows) {
    console.log(
      '  ' + r.id.padEnd(20) +
      String(r.nodes).padStart(5) +
      String(r.srcBytes).padStart(9) +
      String(r.genBytes).padStart(10) +
      String(r.bytesPerNode).padStart(14) +
      (r.bytesRatio.toFixed(1) + 'x').padStart(8) +
      String(r.gzipBytes).padStart(10) +
      (r.compression.toFixed(1) + ':1').padStart(8),
    )
  }

  // Derived readings the series exists to expose.
  const byId = new Map(rows.map(r => [r.id, r]))
  const s4 = byId.get('node-scale-4'), s32 = byId.get('node-scale-32')
  if (s4 && s32) {
    const marginal = Math.round((s32.genBytes - s4.genBytes) / (s32.nodes - s4.nodes))
    console.log(`\n  marginal bytes per added node() site (4 -> 32): ${marginal}`)
    console.log(`  fixed overhead implied at 0 nodes: ${Math.round(s4.genBytes - marginal * s4.nodes)} B`)
  }
  const ast = byId.get('hostmode-ast'), cst = byId.get('hostmode-cst')
  if (ast && cst) {
    console.log(`  hostMode ast vs cst: ${ast.genBytes} B vs ${cst.genBytes} B (${(cst.genBytes / ast.genBytes).toFixed(2)}x)`)
    // Not fatal — but if the two are byte-identical the emitted module does not
    // specialise on host mode at all, which is itself the finding.
    if (ast.genBytes === cst.genBytes) console.log('  NOTE: ast and cst emit IDENTICAL bytes — the lowering does not specialise on host mode.')
  }
  const on = byId.get('trivia-on'), off = byId.get('trivia-off')
  if (on && off) console.log(`  trivia on vs off: ${on.genBytes} B vs ${off.genBytes} B (${(on.genBytes / off.genBytes).toFixed(2)}x)`)

  const jsonPath = argValue('--json')
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ version, tier: tier ?? 'all', cwd: process.cwd(), measuredAt: new Date().toISOString(), rows }, null, 2) + '\n')
    console.log(`\n  wrote ${jsonPath}`)
  }
  const csvPath = argValue('--csv')
  if (csvPath) {
    const head = 'version,id,group,nodes,srcBytes,genBytes,gzipBytes,srcLines,genLines,bytesRatio,locMultiplier,compression,bytesPerNode'
    const body = rows.map(r => [version, r.id, r.group, r.nodes, r.srcBytes, r.genBytes, r.gzipBytes, r.srcLines, r.genLines, r.bytesRatio, r.locMultiplier, r.compression, r.bytesPerNode].join(','))
    writeFileSync(csvPath, [head, ...body].join('\n') + '\n')
    console.log(`  wrote ${csvPath}`)
  }
  console.log()
}

// Runs as a script when invoked directly; importable as a library otherwise, so
// the in-tree CI copy and this portable copy can stay byte-identical.
const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try { return path.resolve(entry) === path.resolve(new URL(import.meta.url).pathname) } catch { return false }
})()

if (invokedDirectly) main().catch(e => die(`unhandled: ${(e as Error).stack ?? String(e)}`))
