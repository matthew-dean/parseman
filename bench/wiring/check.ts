/**
 * The wiring sweep's CORRECTNESS AND SIZE leg — no timing, so it needs no slot.
 *
 * For every (workload × wiring mode) it builds the parser through the SHIPPED
 * path (`compile()` → `compileTable` → `assembledRules` → the emitted assembly),
 * primes it once so the assembly is built, and records:
 *   - the emitted byte count for that wiring,
 *   - whether the parse result is byte-identical to the unrewritten wiring.
 *
 * A mode that throws, or that parses differently, is RECORDED as such. It is not
 * dropped and it is not silently replaced by the baseline — a leg that falls back
 * to the reference is the defect this repo has shipped six times.
 */
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setWiring, lastEmittedBytes } from '../../src/table/assemble.ts'
import { PARSEMAN_VERSION } from '../../src/version.ts'
import { buildWorkloads, type Workload } from '../workloads/index.ts'
import { WIRING_MODES, rewire, duplicateBodies, bodySizes, type WiringMode } from './rewire.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export type ModeResult = {
  mode: WiringMode
  bytes: number
  ok: boolean
  identical: boolean
  error?: string
}

/** Build one parser under one wiring, prime it, and report bytes + result. */
export function buildUnder(w: Workload, mode: WiringMode): { bytes: number; digest: string } {
  setWiring(mode === 'w0-direct' ? undefined : rewire(mode))
  try {
    const p = w.make()
    const v = p.parse()
    return { bytes: lastEmittedBytes(), digest: JSON.stringify(v) ?? 'undefined' }
  } finally {
    setWiring(undefined)
  }
}

export function sweep(w: Workload): ModeResult[] {
  const base = buildUnder(w, 'w0-direct')
  const out: ModeResult[] = [{ mode: 'w0-direct', bytes: base.bytes, ok: true, identical: true }]
  for (const mode of WIRING_MODES) {
    if (mode === 'w0-direct') continue
    try {
      const r = buildUnder(w, mode)
      out.push({ mode, bytes: r.bytes, ok: true, identical: r.digest === base.digest })
    } catch (e) {
      out.push({ mode, bytes: 0, ok: false, identical: false, error: String(e).slice(0, 300) })
    }
  }
  return out
}

function main(): void {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).trim() !== ''
  console.log(`parseman ${PARSEMAN_VERSION}  sha ${sha}${dirty ? ' (src DIRTY)' : ''}`)
  console.log(`  src realpath ${path.join(ROOT, 'src')}`)
  console.log(`  node ${process.version}  loadavg ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)
  console.log('')

  const outPath = path.join(ROOT, 'notes/results/wiring-sweep.jsonl')
  mkdirSync(path.dirname(outPath), { recursive: true })
  const stamp = new Date().toISOString()

  const only = process.argv.slice(2).filter(a => !a.startsWith('-'))
  const all = buildWorkloads()
  const chosen = only.length === 0 ? all : all.filter(w => only.some(o => w.id.includes(o)))
  if (chosen.length === 0) { console.error(`no workload matches ${only.join(', ')}`); process.exit(1) }
  console.log(`workloads: ${chosen.map(w => w.id).join(', ')}\n`)

  for (const w of chosen) {
    // The unrewritten emitted text, for the duplicate-body census W4 rests on.
    let census = { sites: 0, distinct: 0 }
    let captured = ''
    setWiring((s) => { captured = s; return s })
    try { const p = w.make(); p.parse() } finally { setWiring(undefined) }
    let sizes: ReturnType<typeof bodySizes> | undefined
    if (captured !== '') {
      census = duplicateBodies(captured)
      sizes = bodySizes(captured)
    }

    console.log(`${w.id}  ${w.bytes} B input   sites ${census.sites}  distinct bodies ${census.distinct}`)
    if (sizes !== undefined) {
      console.log(`  piece body SOURCE bytes: min ${sizes.min}  p50 ${sizes.p50}  p90 ${sizes.p90}  max ${sizes.max}`)
      console.log(`  bands ${Object.entries(sizes.bands).map(([k, v]) => `${k}:${v}`).join('  ')}`)
      appendFileSync(outPath, `${JSON.stringify({
        kind: 'body-size-census', stamp, sha, srcDirty: dirty, parsemanVersion: PARSEMAN_VERSION,
        node: process.version, workload: w.id, ...sizes,
      })}\n`)
    }
    const rows = sweep(w)
    const base = rows[0]!.bytes
    for (const r of rows) {
      const pct = base > 0 ? ((r.bytes / base - 1) * 100).toFixed(1) : 'n/a'
      const verdict = !r.ok ? `REFUSED ${r.error}` : r.identical ? 'identical parse' : 'PARSE DIFFERS'
      console.log(`  ${r.mode.padEnd(20)} ${String(r.bytes).padStart(9)} B  ${pct.padStart(7)}%   ${verdict}`)
      appendFileSync(outPath, `${JSON.stringify({
        kind: 'wiring-shape', stamp, sha, srcDirty: dirty, parsemanVersion: PARSEMAN_VERSION,
        node: process.version, workload: w.id, inputBytes: w.bytes,
        sites: census.sites, distinctBodies: census.distinct,
        mode: r.mode, emittedBytes: r.bytes, ok: r.ok, identicalParse: r.identical,
        error: r.error ?? null,
      })}\n`)
    }
    console.log('')
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) main()
