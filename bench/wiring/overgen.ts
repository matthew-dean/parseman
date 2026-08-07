/**
 * OVERGENERATION × PARTIAL SHARING — the two strategies the owner named.
 *
 * "trying with generating some functions that don't get used and some that do…
 *  trying with sharing some parts of that and not others"
 *
 * The question this answers is not "does overgeneration work" — it trivially
 * does, unused top-level functions cost bytes and nothing else. The question is
 * WHAT IT COSTS, and the answer turns entirely on how many piece bodies actually
 * MOVE when an option moves. This measures that per body, on the shipping
 * grammars, rather than taking the ~80%-invariant figure on trust:
 *
 *   - emit the assembly for option set A and for option set B,
 *   - align the two by site,
 *   - count bodies that are byte-identical (SHARE them) against bodies that
 *     differ (OVERGENERATE those, and only those),
 *   - and report the byte cost of the union against the cost of shipping one.
 *
 * The overgenerated module is then BUILT AND RUN, so the "zero runtime cost"
 * half is a measurement and not an assertion: the live half is the baseline
 * wiring, direct hoisted names, untouched.
 */
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setWiring, lastEmittedBytes } from '../../src/table/assemble.ts'
import { PARSEMAN_VERSION } from '../../src/version.ts'
import { subjects, defaultCfg, type Subject, type ParseCfg } from './subjects.ts'
import { split, w6Overgenerate } from './rewire.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Prime a parser under one option set and hand back the text its assembly compiled. */
function capture(s: Subject, cfg: ParseCfg): { source: string; digest: string; bytes: number } {
  let source = ''
  setWiring((src) => { source = src; return src })
  try {
    const p = s.make(cfg)
    const v = p.parse()
    return { source, digest: JSON.stringify(v) ?? 'undefined', bytes: lastEmittedBytes() }
  } finally {
    setWiring(undefined)
  }
}

export type Alignment = {
  sitesA: number
  sitesB: number
  common: number
  identical: number
  differing: number
  onlyA: number
  onlyB: number
  bytesA: number
  bytesB: number
  /** Bytes of the bodies that DIFFER, on the B side — what overgeneration must carry. */
  bytesDiffering: number
}

export function align(a: string, b: string): Alignment {
  const A = new Map(split(a).decls.map(d => [d.ip, d.body]))
  const B = new Map(split(b).decls.map(d => [d.ip, d.body]))
  let identical = 0
  let differing = 0
  let bytesDiffering = 0
  for (const [ip, body] of A) {
    const other = B.get(ip)
    if (other === undefined) continue
    if (other === body) identical++
    else { differing++; bytesDiffering += other.length }
  }
  let onlyA = 0
  for (const ip of A.keys()) if (!B.has(ip)) onlyA++
  let onlyB = 0
  for (const ip of B.keys()) if (!A.has(ip)) { onlyB++; bytesDiffering += B.get(ip)!.length }
  return {
    sitesA: A.size, sitesB: B.size, common: identical + differing,
    identical, differing, onlyA, onlyB,
    bytesA: a.length, bytesB: b.length, bytesDiffering,
  }
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
  const dump = process.argv.includes('--dump')
  const all = subjects()
  const chosen = only.length === 0 ? all : all.filter(s => only.some(o => s.id.includes(o)))

  for (const s of chosen) {
    const base = defaultCfg(s.id)
    console.log(`${s.id}   ${s.bytes} B input   base cfg trackLines=${base.trackLines} capture=${base.capture}`)
    const A = capture(s, base)
    if (dump) writeFileSync(path.join(ROOT, `scratchpad/emit-${s.id.replace('/', '-')}.js`), A.source)

    // The OTHER option variant. `trackLines` is the axis with the widest reported
    // reach into piece bodies; it is also the one `combinators/grammar.ts:103`
    // still reads mid-parse, so it is the axis this project most needs resolved
    // by SELECTION rather than by a test.
    let B: { source: string; digest: string; bytes: number } | undefined
    let axisError: string | undefined
    try {
      B = capture(s, { ...base, trackLines: true })
    } catch (e) {
      axisError = String(e).slice(0, 200)
    }

    if (B === undefined) {
      console.log(`  trackLines=true REFUSED: ${axisError}`)
      appendFileSync(outPath, `${JSON.stringify({
        kind: 'overgeneration', stamp, sha, srcDirty: dirty, parsemanVersion: PARSEMAN_VERSION,
        node: process.version, workload: s.id, axis: 'trackLines', ok: false, error: axisError,
      })}\n`)
      console.log('')
      continue
    }

    const al = align(A.source, B.source)
    const invariantPct = al.common === 0 ? 0 : (al.identical / al.common) * 100
    console.log(`  variant A (trackLines=false) ${A.bytes} B, ${al.sitesA} sites`)
    console.log(`  variant B (trackLines=true)  ${B.bytes} B, ${al.sitesB} sites`)
    console.log(`  aligned by site: ${al.identical} IDENTICAL, ${al.differing} differing, ${al.onlyA} only-A, ${al.onlyB} only-B`)
    console.log(`  option-INVARIANT bodies: ${invariantPct.toFixed(1)}% of the ${al.common} common sites`)

    // Naive overgeneration: carry the whole other variant.
    setWiring(w6Overgenerate(B.source))
    let naiveBytes = 0
    let naiveOk = false
    try {
      const p = s.make(base)
      const v = p.parse()
      naiveBytes = lastEmittedBytes()
      naiveOk = (JSON.stringify(v) ?? 'undefined') === A.digest
    } finally {
      setWiring(undefined)
    }

    // Overgeneration RESTRICTED to the bodies that move — the synthesis of the
    // two strategies. Bytes only; the live half is identical to naive.
    const sharedBytes = A.bytes + al.bytesDiffering
    console.log(`  overgenerate ALL:      ${naiveBytes} B  (+${((naiveBytes / A.bytes - 1) * 100).toFixed(1)}%)  parse ${naiveOk ? 'identical' : 'DIFFERS'}`)
    console.log(`  overgenerate MOVERS:   ~${sharedBytes} B  (+${((sharedBytes / A.bytes - 1) * 100).toFixed(1)}%)  — share the ${al.identical} invariant bodies`)
    console.log('')

    appendFileSync(outPath, `${JSON.stringify({
      kind: 'overgeneration', stamp, sha, srcDirty: dirty, parsemanVersion: PARSEMAN_VERSION,
      node: process.version, workload: s.id, inputBytes: s.bytes, axis: 'trackLines', ok: true,
      ...al, invariantPct,
      overgenerateAllBytes: naiveBytes, overgenerateAllIdenticalParse: naiveOk,
      overgenerateMoversBytes: sharedBytes,
    })}\n`)
  }
}

main()
