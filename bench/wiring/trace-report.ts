/**
 * THE V8 EVIDENCE LEG — deterministic, contention-free, no timing slot.
 *
 * For every (workload × wiring) it spawns a child under `--trace-turbo-inlining`
 * and `--trace-deopt`, and reduces V8's own trace to the three things the sweep
 * turns on:
 *
 *   1. **Callee BYTECODE size** for every piece TurboFan considered. Source bytes
 *      are what a size census can see; bytecode bytes are what V8's inlining
 *      budget is actually stated in, and no figure in this repo has ever recorded
 *      one for a real piece.
 *   2. **Whether the call inlined**, per callee, per wiring.
 *   3. **Why it did not**, by V8's own reason code, correlated with size — which
 *      is how the reason codes get identified from evidence instead of from
 *      memory of a header file.
 *
 * Every number here is a property of the trace, so two runs agree and a busy box
 * cannot move it.
 */
import os from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PARSEMAN_VERSION } from '../../src/version.ts'
import { WIRING_MODES, type WiringMode } from './rewire.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** `<SharedFunctionInfo _pf12>` → `_pf12`; an anonymous one → `<anon>`. */
const NAME = /<SharedFunctionInfo ([^>]*)>/

const nameOf = (line: string): string => {
  const m = NAME.exec(line)
  if (m === null) return '<none>'
  return m[1]!.trim() === '' ? '<anon>' : m[1]!.trim()
}

/** Is this one of OUR emitted pieces, under any wiring's naming? */
const isPiece = (n: string): boolean => /^(_pf|_im|_qf|_sk|_ts|_disp|_snap)/.test(n)

/** Normalise a wiring's spelling of a site back to `_pf<N>` so counts compare. */
const canonical = (n: string): string => n.replace(/^_im/, '_pf').replace(/_$/, '')

export type TraceSummary = {
  consideredPieces: number
  inlinedPieces: number
  /** Distinct piece callees V8 refused, by reason code. */
  refusedByReason: Record<string, number>
  /** Bytecode size of every piece target the trace reported, deduped by name. */
  bytecodeByName: Record<string, number>
  bytecodeMin: number
  bytecodeP50: number
  bytecodeMax: number
  deopts: number
  deoptReasons: Record<string, number>
  /** Largest piece observed INLINED, and smallest observed REFUSED — the bracket. */
  largestInlined: { name: string; bytecode: number } | undefined
  anonymousInlines: number
}

export function summarise(trace: string): TraceSummary {
  const lines = trace.split('\n')
  const bytecodeByName: Record<string, number> = {}
  const refusedByReason: Record<string, number> = {}
  const deoptReasons: Record<string, number> = {}
  const inlinedNames = new Set<string>()
  let considered = 0
  let deopts = 0
  let anonymousInlines = 0

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (l.startsWith('Considering ')) { if (isPiece(nameOf(l))) considered++; continue }
    if (l.includes('- target:') && l.includes('bytecode size:')) {
      const n = nameOf(l)
      const size = Number(/bytecode size: (\d+)/.exec(l)?.[1] ?? '-1')
      if (isPiece(n) && size >= 0) bytecodeByName[n] = size
      continue
    }
    if (l.startsWith('Inlining ')) {
      const n = nameOf(l)
      if (isPiece(n)) inlinedNames.add(n)
      else if (n === '<anon>') anonymousInlines++
      continue
    }
    if (l.startsWith('Cannot consider ')) {
      const n = nameOf(l)
      if (!isPiece(n)) continue
      const reason = /reason: (\d+)/.exec(l)?.[1] ?? '?'
      refusedByReason[reason] = (refusedByReason[reason] ?? 0) + 1
      continue
    }
    if (l.includes('[bailout') || l.includes('[deoptimizing')) {
      deopts++
      const r = /reason: ([^\]]+)/.exec(l)?.[1]?.trim()
      if (r !== undefined) deoptReasons[r] = (deoptReasons[r] ?? 0) + 1
    }
  }

  const sizes = Object.values(bytecodeByName).sort((a, b) => a - b)
  let largestInlined: { name: string; bytecode: number } | undefined
  for (const n of inlinedNames) {
    const b = bytecodeByName[n]
    if (b === undefined) continue
    if (largestInlined === undefined || b > largestInlined.bytecode) largestInlined = { name: n, bytecode: b }
  }

  return {
    consideredPieces: considered,
    inlinedPieces: inlinedNames.size,
    refusedByReason,
    bytecodeByName,
    bytecodeMin: sizes[0] ?? -1,
    bytecodeP50: sizes[Math.floor(sizes.length / 2)] ?? -1,
    bytecodeMax: sizes.at(-1) ?? -1,
    deopts,
    deoptReasons,
    largestInlined,
    anonymousInlines,
  }
}

function run(workload: string, mode: WiringMode, reps: number): TraceSummary {
  const r = spawnSync(process.execPath, [
    '--trace-turbo-inlining', '--trace-deopt', '--stack-size=4000',
    '--import', 'tsx/esm', 'bench/wiring/trace.ts', workload, mode, String(reps),
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`trace child failed (${r.status}): ${(r.stderr ?? '').slice(-800)}`)
  return summarise(`${r.stdout ?? ''}\n${r.stderr ?? ''}`)
}

function main(): void {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).trim() !== ''
  console.log(`parseman ${PARSEMAN_VERSION}  sha ${sha}${dirty ? ' (src DIRTY)' : ''}`)
  console.log(`  src realpath ${path.join(ROOT, 'src')}`)
  console.log(`  node ${process.version}  loadavg ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)
  console.log('  DETERMINISTIC: every figure below is a property of V8\'s trace, not of the clock.\n')

  const workload = process.argv[2] ?? 'json'
  const reps = Number(process.argv[3] ?? '60')
  const outPath = path.join(ROOT, 'notes/results/wiring-sweep.jsonl')
  mkdirSync(path.dirname(outPath), { recursive: true })
  const stamp = new Date().toISOString()

  console.log(`workload ${workload}, ${reps} parses per leg\n`)
  console.log(`  ${'wiring'.padEnd(20)} ${'considered'.padStart(10)} ${'inlined'.padStart(8)} ${'bc p50'.padStart(7)} ${'bc max'.padStart(7)} ${'deopts'.padStart(7)}   refusals`)
  for (const mode of WIRING_MODES) {
    let s: TraceSummary
    try {
      s = run(workload, mode, reps)
    } catch (e) {
      console.log(`  ${mode.padEnd(20)}  FAILED ${String(e).slice(0, 120)}`)
      continue
    }
    const refus = Object.entries(s.refusedByReason).map(([k, v]) => `reason${k}:${v}`).join(' ') || '—'
    console.log(`  ${mode.padEnd(20)} ${String(s.consideredPieces).padStart(10)} ${String(s.inlinedPieces).padStart(8)} ${String(s.bytecodeP50).padStart(7)} ${String(s.bytecodeMax).padStart(7)} ${String(s.deopts).padStart(7)}   ${refus}`)
    appendFileSync(outPath, `${JSON.stringify({
      kind: 'v8-trace', stamp, sha, srcDirty: dirty, parsemanVersion: PARSEMAN_VERSION,
      node: process.version, workload, reps, mode, ...s,
    })}\n`)
  }
  console.log('')
  console.log('  `considered`/`inlined` count DISTINCT emitted pieces, so they are comparable across')
  console.log('  wirings that rename them. A wiring whose pieces V8 never even considers is a wiring')
  console.log('  whose call sites it could not resolve to a single callee.')
}

main()
