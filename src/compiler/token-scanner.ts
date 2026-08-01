/**
 * Derived tokenization, part 2: emit the SCANNER for an alphabet.
 *
 * Shape, and why each piece is what it is (all measured on the css grammar):
 *
 *  - Literal and keyword terminals become a DATA TRIE walked by a fixed-size
 *    driver. The trie walk is also the macro-time SEARCH for a distinguishing
 *    position set: it walks until the node is uniquely accepting, so it does not
 *    depend on a fixed discriminator. A fixed one does not work — `(len,c1,c2)`
 *    collides on `@counter-style`/`@color-profile` and
 *    `@font-feature-values`/`@font-palette-values`, and widening to the last
 *    char still leaves 11 buckets for 13 keys.
 *    Emitting the trie as CODE (nested switches) was measured at 25,223 B for 13
 *    css at-keywords; as DATA it is 2,057 B for the same set and 1.4x the speed
 *    of today's slice-plus-char-chain rather than 2.5x. Data also means the
 *    driver's size is independent of how many keys the grammar has.
 *
 *  - Regex terminals stay sticky regexes, consulted ONLY when the position's
 *    first char is in their first set. Ungated, a 42-regex core alphabet scans
 *    benchmark.css at 14.5 MB/s; first-char gated, 30.4 MB/s.
 *
 *  - The candidate set consulted is LOCAL to the decision point (a packed table
 *    of id lists). The id space is global. Global maximal munch over the whole
 *    alphabet produces seven tokens for a 123 KB stylesheet.
 *
 *  - `tight` is set AT SCAN TIME: 1 when no trivia preceded the token. This is
 *    what carries `noTrivia` adjacency (262 sites across the four dialects, 50 in
 *    css) rather than the hand-spelled `boundary` classes, which are not even
 *    self-consistent today: the 26 css `keywords(boundary:)` sites use THREE
 *    different spellings and 16 of them omit `-￿` and/or `\\`.
 *
 *  - Whitespace is a token in `MODE_SELECTOR` (the descendant combinator is
 *    significant there) and skipped otherwise. Mode is part of the memo key.
 */
import type { Alphabet } from './token-alphabet.ts'
import { TOK_EOF, TOK_UNKNOWN, TOK_WS } from './token-alphabet.ts'
import { firstSetFromRegex } from '../regex/first-set.ts'
import { packInts } from './token-dispatch.ts'

/**
 * First CHARS a regex terminal can start with, or null when it is unbounded.
 * Reuses the analyzer the interpreter's first-set gating already trusts — the
 * gate must never be narrower than the real first set or a valid token is
 * skipped, and `firstSetFromRegex` is the same over-approximation used there.
 */
function firstSetOfRegexSource(source: string, flags: string): Set<number> | null {
  let fs
  try { fs = firstSetFromRegex(source).firstSet } catch { return null }
  if (fs.kind === 'any') return null
  const out = new Set<number>()
  if (fs.kind === 'empty') return out
  for (const r of fs.ranges) {
    // An unbounded tail (non-ASCII ranges are wide) collapses to the non-ASCII flag.
    if (r.hi - r.lo > 512) return null
    for (let c = r.lo; c <= r.hi; c++) out.add(c)
  }
  // Under `/i` the analyzer's ranges may name only one case; admit both, since a
  // gate narrower than the real first set would skip a valid token.
  if (flags.includes('i')) {
    for (const c of [...out]) {
      if (c >= 65 && c <= 90) out.add(c + 32)
      else if (c >= 97 && c <= 122) out.add(c - 32)
    }
  }
  return out
}

type TrieNode = { edges: Map<number, number>; accept: number }

/**
 * Build the literal/keyword trie. Case-insensitive terminals fold with `| 32`,
 * which is exact for ASCII letters and identity for everything else, so one
 * folded walk serves both. A case-SENSITIVE terminal whose text contains an
 * ASCII letter cannot share the folded walk and is left to the regex path.
 */
