/**
 * What does the measured `_ctx` state COST at a read site?
 *
 * Measured state (ctx-hidden-class.mjs): 5 distinct maps across 6 construction
 * sites; a parse TRANSITIONS the caller's object; the transition chain is shared
 * so same-order writes converge; write ORDER changes the map; pre-declaring all
 * fields gives one map and no transitions.
 *
 * Two flaws in the first version of this file, both fixed here:
 *   - every field was 0 and every array empty, so the checksum was trivially 0
 *     and the arithmetic could fold. Fields now hold varying non-zero values.
 *   - the "hoist" variant read each field exactly ONCE, so it was a no-op by
 *     construction. Real rule bodies read the same ctx field repeatedly
 *     (`_cstRawChildren` alone appears 474 times in the css artifact), so the
 *     hoist variant now reads each field 4x, which is what hoisting targets.
 */
const ITER = 5_000_000

const FIELDS = ['_triviaLog', '_cstChildren', '_cstRawChildren', '_cstLeaves']
const fill = (o, seed) => {
  o._fx = seed & 7
  o._fe = (seed >> 1) & 7
  o._triviaLog = [seed, seed + 1]
  o._cstChildren = [seed]
  o._cstRawChildren = [seed, seed + 1, seed + 2]
  o._cstLeaves = [seed, seed + 1]
  return o
}
// One literal with every field present, in one order — the "pre-declared" fix.
const mkMono = s => fill({ trackLines: false, _fx: 0, _fe: 0, _triviaLog: null, _cstChildren: null, _cstRawChildren: null, _cstLeaves: null }, s)
// Same fields reached by ASSIGNMENT in differing orders -> differing maps.
const mkB = s => { const o = { trackLines: false }; o._fx = 0; o._fe = 0; o._triviaLog = null; o._cstChildren = null; o._cstRawChildren = null; o._cstLeaves = null; return fill(o, s) }
const mkC = s => { const o = { trackLines: false }; o._cstLeaves = null; o._cstChildren = null; o._triviaLog = null; o._cstRawChildren = null; o._fx = 0; o._fe = 0; return fill(o, s) }
const mkD = s => { const o = { trackLines: false }; o._triviaLog = null; o._cstRawChildren = null; o._fe = 0; o._fx = 0; o._cstLeaves = null; o._cstChildren = null; return fill(o, s) }

// Reads each field ONCE — the shape hoisting cannot help.
function readOnce(c) {
  return c._fx + c._fe + c._triviaLog.length + c._cstChildren.length + c._cstRawChildren.length + c._cstLeaves.length
}
// Reads each field 4x, as a real rule body does.
function readRepeated(c) {
  let a = 0
  for (let i = 0; i < 4; i++) {
    a += c._fx + c._fe + c._triviaLog.length + c._cstChildren.length + c._cstRawChildren.length + c._cstLeaves.length
  }
  return a
}
// Same 4x work, each field loaded ONCE into a local first.
function readRepeatedHoisted(c) {
  const fx = c._fx, fe = c._fe, tl = c._triviaLog, cc = c._cstChildren, rc = c._cstRawChildren, cl = c._cstLeaves
  let a = 0
  for (let i = 0; i < 4; i++) a += fx + fe + tl.length + cc.length + rc.length + cl.length
  return a
}

const mono = [mkMono(1), mkMono(2), mkMono(3), mkMono(4)]
const poly2 = [mkMono(1), mkB(2), mkMono(3), mkB(4)]
const poly4 = [mkMono(1), mkB(2), mkC(3), mkD(4)]

const drive = (fn, pool) => () => { let a = 0; for (let k = 0; k < ITER; k++) a = (a + fn(pool[k & 3])) & 0xffffff; return a }

const candidates = [
  ['1 map,  read once', drive(readOnce, mono)],
  ['2 maps, read once', drive(readOnce, poly2)],
  ['4 maps, read once', drive(readOnce, poly4)],
  ['1 map,  read 4x', drive(readRepeated, mono)],
  ['4 maps, read 4x', drive(readRepeated, poly4)],
  ['1 map,  read 4x HOISTED', drive(readRepeatedHoisted, mono)],
  ['4 maps, read 4x HOISTED', drive(readRepeatedHoisted, poly4)],
]

// Group checks: read-once and read-4x produce different sums by design.
const expOnce = drive(readOnce, mono)()
const exp4 = drive(readRepeated, mono)()
for (const [n, f] of candidates) {
  const want = n.includes('4x') ? exp4 : expOnce
  const got = f()
  if (got !== want) { console.error(`FAIL ${n}: ${got} !== ${want}`); process.exit(1) }
}
console.log(`checksums agreed (once=${expOnce}, 4x=${exp4}), ${ITER.toLocaleString()} sites/round, node ${process.version}\n`)
for (const [, f] of candidates) for (let k = 0; k < 3; k++) f()

const ROUNDS = 31
const times = new Map(candidates.map(([n]) => [n, []]))
for (let r = 0; r < ROUNDS; r++) {
  for (const k of candidates.map((_, j) => (j + r) % candidates.length)) {
    const [n, f] = candidates[k]
    const t0 = process.hrtime.bigint(); f(); const t1 = process.hrtime.bigint()
    times.get(n).push(Number(t1 - t0) / 1e6)
  }
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const b = times.get(candidates[0][0]); const bmed = med(b)
console.log(`candidate                      median     min     rel`)
for (const [n] of candidates) {
  const t = times.get(n)
  console.log(`${n.padEnd(28)} ${med(t).toFixed(2).padStart(7)} ${Math.min(...t).toFixed(2).padStart(7)} ${(med(t) / bmed).toFixed(3).padStart(7)}`)
}
