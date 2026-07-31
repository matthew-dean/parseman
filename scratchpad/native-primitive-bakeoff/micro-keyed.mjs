/**
 * MICRO 3 — the keyed-lookup family: candidates 5, 6, 7 and the owner's 10.
 *
 * Candidate 10's stated target is the emitted rules map. Recon on a REAL
 * artifact (examples/css/parser.ts, 241,068 B fused) established that the map
 * is NOT on the hot path: `_map` occurs 8 times in 4,766 lines — the literal,
 * the defineProperty stamps and `return _map` — and ZERO times inside any rule
 * body. Rule-to-rule calls are direct hoisted `_r_Name(input, pos, _ctx)`
 * references (40 interior call sites, 0 via the map).
 *
 * So this file measures the key representations as a FORWARD-LOOKING datum for
 * the G5 `g.` table, where a real per-swap-point lookup would exist — not as a
 * change to `_map`, whose read count per parse is 1.
 *
 * Reports the crossover between Map.get (C++) and element access (memory read),
 * and dense-vs-sparse switch numbering (candidate 6).
 * Run with --allow-natives-syntax to also print the elements kind.
 */
const N = Number(process.argv[2] ?? 27) // css has 27 rules
const ITER = 2_000_000

const fns = Array.from({ length: N }, (_, i) => (x) => x + i)
const names = Array.from({ length: N }, (_, i) => `Rule${i}`)

// A. string-keyed object (today's `_map` shape)
const objStr = {}
for (let i = 0; i < N; i++) objStr[names[i]] = fns[i]
// B. dense integer-keyed object literal
const objInt = {}
for (let i = 0; i < N; i++) objInt[i] = fns[i]
// C. plain array
const arr = fns.slice()
// D. Map, integer keys
const mapInt = new Map(fns.map((f, i) => [i, f]))
// E. Map, string keys
const mapStr = new Map(fns.map((f, i) => [names[i], f]))
// F. frozen array (candidate 9: Object.freeze for shape stability)
const arrFrozen = Object.freeze(fns.slice())
// G. sparse integer-keyed object (candidate 6: sparse numbering)
const objSparse = {}
for (let i = 0; i < N; i++) objSparse[i * 37 + 1000] = fns[i]

// Access sequence: pseudo-random but identical for every candidate.
const seq = new Int32Array(4096)
let s = 12345
for (let i = 0; i < seq.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; seq[i] = s % N }
const seqNames = Array.from(seq, i => names[i])
const seqSparse = Int32Array.from(seq, i => i * 37 + 1000)

const runObjStr = () => { let a = 0; for (let k = 0; k < ITER; k++) a = objStr[seqNames[k & 4095]](a) & 0xffff; return a }
const runObjInt = () => { let a = 0; for (let k = 0; k < ITER; k++) a = objInt[seq[k & 4095]](a) & 0xffff; return a }
const runArr = () => { let a = 0; for (let k = 0; k < ITER; k++) a = arr[seq[k & 4095]](a) & 0xffff; return a }
const runArrFrozen = () => { let a = 0; for (let k = 0; k < ITER; k++) a = arrFrozen[seq[k & 4095]](a) & 0xffff; return a }
const runMapInt = () => { let a = 0; for (let k = 0; k < ITER; k++) a = mapInt.get(seq[k & 4095])(a) & 0xffff; return a }
const runMapStr = () => { let a = 0; for (let k = 0; k < ITER; k++) a = mapStr.get(seqNames[k & 4095])(a) & 0xffff; return a }
const runSparse = () => { let a = 0; for (let k = 0; k < ITER; k++) a = objSparse[seqSparse[k & 4095]](a) & 0xffff; return a }

const candidates = [
  ['object, string keys (today)', runObjStr],
  ['object, dense int keys', runObjInt],
  ['plain Array', runArr],
  ['Object.freeze(Array)', runArrFrozen],
  ['Map, integer keys', runMapInt],
  ['Map, string keys', runMapStr],
  ['object, SPARSE int keys', runSparse],
]

const expect = runArr()
for (const [name, fn] of candidates) {
  const got = fn()
  if (got !== expect) { console.error(`FAIL ${name}: ${got} !== ${expect}`); process.exit(1) }
}
console.log(`N=${N} entries, ${ITER.toLocaleString()} lookups/round, checksum ${expect}, node ${process.version}`)


for (const [, fn] of candidates) for (let k = 0; k < 3; k++) fn()
const ROUNDS = 31
const times = new Map(candidates.map(([n]) => [n, []]))
for (let r = 0; r < ROUNDS; r++) {
  for (const k of candidates.map((_, j) => (j + r) % candidates.length)) {
    const [name, fn] = candidates[k]
    const t0 = process.hrtime.bigint(); fn(); const t1 = process.hrtime.bigint()
    times.get(name).push(Number(t1 - t0) / 1e6)
  }
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const b = times.get(candidates[0][0]); const bmed = med(b)
console.log(`\ncandidate                      median     min     rel   wins/${ROUNDS}`)
for (const [name] of candidates) {
  const t = times.get(name)
  const wins = t.filter((v, k) => v < b[k]).length
  console.log(`${name.padEnd(28)} ${med(t).toFixed(2).padStart(7)} ${Math.min(...t).toFixed(2).padStart(7)} ${(med(t) / bmed).toFixed(3).padStart(7)} ${String(wins).padStart(7)}`)
}
