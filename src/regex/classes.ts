/**
 * Low-level regex char-class primitives, shared by every hand-rolled regex
 * analysis in the codebase — the interpreter's first-set walker
 * (`./first-set.ts`), `regex()`'s short-scan fast path, and codegen's scannable
 * lowering (`../compiler/scannable-run.ts`). Kept dependency-free (no combinator,
 * no codegen imports) so it lands in even the leanest interpreter bundle.
 *
 * Everything here parses a regex STRUCTURE to code-point ranges; nothing encodes
 * a specific byte meaning ("this is whitespace"). `\d`/`\w` lower to their ASCII
 * ranges (correct for the default, non-`u` engine); `\s` uses the fixed
 * `SPACE_RANGES` set (unaffected by the `u` flag).
 */

/** Single-char escapes whose code point is fixed regardless of context. */
export const CLASS_ESCAPES: Record<string, number> = { t: 9, n: 10, r: 13, f: 12, v: 11, '0': 0 }

/**
 * `\s`'s code-point set per the spec's `WhiteSpace` + `LineTerminator`
 * productions — TAB/LF/VT/FF/CR, SPACE, NBSP, and the Unicode `Zs` space
 * separators. Fixed regardless of the `u` flag, so always safe to lower.
 */
export const SPACE_RANGES: Array<[number, number]> = [
  [9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202],
  [8232, 8232], [8233, 8233], [8239, 8239], [8287, 8287], [12288, 12288], [65279, 65279],
]

/**
 * ASCII code-point ranges for the shorthand classes we lower. `\d`/`\w` are
 * ASCII-only in the default (non-`u`) engine; `\s` maps to `SPACE_RANGES`.
 */
export function shorthandRanges(ch: 'd' | 'w' | 's'): Array<[number, number]> {
  if (ch === 'd') return [[48, 57]]
  if (ch === 's') return SPACE_RANGES
  return [[48, 57], [65, 90], [95, 95], [97, 122]]
}

/** `\uXXXX` at `body[i]` → its code point and the index past it, or null. */
export function readUnicodeEscape(body: string, i: number): { cp: number; next: number } | null {
  if (body[i] !== '\\' || body[i + 1] !== 'u') return null
  const hex = body.slice(i + 2, i + 6)
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null
  return { cp: Number.parseInt(hex, 16), next: i + 6 }
}

type ClassAtom = { cp: number } | { set: Array<[number, number]> }

/**
 * Parse a regex char-class body (the chars BETWEEN `[` and `]`, negation `^`
 * already stripped by the caller) to code-point ranges. `\d`/`\w`/`\s` expand to
 * their ranges; `\uXXXX` and the fixed single-char escapes resolve to their code
 * point; any other letter escape (`\D`, `\W`, `\S`, `\b`, …) returns null rather
 * than being mis-read as a literal letter, so callers fall back to a safe
 * over-approximation instead of a wrong set.
 */
export function parseClassRanges(body: string): Array<[number, number]> | null {
  const ranges: Array<[number, number]> = []
  let i = 0
  const readAtom = (): ClassAtom | null => {
    const ch = body[i]
    if (ch === undefined) return null
    if (ch === '\\') {
      const uni = readUnicodeEscape(body, i)
      if (uni) {
        i = uni.next
        return { cp: uni.cp }
      }
      const e = body[i + 1]
      if (e === undefined) return null
      i += 2
      if (e in CLASS_ESCAPES) return { cp: CLASS_ESCAPES[e]! }
      if (e === 'd' || e === 'w' || e === 's') return { set: shorthandRanges(e) }
      // Any other letter escape is a class we can't safely lower (\D, \W, \S, …).
      if ((e >= 'a' && e <= 'z') || (e >= 'A' && e <= 'Z')) return null
      return { cp: e.codePointAt(0)! }
    }
    i += ch.length
    return { cp: ch.codePointAt(0)! }
  }
  while (i < body.length) {
    const lo = readAtom()
    if (lo === null) return null
    if ('set' in lo) {
      ranges.push(...lo.set)
      continue
    }
    if (body[i] === '-' && body[i + 1] !== undefined && body[i + 1] !== ']') {
      i += 1
      const hi = readAtom()
      if (hi === null || 'set' in hi) return null
      ranges.push([lo.cp, hi.cp])
    } else {
      ranges.push([lo.cp, lo.cp])
    }
  }
  return ranges.length ? ranges : null
}
