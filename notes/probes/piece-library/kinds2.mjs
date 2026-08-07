// ILLUSTRATIVE PROBE — not shipping code.
// Disambiguated: k1 is always `tail` (its own FunctionLiteral), so any
// "Inlining kindX into seq2" line is unambiguously the k0 slot.
// argv[2] = M = number of distinct callee FunctionLiterals reaching k0.
const FAIL = Symbol('FAIL')
const M = Number(process.argv[2] ?? 1)

function kindA(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
function kindB(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
function kindC(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
function kindD(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
function kindE(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
function kindF(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
function kindG(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
function kindH(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
const kinds = [kindA, kindB, kindC, kindD, kindE, kindF, kindG, kindH]
function tail(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }

function makeSeq2(k0, k1) {
  return function seq2(input, p) {
    const a = k0(input, p); if (a === FAIL) return FAIL
    const b = k1(input, a); if (b === FAIL) return FAIL
    return b
  }
}

const sites = []
for (let i = 0; i < M; i++) sites.push(makeSeq2(kinds[i], tail))

const input = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
function drive(site, n) { let acc = 0; for (let i = 0; i < n; i++) { const r = site(input, 0); if (r !== FAIL) acc += r } return acc }

for (let round = 0; round < 50; round++) for (const s of sites) drive(s, 100)
const acc = drive(sites[0], 3e6)
console.log('M=' + M, 'acc=' + acc)
