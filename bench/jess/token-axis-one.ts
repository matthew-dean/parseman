/**
 * WHAT A TOKEN GATE WOULD HAVE TO BEAT, for ONE dialect — STATIC, no timing.
 *
 * Two questions, answered against THIS worktree's shipping grammars, because
 * every published figure about derived tokenization was taken against the
 * bytecode interpreter or against codegen, and neither is what runs.
 *
 * 1. THE SPECULATION THE CHAR GATE LEAVES. `emit-assembly.ts:1155` gates a
 *    non-exclusive `choice` on `MASK[c]`, one bit per arm, keyed by the LEAD
 *    CODE POINT. So the arms actually entered at a position is `popcount` of
 *    that word. An `exclusive` site enters exactly one. The mean over the ASCII
 *    lead chars a site can see is the multiplier a wider key would attack — a
 *    site whose mean is 1.0 has nothing left for a token id to remove.
 *
 *    This is a STATIC bound, not an execution count: it weights every lead char
 *    equally rather than by how often the parse lands on it. It is an upper
 *    bound on the arm-entry speculation, and it says nothing about frequency.
 *
 * 2. WHETHER A DERIVED TOKEN COULD DECIDE THE SITE AT ALL.
 *    `src/compiler/token-alphabet.ts` — in-tree, never wired — answers this from
 *    the COMBINATOR graph: `candidateSet` reports each arm's lead terminal, and
 *    `complete: false` means at least one arm has no single derived terminal and
 *    the site must stay scannerless. Run here on the real grammars for the first
 *    time.
 *
 * The two halves are counted over DIFFERENT populations on purpose — encoded
 * sites for (1), combinator `choice()` nodes for (2) — and are not joined,
 * because the encoder rewrites choices (left-factoring, alias folding) and a
 * one-to-one map between the two is not available without inventing it.
 *
 * One dialect per process — `composeLeaf()`'s fuse mutates shared pieces in
 * place (`grammars.ts` header).
 *
 * Usage: `node --experimental-strip-types bench/jess/token-axis-one.ts less`
 */
import { candidateSet, collectAlphabet } from '../../src/compiler/token-alphabet.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_CHOICE } from '../../src/table/ops.ts'
import { resolveTable } from '../../src/table/program.ts'
import type { Combinator } from '../../src/types.ts'
import { assertParseman, loadGrammar, type Dialect } from './grammars.ts'

const dialect = process.argv[2] as Dialect
if (dialect === undefined) throw new Error('usage: token-axis-one.ts <dialect>')

const prov = await assertParseman()
const g = await loadGrammar(dialect, 'ast')

/* ---- 1. speculation left by the char gate, on the ENCODED table ---------- */

const prog = encodeTable(g.rules, {})
const t = resolveTable(prog)
const code = prog.code

let sites = 0
let exclusive = 0
let ungated = 0
let armsTotal = 0
/** Sum over sites of (mean arms admitted per admitting lead char). */
let meanSum = 0
let worstMean = 0
let worstArms = 0
const histogram = new Map<string, number>()

for (const ip of reachableIps(prog)) {
  if (code[ip] !== OP_CHOICE) continue
  const di = code[ip + 1]!
  const n = code[ip + 2]!
  sites++
  armsTotal += n
  if (di < 0) { ungated++; meanSum += n; continue }
  const table = t.disp[di]!
  if (table.exclusive) { exclusive++; meanSum += 1; continue }
  if (n > 32) { meanSum += n; continue }
  let admittingChars = 0
  let entries = 0
  for (let c = 0; c < 128; c++) {
    let bits = 0
    for (let i = 0; i < n; i++) {
      const cls = table.armCls[i] ?? null
      if (cls === null || cls.ascii[c] === 1) bits++
    }
    if (bits > 0) { admittingChars++; entries += bits }
  }
  const mean = admittingChars === 0 ? 0 : entries / admittingChars
  meanSum += mean
  if (mean > worstMean) { worstMean = mean; worstArms = n }
  const bucket = mean < 1.05 ? '1.0 (decided)' : mean < 2 ? '1.05–2' : mean < 4 ? '2–4' : '4+'
  histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1)
}

/* ---- 2. what the in-tree alphabet walker says, on the COMBINATOR graph --- */

