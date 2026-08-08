// ILLUSTRATIVE PROBE — not shipping code. Mirrors the assemble.ts arity-2
// sequence piece: one FunctionLiteral, N closures, each closing over two child
// pieces. Question: at what N does V8 stop inlining the k0(...) call site?
const FAIL = Symbol('FAIL')
const N = Number(process.argv[2] ?? 1)

// ---- leaf pieces: ONE shared FunctionLiteral, 64 closures (mirrors a shared
// library leaf piece bound to 64 different literals) ----
function makeLeaf(i) {
  return function leaf(input, p) { return input.charCodeAt(p) === 97 + (i & 7) ? p + 1 : FAIL }
}
const leaves = []
for (let i = 0; i < 64; i++) leaves.push(makeLeaf(i))

// ---- the shared arity-2 sequence piece: ONE FunctionLiteral ----
function makeSeq2(k0, k1) {
  return function seq2(input, p) {
    const a = k0(input, p); if (a === FAIL) return FAIL
    const b = k1(input, a); if (b === FAIL) return FAIL
    return b
  }
}

const sites = []
for (let i = 0; i < N; i++) sites.push(makeSeq2(leaves[(i * 2) % 64], leaves[(i * 2 + 1) % 64]))

const input = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
function drive(site, n) { let acc = 0; for (let i = 0; i < n; i++) { const r = site(input, 0); if (r !== FAIL) acc += r } return acc }

for (const s of sites) drive(s, 200)
const acc = drive(sites[0], 3e6)
console.log('N=' + N, 'acc=' + acc)