function buildTrie(alphabet: Alphabet): { nodes: TrieNode[]; covered: Set<number> } {
  const nodes: TrieNode[] = [{ edges: new Map(), accept: 0 }]
  const covered = new Set<number>()
  const hasAsciiLetter = (s: string): boolean => /[a-zA-Z]/.test(s)

  const insert = (text: string, id: number): boolean => {
    if (text.length === 0) return false
    let n = 0
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i) | 32
      let t = nodes[n]!.edges.get(c)
      if (t === undefined) {
        t = nodes.length
        nodes.push({ edges: new Map(), accept: 0 })
        nodes[n]!.edges.set(c, t)
      }
      n = t
    }
    // A collision means two terminals fold to the same text; keep the first.
    if (nodes[n]!.accept !== 0) return false
    nodes[n]!.accept = id
    return true
  }

  for (const t of alphabet.terminals) {
    if (t.kind === 'literal') {
      if (!t.caseInsensitive && hasAsciiLetter(t.value)) continue
      if (insert(t.value, t.id)) covered.add(t.id)
    } else if (t.kind === 'keywords') {
      // One id per SET: every word in the set accepts the same id, which is
      // exactly what the dispatch needs (the set is the terminal).
      let any = false
      for (const w of t.words) {
        if (!t.caseInsensitive && hasAsciiLetter(w)) continue
        if (insert(w, t.id)) any = true
      }
      if (any) covered.add(t.id)
    }
  }
  return { nodes, covered }
}

export type ScannerEmission = {
  /** Module-scope declarations for the artifact prelude. */
  decls: string[]
  /** Name of the cursor entry point. */
  nextFn: string
  /** Register a candidate set, returning its table index. */
  candidateIndexOf: (ids: readonly number[]) => number
  /** True when the alphabet produced a usable scanner at all. */
  usable: boolean
}

/**
 * Emit the scanner for `alphabet`. `ns` namespaces every hoisted name exactly
 * like `_re`/`_fx`/`_pf` so two fused pieces never collide.
 */
