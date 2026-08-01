/**
 * Derived tokenization, part 3: token-KEYED dispatch.
 *
 * A `dispatch()` used to emit, per case, a chained condition that re-derived the
 * key from the selector's STRING one character at a time:
 *
 *   if (_dkey.length === 6 && _dkey.charCodeAt(0) === 64 && (_dkey.charCodeAt(1) | 32) === 108 && ...)
 *   else if (_dkey.length === 15 && ...)
 *
 * Measured on the built css artifact: 40,269 B of 3,336,650 B was exactly these
 * chains, 10,499 B of it inside `_r_StylesheetAtRule` alone.
 *
 * Instead the selector's matched span is walked to a small integer case id, and
 * the cases select on the integer. Every id strategy below is BUILT, not
 * reasoned about — `PARSEMAN_DISPATCH=<id>:<sel>` picks one so they can be
 * measured on the shipped artifact rather than in a microbenchmark, which
 * already misled us once: a standalone "table" looked slow because that
 * implementation sliced and lowercased and hashed, not because table dispatch
 * is slow.
 *
 * Every strategy is "compute a candidate case cheaply, then VERIFY against the
 * packed key text", except `trie`, whose walk is already exact.
 */

/** One dispatch case's keys, in emission order. Case ids are 1-based; 0 = no match. */
export type DispatchKeySet = { keys: readonly string[]; caseInsensitive: boolean }

export type IdStrategy = 'trie' | 'lenswitch' | 'firstchar' | 'phash'
export type ArmSelection = 'ifchain' | 'switch'

export type DispatchConfig = { id: IdStrategy | 'auto'; sel: ArmSelection }

/**
 * `PARSEMAN_DISPATCH=<id>:<sel>`. The default is the MEASURED winner on the
 * shipped css artifact, not a preference. All five configurations were built
 * into this emitter and compared on the real artifact with the trees diffed for
 * equality, interleaved in one process (medians of 31 rounds):
 *
 *   config          ms/parse   rel     raw B      gzip B
 *   chain            6.092    1.000   3,336,650   426,247
 *   trie:ifchain     5.967    0.979   3,311,657   424,465   <- default
 *   trie:switch      5.945    0.976   3,333,421   424,895
 *   phash:switch     6.011    0.987   3,331,361   424,637
 *
 * `firstchar` and `lenswitch` BUILD but are inapplicable to css's at-keyword
 * sets — every key starts with `@`, and the lengths collide — so they fall back
 * and emit the chain. `phash` finds an injective hash (the search works) but
 * costs more table bytes than the trie saves. `switch` arm selection is within
 * noise of the chain of integer compares at 3 sites x 8 cases; its larger raw
 * size is the downstream formatter indenting case bodies, which is why gzip is
 * the metric that decides here.
 *
 * The speed spread across ALL configurations is 2.4% — dispatch keying is not
 * where css parse time goes.
 */
export function dispatchConfigFromEnv(env: Record<string, string | undefined>): DispatchConfig {
  const raw = env.PARSEMAN_DISPATCH
  if (raw === undefined || raw === '') return { id: 'trie', sel: 'ifchain' }
  const [idPart, selPart] = raw.split(':')
  const id = (['trie', 'lenswitch', 'firstchar', 'phash', 'auto'] as const).find(s => s === idPart) ?? 'auto'
  const sel: ArmSelection = selPart === 'ifchain' ? 'ifchain' : 'switch'
  return { id, sel }
}

/** Flattened (key, caseIndex) pairs, folded when the case is case-insensitive. */
type FlatKey = { text: string; caseIndex: number }

function flatten(cases: ReadonlyArray<DispatchKeySet>): FlatKey[] | null {
  const out: FlatKey[] = []
  for (const [i, c] of cases.entries()) {
    for (const key of c.keys) {
      if (key.length === 0) return null
      // A case-SENSITIVE key containing an ASCII letter cannot share a folded
      // comparison with the rest; refuse rather than accept the wrong case.
      if (!c.caseInsensitive && /[a-zA-Z]/.test(key)) return null
      out.push({ text: foldText(key), caseIndex: i + 1 })
    }
  }
  return out.length === 0 ? null : out
}

