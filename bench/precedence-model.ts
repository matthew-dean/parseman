/**
 * Go/no-go model for the precedence-collapse (#7) idea.
 *
 * Faithfully models the COMPILED emitted shape of a 6-level leftAssoc chain
 * (per the codegen map: outer sequence 2-tuple + empty `many` array + separate
 * transform fold, per level) vs the proposed `chainl1` emitter (first-set-guarded
 * loop, inline fold, no tuple, no array).
 *
 * We parse a bare identifier `x` — the operator-free common case — which descends
 * ALL 6 levels and hits a zero-match at each. This isolates the no-op-level cost
 * the collapse targets. No trivia, no CST — pure structural overhead, best case
 * for the optimization (real emitter adds trivia/CST equally to both paths).
 *
 * Run: node --import tsx/esm bench/precedence-model.ts
 */

const INPUT = 'x'  // one bare identifier; parses at pos 0
const OPS = ['*', '+', '<', '=', '&', '|']  // one op char per level (mul..or)

// ---- leaf: match an identifier [a-z]+ ----
function ident(input: string, pos: number): { ok: boolean; end: number; value: unknown } {
  let cur = pos
  while (cur < input.length) {
    const c = input.charCodeAt(cur)
    if (c >= 97 && c <= 122) cur++
    else break
  }
  if (cur === pos) return { ok: false, end: pos, value: undefined }
  return { ok: true, end: cur, value: { type: 'id', name: input.slice(pos, cur) } }
}

// =========================================================================
// CURRENT shape: transform(sequence(base, many(sequence(op, base))), fold)
// emitted per level as: parse base; _arr=[]; while(op){...}; tuple=[vBase,_arr];
// node=vBase; for(rest) fold; return node
// =========================================================================
function makeCurrentLevel(
  base: (i: string, p: number) => { ok: boolean; end: number; value: unknown },
  opChar: number,
) {
  return function level(input: string, pos: number) {
    // parse base
    const b = base(input, pos)
    if (!b.ok) return b
    let cur = b.end
    // many(sequence(op, base)) — allocate array (observed by fold)
    const rest: [unknown, unknown][] = []
    while (cur < input.length) {
      const c = input.charCodeAt(cur)
      if (c !== opChar) break // (op literal fails first-char)
      const opStart = cur
      cur += 1
      const r = base(input, cur)
      if (!r.ok) { cur = opStart; break }
      rest.push([opChar, r.value]) // inner 2-tuple pushed
      cur = r.end
    }
    // outer sequence 2-tuple
    const tuple: [unknown, [unknown, unknown][]] = [b.value, rest]
    // transform fold
    let node = tuple[0]
    for (const [op, right] of tuple[1]) {
      node = { type: 'binary', op, left: node, right }
    }
    return { ok: true, end: cur, value: node }
  }
}

// =========================================================================
// PROPOSED chainl1 emitter: first-set-guarded loop, inline fold, no tuple/array
// =========================================================================
function makeChainlLevel(
  base: (i: string, p: number) => { ok: boolean; end: number; value: unknown },
  opChar: number,
) {
  return function level(input: string, pos: number) {
    const b = base(input, pos)
    if (!b.ok) return b
    let acc = b.value
    let cur = b.end
    // guard: only enter the loop if next char is the op's first char
    while (cur < input.length && input.charCodeAt(cur) === opChar) {
      const opStart = cur
      cur += 1
      const r = base(input, cur)
      if (!r.ok) { cur = opStart; break }
      acc = { type: 'binary', op: opChar, left: acc, right: r.value } // inline fold
      cur = r.end
    }
    return { ok: true, end: cur, value: acc }
  }
}

function build(make: typeof makeCurrentLevel) {
  let level: (i: string, p: number) => { ok: boolean; end: number; value: unknown } = ident
  for (const op of OPS) level = make(level, op.charCodeAt(0))
  return level
}

const current = build(makeCurrentLevel)
const chainl = build(makeChainlLevel)

// sanity: identical results on a bare id
console.log('current:', JSON.stringify(current(INPUT, 0)))
console.log('chainl :', JSON.stringify(chainl(INPUT, 0)))

function bench(label: string, fn: (i: string, p: number) => unknown, iters: number) {
  for (let i = 0; i < 100_000; i++) fn(INPUT, 0)
  const runs: number[] = []
  for (let r = 0; r < 11; r++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iters; i++) fn(INPUT, 0)
    const t1 = process.hrtime.bigint()
    runs.push(Number(t1 - t0) / iters)
  }
  runs.sort((a, b) => a - b)
  const med = runs[Math.floor(runs.length / 2)]
  console.log(`${label.padEnd(10)} ${med.toFixed(2)} ns/parse  (median of 11)`)
  return med
}

console.log('\n=== 6-level descent on bare `x` (operator-free) ===')
const c = bench('current', current, 2_000_000)
const l = bench('chainl1', chainl, 2_000_000)
console.log(`\nspeedup: ${(c / l).toFixed(2)}x   (${(c - l).toFixed(1)} ns/parse saved)`)
