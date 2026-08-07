/**
 * DID THE MIX ACTUALLY ROUTE? — the positive control for the mixture seam.
 *
 * Identical digests across configurations prove the seam is CORRECT and prove
 * nothing about whether it is CONNECTED: a knob that silently did nothing would
 * produce exactly the same clean sweep. This is the differential that fails when
 * the mixture is inert.
 *
 * Two independent witnesses, because either alone has a way of being vacuous:
 *
 *   BYTES  the emitted source, which must SHRINK when a construct is flipped —
 *          a stub is shorter than any real body. Structural, no parse needed.
 *   ROWS   `PM_TABLE_COUNT=1` counts rows executed by the driver, per opcode.
 *          For the all-specialised endpoint this must be ZERO — the driver is
 *          built but never called. For a flip it must be non-zero, and the
 *          opcodes counted must be the ones flipped PLUS whatever they reach.
 *
 * `consumed` and `ok` are reported together: a configuration that parses less
 * of the input is the failure mode a byte count would happily call an
 * improvement.
 *
 *   PM_MIX_DRIVER=NODE PM_TABLE_COUNT=1 node --import ./bench/jess/register.mjs \
 *     bench/jess/mixture-route-probe.ts <dialect> [variant]
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { run } from '../../src/functional/run.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { resolveTable } from '../../src/table/program.ts'
import { MIX_OPS, assembledRules } from '../../src/table/assemble.ts'
import { emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { OP_NAMES } from '../../src/table/ops.ts'
import { tableCounters, resetTableCounters } from '../../src/table/exec.ts'
import {
  DIALECTS, ENTRY, JESS_ROOT, VARIANTS, VARIANT_SETTINGS, loadGrammar,
  type Dialect, type Variant,
} from './grammars.ts'

type RunnableLike = Parameters<typeof run>[0]

const dialect = process.argv[2] as Dialect
if (!DIALECTS.includes(dialect)) throw new Error(`unknown dialect '${String(process.argv[2])}'`)
const variant = (process.argv[3] ?? 'ast') as Variant
if (!VARIANTS.includes(variant)) throw new Error(`unknown variant '${String(process.argv[3])}'`)

const FIXTURE: Record<Dialect, string> = {
  css: 'packages/jess/benchmark/benchmark.css',
  less: 'packages/jess/benchmark/benchmark.less',
  scss: 'packages/jess/benchmark/gen-workload.scss',
  jess: 'packages/jess/benchmark/benchmark.jess',
}

const { rules } = await loadGrammar(dialect, variant)
const settings = VARIANT_SETTINGS[variant]
const prog = encodeTable(rules, settings)

// BYTES — emitted with the mix `assemble.ts` ITSELF resolved, imported rather
// than re-parsed here. A second copy of the parser drifted the moment the
// exclusion syntax landed: this file rejected `*,-NODE` while the assembly
// accepted it, so the probe reported nothing for a configuration that ran.
const rawMix = process.env.PM_MIX_DRIVER
const mix = MIX_OPS

const t = resolveTable(prog)
const extraIps: number[] = []
for (const s of prog.scans ?? []) {
  for (const r of s.skip) extraIps.push(r[0])
  if (s.sentinel !== undefined) extraIps.push(s.sentinel[0])
}
for (const set of prog.scanSkip ?? []) for (const r of set) extraIps.push(r[0])
const em = emitAssemblySource(t, prog, {
  hostCst: settings.hostMode === 'cst',
  trackLines: settings.trackLines === true,
  tolerant: false, coverage: false, probe: false, mix,
}, extraIps)

// ROWS — one real parse of the dialect's own large fixture.
const file = path.join(JESS_ROOT, FIXTURE[dialect])
const input = readFileSync(file, 'utf8')
const map = assembledRules(prog)
resetTableCounters()
const r = run(map[ENTRY] as unknown as RunnableLike, input)
const byOp: Record<string, number> = {}
for (let op = 0; op < tableCounters.byOp.length; op++) {
  const n = tableCounters.byOp[op]!
  if (n > 0) byOp[OP_NAMES[op] ?? `OP_${op}`] = n
}

console.log(JSON.stringify({
  dialect,
  variant,
  mix: rawMix ?? '(none — all specialised)',
  emittedBytes: Buffer.byteLength(em.source, 'utf8'),
  driverRows: tableCounters.rows,
  driverRowsByOp: byOp,
  ok: r.ok,
  // `unconsumedFrom ?? bytes` — a FAILED parse records the full byte count, so
  // this is only meaningful beside `ok`.
  consumed: (r as { unconsumedFrom?: number }).unconsumedFrom ?? input.length,
  bytes: input.length,
}))