/**
 * ASCII letter-only case fold. Used IDENTICALLY when building the tables and
 * when reading input — the two must never disagree. The cheaper `c | 32` is
 * wrong here: it maps '@'(64) to '`'(96), which silently stops every '@'-led
 * key from ever matching, and maps '_'(95) to DEL(127), which would accept a
 * character the key does not contain.
 */
export const foldExpr = (c: string): string => `(${c} >= 65 && ${c} <= 90 ? ${c} + 32 : ${c})`
export function foldCode(c: number): number { return c >= 65 && c <= 90 ? c + 32 : c }
function foldText(t: string): string {
  let out = ''
  for (let i = 0; i < t.length; i++) out += String.fromCharCode(foldCode(t.charCodeAt(i)))
  return out
}

/**
 * Pack a non-negative int array into a two-chars-per-value string literal.
 *
 * Two chars at six bits each is TWELVE BITS: the representable range is 0..4095.
 * The mask made anything larger wrap SILENTLY, and `unpack` then decoded a wrong
 * index — a table that looks fine and routes to the wrong arm. Bounded here, and
 * this is the ONLY implementation: a second copy in token-scanner.ts had the same
 * encoding and the same missing check, which is how one defect became two.
 */
export const PACK_MAX = 4095
export function packInts(values: readonly number[]): string {
  let s = ''
  for (const v of values) {
    if (!Number.isInteger(v) || v < 0 || v > PACK_MAX) {
      throw new RangeError(
        `packInts: ${v} is outside the 12-bit range 0..${PACK_MAX} this encoding can represent. ` +
          'Widen the encoding rather than letting the value wrap.',
      )
    }
    s += String.fromCharCode(35 + (v & 63), 35 + ((v >> 6) & 63))
  }
  return JSON.stringify(s)
}

/* ------------------------------------------------------------------ *
 * Shared runtime helpers, emitted ONCE per artifact however many sites
 * use them. That is what lets tables shrink the artifact instead of
 * growing it: only the small per-site data is duplicated.
 * ------------------------------------------------------------------ */

export type SharedHelper = 'unpack' | 'verify' | 'trie' | 'lenswitch' | 'firstchar' | 'phash'

export function sharedHelperDecl(kind: SharedHelper, n: (h: SharedHelper) => string): string {
  switch (kind) {
    case 'unpack':
      return `const ${n('unpack')} = s => { const o = new Int32Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = (s.charCodeAt(i * 2) - 35) | ((s.charCodeAt(i * 2 + 1) - 35) << 6); return o }`
    case 'verify':
      return [
        `function ${n('verify')}(input, from, to, keys, ko, kl) {`,
        `  if (to - from !== kl) return false`,
        `  for (let i = 0; i < kl; i++) { const c = input.charCodeAt(from + i); if (${foldExpr('c')} !== keys.charCodeAt(ko + i)) return false }`,
        `  return true`,
        `}`,
      ].join('\n')
    case 'trie':
      return [
        `function ${n('trie')}(input, from, to, ch, st, nx, ac) {`,
        `  let node = 0`,
        `  for (let i = from; i < to; i++) {`,
        `    const c0 = input.charCodeAt(i), c = ${foldExpr('c0')}`,
        `    let t = -1`,
        `    for (let e = st[node], z = st[node + 1]; e < z; e++) if (ch.charCodeAt(e) === c) { t = nx[e]; break }`,
        `    if (t < 0) return 0`,
        `    node = t`,
        `  }`,
        `  return ac[node]`,
        `}`,
      ].join('\n')
    case 'lenswitch':
      return [
        `function ${n('lenswitch')}(input, from, to, lens, cix, keys, kos, kls) {`,
        `  const len = to - from`,
        `  for (let i = 0; i < lens.length; i++) {`,
        `    if (lens[i] !== len) continue`,
        `    if (${n('verify')}(input, from, to, keys, kos[i], kls[i])) return cix[i]`,
        `  }`,
        `  return 0`,
        `}`,
      ].join('\n')
    case 'firstchar':
      return [
        `function ${n('firstchar')}(input, from, to, tab, cix, keys, kos, kls) {`,
        `  const c0 = input.charCodeAt(from), c = ${foldExpr('c0')}`,
        `  if (c > 127) return 0`,
        `  let i = tab[c]`,
        `  if (i === 0) return 0`,
        `  i--`,
        `  return ${n('verify')}(input, from, to, keys, kos[i], kls[i]) ? cix[i] : 0`,
        `}`,
      ].join('\n')
    case 'phash':
      return [
        `function ${n('phash')}(input, from, to, p1, p2, mul, mod, tab, cix, keys, kos, kls) {`,
        `  const len = to - from`,
        `  let a = 0, b = 0`,
        `  if (p1 < len) { const c = input.charCodeAt(from + p1); a = ${foldExpr('c')} }`,
        `  if (p2 < len) { const c = input.charCodeAt(from + p2); b = ${foldExpr('c')} }`,
        `  let i = tab[(len * mul + a * 31 + b) % mod]`,
        `  if (i === 0) return 0`,
        `  i--`,
        `  return ${n('verify')}(input, from, to, keys, kos[i], kls[i]) ? cix[i] : 0`,
        `}`,
      ].join('\n')
  }
}

