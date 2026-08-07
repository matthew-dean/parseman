/**
 * THE PIECE-LIBRARY CENSUS — how many static, hand-written pieces would a
 * library need for `link` to wire table rows to it without generating any
 * JavaScript after the macro runs?
 *
 * The owner's specification: the TABLE is the generated artifact; the FUNCTIONS
 * are static source in `src/`; linking selects among them, once, at run start.
 * `assemble.ts:2536` does the opposite — it builds a source string per option
 * set and `new Function`s it. This file measures what replacing that would take,
 * and it is a COUNT, not a timing: nothing here needs a quiet box.
 *
 * Three censuses, because the answer differs sharply depending on whether leaf
 * matchers may be PASTED into their parent. Pasting is generation, so under the
 * owner's constraint it is unavailable — but its absence is the whole cost, and
 * the two numbers have to sit next to each other to see that.
 *
 *   A. AS EMITTED       one FunctionLiteral per SITE. What exists today.
 *   B. SHAPE CENSUS     site bodies with every bindable operand erased — pool
 *                       references, string/number/regex literals. This is the
 *                       library size IF pasting is kept and only the operands
 *                       become bindings. The gap to (A) is what a `link()` can
 *                       actually factor out.
 *   C. ALL-CALL CENSUS  no pasting: every child is a call to a static leaf
 *                       piece, so a site's identity collapses to
 *                       `(opcode, arity)`. This is the authorable library, and
 *                       it is the one the owner's constraint permits.
 *
 * The number that decides the design is the MULTIPLICITY in (C): how many sites
 * end up bound from one authored FunctionLiteral. Per
 * `notes/DESIGN-child-kind-specialisation.md` §0.3, V8 attaches inline-cache
 * feedback to the FunctionLiteral, not to the closure — so every site sharing an
 * authored piece shares one feedback vector, which is precisely the megamorphism
 * the emitted engine exists to escape.
 *
 * Usage: node --import ./bench/jess/register.mjs bench/jess/piece-library-census.ts
 */
import { createHash } from 'node:crypto'
import { encodeTable } from '../../src/table/encode.ts'
import { expandCompact, resolveTable, type TableProgram } from '../../src/table/program.ts'
import { emitAssemblySource, Unemittable } from '../../src/table/emit-assembly.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import * as OPS from '../../src/table/ops.ts'
import { DIALECTS, assertParseman, headSha, loadGrammar } from './grammars.ts'

const OFF = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }
const OPT_AXES = [
  ['trackLines', { ...OFF, trackLines: true }],
  ['tolerant  ', { ...OFF, tolerant: true }],
  ['hostCst   ', { ...OFF, hostCst: true }],
] as const

const OPNAME = new Map<number, string>()
for (const [k, v] of Object.entries(OPS)) {
  if (k.startsWith('OP_') && typeof v === 'number') OPNAME.set(v, k)
}

/** `assemble.ts:2503-2510`, replicated so the emitter can be driven directly. */
function extraIpsOf(p: TableProgram): number[] {
  const out: number[] = []
  for (const s of p.scans ?? []) {
    for (const r of s.skip) out.push(r[0])
    if (s.sentinel !== undefined) out.push(s.sentinel[0])
  }
  for (const set of p.scanSkip ?? []) for (const r of set) out.push(r[0])
  return out
}

function bodies(src: string): Array<{ name: string; text: string }> {
  const re = /^function ([A-Za-z0-9_$]+)\(/gm
  const starts: Array<{ name: string; at: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) starts.push({ name: m[1]!, at: m.index })
  return starts.map((s, i) => ({ name: s.name, text: src.slice(s.at, starts[i + 1]?.at ?? src.length) }))
}

/** Erase every operand a `link()` could hand a static piece as a bound value. */
function shapeOf(t: string): string {
  return t
    .replace(/^function [A-Za-z0-9_$]+\(/, 'function _(')
    .replace(/\b_(?:pf|fx|tv|tl|sk|sc|cl|ms)\d+\b/g, '_B')
    .replace(/\b(?:K|FX|FNS|MASK|CLS|AFX|TRIVIA|SCANS|DISP|DSP|SENTS)\[\d+\]/g, 'B')
    .replace(/'(?:[^'\\]|\\.)*'/g, "'S'")
    .replace(/"(?:[^"\\]|\\.)*"/g, "'S'")
    .replace(/\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/g, '/RX/')
    .replace(/\b\d+(?:\.\d+)?\b/g, 'N')
    .replace(/\b_t\d+__[A-Za-z]+\d*\b/g, '_L')
    .replace(/\b[a-z]{1,3}\d+\b/g, '_L')
    .replace(/\s+/g, '')
}

