/**
 * DETERMINISTIC SHAPE OF ONE GRAMMAR, for the mixture sweep.
 *
 * Prints, for one dialect × variant: the emitted-source byte count, the number
 * of reachable sites, and the opcode histogram over those sites. Nothing here is
 * timed — every number is a property of the table and re-reads identically on
 * any box, so this runs without a timing slot.
 *
 * The histogram is the sweep's denominator: a construct kind that occurs at
 * three sites cannot be worth a slot however it ranks per-site, and a kind that
 * occurs at eight hundred is where the bytes are.
 *
 *   node --import ./bench/jess/register.mjs \
 *     bench/jess/mixture-shape-one.ts <dialect> [variant]
 */
import { encodeTable } from '../../src/table/encode.ts'
import { resolveTable } from '../../src/table/program.ts'
import { emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { CAP_OFF, CAP_ON, TOP, computeSiteLabels, reachableSites } from '../../src/table/site-labels.ts'
import { OP_NAMES } from '../../src/table/ops.ts'
import {
  DIALECTS, VARIANTS, VARIANT_SETTINGS, loadGrammar,
  type Dialect, type Variant,
} from './grammars.ts'

const dialect = process.argv[2] as Dialect
if (!DIALECTS.includes(dialect)) throw new Error(`unknown dialect '${String(process.argv[2])}'`)
const variant = (process.argv[3] ?? 'ast') as Variant
if (!VARIANTS.includes(variant)) throw new Error(`unknown variant '${String(process.argv[3])}'`)

const { rules } = await loadGrammar(dialect, variant)
const settings = VARIANT_SETTINGS[variant]
const prog = encodeTable(rules, settings)
const t = resolveTable(prog)

const hostCst = settings.hostMode === 'cst'
const cfg = { hostCst, trackLines: settings.trackLines === true, tolerant: false, coverage: false, probe: false, mix: undefined }

// The scan pool's sites are roots too — `assemble.ts` passes them as `extraIps`
// and an emitted body exists for each, so a census that omitted them would
// under-count exactly the constructs `scanTo`/`balanced` reach.
const extraIps: number[] = []
for (const s of prog.scans ?? []) {
  for (const r of s.skip) extraIps.push(r[0])
  if (s.sentinel !== undefined) extraIps.push(s.sentinel[0])
}
for (const set of prog.scanSkip ?? []) for (const r of set) extraIps.push(r[0])

const em = emitAssemblySource(t, prog, cfg, extraIps)

const roots = [...Object.values(prog.rules), ...extraIps]
const hist = new Map<string, number>()
let sites = 0
for (const ip of reachableSites(t.code, roots)) {
  sites++
  const op = t.code[ip]!
  const name = OP_NAMES[op] ?? `OP_${String(op)}`
  hist.set(name, (hist.get(name) ?? 0) + 1)
}

const rows = [...hist.entries()].sort((a, b) => b[1] - a[1])

/**
 * THE CAPTURE LABEL, SPLIT PER OPCODE — for `lane/capoff`, and structural.
 *
 * `cap` is read at exactly one place in the emitted engine
 * (`emit-assembly.ts:529`, the `skipFor` trivia arm), so the split below is the
 * whole population that fix moves. Reported per opcode because a global
 * percentage cannot say whether the over-marking sits on hot rows or cold ones.
 */
const labels = computeSiteLabels(t.code, roots, hostCst)
const capOn = new Map<string, number>()
const capOff = new Map<string, number>()
const capDyn = new Map<string, number>()
for (const ip of reachableSites(t.code, roots)) {
  const name = OP_NAMES[t.code[ip]!] ?? `OP_${String(t.code[ip]!)}`
  const c = labels.at(ip).cap
  const m = c === CAP_ON ? capOn : c === CAP_OFF ? capOff : capDyn
  m.set(name, (m.get(name) ?? 0) + 1)
}
const total = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0)

console.log(JSON.stringify({
  dialect,
  variant,
  emittedBytes: Buffer.byteLength(em.source, 'utf8'),
  reachedSites: em.reached.size,
  censusSites: sites,
  codeWords: t.code.length,
  opcodes: Object.fromEntries(rows),
  cap: {
    on: total(capOn),
    off: total(capOff),
    dynamic: total(capDyn),
    onPct: sites === 0 ? 0 : Math.round((total(capOn) / sites) * 1000) / 10,
    byOpOn: Object.fromEntries([...capOn.entries()].sort((a, b) => b[1] - a[1])),
    byOpOff: Object.fromEntries([...capOff.entries()].sort((a, b) => b[1] - a[1])),
    byOpDynamic: Object.fromEntries([...capDyn.entries()].sort((a, b) => b[1] - a[1])),
  },
}))
void TOP