/** Per-site emission: declarations to hoist plus the call expression. */
export type SiteEmission = {
  strategy: IdStrategy
  decls: string[]
  callExpr: string
  helpers: SharedHelper[]
}

/** Packed key text plus offset/length/case tables, shared by every verify strategy. */
function packKeys(prefix: string, unpack: string, flat: FlatKey[]): {
  decls: string[]; kos: string; kls: string; cix: string; keys: string
} {
  let text = ''
  const kos: number[] = []
  const kls: number[] = []
  const cix: number[] = []
  for (const f of flat) {
    kos.push(text.length)
    kls.push(f.text.length)
    cix.push(f.caseIndex)
    text += f.text
  }
  return {
    decls: [
      `const ${prefix}k = ${JSON.stringify(text)}`,
      `const ${prefix}o = ${unpack}(${packInts(kos)})`,
      `const ${prefix}l = ${unpack}(${packInts(kls)})`,
      `const ${prefix}x = ${unpack}(${packInts(cix)})`,
    ],
    keys: `${prefix}k`, kos: `${prefix}o`, kls: `${prefix}l`, cix: `${prefix}x`,
  }
}

function emitTrie(prefix: string, unpack: string, helper: string, flat: FlatKey[], pos: string, end: string): SiteEmission | null {
  type Node = { edges: Map<number, number>; accept: number }
  const nodes: Node[] = [{ edges: new Map(), accept: 0 }]
  for (const f of flat) {
    let n = 0
    for (let i = 0; i < f.text.length; i++) {
      const code = f.text.charCodeAt(i)
      let t = nodes[n]!.edges.get(code)
      if (t === undefined) { t = nodes.length; nodes.push({ edges: new Map(), accept: 0 }); nodes[n]!.edges.set(code, t) }
      n = t
    }
    if (nodes[n]!.accept !== 0 && nodes[n]!.accept !== f.caseIndex) return null
    nodes[n]!.accept = f.caseIndex
  }
  const start: number[] = [0]; const char: number[] = []; const next: number[] = []; const accept: number[] = []
  for (const nd of nodes) {
    for (const [c, t] of [...nd.edges.entries()].sort((a, b) => a[0] - b[0])) { char.push(c); next.push(t) }
    start.push(char.length); accept.push(nd.accept)
  }
  return {
    strategy: 'trie',
    decls: [
      `const ${prefix}c = ${JSON.stringify(char.map(c => String.fromCharCode(c)).join(''))}`,
      `const ${prefix}s = ${unpack}(${packInts(start)})`,
      `const ${prefix}n = ${unpack}(${packInts(next)})`,
      `const ${prefix}a = ${unpack}(${packInts(accept)})`,
    ],
    callExpr: `${helper}(input, ${pos}, ${end}, ${prefix}c, ${prefix}s, ${prefix}n, ${prefix}a)`,
    helpers: ['unpack', 'trie'],
  }
}

function emitLenSwitch(prefix: string, unpack: string, helper: string, flat: FlatKey[], pos: string, end: string): SiteEmission | null {
  // Only worth it when length is close to decisive: at most one collision bucket.
  const byLen = new Map<number, number>()
  for (const f of flat) byLen.set(f.text.length, (byLen.get(f.text.length) ?? 0) + 1)
  if ([...byLen.values()].filter(v => v > 1).length > 1) return null
  const packed = packKeys(prefix, unpack, flat)
  return {
    strategy: 'lenswitch',
    decls: [...packed.decls, `const ${prefix}n = ${unpack}(${packInts(flat.map(f => f.text.length))})`],
    callExpr: `${helper}(input, ${pos}, ${end}, ${prefix}n, ${packed.cix}, ${packed.keys}, ${packed.kos}, ${packed.kls})`,
    helpers: ['unpack', 'verify', 'lenswitch'],
  }
}

