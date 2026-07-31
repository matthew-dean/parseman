/**
 * INSTRUMENT 2 — the ABSORBABLE SHARE.
 *
 * How much of current AST parse time is character-level work that a token cursor
 * takes over, and how much would the cursor itself pay?
 *
 * Cases, all timed in ONE process, interleaved round-robin (docs/design
 * §16.4 — separate-process A/B of this parse has a noise floor an order of
 * magnitude above the effects at stake):
 *
 *   parse          full AST parse with the SHIPPED artifact (uninstrumented)
 *   parse-control   the same parse, registered a second time — the in-run noise
 *                   floor, measured here rather than quoted from memory
 *   replay-cc      the recorded charCodeAt/codePointAt reads, replayed at the
 *                  recorded positions, nothing else
 *   replay-ex      the recorded regex execs, replayed at the recorded starts
 *   replay-all     both
 *   scan1          a single context-free pass reading every position exactly once
 *                  — the floor a token cursor cannot go below
 *
 * `replay-all` is a LOWER bound on the absorbable time: it re-executes the reads
 * but not the comparisons, branches and loop bookkeeping wrapped around them in
 * the emitted code. `scan1` is what the cursor pays. The difference is the
 * headroom.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from 'parseman'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const base = process.argv[2] ?? 'css'
const grammarModule = process.argv[3] ?? './grammar.orig.js'
const rounds = Number(process.argv[4] ?? 31)

const meta = JSON.parse(readFileSync(path.join(HERE, `trace.${base}.meta.json`), 'utf8'))
const input = readFileSync(meta.corpus, 'utf8')
const pos = new Int32Array(readFileSync(path.join(HERE, `trace.${base}.pos.bin`)).buffer.slice(0))
const ex = new Int32Array(readFileSync(path.join(HERE, `trace.${base}.ex.bin`)).buffer.slice(0))
const sl = new Int32Array(readFileSync(path.join(HERE, `trace.${base}.sl.bin`)).buffer.slice(0))
const regexes = meta.regexes.map(r => new RegExp(r.source, r.flags))

const mod = await import(grammarModule)
const grammarFor = mod.grammarFor ?? mod.t
const g = grammarFor({ trackLines: false })
const entry = g.Stylesheet
const runOpts = { trivia: g.whitespace }
if (process.env.TC_STATE_SOURCE === '1') runOpts.state = { source: input }

let sink = 0

function doParse() {
  const opts = process.env.TC_STATE_SOURCE === '1'
    ? { trivia: g.whitespace, state: { source: input } }
    : runOpts
  const r = run(entry, input, opts)
  if (!r.ok || r.unconsumedFrom !== null) throw new Error('parse failed')
  sink += r.span.end
}
// A separate function object with an identical body: the byte-identical control.
function doParseControl() {
  const opts = process.env.TC_STATE_SOURCE === '1'
    ? { trivia: g.whitespace, state: { source: input } }
    : runOpts
  const r = run(entry, input, opts)
  if (!r.ok || r.unconsumedFrom !== null) throw new Error('parse failed')
  sink += r.span.end
}

function replayCc() {
  let acc = 0
  for (let i = 0; i < pos.length; i++) acc ^= input.charCodeAt(pos[i])
  sink += acc
}

function replayEx() {
  let acc = 0
  for (let i = 0; i < ex.length; i += 2) {
    const re = regexes[ex[i]]
    re.lastIndex = ex[i + 1]
    const m = re.exec(input)
    if (m !== null) acc += m[0].length
  }
  sink += acc
}

function replayAll() { replayCc(); replayEx() }

/**
 * Leaf materialisation, priced on its own: the `input.slice(start, end)` calls the
 * emitted code makes. §8.1.1 measured 89% of css leaf-capture sites as exactly
 * this, derivable from a token range — so this is the mass experiment #25
 * (deferred leaf materialisation) acts on, and it is ENABLED-BY the cursor rather
 * than absorbed by it.
 */
function replaySlice() {
  let acc = 0
  for (let i = 0; i < sl.length; i += 2) acc += input.slice(sl[i], sl[i + 1]).length
  sink += acc
}

/**
 * The floor: one pass, one read per position, with the kind of per-character
 * classification any scanner must do. Deliberately minimal — it is a floor, not
 * a proposed scanner.
 */
function scan1() {
  let acc = 0
  const n = input.length
  for (let i = 0; i < n; i++) {
    const c = input.charCodeAt(i)
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) acc += 1
    else if (c >= 97 && c <= 122) acc += 2
    else if (c >= 65 && c <= 90) acc += 3
    else if (c >= 48 && c <= 57) acc += 4
    else acc += 5
  }
  sink += acc
}

/**
 * The CURSOR FLOOR, measured live rather than quoted: a context-free scanner at
 * the FINEST context-free grain, emitting (kind, start, end, tight) per token
 * into a preallocated Int32Array.
 *
 * Finest grain is the design rule, not a shortcut: a leading `+`/`-` is NOT
 * attached to a number, `10px` is NOT one DIMENSION, and `@white` is NOT one
 * AT_KEYWORD. Merging is reconstruction the consumer can do; splitting is a
 * guess it cannot undo.
 *
 * `tight` is the adjacency bit of the design's §4 — set when nothing was skipped
 * before this token — so this case prices adjacency too.
 */
