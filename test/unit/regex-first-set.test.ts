/**
 * The hand-rolled regex first-set analyzer (`src/regex/first-set.ts`) replaced
 * the old `regexp-tree`-backed one, dropping ~264 KB from every interpreter
 * bundle. A regex terminal's first-set only drives `choice()` dispatch fast
 * paths — never whether a match succeeds — so the analyzer must be SOUND as an
 * OVER-approximation: every char the pattern can actually start with must be in
 * the returned set, and a NULLABLE pattern (matches empty) must widen to `any`
 * (an empty-matching `choice` arm can succeed at any position, so a narrow set
 * would let dispatch wrongly skip it).
 *
 * The soundness fuzz uses the real `RegExp` engine as the ground-truth oracle
 * (a better oracle than `regexp-tree`, which is itself only a structural
 * approximation): it probes each pattern's true first chars empirically and
 * asserts `mine ⊇ true`. This is what lets us ship the analyzer with no
 * `regexp-tree` dependency at all.
 */
import { describe, it, expect } from 'vitest'
import { firstSetFromRegex } from '../../src/regex/first-set.ts'
import type { FirstSet } from '../../src/types.ts'

function covers(fs: FirstSet, code: number): boolean {
  if (fs.kind === 'any') return true
  if (fs.kind === 'empty') return false
  return fs.ranges.some(r => code >= r.lo && code <= r.hi)
}

function toSet(fs: FirstSet, cap = 0x2ff): Set<number> | 'any' {
  if (fs.kind === 'any') return 'any'
  const s = new Set<number>()
  if (fs.kind === 'empty') return s
  for (const r of fs.ranges) for (let c = Math.max(0, r.lo); c <= Math.min(cap, r.hi); c++) s.add(c)
  return s
}

// Empirical ground-truth via the real engine: a char c is a possible first char
// iff SOME string starting with c has a non-empty anchored match. We probe c
// alone and c + representative fillers — a SUBSET of the true first-set, so
// "mine ⊇ empirical" is a valid necessary soundness condition. `nullable` is
// whether the engine matches the empty string.
const FILLERS = ['', 'a', 'A', '0', '9', '_', '-', '.', '+', '"', "'", '\\', '/', '*', ' ', '\t', '\n',
  'aaaa', '0000', 'abc', '123', '1.5', '1e3', '"x"', '/**/', '//x', '#fff', 'px', 'true', 'xyz', 'ff']
function empirical(src: string): { set: Set<number>; nullable: boolean } | null {
  let re: RegExp
  try { re = new RegExp('^(?:' + src + ')') } catch { return null }
  let nullable = false
  try { const m = re.exec(''); nullable = !!m && m[0] === '' } catch { /* ignore */ }
  const set = new Set<number>()
  for (let c = 0; c <= 0x2ff; c++) {
    const ch = String.fromCharCode(c)
    for (const f of FILLERS) {
      const m = re.exec(ch + f)
      if (m && m[0].length >= 1 && m[0].charCodeAt(0) === c) { set.add(c); break }
    }
  }
  return { set, nullable }
}

describe('regex first-set — targeted behavior', () => {
  it('gives precise first chars for a non-nullable pattern', () => {
    const { firstSet } = firstSetFromRegex('\\d+')
    expect(firstSet.kind).toBe('ranges')
    expect(covers(firstSet, '0'.charCodeAt(0))).toBe(true)
    expect(covers(firstSet, '9'.charCodeAt(0))).toBe(true)
    expect(covers(firstSet, 'a'.charCodeAt(0))).toBe(false)
  })

  it('handles a leading optional prefix (nullable term) then a required term', () => {
    // -?[0-9]  — first char can be '-' OR a digit.
    const { firstSet } = firstSetFromRegex('-?[0-9]')
    expect(covers(firstSet, '-'.charCodeAt(0))).toBe(true)
    expect(covers(firstSet, '5'.charCodeAt(0))).toBe(true)
    expect(covers(firstSet, 'a'.charCodeAt(0))).toBe(false)
  })

  it('resolves the JSON number token to { - , 0-9 }', () => {
    const { firstSet } = firstSetFromRegex('-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?')
    expect(covers(firstSet, '-'.charCodeAt(0))).toBe(true)
    expect(covers(firstSet, '0'.charCodeAt(0))).toBe(true)
    expect(covers(firstSet, '"'.charCodeAt(0))).toBe(false)
  })

  it('resolves the JSON string token to just the opening quote', () => {
    const { firstSet } = firstSetFromRegex('"(?:[^\\\\"]|\\\\(?:[bfnrtv"\\\\/]|u[0-9a-fA-F]{4}))*"')
    expect(covers(firstSet, '"'.charCodeAt(0))).toBe(true)
    expect(covers(firstSet, 'a'.charCodeAt(0))).toBe(false)
  })

  it('widens a NULLABLE pattern to any', () => {
    expect(firstSetFromRegex('[ \\t\\n\\r]*').firstSet.kind).toBe('any')
    expect(firstSetFromRegex('a?').firstSet.kind).toBe('any')
    expect(firstSetFromRegex('(?:ab)*').firstSet.kind).toBe('any')
  })

  it('widens genuinely unknowable constructs (negated class, backreference) sensibly', () => {
    // `[^x]` — starts with (almost) anything → any.
    expect(firstSetFromRegex('[^x]').firstSet.kind).toBe('any')
    // `\D` — negated shorthand → any.
    expect(firstSetFromRegex('\\D').firstSet.kind).toBe('any')
  })

  it('degrades an unparseable pattern to any rather than throwing', () => {
    expect(firstSetFromRegex('(unbalanced').firstSet.kind).toBe('any')
    expect(firstSetFromRegex('[z-a').firstSet.kind).toBe('any')
  })

  it('tracks whether the first char can be a newline', () => {
    expect(firstSetFromRegex('\\n').canMatchNewline).toBe(true)
    expect(firstSetFromRegex('[\\n]').canMatchNewline).toBe(true)
    expect(firstSetFromRegex('a').canMatchNewline).toBe(false)
    expect(firstSetFromRegex('\\d').canMatchNewline).toBe(false)
  })
})

