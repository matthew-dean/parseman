/**
 * MICRO 2 — scan-to-delimiter (candidate 4: String.prototype.indexOf is
 * SIMD-accelerated in V8).
 *
 * Target site: scannable-run.ts:1480, the `scanTo` loop, emitted today as
 *   while (j < input.length && !(classCond(input.charCodeAt(j), stop))) j++
 * i.e. a manual char loop with a negated comparison chain. Also the shape of
 * `balanced()` and every skip set.
 *
 * TWO regimes, because they have different answers:
 *   (a) SINGLE stop char  — indexOf can be used directly.
 *   (b) MULTI stop set    — indexOf must be called per member and min-reduced,
 *                           which is where the SIMD advantage can be eaten.
 *
 * Checksums asserted equal before any timing is kept.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const input = readFileSync(path.join(here, '../../bench/workloads/fixtures/site.css'), 'utf8').repeat(64)
const n = input.length

// ---------------------------------------------------------------------------
// (a) SINGLE stop char: ';' (59) — the declaration terminator.
// ---------------------------------------------------------------------------
const SEMI = 59
const singleLoop = () => {
  let i = 0, hops = 0, acc = 0
  while (i < n) {
    let j = i
    while (j < n && input.charCodeAt(j) !== SEMI) j++
    hops++; acc += j - i
    i = j + 1
  }
  return hops * 1000003 + acc
}
const singleIndexOf = () => {
  let i = 0, hops = 0, acc = 0
  while (i < n) {
    let j = input.indexOf(';', i)
    if (j < 0) j = n
    hops++; acc += j - i
    i = j + 1
  }
  return hops * 1000003 + acc
}
const SINGLE_RE = /[^;]*/y
const singleSticky = () => {
  let i = 0, hops = 0, acc = 0
  while (i < n) {
    SINGLE_RE.lastIndex = i
    SINGLE_RE.test(input)
    const j = SINGLE_RE.lastIndex
    hops++; acc += j - i
    i = j + 1
  }
  return hops * 1000003 + acc
}

// ---------------------------------------------------------------------------
// (b) MULTI stop set: '{' '}' ';' — a realistic at-rule prelude stop set.
// ---------------------------------------------------------------------------
const LB = 123, RB = 125
const multiLoop = () => {
  let i = 0, hops = 0, acc = 0
  while (i < n) {
    let j = i
    while (j < n) {
      const c = input.charCodeAt(j)
      if (c === LB || c === RB || c === SEMI) break
      j++
    }
    hops++; acc += j - i
    i = j + 1
  }
  return hops * 1000003 + acc
}
const STOP = new Uint8Array(65536)
STOP[LB] = 1; STOP[RB] = 1; STOP[SEMI] = 1
const multiLut = () => {
  let i = 0, hops = 0, acc = 0
  while (i < n) {
    let j = i
    while (j < n && STOP[input.charCodeAt(j)] === 0) j++
    hops++; acc += j - i
    i = j + 1
  }
  return hops * 1000003 + acc
}
const multiIndexOf = () => {
  let i = 0, hops = 0, acc = 0
  while (i < n) {
    let a = input.indexOf('{', i); if (a < 0) a = n
    let b = input.indexOf('}', i); if (b < 0) b = n
    let c = input.indexOf(';', i); if (c < 0) c = n
    const j = a < b ? (a < c ? a : c) : (b < c ? b : c)
    hops++; acc += j - i
    i = j + 1
  }
  return hops * 1000003 + acc
}
const MULTI_RE = /[^{};]*/y
const multiSticky = () => {
  let i = 0, hops = 0, acc = 0
  while (i < n) {
    MULTI_RE.lastIndex = i
    MULTI_RE.test(input)
    const j = MULTI_RE.lastIndex
    hops++; acc += j - i
    i = j + 1
  }
  return hops * 1000003 + acc
}

function bake(label, cands) {
  const expect = cands[0][1]()
  for (const [name, fn] of cands) {
    const got = fn()
    if (got !== expect) { console.error(`FAIL ${label}/${name}: ${got} !== ${expect}`); process.exit(1) }
  }
  for (const [, fn] of cands) for (let k = 0; k < 8; k++) fn()
  const ROUNDS = 61
  const times = new Map(cands.map(([nm]) => [nm, []]))
  for (let r = 0; r < ROUNDS; r++) {
    for (const k of cands.map((_, j) => (j + r) % cands.length)) {
      const [name, fn] = cands[k]
      const t0 = process.hrtime.bigint(); fn(); const t1 = process.hrtime.bigint()
      times.get(name).push(Number(t1 - t0) / 1e6)
    }
  }
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
  const b = times.get(cands[0][0]); const bmed = med(b)
  console.log(`\n=== ${label} (checksum ${expect}) ===`)
  console.log(`candidate                      median     min     rel   wins/${ROUNDS}`)
  for (const [name] of cands) {
    const t = times.get(name)
    const wins = t.filter((v, k) => v < b[k]).length
    console.log(`${name.padEnd(28)} ${med(t).toFixed(3).padStart(7)} ${Math.min(...t).toFixed(3).padStart(7)} ${(med(t) / bmed).toFixed(3).padStart(7)} ${String(wins).padStart(7)}`)
  }
}

console.log(`input ${(n / 1048576).toFixed(2)} MiB, node ${process.version}`)
bake('(a) SINGLE stop char ";"', [
  ['manual loop (current)', singleLoop],
  ['String.indexOf (SIMD)', singleIndexOf],
  ['sticky /[^;]*/y', singleSticky],
])
bake('(b) MULTI stop set "{ } ;"', [
  ['manual loop chain (current)', multiLoop],
  ['Uint8Array LUT', multiLut],
  ['3x indexOf + min', multiIndexOf],
  ['sticky /[^{};]*/y', multiSticky],
])
