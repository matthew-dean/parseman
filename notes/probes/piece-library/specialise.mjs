// ILLUSTRATIVE PROBE — not shipping code.
// E6: THE DESIGN TEST. 8 distinct child kinds must be sequenced by a parent.
//   mode=shared      : ONE seq2 FunctionLiteral for all 8 -> child slot sees 8 kinds
//   mode=specialised : 8 seq2 FunctionLiterals, one per child kind -> each slot sees 1
//   mode=wrapper     : ONE seq2 literal, but each child is wrapped by ONE shared
//                      wrapper literal (tests whether interposition recovers anything)
//   mode=pasted      : ONE seq2 literal per child kind with the child's body PASTED
//                      (no call at all) -- the codegen shape, as a control
// Each mode is run in its own process. Trace tells us what inlined.
const FAIL = Symbol('FAIL')
const mode = process.argv[2] ?? 'shared'
const KINDS = 8
const SITES = 16

function leafA(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
function leafB(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
function leafC(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
function leafD(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
function leafE(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
function leafF(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
function leafG(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
function leafH(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }
const leaves = [leafA, leafB, leafC, leafD, leafE, leafF, leafG, leafH]
function tail(input, p) { return input.charCodeAt(p) === 97 ? p + 1 : FAIL }

// --- mode: shared. ONE parent FunctionLiteral. ---
function mkShared(k0, k1) { return function seqShared(input, p) { const a = k0(input, p); if (a === FAIL) return FAIL; return k1(input, a) } }

// --- mode: specialised. 8 parent FunctionLiterals, one per child kind. This is
// the piece library: authored once, shared across every site whose child is that
// kind, in every grammar. ---
function mkS0(k0, k1) { return function seqS0(input, p) { const a = k0(input, p); if (a === FAIL) return FAIL; return k1(input, a) } }
function mkS1(k0, k1) { return function seqS1(input, p) { const a = k0(input, p); if (a === FAIL) return FAIL; return k1(input, a) } }
function mkS2(k0, k1) { return function seqS2(input, p) { const a = k0(input, p); if (a === FAIL) return FAIL; return k1(input, a) } }
function mkS3(k0, k1) { return function seqS3(input, p) { const a = k0(input, p); if (a === FAIL) return FAIL; return k1(input, a) } }
function mkS4(k0, k1) { return function seqS4(input, p) { const a = k0(input, p); if (a === FAIL) return FAIL; return k1(input, a) } }
function mkS5(k0, k1) { return function seqS5(input, p) { const a = k0(input, p); if (a === FAIL) return FAIL; return k1(input, a) } }
function mkS6(k0, k1) { return function seqS6(input, p) { const a = k0(input, p); if (a === FAIL) return FAIL; return k1(input, a) } }
function mkS7(k0, k1) { return function seqS7(input, p) { const a = k0(input, p); if (a === FAIL) return FAIL; return k1(input, a) } }
const mkS = [mkS0, mkS1, mkS2, mkS3, mkS4, mkS5, mkS6, mkS7]

// --- mode: wrapper. ONE shared wrapper literal in front of every child. ---
function wrap(k) { return function pieceWrapper(input, p) { return k(input, p) } }

// --- mode: pasted. child body inlined textually into a per-kind parent. ---
function mkP0(c, k1) { return function seqP0(input, p) { if (input.charCodeAt(p) !== c) return FAIL; return k1(input, p + 1) } }
function mkP1(c, k1) { return function seqP1(input, p) { if (input.charCodeAt(p) !== c) return FAIL; return k1(input, p + 1) } }
const mkP = [mkP0, mkP1]

const sites = []
for (let s = 0; s < SITES; s++) {
  const kind = s % KINDS
  if (mode === 'shared') sites.push(mkShared(leaves[kind], tail))
  else if (mode === 'specialised') sites.push(mkS[kind](leaves[kind], tail))
  else if (mode === 'wrapper') sites.push(mkShared(wrap(leaves[kind]), tail))
  else sites.push(mkP[kind % 2](97, tail))
}

const input = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
function drive(site, n) { let acc = 0; for (let i = 0; i < n; i++) { const r = site(input, 0); if (r !== FAIL) acc += r } return acc }
for (let round = 0; round < 30; round++) for (const s of sites) drive(s, 200)
drive(sites[0], 2e6)
console.log('mode=' + mode)
