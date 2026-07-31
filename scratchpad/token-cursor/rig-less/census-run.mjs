/**
 * INSTRUMENT 1 — exact dynamic census of character-level work on the AST path,
 * plus a replayable trace of that work.
 *
 * Parses the corpus with an instrumented copy of the SHIPPING jess grammar
 * artifact and reports total input character reads, DISTINCT input positions
 * touched, and the redundancy factor R = reads / distinct positions.
 *
 * R is the load-bearing number for the token cursor: a cursor scans each position
 * once, so R is the multiple of blind-tokenizer work the current parser performs
 * — i.e. how much MORE than a css-syntax-3 tokenizer a cursor absorbs.
 *
 * The instrumented artifact is gated on producing a tree identical to the
 * uninstrumented one, so this is a census OF THE SHIPPED PARSE, not of a variant.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { run } from 'parseman'
import { C, armTrace, disarm, resetCounts, distinctTouched, posTrace, exTrace, slTrace, reList } from './counters.mjs'

const corpus = process.argv[2]
const grammarModule = process.argv[3] ?? './grammar.instr.js'
const origModule = process.argv[4] ?? './grammar.orig.js'
const entryName = process.argv[5] ?? 'Stylesheet'
const outBase = process.argv[6] ?? 'css'

const _mi = await import(grammarModule); const grammarInstr = _mi.grammarFor ?? _mi.t
const _mo = await import(origModule); const grammarOrig = _mo.grammarFor ?? _mo.t

const input = readFileSync(corpus, 'utf8')

function parseWith(grammarFor) {
  const g = grammarFor({ trackLines: false })
  const entry = g[entryName]
  const opts = { trivia: g.whitespace }
  if (process.env.TC_STATE_SOURCE === '1') opts.state = { source: input }
  const r = run(entry, input, opts)
  if (!r.ok || r.unconsumedFrom !== null) throw new Error(`parse failed at ${JSON.stringify(r.span)} unconsumed=${r.unconsumedFrom}`)
  return r
}

// --- correctness gate: instrumented tree must equal the shipped tree ---------
function stable(v) {
  const seen = new WeakSet()
  return JSON.stringify(v, (k, val) => {
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[circular]'
      seen.add(val)
      if (!Array.isArray(val)) {
        const out = {}
        for (const key of Object.keys(val).sort()) out[key] = val[key]
        return out
      }
    }
    if (typeof val === 'function') return undefined
    return val
  })
}
const a = stable(parseWith(grammarOrig).value)
const b = stable(parseWith(grammarInstr).value)
if (a !== b) {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  throw new Error(`INSTRUMENTED TREE DIVERGES at byte ${i}\n  A: ${a.slice(Math.max(0, i - 80), i + 80)}\n  B: ${b.slice(Math.max(0, i - 80), i + 80)}`)
}

// --- census -----------------------------------------------------------------
resetCounts()
armTrace(input.length)
parseWith(grammarInstr)
disarm()

const distinct = distinctTouched()
const inputReads = C.cc + C.cp + C.exChars + C.exFail
const out = {
  corpus,
  bytes: input.length,
  treeIdenticalToShipped: true,
  charCodeAt: C.cc,
  codePointAt: C.cp,
  regexExec: C.ex,
  regexExecMatched: C.exOk,
  regexExecFailed: C.exFail,
  regexCharsConsumed: C.exChars,
  dispatchKeyReads: C.dk,
  distinctRegexes: reList.length,
  sliceCalls: C.sl,
  sliceBytes: C.slBytes,
  regexObjectsAllocated: C.reAlloc,
  totalInputCharReads: inputReads,
  distinctPositionsTouched: distinct,
  coverageOfFile: +(distinct / input.length).toFixed(4),
  redundancyFactor: +(inputReads / distinct).toFixed(3),
  readsPerInputByte: +(inputReads / input.length).toFixed(3),
}
console.log(JSON.stringify(out, null, 2))

const dir = path.dirname(new URL(import.meta.url).pathname)
writeFileSync(path.join(dir, `trace.${outBase}.pos.bin`), Buffer.from(Int32Array.from(posTrace).buffer))
writeFileSync(path.join(dir, `trace.${outBase}.ex.bin`), Buffer.from(Int32Array.from(exTrace).buffer))
writeFileSync(path.join(dir, `trace.${outBase}.sl.bin`), Buffer.from(Int32Array.from(slTrace).buffer))
writeFileSync(path.join(dir, `trace.${outBase}.meta.json`), JSON.stringify({ corpus, regexes: reList, census: out }, null, 2))
