/**
 * MICRO 1b — the two losers from micro-charclass, retried with the tweak their
 * failure mode implies, plus a class-WIDTH sweep.
 *
 * Bitmask lost with 4 branches to select the mask. Tweaks:
 *   - single Int32Array of 4 masks, indexed (1 read + shift)
 *   - narrow classes where the chain is SHORT (the premise may only hold there)
 * Sticky lost because exec() allocates a match array per call. Tweaks:
 *   - .test() (no allocation)
 *   - invoke the regex only where a run actually STARTS
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const input = readFileSync(path.join(here, '../../bench/workloads/fixtures/site.css'), 'utf8').repeat(64)

// ---- sticky, retried ------------------------------------------------------
const RE_EXEC = /[-_a-zA-Z0-9\u0080-\uFFFF\\]+/y
const RE_TEST = /[-_a-zA-Z0-9\u0080-\uFFFF\\]+/y
function scanStickyTest(input) {
  const n = input.length
  let i = 0, runs = 0, total = 0
  while (i < n) {
    RE_TEST.lastIndex = i
    if (RE_TEST.test(input)) { runs++; total += RE_TEST.lastIndex - i; i = RE_TEST.lastIndex }
    else i++
  }
  return runs * 1000003 + total
}
// guarded: cheap ASCII LUT decides whether a run starts, regex only then.
const START = new Uint8Array(65536)
for (let c = 0; c < 65536; c++) {
  START[c] = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
    c === 45 || c === 95 || (c >= 128 && c <= 65535) || c === 92 ? 1 : 0
}
function scanStickyGuarded(input) {
  const n = input.length
  let i = 0, runs = 0, total = 0
  while (i < n) {
    if (START[input.charCodeAt(i)] === 0) { i++; continue }
    RE_TEST.lastIndex = i
    RE_TEST.test(input)
    runs++; total += RE_TEST.lastIndex - i; i = RE_TEST.lastIndex
  }
  return runs * 1000003 + total
}

// ---- bitmask, retried: indexed typed-array of masks ------------------------
const MASKS = new Int32Array(4)
for (let c = 0; c < 128; c++) {
  const inSet = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
    c === 45 || c === 95 || c === 92
  if (inSet) MASKS[c >> 5] |= 1 << (c & 31)
}
function scanBitmaskIndexed(input) {
  const n = input.length
  let i = 0, runs = 0, total = 0
  while (i < n) {
    const s = i
    for (;;) {
      if (i >= n) break
      const c = input.charCodeAt(i)
      if (c > 127 ? true : ((MASKS[c >> 5] >> (c & 31)) & 1) === 1) i++
      else break
    }
    if (i > s) { runs++; total += i - s } else i++
  }
  return runs * 1000003 + total
}

const LUT = START
function scanLut(input) {
  const n = input.length
  let i = 0, runs = 0, total = 0
  while (i < n) {
    const s = i
    while (i < n && LUT[input.charCodeAt(i)] === 1) i++
    if (i > s) { runs++; total += i - s } else i++
  }
  return runs * 1000003 + total
}
function scanChain(input) {
  const n = input.length
  let i = 0, runs = 0, total = 0
  while (i < n) {
    const s = i
    let c = input.charCodeAt(i)
    while (i < n && ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
      c === 45 || c === 95 || (c >= 128 && c <= 65535) || c === 92)) { i++; c = input.charCodeAt(i) }
    if (i > s) { runs++; total += i - s } else i++
  }
  return runs * 1000003 + total
}

const candidates = [
  ['chain (baseline)', scanChain],
  ['Uint8Array LUT 64KB', scanLut],
  ['bitmask indexed Int32Array', scanBitmaskIndexed],
  ['sticky .test() no-alloc', scanStickyTest],
  ['sticky LUT-guarded', scanStickyGuarded],
]
const expect = scanChain(input)
for (const [name, fn] of candidates) {
  const got = fn(input)
  if (got !== expect) { console.error(`FAIL ${name}: ${got} !== ${expect}`); process.exit(1) }
}
console.log(`checksum agreed: ${expect}\n`)
for (const [, fn] of candidates) for (let k = 0; k < 5; k++) fn(input)

const ROUNDS = 31
const times = new Map(candidates.map(([n]) => [n, []]))
for (let r = 0; r < ROUNDS; r++) {
  for (const k of candidates.map((_, j) => (j + r) % candidates.length)) {
    const [name, fn] = candidates[k]
    const t0 = process.hrtime.bigint(); fn(input); const t1 = process.hrtime.bigint()
    times.get(name).push(Number(t1 - t0) / 1e6)
  }
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const b = times.get('chain (baseline)'), bmed = med(b)
console.log('candidate                        median    min     rel    wins/31')
for (const [name] of candidates) {
  const t = times.get(name)
  const wins = t.filter((v, k) => v < b[k]).length
  console.log(`${name.padEnd(30)} ${med(t).toFixed(3).padStart(7)} ${Math.min(...t).toFixed(3).padStart(7)} ${(med(t) / bmed).toFixed(3).padStart(7)} ${String(wins).padStart(6)}`)
}