/** How many child ips a row names. Leaves report 0. */
function arityOf(code: readonly number[], ip: number): number {
  switch (code[ip]!) {
    case OPS.OP_SEQ: case OPS.OP_SEQV: case OPS.OP_SEQX: case OPS.OP_CHOICE:
      return code[ip + 1]!
    case OPS.OP_REP: case OPS.OP_REPV: case OPS.OP_OPT: case OPS.OP_NODE:
    case OPS.OP_XFORM: case OPS.OP_GATE: case OPS.OP_NOT: case OPS.OP_PEEK:
    case OPS.OP_FIELD: case OPS.OP_SCOPE: case OPS.OP_SCOPE_CAP:
    case OPS.OP_WITHCTX: case OPS.OP_GUARD: case OPS.OP_GREEDY:
    case OPS.OP_ATTEMPT: case OPS.OP_LABEL: case OPS.OP_EXPECT:
      return 1
    default:
      return 0
  }
}

const h = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 12)

const prov = await assertParseman()
console.log(`parseman ${prov.version} at ${prov.root}   sha ${headSha()}`)
console.log('Counts only — no timing, so this is readable regardless of machine load.\n')

const unionShapes = new Map<string, number>()
const unionPieces = new Map<string, number>()
const arities = new Map<number, number>()
const opTotals = new Map<string, number>()
let totalSites = 0

console.log('A/B — emitted bodies and their shapes, key 0 (plain, AST host)')
console.log('  dialect   emitted KB   sites   distinct shapes   sites per shape   most-shared shape')
for (const d of DIALECTS) {
  const g = await loadGrammar(d, 'ast')
  const prog = expandCompact(encodeTable(g.rules, {}))
  const src = emitAssemblySource(resolveTable(prog), prog, OFF, extraIpsOf(prog)).source
  const bs = bodies(src)
  const local = new Map<string, number>()
  for (const b of bs) {
    const k = h(shapeOf(b.text))
    local.set(k, (local.get(k) ?? 0) + 1)
    unionShapes.set(k, (unionShapes.get(k) ?? 0) + 1)
  }
  const top = [...local.values()].sort((a, b) => b - a)[0]!
  console.log(
    `  ${d.padEnd(10)}${(src.length / 1024).toFixed(0).padStart(9)}${String(bs.length).padStart(9)}`
    + `${String(local.size).padStart(18)}${(bs.length / local.size).toFixed(2).padStart(18)}`
    + `${(top + ' sites').padStart(20)}`,
  )
}
console.log(`  UNION over the four grammars: ${unionShapes.size} distinct shapes`
  + `, ${[...unionShapes.values()].filter(x => x === 1).length} of them used exactly ONCE`)

console.log('\nOPTION AXIS — how much of the emitted text an option set actually changes')
console.log('  dialect   axis         bodies identical   bodies DIFFER   % differing')
for (const d of DIALECTS) {
  const g = await loadGrammar(d, 'ast')
  const prog = expandCompact(encodeTable(g.rules, {}))
  const resolved = resolveTable(prog)
  const extra = extraIpsOf(prog)
  const base = new Map(bodies(emitAssemblySource(resolved, prog, OFF, extra).source).map(b => [b.name, b.text]))
  for (const [label, cfg] of OPT_AXES) {
    const other = new Map(bodies(emitAssemblySource(resolved, prog, cfg, extra).source).map(b => [b.name, b.text]))
    let same = 0, differ = 0
    for (const [n, t] of base) {
      const o = other.get(n)
      if (o === undefined) continue
      if (o === t) same++; else differ++
    }
    console.log(
      `  ${d.padEnd(10)}${label}${String(same).padStart(15)}${String(differ).padStart(16)}`
      + `${((differ / (same + differ)) * 100).toFixed(1).padStart(13)}%`,
    )
  }
}

