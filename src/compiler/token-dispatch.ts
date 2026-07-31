/**
 * Derived tokenization, part 3: token-KEYED dispatch.
 *
 * A `dispatch()` today emits, per case, a chained condition that re-derives the
 * key from the selector's STRING one character at a time:
 *
 *   if (_dkey.length === 6 && _dkey.charCodeAt(0) === 64 && (_dkey.charCodeAt(1) | 32) === 108 && ...)
 *   else if (_dkey.length === 15 && ...)
 *
 * Measured on the built css artifact: 40,269 B of the 3,336,650 B artifact is
 * exactly these chains, 10,499 B of it inside `_r_StylesheetAtRule` alone.
 *
 * This module replaces them with a WALK to a small integer id, and the cases
 * then compare integers. The walk is a DATA trie, not a comparison tree:
 *
 *  - Data, because emitting the trie as nested switches costs 25,223 B for 13
 *    css at-keywords while the same trie as data costs 2,057 B, and the driver's
 *    size is then independent of the key count.
 *  - A trie rather than a hash, because a FIXED discriminator is not injective:
 *    `(len, c1, c2)` collides on `@counter-style`/`@color-profile` and on
 *    `@font-feature-values`/`@font-palette-values`, and adding the last char
 *    still leaves 11 buckets for 13 keys. Walking until the node is uniquely
 *    accepting IS the macro-time search for a distinguishing position set.
 *
 * Measured, 20,000 lookups, median of 25 interleaved rounds:
 *   key -> id     current char-chain 47.7 ns · code trie 21.8 ns · data trie 30.5 ns
 *   id  -> arm    current char-chain 100.6 ns · switch 16.4 ns · indexed table 16.9 ns
 */

/** One dispatch case's keys, in emission order. Index 0 is "no case matched". */
export type DispatchKeySet = { keys: readonly string[]; caseInsensitive: boolean }

export type TrieTables = { char: string; start: number[]; next: number[]; accept: number[] }

/**
 * Build the walk tables. Returns null when the key set cannot share one folded
 * walk — a case-SENSITIVE key containing an ASCII letter would need an unfolded
 * comparison, and mixing the two in one trie would accept the wrong case.
 */
export function buildDispatchTrie(cases: ReadonlyArray<DispatchKeySet>): TrieTables | null {
  type Node = { edges: Map<number, number>; accept: number }
  const nodes: Node[] = [{ edges: new Map(), accept: 0 }]
  let inserted = 0

  for (const [caseIndex, c] of cases.entries()) {
    for (const key of c.keys) {
      if (key.length === 0) return null
      if (!c.caseInsensitive && /[a-zA-Z]/.test(key)) return null
      let n = 0
      for (let i = 0; i < key.length; i++) {
        const code = key.charCodeAt(i) | 32
        let t = nodes[n]!.edges.get(code)
        if (t === undefined) {
          t = nodes.length
          nodes.push({ edges: new Map(), accept: 0 })
          nodes[n]!.edges.set(code, t)
        }
        n = t
      }
      // Two cases folding to the same text would make the dispatch ambiguous;
      // refuse rather than silently pick one.
      if (nodes[n]!.accept !== 0 && nodes[n]!.accept !== caseIndex + 1) return null
      nodes[n]!.accept = caseIndex + 1
      inserted++
    }
  }
  if (inserted === 0) return null

  const start: number[] = [0]
  const char: number[] = []
  const next: number[] = []
  const accept: number[] = []
  for (const nd of nodes) {
    for (const [c, t] of [...nd.edges.entries()].sort((a, b) => a[0] - b[0])) { char.push(c); next.push(t) }
    start.push(char.length)
    accept.push(nd.accept)
  }
  return { char: char.map(c => String.fromCharCode(c)).join(''), start, next, accept }
}

/** Pack a non-negative int array into a two-chars-per-value string literal. */
export function packInts(values: readonly number[]): string {
  let s = ''
  for (const v of values) s += String.fromCharCode(35 + (v & 63), 35 + ((v >> 6) & 63))
  return JSON.stringify(s)
}

/**
 * The ONE shared walker. Emitted once per artifact, whatever the number of
 * dispatch sites — this is the whole point of tables over comparison trees.
 * Walks `input[from..to)` and returns the accepting case index, or 0.
 *
 * The `to` bound is the selector's own end, so the walk cannot run past what the
 * selector matched: a key that is a strict prefix of the matched text (`@page`
 * against `@pages`) correctly fails instead of accepting early.
 */
export function dispatchWalkerDecl(name: string, unpackName: string): string {
  return [
    `const ${unpackName} = s => { const o = new Int32Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = (s.charCodeAt(i * 2) - 35) | ((s.charCodeAt(i * 2 + 1) - 35) << 6); return o }`,
    `function ${name}(input, from, to, ch, st, nx, ac) {`,
    `  let node = 0`,
    `  for (let i = from; i < to; i++) {`,
    `    const c = input.charCodeAt(i) | 32`,
    `    let t = -1`,
    `    for (let e = st[node], z = st[node + 1]; e < z; e++) if (ch.charCodeAt(e) === c) { t = nx[e]; break }`,
    `    if (t < 0) return 0`,
    `    node = t`,
    `  }`,
    `  return ac[node]`,
    `}`,
  ].join('\n')
}

/** Per-site table declarations. `prefix` is already namespaced. */
export function dispatchTableDecls(prefix: string, unpackName: string, t: TrieTables): string[] {
  return [
    `const ${prefix}c = ${JSON.stringify(t.char)}`,
    `const ${prefix}s = ${unpackName}(${packInts(t.start)})`,
    `const ${prefix}n = ${unpackName}(${packInts(t.next)})`,
    `const ${prefix}a = ${unpackName}(${packInts(t.accept)})`,
  ]
}