const toks = new Int32Array(input.length * 4)
function isIdentStart(c) { return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c >= 128 }
function isIdentPart(c) { return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 45 || c >= 128 }
function scanEmit() {
  const n = input.length
  let i = 0, t = 0
  while (i < n) {
    const before = i
    // skip trivia; whether anything was skipped becomes the token's `tight` bit
    for (;;) {
      const c = input.charCodeAt(i)
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) { i++; continue }
      if (c === 47 && input.charCodeAt(i + 1) === 42) {
        i += 2
        while (i < n && !(input.charCodeAt(i) === 42 && input.charCodeAt(i + 1) === 47)) i++
        i += 2
        continue
      }
      break
    }
    if (i >= n) break
    const tight = i === before ? 1 : 0
    const start = i
    const c = input.charCodeAt(i)
    let kind
    if (isIdentStart(c) || (c === 45 && isIdentPart(input.charCodeAt(i + 1))) || c === 92) {
      kind = 1
      i++
      while (i < n && (isIdentPart(input.charCodeAt(i)) || input.charCodeAt(i) === 92)) i++
    } else if (c >= 48 && c <= 57) {
      kind = 2
      i++
      while (i < n) { const d = input.charCodeAt(i); if ((d >= 48 && d <= 57) || d === 46) i++; else break }
    } else if (c === 46 && (() => { const d = input.charCodeAt(i + 1); return d >= 48 && d <= 57 })()) {
      kind = 2
      i++
      while (i < n) { const d = input.charCodeAt(i); if ((d >= 48 && d <= 57) || d === 46) i++; else break }
    } else if (c === 34 || c === 39) {
      kind = 3
      i++
      while (i < n) { const d = input.charCodeAt(i); if (d === 92) { i += 2; continue } i++; if (d === c) break }
    } else {
      kind = 4
      i++
    }
    toks[t] = kind; toks[t + 1] = start; toks[t + 2] = i; toks[t + 3] = tight
    t += 4
  }
  sink += t
}

const cases = [
  ['parse', doParse],
  ['scan-emit', scanEmit],
  ['parse-control', doParseControl],
  ['replay-cc', replayCc],
  ['replay-ex', replayEx],
  ['replay-all', replayAll],
  ['replay-slice', replaySlice],
  ['scan1', scan1],
]

/** Batch each case so one sample is ~20 ms — an earlier harness read two
 *  byte-identical artifacts 7.8% apart until samples were batched. */
function calibrate(fn) {
  fn()
  let batch = 1
  for (;;) {
    const t0 = performance.now()
    for (let i = 0; i < batch; i++) fn()
    const dt = performance.now() - t0
    if (dt >= 20 || batch >= 4096) return { batch, per: dt / batch }
    batch = Math.max(batch + 1, Math.ceil(batch * Math.max(2, 20 / Math.max(dt, 0.01))))
  }
}

const batches = new Map()
for (const [name, fn] of cases) {
  // warm each case to a steady state before any timed round
  for (let i = 0; i < 5; i++) fn()
  const { batch } = calibrate(fn)
  batches.set(name, batch)
}

const samples = new Map(cases.map(([n]) => [n, []]))
for (let r = 0; r < rounds; r++) {
  // rotate the order every round so no case is permanently first
  for (let k = 0; k < cases.length; k++) {
    const [name, fn] = cases[(k + r) % cases.length]
    const batch = batches.get(name)
    const t0 = performance.now()
    for (let i = 0; i < batch; i++) fn()
    samples.get(name).push((performance.now() - t0) / batch)
  }
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const res = {}
for (const [name] of cases) {
  const s = samples.get(name)
  res[name] = { medianMs: +median(s).toFixed(4), minMs: +Math.min(...s).toFixed(4), batch: batches.get(name) }
}

const p = res['parse'].medianMs
const out = {
  corpus: meta.corpus,
  bytes: input.length,
  rounds,
  cases: res,
  controlSpreadPct: +(((res['parse-control'].medianMs - p) / p) * 100).toFixed(2),
  shareOfParse: {
    'replay-cc': +((res['replay-cc'].medianMs / p) * 100).toFixed(2),
    'replay-ex': +((res['replay-ex'].medianMs / p) * 100).toFixed(2),
    'replay-all': +((res['replay-all'].medianMs / p) * 100).toFixed(2),
    'scan1': +((res['scan1'].medianMs / p) * 100).toFixed(2),
    'scan-emit': +((res['scan-emit'].medianMs / p) * 100).toFixed(2),
    'replay-slice': +((res['replay-slice'].medianMs / p) * 100).toFixed(2),
  },
  minOfMinsShareOfParse: {
    'replay-all': +((res['replay-all'].minMs / res['parse'].minMs) * 100).toFixed(2),
    'scan-emit': +((res['scan-emit'].minMs / res['parse'].minMs) * 100).toFixed(2),
    'replay-slice': +((res['replay-slice'].minMs / res['parse'].minMs) * 100).toFixed(2),
  },
  /** How much more char work the cursor absorbs than a blind one-pass scanner. */
  absorbedOverScannerCost: +(res['replay-all'].medianMs / res['scan-emit'].medianMs).toFixed(2),
  census: meta.census,
  sinkGuard: sink !== 0,
}
console.log(JSON.stringify(out, null, 2))