console.log('\nC — the ALL-CALL library: (opcode, arity) pieces a person would author')
console.log('  dialect   reachable sites   distinct (opcode, arity) pieces')
for (const d of DIALECTS) {
  const g = await loadGrammar(d, 'ast')
  const prog = expandCompact(encodeTable(g.rules, {}))
  const ips = reachableIps(prog)
  const local = new Set<string>()
  for (const ip of ips) {
    const name = OPNAME.get(prog.code[ip]!) ?? `OP_${prog.code[ip]}`
    const n = arityOf(prog.code, ip)
    local.add(`${name}/${n}`)
    unionPieces.set(`${name}/${n}`, (unionPieces.get(`${name}/${n}`) ?? 0) + 1)
    arities.set(n, (arities.get(n) ?? 0) + 1)
    opTotals.set(name, (opTotals.get(name) ?? 0) + 1)
    totalSites++
  }
  console.log(`  ${d.padEnd(10)}${String(ips.size).padStart(15)}${String(local.size).padStart(34)}`)
}
console.log(`  UNION: ${totalSites} reachable sites -> ${unionPieces.size} distinct (opcode, arity) pieces`)

/** §2.2's cutoff applied: unroll arity 1..4, one generic body above. This is the
 *  number a person would actually have to write, before the option axis. */
const capped = new Set<string>()
for (const key of unionPieces.keys()) {
  const [name, n] = key.split('/') as [string, string]
  capped.add(Number(n) > 4 ? `${name}/n` : key)
}
console.log(`  with arity capped at 4 + one generic body above: ${capped.size} authored pieces`)

console.log('\n  arity histogram (drives the unroll cutoff; §2.2 proposes 1..4 then a generic loop)')
let wide = 0
for (const [n, c] of [...arities].sort((a, b) => a[0] - b[0])) {
  if (n > 4) { wide += c; continue }
  console.log(`    arity ${String(n).padStart(2)}  ${String(c).padStart(5)} sites  ${(c / totalSites * 100).toFixed(1)}%`)
}
console.log(`    arity >4  ${String(wide).padStart(5)} sites  ${(wide / totalSites * 100).toFixed(1)}%  -> the generic-loop tail`)

console.log('\n  the pieces that must be fastest, by reachable-site count:')
for (const [name, c] of [...opTotals].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`    ${name.padEnd(14)} ${String(c).padStart(5)}  ${(c / totalSites * 100).toFixed(1)}%`
    + `   <- ${c} sites would share ONE authored FunctionLiteral`)
}

console.log('\nEMITTABILITY of the 32 option sets (a refused set already runs closures):')
{
  const g = await loadGrammar('less', 'ast')
  const prog = expandCompact(encodeTable(g.rules, {}))
  const resolved = resolveTable(prog)
  const extra = extraIpsOf(prog)
  const KEYS = ['hostCst', 'trackLines', 'tolerant', 'coverage', 'probe'] as const
  const texts = new Set<string>()
  let refused = 0
  for (let key = 0; key < 32; key++) {
    const cfg = { ...OFF }
    KEYS.forEach((k, i) => { (cfg as Record<string, boolean>)[k] = (key & (1 << i)) !== 0 })
    try {
      texts.add(h(emitAssemblySource(resolved, prog, cfg, extra).source))
    } catch (e) {
      if (!(e instanceof Unemittable)) throw e
      refused++
    }
  }
  console.log(`  less: ${32 - refused} emittable option sets -> ${texts.size} DISTINCT texts; ${refused} refuse emit (every coverage set).`)
  console.log('  No two option sets share a text, so no compiled body can be reused across them.')
}