const roots = Object.values(g.rules)
const byName = new Map(Object.entries(g.rules))
const resolve = (n: string): Combinator<unknown> | undefined => byName.get(n)
const alphabet = collectAlphabet(roots, resolve)

let lit = 0
let kw = 0
let kwWords = 0
let rx = 0
for (const term of alphabet.terminals) {
  if (term.kind === 'literal') lit++
  else if (term.kind === 'keywords') { kw++; kwWords += term.words.length }
  else rx++
}

/** Every `choice()` in the combinator graph, walked with the same edge set. */
const seen = new Set<Combinator<unknown>>()
const choices: Combinator<unknown>[] = []
const stack = [...roots]
while (stack.length > 0) {
  const p = stack.pop()!
  if (seen.has(p)) continue
  seen.add(p)
  if (p._def.tag === 'choice') choices.push(p)
  const d = p._def as unknown as Record<string, unknown>
  for (const key of ['parser', 'main', 'skipped', 'separator', 'selector', 'sentinel', 'fallback', 'otherwise', 'triviaParser']) {
    const v = d[key]
    if (v !== null && typeof v === 'object' && '_def' in (v as object)) stack.push(v as Combinator<unknown>)
  }
  if (Array.isArray(d.parsers)) for (const c of d.parsers as Combinator<unknown>[]) stack.push(c)
  if (Array.isArray(d.skip)) for (const c of d.skip as Combinator<unknown>[]) stack.push(c)
  if (Array.isArray(d.cases)) for (const c of d.cases as Array<{ parser: Combinator<unknown> }>) stack.push(c.parser)
  if (Array.isArray(d.matchers)) for (const c of d.matchers as Array<{ parser: Combinator<unknown> }>) stack.push(c.parser)
  if (p._def.tag === 'lazy') {
    let target: Combinator<unknown> | undefined
    try { target = p._def.thunk() } catch { target = undefined }
    if (target === undefined) {
      const nm = (p as unknown as { _ruleName?: string })._ruleName
      if (nm !== undefined) target = resolve(nm)
    }
    if (target !== undefined) stack.push(target)
  }
}

let complete = 0
let injective = 0
let incomplete = 0
for (const c of choices) {
  const arms = (c._def as unknown as { parsers: Combinator<unknown>[] }).parsers
  const cs = candidateSet(arms, alphabet, resolve)
  if (!cs.complete) { incomplete++; continue }
  complete++
  if (cs.ids.length === arms.length) injective++
}

const pct = (a: number, b: number): string => b === 0 ? '—' : `${(100 * a / b).toFixed(1)}%`

console.log(`parseman: ${prov.root} @ ${prov.version} (installed ${prov.installed})`)
console.log(`dialect:  ${dialect} (ast)`)
console.log('')
console.log('1. CHAR-GATE SPECULATION on the encoded table (emit-assembly MASK semantics)')
console.log(`   reachable OP_CHOICE sites: ${sites}   arms ${armsTotal}`)
console.log(`   exclusive (1 arm, no speculation): ${exclusive} (${pct(exclusive, sites)})`)
console.log(`   ungated (d === -1, every arm entered): ${ungated} (${pct(ungated, sites)})`)
console.log(`   mean arms entered per admitting lead char, averaged over sites: ${(meanSum / Math.max(sites, 1)).toFixed(3)}`)
console.log(`   worst site: ${worstMean.toFixed(2)} of ${worstArms} arms`)
for (const b of ['1.0 (decided)', '1.05–2', '2–4', '4+']) {
  if (histogram.has(b)) console.log(`     masked sites at ${b}: ${histogram.get(b)}`)
}
console.log('')
console.log('2. DERIVED ALPHABET on the combinator graph (src/compiler/token-alphabet.ts)')
console.log(`   terminals: ${alphabet.terminals.length}  (literals ${lit}, keyword sets ${kw} / ${kwWords} words, regexes ${rx})`)
console.log(`   choice() nodes reached: ${choices.length}`)
console.log(`   every arm has a lead terminal:      ${complete} (${pct(complete, choices.length)})`)
console.log(`     …and the leads are DISTINCT:      ${injective} (${pct(injective, choices.length)})`)
console.log(`   at least one arm has none (stay scannerless): ${incomplete} (${pct(incomplete, choices.length)})`)
