/**
 * MICRO 1 — character-class membership in the ident scan loop.
 *
 * The class is css's intended ident-continuation set (docs/design/derived-tokenization.md
 * §7.1, the "complete" spelling): - _ a-z A-Z 0-9 -￿ \
 * That is SEVEN ranges, i.e. a seven-term `||` chain as `classCond` emits it today.
 *
 * Task, identical for every candidate: walk the whole document; at each position
 * scan the maximal run of class members. Returns a checksum (sum of run lengths
 * plus count) so a candidate that does LESS WORK cannot win — checksums are
 * asserted equal before any timing is reported.
 *
 * Discipline: interleaved rounds in ONE process, rotating order per round,
 * median + min + win-rate. Per docs §16.4 / §16.5 (noise floor ~1%).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.join(here, '../../bench/workloads/fixtures/site.css'), 'utf8')
// ~1 MB of realistic input so the loop dominates call overhead.
const input = css.repeat(64)
const N = input.length

// ---------------------------------------------------------------------------
// A. CHAIN — exactly what `classCond` emits today.
// ---------------------------------------------------------------------------
function scanChain(input) {
  const n = input.length
  let i = 0, runs = 0, total = 0
  while (i < n) {
    const s = i
    let c = input.charCodeAt(i)
    while (
      i < n &&
      ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
        c === 45 || c === 95 || (c >= 128 && c <= 65535) || c === 92)
    ) {
      i++
      c = input.charCodeAt(i)
    }
    if (i > s) { runs++; total += i - s } else i++
  }
  return runs * 1000003 + total
}

// ---------------------------------------------------------------------------
// B. Uint8Array LUT over the FULL BMP (65536 B) — one raw memory read.
// ---------------------------------------------------------------------------
const LUT16 = new Uint8Array(65536)
for (let c = 0; c < 65536; c++) {
  LUT16[c] =
    (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
    c === 45 || c === 95 || (c >= 128 && c <= 65535) || c === 92 ? 1 : 0
}
function scanLut16(input) {
  const n = input.length
  let i = 0, runs = 0, total = 0
  while (i < n) {
    const s = i
    while (i < n && LUT16[input.charCodeAt(i)] === 1) i++
    if (i > s) { runs++; total += i - s } else i++
  }
  return runs * 1000003 + total
}

// ---------------------------------------------------------------------------
// B2. Uint8Array LUT over ASCII only (128 B) + one range compare for non-ASCII.
//     Cache-friendly: 128 bytes is two cache lines, vs 64 KB for the full BMP.
// ---------------------------------------------------------------------------
const LUT7 = new Uint8Array(128)
for (let c = 0; c < 128; c++) {
  LUT7[c] =
    (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
    c === 45 || c === 95 || c === 92 ? 1 : 0
}
function scanLut7(input) {
  const n = input.length
  let i = 0, runs = 0, total = 0
  while (i < n) {
    const s = i
    for (;;) {
      if (i >= n) break
      const c = input.charCodeAt(i)
      if (c < 128 ? LUT7[c] === 1 : true) i++
      else break
    }
    if (i > s) { runs++; total += i - s } else i++
  }
  return runs * 1000003 + total
}

// ---------------------------------------------------------------------------
// C. BITMASK — four 32-bit masks covering ASCII, held as plain locals (SMI).
//    Signed `>>` keeps the result in SMI range; `>>>` would make a heap number.
// ---------------------------------------------------------------------------
let M0 = 0, M1 = 0, M2 = 0, M3 = 0
for (let c = 0; c < 128; c++) {
  const inSet =
    (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
    c === 45 || c === 95 || c === 92
  if (!inSet) continue
  const bit = 1 << (c & 31)
  if (c < 32) M0 |= bit
  else if (c < 64) M1 |= bit
  else if (c < 96) M2 |= bit
  else M3 |= bit
}
function scanBitmask(input) {
  const n = input.length
  const m0 = M0, m1 = M1, m2 = M2, m3 = M3
  let i = 0, runs = 0, total = 0
  while (i < n) {
    const s = i
    for (;;) {
      if (i >= n) break
      const c = input.charCodeAt(i)
      let hit
      if (c > 127) hit = true
      else if (c < 64) hit = c < 32 ? (m0 >> c) & 1 : (m1 >> (c & 31)) & 1
      else hit = c < 96 ? (m2 >> (c & 31)) & 1 : (m3 >> (c & 31)) & 1
      if (hit) i++
      else break
    }
    if (i > s) { runs++; total += i - s } else i++
  }
  return runs * 1000003 + total
}

// ---------------------------------------------------------------------------
// D. STICKY REGEX — Irregexp compiles to native code and advances for free.
// ---------------------------------------------------------------------------
const STICKY = /[-_a-zA-Z0-9\u0080-\uFFFF\\]+/y
function scanSticky(input) {
  const n = input.length
  let i = 0, runs = 0, total = 0
  while (i < n) {
    STICKY.lastIndex = i
    const m = STICKY.exec(input)
    if (m !== null) { runs++; total += STICKY.lastIndex - i; i = STICKY.lastIndex }
    else i++
  }
  return runs * 1000003 + total
}

// ---------------------------------------------------------------------------
// Harness — interleaved rounds, one process, rotating order.
// ---------------------------------------------------------------------------
const candidates = [
  ['chain (current classCond)', scanChain],
  ['Uint8Array LUT 64KB', scanLut16],
  ['Uint8Array LUT 128B + range', scanLut7],
  ['bitmask 4x SMI', scanBitmask],
  ['sticky regex /y', scanSticky],
]

// Correctness gate FIRST: every candidate must return the same checksum.
const expect = scanChain(input)
for (const [name, fn] of candidates) {
  const got = fn(input)
  if (got !== expect) {
    console.error(`FAIL ${name}: checksum ${got} !== ${expect}`)
    process.exit(1)
  }
}
console.log(`checksum agreed across all ${candidates.length} candidates: ${expect}`)
console.log(`input ${(N / 1024 / 1024).toFixed(2)} MiB\n`)

// Warm each candidate so all are JIT-tiered before any measured round.
for (const [, fn] of candidates) for (let k = 0; k < 5; k++) fn(input)

const ROUNDS = 31
const times = new Map(candidates.map(([n]) => [n, []]))
for (let r = 0; r < ROUNDS; r++) {
  // rotate order each round so no candidate has a fixed cache/GC position
  const order = candidates.map((_, k) => (k + r) % candidates.length)
  for (const k of order) {
    const [name, fn] = candidates[k]
    const t0 = process.hrtime.bigint()
    fn(input)
    const t1 = process.hrtime.bigint()
    times.get(name).push(Number(t1 - t0) / 1e6)
  }
}

const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const base = candidates[0][0]
const rows = candidates.map(([name]) => {
  const t = times.get(name)
  return { name, med: med(t), min: Math.min(...t) }
})
const bmed = rows[0].med
// win rate: per-round head-to-head against the chain baseline
for (const row of rows) {
  const t = times.get(row.name), b = times.get(base)
  row.wins = t.filter((v, k) => v < b[k]).length
}
console.log('candidate                        median    min     rel    wins/31')
for (const r of rows) {
  console.log(
    `${r.name.padEnd(30)} ${r.med.toFixed(3).padStart(7)} ${r.min.toFixed(3).padStart(7)} ` +
    `${(r.med / bmed).toFixed(3).padStart(7)} ${String(r.wins).padStart(6)}`,
  )
}