function emitFirstChar(prefix: string, unpack: string, helper: string, flat: FlatKey[], pos: string, end: string): SiteEmission | null {
  const tab = new Array<number>(128).fill(0)
  for (const [i, f] of flat.entries()) {
    const c = f.text.charCodeAt(0)
    // Requires the key set to SEPARATE on char 0 — that is the whole premise.
    if (c > 127 || tab[c] !== 0) return null
    tab[c] = i + 1
  }
  const packed = packKeys(prefix, unpack, flat)
  return {
    strategy: 'firstchar',
    decls: [...packed.decls, `const ${prefix}t = ${unpack}(${packInts(tab)})`],
    callExpr: `${helper}(input, ${pos}, ${end}, ${prefix}t, ${packed.cix}, ${packed.keys}, ${packed.kos}, ${packed.kls})`,
    helpers: ['unpack', 'verify', 'firstchar'],
  }
}

/**
 * gperf-style SEARCH for an injective hash over the ACTUAL key set. A FIXED
 * discriminator provably fails — `(len,c1,c2)` collides on
 * `@counter-style`/`@color-profile` and `@font-feature-values`/
 * `@font-palette-values` — but that says nothing about a SEARCHED one, which is
 * what this does: try every character-position pair against a set of
 * multipliers and moduli and keep the first combination with no collisions.
 */
function emitPHash(prefix: string, unpack: string, helper: string, flat: FlatKey[], pos: string, end: string): SiteEmission | null {
  const maxLen = Math.max(...flat.map(f => f.text.length))
  const at = (f: FlatKey, p: number): number => (p < f.text.length ? f.text.charCodeAt(p) : 0)
  for (let p1 = 0; p1 < maxLen; p1++) {
    for (let p2 = p1; p2 < maxLen; p2++) {
      for (const mul of [1, 3, 7, 11, 17, 31, 53]) {
        for (let mod = flat.length; mod <= flat.length * 6 + 16; mod++) {
          const slots = new Array<number>(mod).fill(0)
          let ok = true
          for (const [i, f] of flat.entries()) {
            const h = (f.text.length * mul + at(f, p1) * 31 + at(f, p2)) % mod
            if (slots[h] !== 0) { ok = false; break }
            slots[h] = i + 1
          }
          if (!ok) continue
          const packed = packKeys(prefix, unpack, flat)
          return {
            strategy: 'phash',
            decls: [...packed.decls, `const ${prefix}t = ${unpack}(${packInts(slots)})`],
            callExpr: `${helper}(input, ${pos}, ${end}, ${p1}, ${p2}, ${mul}, ${mod}, ${prefix}t, ${packed.cix}, ${packed.keys}, ${packed.kos}, ${packed.kls})`,
            helpers: ['unpack', 'verify', 'phash'],
          }
        }
      }
    }
  }
  return null
}

/**
 * Emit the id computation for one site. `auto` picks by KEY-SET SHAPE measured
 * at macro time rather than applying one strategy everywhere: separation on
 * char 0 is the cheapest test there is, a searched perfect hash next, then
 * length, with the trie as the always-applicable fallback.
 */
export function emitDispatchId(
  cases: ReadonlyArray<DispatchKeySet>,
  cfg: DispatchConfig,
  prefix: string,
  helperName: (h: SharedHelper) => string,
  pos: string,
  end: string,
): SiteEmission | null {
  const flat = flatten(cases)
  if (flat === null) return null
  const unpack = helperName('unpack')
  const order: IdStrategy[] = cfg.id === 'auto' ? ['firstchar', 'phash', 'lenswitch', 'trie'] : [cfg.id]
  for (const s of order) {
    const built =
      s === 'trie' ? emitTrie(prefix, unpack, helperName('trie'), flat, pos, end)
      : s === 'lenswitch' ? emitLenSwitch(prefix, unpack, helperName('lenswitch'), flat, pos, end)
      : s === 'firstchar' ? emitFirstChar(prefix, unpack, helperName('firstchar'), flat, pos, end)
      : emitPHash(prefix, unpack, helperName('phash'), flat, pos, end)
    if (built !== null) return built
  }
  return null
}
