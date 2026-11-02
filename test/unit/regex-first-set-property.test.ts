/**
 * THE REGEX FIRST SET, PROVED GENERATIVELY: no character outside it can start a match.
 *
 * A `regex()` terminal's first set gates choice dispatch, optional terms and
 * trivia skips in every engine. Those gates read the input's leading CODE POINT
 * (`lead()`), so the property is stated over code points.
 *
 * The property: if the regex matches at least one character at position 0 of
 * some input, that input's leading code point is in the first set. A NULLABLE
 * regex must report `any`.
 *
 * Patterns are generated from a seeded grammar covering the syntax the analyzer
 * reads: escapes (control, octal, code point, property, shorthand, backreference),
 * flat and negated classes, `v`-mode nested classes, set operations and `\q{}`,
 * astral literals, groups, lookarounds, alternation, and quantifiers including
 * `{0}`. Each pattern runs under each flag set from `i`/`u`/`v`/`s`/`m` that
 * compiles.
 *
 * For each code point outside the computed set, a sticky `RegExp` is tried on
 * that character followed by each of a few suffixes, and must not match. The
 * code points tried:
 * - every code unit below U+0400;
 * - both neighbours of every range boundary in the set;
 * - every surrogate boundary;
 * - astral samples;
 * - seeded random draws.
 *
 * A failure names the seed, the pattern, the flags and the character.
 * `pnpm check:differentials` plants a `v`-class misreading and requires this
 * file to go red.
 */
import { describe, expect, it } from 'vitest'
import { regex } from '../../src/combinators/regex.ts'
import type { FirstSet } from '../../src/types.ts'

const SEED = Number(process.env.FIRST_SET_SEED ?? 0x51ed)
const PATTERNS = Number(process.env.FIRST_SET_PATTERNS ?? 400)

function lcg(seed: number): () => number {
  let x = seed >>> 0
  return () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 0x100000000
}

const ATOMS = [
  'a', 'z', 'A', '0', '_', '-', '.', '/', '#', ' ', 'é', 'É', 'σ', 'ſ', 'K', '😀', '𝒳',
  '\\d', '\\w', '\\s', '\\D', '\\W', '\\S', '\\.', '\\/', '\\n', '\\t', '\\0', '\\012', '\\cJ', '\\cz', '\\c1',
  '\\x41', '\\u00e9', '\\u{1F600}', '\\u{20}', '\\uD83D', '\\uDE00', '\\p{L}', '\\P{L}', '\\p{White_Space}', '\\k<n>', '\\1',
  '[a-z]', '[^a-z]', '[0-9_]', '[\\d.]', '[ \\t]', '[^\\n]', '[é-ÿ]', '[😀]', '[\\u0080-\\uffff]', '[\\012]', '[\\cJ]',
  '[[^a]]', '[[a-c]--b]', '[a[^b]]', '[[^a]&&[a-z]]', '[\\q{ab|c}]', '[\\p{L}--[a-z]]',
]
const QUANTS = ['', '', '', '?', '*', '+', '{0}', '{2}', '{1,3}', '{0,}']
const FLAG_SETS = ['', 'i', 'u', 'v', 's', 'm', 'iu', 'iv', 'is', 'us', 'vs', 'ium']
const SUFFIXES = ['', 'a', ' ', '\n', '😀']

function generate(rand: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  const seq = (depth: number): string => {
    let out = ''
    const n = 1 + Math.floor(rand() * 3)
    for (let i = 0; i < n; i++) out += atom(depth)
    return out
  }
  const atom = (depth: number): string => {
    const r = rand()
    if (depth < 2 && r < 0.12) return `(?:${seq(depth + 1)}|${seq(depth + 1)})${pick(QUANTS)}`
    if (depth < 2 && r < 0.18) return `(?<n>${seq(depth + 1)})`
    if (depth < 2 && r < 0.24) return `${pick(['(?=', '(?!', '(?<=', '(?<!'])}${seq(depth + 1)})`
    if (r < 0.27) return pick(['^', '$', '\\b', '\\B'])
    return pick(ATOMS) + pick(QUANTS)
  }
  return seq(0)
}

const inSet = (fs: FirstSet, cp: number): boolean =>
  fs.kind === 'any' || (fs.kind === 'ranges' && fs.ranges.some(r => cp >= r.lo && cp <= r.hi))

/** The code points worth trying for one first set. */
function probes(fs: FirstSet, rand: () => number): number[] {
  const out = new Set<number>()
  for (let c = 0; c < 0x400; c++) out.add(c)
  for (const c of [0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xfeff, 0xffff, 0x10000, 0x1f600, 0x1d4b3, 0x10ffff]) out.add(c)
  if (fs.kind === 'ranges') {
    for (const r of fs.ranges) for (const c of [r.lo - 1, r.lo, r.hi, r.hi + 1]) if (c >= 0 && c <= 0x10ffff) out.add(c)
  }
  for (let k = 0; k < 64; k++) out.add(Math.floor(rand() * 0x110000))
  return [...out]
}

/** Can `re` match at least one character at position 0 of an input led by `cp`? */
function startsWith(re: RegExp, cp: number): boolean {
  for (const suffix of SUFFIXES) {
    re.lastIndex = 0
    const m = re.exec(String.fromCodePoint(cp) + suffix)
    if (m !== null && m[0].length > 0) return true
  }
  return false
}

describe('regex first sets: no character outside the set starts a match (seed ' + SEED + ')', () => {
  it('holds for generated patterns under every flag set', () => {
    const rand = lcg(SEED)
    const failures: string[] = []
    let checked = 0
    let bounded = 0
    let probed = 0
    for (let n = 0; n < PATTERNS; n++) {
      const source = generate(rand)
      for (const flags of FLAG_SETS) {
        let re: RegExp
        try { re = new RegExp(source, `${flags}y`) } catch { continue }
        const fs = regex(source, flags)._meta.firstSet
        checked++
        re.lastIndex = 0
        const empty = re.exec('') !== null
        if (empty && fs.kind !== 'any') { failures.push(`seed ${SEED}: /${source}/${flags} matches empty but reports a bounded set`); continue }
        if (fs.kind === 'any') continue
        bounded++
        for (const cp of probes(fs, rand)) {
          if (inSet(fs, cp)) continue
          probed++
          if (!startsWith(re, cp)) continue
          failures.push(`seed ${SEED}: /${source}/${flags} can start with U+${cp.toString(16).toUpperCase()}, outside its first set`)
          break
        }
        if (failures.length >= 10) break
      }
      if (failures.length >= 10) break
    }
    expect(failures).toEqual([])
    expect(checked, 'patterns compiled under some flag set').toBeGreaterThan(PATTERNS)
    // A run in which every set widened to `any` would prove nothing.
    expect(bounded, 'pattern/flag pairs with a bounded first set').toBeGreaterThan(checked / 4)
    expect(probed, 'characters tried outside a bounded set').toBeGreaterThan(bounded * 1000)
  }, 300_000)
})