describe('regex first-set — soundness vs the RegExp engine (fuzz)', () => {
  const curated = [
    '"(?:[^\\\\"]|\\\\(?:[bfnrtv"\\\\/]|u[0-9a-fA-F]{4}))*"',
    '-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?',
    '[ \\t\\n\\r]*', '-?[a-zA-Z_][a-zA-Z0-9_-]*', '--[a-zA-Z0-9_-]+', '@-?[a-zA-Z]+',
    '\\/\\*[^*]*\\*+(?:[^/*][^*]*\\*+)*\\/', '\\/\\/[^\\n]*', '#[0-9a-fA-F]{3,8}',
    '[0-9]+(\\.[0-9]+)?(px|em|rem|%)?', '\\s+', '\\d+', '\\w+', '\\S+', '\\D', '\\W',
    '[^"\\\\]+', '[^\\]]', '[a-z]|[A-Z]|[0-9]', 'abc', 'a?bc', '(foo|bar)baz', '(?:x|y)+',
    'a{2,4}b', '\\.', '\\/', '.', '^abc$', 'a\\1b', '\\bword\\b',
    '(?=[abc])x', '(?![0-9])[a-z]', 'foo(?<name>[0-9]+)', '[\\d.]+', '[-+]?\\d',
    'true', 'false', 'null', '\\u00e9', '\\x41', '[\\u0041-\\u005a]', 'p{2}',
    'a*', 'a*b', '(a|b)?c', '[a-z]*[0-9]', 'x?y?z', '(ab)+', '[^\\n]+',
  ]

  // Deterministic LCG — no Math.random (keeps failures reproducible).
  let seed = 0x2545f
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const pick = <A>(a: A[]): A => a[Math.floor(rand() * a.length)]!
  const atoms = ['a', 'b', 'z', '0', '9', '_', '-', '.', '/', '#', '@', '\\d', '\\w', '\\s', '\\.', '\\/',
    '[a-z]', '[A-Z]', '[0-9]', '[a-z0-9_]', '[^"]', '[^\\n]', '[ \\t]', '.', '\\n', '\\t']
  const quants = ['', '', '', '?', '*', '+', '{2}', '{1,3}']
  function genAtom(depth: number): string {
    if (depth < 2 && rand() < 0.25) {
      const n = 1 + Math.floor(rand() * 3)
      const arms: string[] = []
      for (let i = 0; i < n; i++) arms.push(genSeq(depth + 1))
      return '(?:' + arms.join('|') + ')' + pick(quants)
    }
    return pick(atoms) + pick(quants)
  }
  function genSeq(depth: number): string {
    const n = 1 + Math.floor(rand() * 4)
    let s = ''
    for (let i = 0; i < n; i++) s += genAtom(depth)
    return s
  }

  const patterns = [...curated]
  for (let i = 0; i < 2000; i++) patterns.push(genSeq(0))

  it('never under-approximates a pattern\'s true first-set (mine ⊇ engine)', () => {
    const unsound: string[] = []
    const nullableViolations: string[] = []
    let checked = 0
    for (const src of patterns) {
      const emp = empirical(src)
      if (!emp) continue
      const mine = firstSetFromRegex(src)
      const set = toSet(mine.firstSet)
      checked++
      if (set !== 'any') {
        const missing = [...emp.set].filter(c => !set.has(c))
        if (missing.length) unsound.push(`${JSON.stringify(src)} missing ${JSON.stringify(missing.slice(0, 8))}`)
        if (emp.nullable) nullableViolations.push(JSON.stringify(src))
      }
    }
    expect(checked).toBeGreaterThan(1000)
    expect(unsound).toEqual([])
    expect(nullableViolations).toEqual([])
  })
})
