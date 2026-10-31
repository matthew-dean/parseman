/**
 * Packing and case-fold helpers for the dormant token scanner (`token-scanner.ts`).
 *
 * This module once also emitted token-keyed `dispatch()` id strategies (trie,
 * length switch, first char, perfect hash) for the source lowering deleted in
 * 0.47.0. Those strategies, their `PARSEMAN_DISPATCH` selector and their
 * measurements were removed with nothing left calling them; they last existed at
 * `acb421e2`. What remains is what `token-scanner.ts` imports.
 */

/**
 * ASCII letter-only case fold. Used IDENTICALLY when building the tables and
 * when reading input — the two must never disagree. The cheaper `c | 32` is
 * wrong here: it maps '@'(64) to '`'(96), which silently stops every '@'-led
 * key from ever matching, and maps '_'(95) to DEL(127), which would accept a
 * character the key does not contain.
 */
export const foldExpr = (c: string): string => `(${c} >= 65 && ${c} <= 90 ? ${c} + 32 : ${c})`
export function foldCode(c: number): number { return c >= 65 && c <= 90 ? c + 32 : c }

/**
 * Pack a non-negative int array into a two-chars-per-value string literal.
 *
 * Two chars at six bits each is TWELVE BITS: the representable range is 0..4095.
 * The mask made anything larger wrap SILENTLY, and `unpack` then decoded a wrong
 * index — a table that looks fine and routes to the wrong arm. Bounded here, and
 * this is the ONLY implementation: a second copy in token-scanner.ts had the same
 * encoding and the same missing check, which is how one defect became two.
 */
const PACK_MAX = 4095
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

/**
 * The decoder for `packInts`, emitted once per artifact under `name`.
 */
export function unpackHelperDecl(name: string): string {
  return `const ${name} = s => { const o = new Int32Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = (s.charCodeAt(i * 2) - 35) | ((s.charCodeAt(i * 2 + 1) - 35) << 6); return o }`
}