export function emitScanner(alphabet: Alphabet, ns: string): ScannerEmission {
  const { nodes, covered } = buildTrie(alphabet)

  // Regex terminals, with their first-char gate. A terminal whose first set is
  // empty can never start a token; one that is effectively unbounded is only
  // consulted on the default arm.
  const regexes: Array<{ id: number; src: string; flags: string; first: Set<number> | null }> = []
  for (const t of alphabet.terminals) {
    if (t.kind !== 'regex') continue
    regexes.push({ id: t.id, src: t.source, flags: t.flags, first: firstSetOfRegexSource(t.source, t.flags) })
  }

  const usable = covered.size > 0 || regexes.length > 0
  if (!usable) {
    return { decls: [], nextFn: '', candidateIndexOf: () => -1, usable: false }
  }

  // Flatten the trie.
  const START: number[] = [0]
  const CHAR: number[] = []
  const NEXT: number[] = []
  const ACCEPT: number[] = []
  for (const nd of nodes) {
    for (const [c, t] of [...nd.edges.entries()].sort((a, b) => a[0] - b[0])) { CHAR.push(c); NEXT.push(t) }
    START.push(CHAR.length)
    ACCEPT.push(nd.accept)
  }

  // Candidate-set table, filled as decision points register.
  const candOffsets: number[] = [0]
  const candIds: number[] = []
  const candKeyToIndex = new Map<string, number>()
  const candidateIndexOf = (ids: readonly number[]): number => {
    const sorted = [...new Set(ids)].sort((a, b) => a - b)
    const key = sorted.join(',')
    const hit = candKeyToIndex.get(key)
    if (hit !== undefined) return hit
    const idx = candOffsets.length - 1
    for (const id of sorted) candIds.push(id)
    candOffsets.push(candIds.length)
    candKeyToIndex.set(key, idx)
    return idx
  }

  const p = (n: string): string => `${ns}${n}`
  const decls: string[] = []

  decls.push(`const ${p('_tkChar')} = ${JSON.stringify(CHAR.map(c => String.fromCharCode(c)).join(''))}`)
  decls.push(`const ${p('_tkUnpack')} = s => { const o = new Int32Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = (s.charCodeAt(i * 2) - 35) | ((s.charCodeAt(i * 2 + 1) - 35) << 6); return o }`)
  decls.push(`const ${p('_tkNext_')} = ${p('_tkUnpack')}(${packInts(NEXT)})`)
  decls.push(`const ${p('_tkStart')} = ${p('_tkUnpack')}(${packInts(START)})`)
  decls.push(`const ${p('_tkAccept')} = ${p('_tkUnpack')}(${packInts(ACCEPT)})`)

  for (const [i, r] of regexes.entries()) {
    const flags = r.flags.includes('y') ? r.flags : `${r.flags.replace(/[g]/g, '')}y`
    decls.push(`const ${p(`_tkRx${i}`)} = /${r.src}/${flags}`)
  }
  decls.push(`const ${p('_tkRx')} = [${regexes.map((_, i) => p(`_tkRx${i}`)).join(', ')}]`)
  decls.push(`const ${p('_tkRxId')} = new Int32Array([${regexes.map(r => r.id).join(', ')}])`)

  // Per-regex first-char gate as a bitset over 0..127 plus an "also non-ASCII" flag.
  const gateWords: number[] = []
  const gateNonAscii: number[] = []
  for (const r of regexes) {
    const w = new Array<number>(4).fill(0)
    let nonAscii = 0
    if (r.first === null) { w.fill(-1); nonAscii = 1 } else {
      for (const c of r.first) {
        if (c >= 128) { nonAscii = 1; continue }
        w[c >> 5] = (w[c >> 5]! | (1 << (c & 31))) | 0
      }
    }
    gateWords.push(...w)
    gateNonAscii.push(nonAscii)
  }
  decls.push(`const ${p('_tkGate')} = new Int32Array([${gateWords.join(', ')}])`)
  decls.push(`const ${p('_tkGateHi')} = new Uint8Array([${gateNonAscii.join(', ')}])`)

  // Candidate table is emitted lazily by the caller after all sites registered;
  // placeholders are patched in `finalizeScanner`.
  decls.push(`__TK_CAND_OFFSETS__`)
  decls.push(`__TK_CAND_IDS__`)

  const nextFn = p('_tkScan')
  decls.push([
    `let ${p('_tkId')} = ${TOK_EOF}, ${p('_tkStartPos')} = 0, ${p('_tkEnd')} = 0, ${p('_tkTight')} = 0`,
    // The memo is module state, so INPUT IDENTITY is part of the key. Without it a
    // second parse of a different string hits the first string's cached token at the
    // same (pos, mode, set) and returns it — a wrong token from a warm cache, with no
    // error. The reference check is O(1) on the common path: the same parse passes the
    // same string object every call.
    `let ${p('_tkMemoInput')} = null, ${p('_tkMemoPos')} = -1, ${p('_tkMemoMode')} = -1, ${p('_tkMemoSet')} = -1`,
    `function ${nextFn}(input, pos, mode, set) {`,
    `  if (input === ${p('_tkMemoInput')} && pos === ${p('_tkMemoPos')} && mode === ${p('_tkMemoMode')} && set === ${p('_tkMemoSet')}) return ${p('_tkId')}`,
    `  ${p('_tkMemoInput')} = input; ${p('_tkMemoPos')} = pos; ${p('_tkMemoMode')} = mode; ${p('_tkMemoSet')} = set`,
    `  const n = input.length`,
    `  let q = pos`,
    // Comments skip in both modes; whitespace only outside selector mode.
    `  for (;;) {`,
    `    const before = q`,
    `    if (mode !== 1) { while (q < n) { const c = input.charCodeAt(q); if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) q++; else break } }`,
    `    if (q + 1 < n && input.charCodeAt(q) === 47 && input.charCodeAt(q + 1) === 42) { const e = input.indexOf('*/', q + 2); q = e < 0 ? n : e + 2 }`,
    `    if (q === before) break`,
    `  }`,
    `  ${p('_tkTight')} = q === pos ? 1 : 0`,
    `  ${p('_tkStartPos')} = q`,
    `  if (mode === 1) {`,
    `    let w = q`,
    `    while (w < n) { const c = input.charCodeAt(w); if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) w++; else break }`,
    `    if (w > q) { ${p('_tkEnd')} = w; ${p('_tkId')} = ${TOK_WS}; return ${TOK_WS} }`,
    `  }`,
    `  if (q >= n) { ${p('_tkEnd')} = q; ${p('_tkId')} = ${TOK_EOF}; return ${TOK_EOF} }`,
    `  const lo = ${p('_tkCandOff')}[set], hi = ${p('_tkCandOff')}[set + 1]`,
    `  let bestId = ${TOK_UNKNOWN}, bestEnd = q`,
    // Trie walk: longest accepting prefix wins, which is maximal munch over the
    // literal/keyword part of the candidate set.
    `  {`,
    `    let node = 0, i = q`,
    `    while (i < n) {`,
    `      const c = input.charCodeAt(i) | 32`,
    `      let nx = -1`,
    `      for (let e = ${p('_tkStart')}[node], z = ${p('_tkStart')}[node + 1]; e < z; e++) if (${p('_tkChar')}.charCodeAt(e) === c) { nx = ${p('_tkNext_')}[e]; break }`,
    `      if (nx < 0) break`,
    `      node = nx; i++`,
    `      const acc = ${p('_tkAccept')}[node]`,
    `      if (acc !== 0 && i > bestEnd) { for (let k = lo; k < hi; k++) if (${p('_tkCandIds')}[k] === acc) { bestId = acc; bestEnd = i; break } }`,
    `    }`,
    `  }`,
    // Regex candidates, first-char gated.
    `  {`,
    `    const c0 = input.charCodeAt(q)`,
    `    const wi = c0 < 128 ? (c0 >> 5) : -1, bit = c0 < 128 ? (1 << (c0 & 31)) : 0`,
    `    for (let k = lo; k < hi; k++) {`,
    `      const want = ${p('_tkCandIds')}[k]`,
    `      for (let r = 0; r < ${p('_tkRxId')}.length; r++) {`,
    `        if (${p('_tkRxId')}[r] !== want) continue`,
    `        if (wi < 0 ? !${p('_tkGateHi')}[r] : !(${p('_tkGate')}[r * 4 + wi] & bit)) break`,
    `        const rx = ${p('_tkRx')}[r]`,
    `        rx.lastIndex = q`,
    `        const m = rx.exec(input)`,
    `        if (m !== null && m[0].length > 0 && q + m[0].length > bestEnd) { bestId = want; bestEnd = q + m[0].length }`,
    `        break`,
    `      }`,
    `    }`,
    `  }`,
    `  ${p('_tkEnd')} = bestEnd > q ? bestEnd : q`,
    `  ${p('_tkId')} = bestId`,
    `  return bestId`,
    `}`,
  ].join('\n'))

  return {
    decls,
    nextFn,
    candidateIndexOf,
    usable: true,
    // Consumed by `finalizeScanner`.
    ...({ _cand: { offsets: candOffsets, ids: candIds, ns } } as object),
  } as ScannerEmission
}

/** Patch the candidate table placeholders once every decision point registered. */
export function finalizeScanner(emission: ScannerEmission): string[] {
  const cand = (emission as unknown as { _cand?: { offsets: number[]; ids: number[]; ns: string } })._cand
  if (cand === undefined) return emission.decls
  const p = (n: string): string => `${cand.ns}${n}`
  return emission.decls.map(d => {
    if (d === '__TK_CAND_OFFSETS__') return `const ${p('_tkCandOff')} = new Int32Array([${cand.offsets.join(', ')}])`
    if (d === '__TK_CAND_IDS__') return `const ${p('_tkCandIds')} = new Int32Array([${cand.ids.join(', ')}])`
    return d
  })
}
