// ILLUSTRATIVE PROBE — not shipping code.
// E7: the callee-SIZE axis. A child slot can be perfectly monomorphic (one
// FunctionLiteral) and still not inline if the callee's bytecode exceeds
// TurboFan's budget. This is the axis that distinguishes "many small pieces"
// from "one big pasted rule", and neither previous design mentions it.
// argv[2] = B, the number of filler statements in the callee body.
const FAIL = Symbol('FAIL')
const B = Number(process.argv[2] ?? 1)

// Build ONE callee FunctionLiteral whose bytecode size grows with B. We cannot
// vary a literal's size without generating it, and generating means Function/eval
// -- which this project forbids in SHIPPED code but is fine in a throwaway probe.
// So: a fixed literal with a data-driven loop is NOT equivalent (loops change the
// shape). Instead, hand-write a ladder of sizes.
function mk(n) {
  // n distinct straight-line char tests, hand-unrolled by a switch over n.
  if (n === 1) return function callee(input, p) { if (input.charCodeAt(p) !== 97) return FAIL; return p + 1 }
  if (n === 4) return function callee(input, p) { if (input.charCodeAt(p) !== 97) return FAIL; if (input.charCodeAt(p + 1) !== 97) return FAIL; if (input.charCodeAt(p + 2) !== 97) return FAIL; if (input.charCodeAt(p + 3) !== 97) return FAIL; return p + 4 }
  if (n === 16) return function callee(input, p) { let q = p; for (const c of [97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97]) { if (input.charCodeAt(q) !== c) return FAIL; q++ } if (input.charCodeAt(p) !== 97) return FAIL; if (input.charCodeAt(p + 1) !== 97) return FAIL; if (input.charCodeAt(p + 2) !== 97) return FAIL; if (input.charCodeAt(p + 3) !== 97) return FAIL; if (input.charCodeAt(p + 4) !== 97) return FAIL; if (input.charCodeAt(p + 5) !== 97) return FAIL; if (input.charCodeAt(p + 6) !== 97) return FAIL; if (input.charCodeAt(p + 7) !== 97) return FAIL; return q }
  return null
}

const callee = mk(B)
function makeParent(k) { return function parent(input, p) { const a = k(input, p); if (a === FAIL) return FAIL; return a } }
const sites = []
for (let i = 0; i < 8; i++) sites.push(makeParent(callee))

const input = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
function drive(site, n) { let acc = 0; for (let i = 0; i < n; i++) { const r = site(input, 0); if (r !== FAIL) acc += r } return acc }
for (let round = 0; round < 30; round++) for (const s of sites) drive(s, 200)
drive(sites[0], 2e6)
console.log('B=' + B)
