/**
 * The case-fold CLASS of a code point under ECMAScript's NON-Unicode `/i`
 * matching — the exact relation `keywords({ caseInsensitive: true })` compiles to.
 *
 * A first-set drives O(1) `choice` dispatch, so it MUST be a superset of every
 * character the combinator can really start with. For a case-insensitive matcher
 * that means: for every input char X that the matcher would accept as the first
 * char, X is in the set. Under `/i` WITHOUT `u`, two chars match iff they share a
 * canonical form, and that relation is NOT simply `{c, toUpperCase(c),
 * toLowerCase(c)}` — 67 BMP code points sit in classes those three miss:
 *
 *   σ (U+03C3) ↔ Σ (U+03A3) ↔ ς (U+03C2)   final sigma is in the class but is
 *                                            neither the upper- nor lowercase of σ
 *   µ (U+00B5) ↔ μ (U+03BC) ↔ Μ (U+039C)   micro sign folds into Greek mu
 *   Ǆ (U+01C4) ↔ ǅ (U+01C5) ↔ ǆ (U+01C6)   titlecase digraphs (also ǇǈǉǊǋǌǱǲǳ)
 *   ͅ (U+0345) ↔ ι (U+03B9) ↔ ι (U+1FBE)   combining iota subscript
 *
 * so widening a first-set by upper/lower alone is UNSOUND for them.
 *
 * The canonical form below is ECMAScript's `Canonicalize` for non-Unicode mode:
 * uppercase the char; if that is not exactly one char, or if it would cross the
 * ASCII boundary INTO Basic Latin, keep the original. That last clause is why
 * `/s/i` does not match `ſ` (U+017F) and `/k/i` does not match `K` (U+212A) —
 * cross-boundary folds are refused in BOTH directions, which is what keeps an
 * ASCII first-set tight and sound for the common all-ASCII keyword set.
 *
 * The classes are derived from the RUNNING engine's own `toUpperCase`, not a
 * frozen table, so they cannot drift from the regex engine that will do the
 * matching. Verified exhaustively against real `/i` behaviour across the BMP:
 * 1141 multi-member classes, 2307 members, zero disagreements in either
 * direction (see `test/unit/case-fold.test.ts`).
 */

/** ECMAScript `Canonicalize` for non-Unicode `/i`. */
function canonical(ch: string): string {
  const u = ch.toUpperCase()
  // A fold that expands (`ß` → `SS`) is not a single-char fold: no canonicalization.
  if (u.length !== 1) return ch
  // Refuse a fold that would move a non-ASCII char INTO Basic Latin (`ſ` → `S`).
  if (ch.codePointAt(0)! >= 128 && u.codePointAt(0)! < 128) return ch
  return u
}

/**
 * Lazily-built reverse index over the non-ASCII BMP, keyed by canonical form.
 * Only classes with more than one member are kept (a singleton class needs no
 * widening), which is ~2.3k entries rather than 65k. The ~12ms scan is paid ONCE
 * per process and only when a non-ASCII case-insensitive first char actually
 * appears — the all-ASCII path below never touches it.
 */
let foldIndex: Map<number, readonly number[]> | null = null

function buildFoldIndex(): Map<number, readonly number[]> {
  const byCanonical = new Map<string, number[]>()
  for (let cp = 0; cp < 0x10000; cp++) {
    // Lone surrogates have no case and never canonicalize with anything.
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const key = canonical(String.fromCharCode(cp))
    const bucket = byCanonical.get(key)
    if (bucket) bucket.push(cp)
    else byCanonical.set(key, [cp])
  }
  const index = new Map<number, readonly number[]>()
  for (const members of byCanonical.values()) {
    if (members.length < 2) continue
    for (const cp of members) index.set(cp, members)
  }
  return index
}

/**
 * Every code point that a non-Unicode `/i` matcher treats as equal to `cp`,
 * INCLUDING `cp` itself. Union these into a first-set to keep case-insensitive
 * dispatch sound.
 */
export function caseFoldVariants(cp: number): readonly number[] {
  // Basic Latin: the fold class is exactly the a↔A twin, no index needed. (The
  // cross-boundary refusal above is what guarantees nothing outside ASCII joins
  // an ASCII char's class, so this fast path is exact, not an approximation.)
  if (cp < 128) {
    if (cp >= 0x41 && cp <= 0x5a) return [cp, cp + 32]
    if (cp >= 0x61 && cp <= 0x7a) return [cp, cp - 32]
    return [cp]
  }
  // Above the BMP there is nothing to fold: in non-Unicode mode the pattern is
  // matched as UTF-16 code units, and no surrogate has a case mapping.
  if (cp > 0xffff) return [cp]
  foldIndex ??= buildFoldIndex()
  return foldIndex.get(cp) ?? [cp]
}
