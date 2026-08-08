// ILLUSTRATIVE PROBE — not shipping code.
// E3: does the WIRING (how the parent reaches its child) change inlining, holding
// the callee at ONE FunctionLiteral?
//   A: closure-captured direct binding    k0(input,p)
//   B: array index                        kids[0](input,p)
//   C: object property                    self.k0(input,p)
//   D: array index with a VARIABLE index  kids[i](input,p)
const FAIL = Symbol('FAIL')
const which = process.argv[2] ?? 'A'
const SITES = Number(process.argv[3] ?? 8)

function makeLeaf(i) { return function leaf(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL } }
const leaves = []; for (let i = 0; i < 64; i++) leaves.push(makeLeaf(i))

function mkA(k0, k1) { return function seqA(input, p) { const a = k0(input, p); if (a === FAIL) return FAIL; const b = k1(input, a); return b } }
function mkB(kids)   { return function seqB(input, p) { const a = kids[0](input, p); if (a === FAIL) return FAIL; const b = kids[1](input, a); return b } }
function mkC(k0, k1) { const self = { k0, k1 }; return function seqC(input, p) { const a = self.k0(input, p); if (a === FAIL) return FAIL; const b = self.k1(input, a); return b } }
function mkD(kids)   { return function seqD(input, p) { let cur = p; for (let i = 0; i < kids.length; i++) { const v = kids[i](input, cur); if (v === FAIL) return FAIL; cur = v } return cur } }

const sites = []
for (let i = 0; i < SITES; i++) {
  const k0 = leaves[(i * 2) % 64], k1 = leaves[(i * 2 + 1) % 64]
  sites.push(which === 'A' ? mkA(k0, k1) : which === 'B' ? mkB([k0, k1]) : which === 'C' ? mkC(k0, k1) : mkD([k0, k1]))
}

const input = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
function drive(site, n) { let acc = 0; for (let i = 0; i < n; i++) { const r = site(input, 0); if (r !== FAIL) acc += r } return acc }
for (let round = 0; round < 20; round++) for (const s of sites) drive(s, 200)
const acc = drive(sites[0], 3e6)
console.log('wiring=' + which, 'sites=' + SITES, 'acc=' + acc)
