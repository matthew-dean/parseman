/**
 * MICRO 1 (CONSOLIDATED) — every char-class membership candidate in ONE run,
 * so all comparisons share a baseline. Separate runs have separate JIT/cache
 * environments and their baselines are NOT comparable (observed: the same
 * `chain` measured 2.305 ms in one run and 3.059 ms in another).
 *
 * Class = css ident-continuation, the "complete" spelling from
 * docs/design/derived-tokenization.md §7.1: - _ a-z A-Z 0-9 U+0080-U+FFFF \
 * Written with explicit \u escapes: hand-typing the literal form reproduced the
 * §7.2 dropped-low-bound bug in this very lane.
 *
 * Every candidate must return an identical checksum before any timing is kept.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const input = readFileSync(path.join(here, '../../bench/workloads/fixtures/site.css'), 'utf8').repeat(64)

const inSet = c =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
  c === 45 || c === 95 || (c >= 128 && c <= 65535) || c === 92

const LUT16 = new Uint8Array(65536)
for (let c = 0; c < 65536; c++) LUT16[c] = inSet(c) ? 1 : 0
const LUT7 = new Uint8Array(128)
for (let c = 0; c < 128; c++) LUT7[c] = inSet(c) ? 1 : 0
const MASKS = new Int32Array(4)
for (let c = 0; c < 128; c++) if (inSet(c)) MASKS[c >> 5] |= 1 << (c & 31)
let M0 = MASKS[0], M1 = MASKS[1], M2 = MASKS[2], M3 = MASKS[3]

const RE = /[-_a-zA-Z0-9\u0080-\uFFFF\\]+/y

const chain = input => {
  const n = input.length; let i = 0, runs = 0, total = 0
  while (i < n) {
    const s = i; let c = input.charCodeAt(i)
    while (i < n && ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
      c === 45 || c === 95 || (c >= 128 && c <= 65535) || c === 92)) { i++; c = input.charCodeAt(i) }
    if (i > s) { runs++; total += i - s } else i++
  }
  return runs * 1000003 + total
}
const lut16 = input => {
  const n = input.length; let i = 0, runs = 0, total = 0
  while (i < n) {
    const s = i
    while (i < n && LUT16[input.charCodeAt(i)] === 1) i++
    if (i > s) { runs++; total += i - s } else i++
  }
  return runs * 1000003 + total
}
const lut7 = input => {
  const n = input.length; let i = 0, runs = 0, total = 0
  while (i < n) {
    const s = i
    for (;;) {
      if (i >= n) break
      const c = input.charCodeAt(i)
      if (c > 127 || LUT7[c] === 1) i++; else break
    }
    if (i > s) { runs++; total += i - s } else i++
  }
  return runs * 1000003 + total
}
const bitBranch = input => {
  const n = input.length; const m0 = M0, m1 = M1, m2 = M2, m3 = M3
  let i = 0, runs = 0, total = 0
  while (i < n) {
    const s = i
    for (;;) {
      if (i >= n) break
      const c = input.charCodeAt(i)
      let hit
      if (c > 127) hit = 1
      else if (c < 64) hit = c < 32 ? (m0 >> c) & 1 : (m1 >> (c & 31)) & 1
      else hit = c < 96 ? (m2 >> (c & 31)) & 1 : (m3 >> (c & 31)) & 1
      if (hit) i++; else break
    }
    if (i > s) { runs++; total += i - s } else i++
  }
  return runs * 1000003 + total
}
const bitIndexed = input => {
  const n = input.length; let i = 0, runs = 0, total = 0
  while (i < n) {
    const s = i
    for (;;) {
      if (i >= n) break
      const c = input.charCodeAt(i)
      if (c > 127 || ((MASKS[c >> 5] >> (c & 31)) & 1) === 1) i++; else break
    }
    if (i > s) { runs++; total += i - s } else i++
  }
  return runs * 1000003 + total
}
const stickyExec = input => {
  const n = input.length; let i = 0, runs = 0, total = 0
  while (i < n) {
    RE.lastIndex = i
    const m = RE.exec(input)
    if (m !== null) { runs++; total += RE.lastIndex - i; i = RE.lastIndex } else i++
  }
  return runs * 1000003 + total
}
const stickyTest = input => {
  const n = input.length; let i = 0, runs = 0, total = 0
  while (i < n) {
    RE.lastIndex = i
    if (RE.test(input)) { runs++; total += RE.lastIndex - i; i = RE.lastIndex } else i++
  }
  return runs * 1000003 + total
}
const stickyGuarded = input => {
  const n = input.length; let i = 0, runs = 0, total = 0
  while (i < n) {
    if (LUT16[input.charCodeAt(i)] === 0) { i++; continue }
    RE.lastIndex = i
    RE.test(input)
    runs++; total += RE.lastIndex - i; i = RE.lastIndex
  }
  return runs * 1000003 + total
}

const candidates = [
  ['chain (current classCond)', chain],
  ['Uint8Array LUT 64KB', lut16],
  ['Uint8Array LUT 128B+range', lut7],
  ['bitmask 4x SMI branched', bitBranch],
  ['bitmask Int32Array indexed', bitIndexed],
  ['sticky /y exec()', stickyExec],
  ['sticky /y test()', stickyTest],
  ['sticky /y LUT-guarded', stickyGuarded],
]

const expect = chain(input)
for (const [name, fn] of candidates) {
  const got = fn(input)
  if (got !== expect) { console.error(`FAIL ${name}: ${got} !== ${expect}`); process.exit(1) }
}
console.log(`checksum agreed across ${candidates.length} candidates: ${expect}`)
console.log(`input ${(input.length / 1048576).toFixed(2)} MiB, node ${process.version}\n`)

for (const [, fn] of candidates) for (let k = 0; k < 8; k++) fn(input)

const ROUNDS = 61
const times = new Map(candidates.map(([n]) => [n, []]))
for (let r = 0; r < ROUNDS; r++) {
  for (const k of candidates.map((_, j) => (j + r) % candidates.length)) {
    const [name, fn] = candidates[k]
    const t0 = process.hrtime.bigint(); fn(input); const t1 = process.hrtime.bigint()
    times.get(name).push(Number(t1 - t0) / 1e6)
  }
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const b = times.get(candidates[0][0]); const bmed = med(b)
console.log(`candidate                      median     min     rel   wins/${ROUNDS}`)
for (const [name] of candidates) {
  const t = times.get(name)
  const wins = t.filter((v, k) => v < b[k]).length
  console.log(`${name.padEnd(28)} ${med(t).toFixed(3).padStart(7)} ${Math.min(...t).toFixed(3).padStart(7)} ${(med(t) / bmed).toFixed(3).padStart(7)} ${String(wins).padStart(7)}`)
}
