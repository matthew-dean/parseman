// ILLUSTRATIVE PROBE — not shipping code.
// E5: the 2x2 that isolates the real variable.
//   wiring  in {A = closure-captured binding, D = generic kids[i] loop}
//   kinds   in {1 = all children minted from ONE FunctionLiteral,
//               K = children minted from K distinct FunctionLiterals}
// argv: <A|D> <K>
const FAIL = Symbol('FAIL')
const which = process.argv[2] ?? 'A'
const K = Number(process.argv[3] ?? 1)
const SITES = 16

// K distinct FunctionLiterals, identical bodies. K=1 means one shared literal
// minting many closures (the piece-library case).
const factories = []
factories.push(function f0(i) { return function leaf0(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL } })
factories.push(function f1(i) { return function leaf1(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL } })
factories.push(function f2(i) { return function leaf2(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL } })
factories.push(function f3(i) { return function leaf3(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL } })
factories.push(function f4(i) { return function leaf4(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL } })
factories.push(function f5(i) { return function leaf5(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL } })
factories.push(function f6(i) { return function leaf6(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL } })
factories.push(function f7(i) { return function leaf7(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL } })

function mkA(k0, k1) { return function seqA(input, p) { const a = k0(input, p); if (a === FAIL) return FAIL; const b = k1(input, a); return b } }
function mkD(kids) { return function seqD(input, p) { let cur = p; for (let i = 0; i < kids.length; i++) { const v = kids[i](input, cur); if (v === FAIL) return FAIL; cur = v } return cur } }

const sites = []
for (let s = 0; s < SITES; s++) {
  const k0 = factories[s % K](s)
  const k1 = factories[(s + 1) % K](s)
  sites.push(which === 'A' ? mkA(k0, k1) : mkD([k0, k1]))
}

const input = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
function drive(site, n) { let acc = 0; for (let i = 0; i < n; i++) { const r = site(input, 0); if (r !== FAIL) acc += r } return acc }
for (let round = 0; round < 30; round++) for (const s of sites) drive(s, 200)

// in-process timing: 7 reps, report median ns/parse. Box is shared; the number
// to read is the RATIO between configurations, not the absolute.
const REPS = 1, ITERS = 200000
const ts = []
for (let r = 0; r < REPS; r++) { const t0 = process.hrtime.bigint(); drive(sites[0], ITERS); ts.push(Number(process.hrtime.bigint() - t0) / ITERS) }
ts.sort((a, b) => a - b)
console.log(`wiring=${which} kinds=${K} median_ns=${ts[3].toFixed(3)} min=${ts[0].toFixed(3)}`)
