/**
 * THE REGEX FIRST SET, PROVED GENERATIVELY: no character outside it can start a match.
 *
 * A `regex()` terminal's first set gates choice dispatch, optional terms and
 * trivia skips in every engine. Those gates read the input's leading CODE POINT
 * (`lead()`). Under `u`/`v` the set holds code points. Outside Unicode mode it
 * holds code units, and an astral lead is read through its high surrogate
 * (`rangesHaveLead`).
 *
 * The property: if the regex matches at least one character at position 0 of
 * some input, that input's lead is in the first set, read as above. A NULLABLE
 * regex must report `any`.
 *
 * Patterns are generated from a seeded grammar covering the syntax the analyzer
 * reads:
 * - escapes: control, octal, code point, escaped surrogate pair, property,
 *   shorthand, backreference;
 * - flat and negated classes;
 * - `v`-mode nested classes, set operations and `\q{}`;
 * - astral literals;
 * - groups, lookarounds, alternation, and quantifiers including `{0}`.
 * Each pattern runs under each flag set from `i`/`u`/`v`/`s`/`m` that compiles.
 *
 * Every generated pattern also gets a WITNESS, a string it is built to match: one
 * branch of each alternation, nothing for a lookaround or an anchor, and for each
 * atom the first candidate the atom matches alone under those flags. A probe is a
 * code point followed by the witness's remainder, or by a few fixed suffixes.
 * Probes are tried on both sides of the set:
 * - a match from a probe outside the set is a failure;
 * - a match from a probe inside it counts toward the floor, so a run that cannot
 *   reach a match does not pass.
 * The code points probed:
 * - every code unit below U+0400;
 * - both neighbours of every range boundary in the set;
 * - every surrogate boundary;
 * - astral samples;
 * - the witness's own lead;
 * - seeded random draws.
 *
 * The same property is then checked over COMPOSITIONS: small trees of
 * `sequence`, `choice`, `optional`, `peek`, `not` and `literal` over generated
 * regex atoms, at every node of the tree. Each tree has an equivalent `RegExp`:
 * `(?=…)` for `peek`, `(?!…)` for `not`, alternation for `choice`. It backtracks
 * where the combinators commit, so it accepts at least the leads they accept.
 * A probe the `RegExp` matches with a lead outside the node's first set is a
 * failure. So is one the interpreter itself accepts there.
 *
 * A failure names the seed, the pattern, the flags and the character.
 * `pnpm check:differentials` plants first-set defects and requires this file to
 * go red.
 */
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { regex } from '../../src/combinators/regex.ts'
import { choice, literal, not, optional, peek, sequence } from '../../src/index.ts'
import { run } from '../../src/functional/run.ts'
import type { Combinator, FirstSet } from '../../src/types.ts'

const SEED = Number(process.env.FIRST_SET_SEED ?? 0x51ed)
const PATTERNS = Number(process.env.FIRST_SET_PATTERNS ?? 400)

function lcg(seed: number): () => number {
  let x = seed >>> 0
  return () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 0x100000000
}

const ATOMS = [
  'a', 'z', 'A', '0', '_', '-', '.', '/', '#', ' ', 'é', 'É', 'σ', 'ſ', 'K', '😀', '𝒳',
  '\\d', '\\w', '\\s', '\\D', '\\W', '\\S', '\\.', '\\/', '\\n', '\\t', '\\0', '\\012', '\\cJ', '\\cz', '\\c1',
  '\\x41', '\\u00e9', '\\u{1F600}', '\\u{20}', '\\uD83D', '\\uDE00', '\\uD83D\\uDE00', '\\p{L}', '\\P{L}', '\\p{White_Space}', '\\k<n>', '\\1',
  '[a-z]', '[^a-z]', '[0-9_]', '[\\d.]', '[ \\t]', '[^\\n]', '[é-ÿ]', '[😀]', '[\\uD83D\\uDE00]', '[\\u0080-\\uffff]', '[\\012]', '[\\cJ]',
  '[[^a]]', '[[a-c]--b]', '[a[^b]]', '[[^a]&&[a-z]]', '[\\q{ab|c}]', '[\\p{L}--[a-z]]',
]
const QUANTS = ['', '', '', '?', '*', '+', '{0}', '{2}', '{1,3}', '{0,}']
const FLAG_SETS = ['', 'i', 'u', 'v', 's', 'm', 'iu', 'iv', 'is', 'us', 'vs', 'ium']
const SUFFIXES = ['', 'a', ' ', '\n', '😀']

/** What an atom may match alone: the first of these it matches is its witness. */
const CANDIDATES = [
  'a', 'z', 'A', 'K', '0', '_', '-', '.', '/', '#', ' ', '\t', '\n', '\0', '\x01', '\x1a', 'é', 'É', 'σ', 'ſ', 'ÿ',
  '😀', '𝒳', '\uD83D', '\uDE00', '\u212a', 'b', 'c', 'ab', 'q', 'u', 'u'.repeat(32), '\\c', '\\c1',
  'p{L}', 'P{L}', 'p{White_Space}', 'k<n>', '[', ']', '[]', 'a]', 'a--b]', '[&&a]',
]
// Outside Unicode mode a quantifier after a multi-character atom (`\c1{2}`,
// `k<n>{0}`) binds its last character, so each candidate is also tried with that
// character repeated or dropped.
const QUANTIFIED = CANDIDATES.flatMap(c => [c, c + c.slice(-1), c + c, c.slice(0, -1)])

type Pattern = { readonly source: string; readonly witness: (flags: string, named: boolean) => string }

const repeatFor = (q: string): number => q === '{0}' ? 0 : q === '{2}' ? 2 : 1

/** The first candidate `atom` followed by `q` matches whole under `flags`. */
const atomWitness = (atom: string, q: string, flags: string, named: boolean): string => {
  // A backreference to a group that has matched nothing yet matches empty.
  if (named && (atom === '\\k<n>' || atom === '\\1')) return ''
  let re: RegExp
  try { re = new RegExp(`(?:${atom}${q})`, `${flags}y`) } catch { return '' }
  const whole = (c: string): boolean => { re.lastIndex = 0; return re.exec(c)?.[0] === c }
  return QUANTIFIED.find(c => c !== '' && whole(c)) ?? ''
}

function generate(rand: () => number): Pattern {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  const seq = (depth: number): Pattern => {
    const parts: Pattern[] = []
    const n = 1 + Math.floor(rand() * 3)
    for (let i = 0; i < n; i++) parts.push(atom(depth))
    return { source: parts.map(p => p.source).join(''), witness: (f, named) => parts.map(p => p.witness(f, named)).join('') }
  }
  const atom = (depth: number): Pattern => {
    const r = rand()
    if (depth < 2 && r < 0.12) {
      const a = seq(depth + 1), b = seq(depth + 1), q = pick(QUANTS), arm = rand() < 0.5 ? a : b
      return { source: `(?:${a.source}|${b.source})${q}`, witness: (f, named) => arm.witness(f, named).repeat(repeatFor(q)) }
    }
    if (depth < 2 && r < 0.18) {
      const inner = seq(depth + 1)
      return { source: `(?<n>${inner.source})`, witness: inner.witness }
    }
    if (depth < 2 && r < 0.24) {
      const inner = seq(depth + 1)
      return { source: `${pick(['(?=', '(?!', '(?<=', '(?<!'])}${inner.source})`, witness: () => '' }
    }
    if (r < 0.27) return { source: pick(['\\b', '\\B']), witness: () => '' }
    const a = pick(ATOMS), q = pick(QUANTS)
    return { source: a + q, witness: (f, named) => atomWitness(a, q, f, named) }
  }
  // `^` and `$` stand where they can match: an anchor mid-pattern mostly makes
  // a pattern no input satisfies, which no probe can test.
  const body = seq(0)
  const head = rand() < 0.1 ? '^' : '', tail = rand() < 0.1 ? '$' : ''
  return { source: head + body.source + tail, witness: body.witness }
}

/** The engines' lead test, stated independently: a `u`/`v` set holds code
 * points; outside Unicode mode an astral lead reads through its high surrogate. */
const inSet = (fs: FirstSet, cp: number, unicode: boolean): boolean => {
  if (fs.kind === 'any') return true
  if (fs.kind !== 'ranges') return false
  const has = (c: number): boolean => fs.ranges.some(r => c >= r.lo && c <= r.hi)
  return has(cp) || (!unicode && cp > 0xffff && has(0xd800 + ((cp - 0x10000) >> 10)))
}

/** The code points worth trying for one first set. */
function probes(fs: FirstSet, witnessLead: number | undefined, rand: () => number): number[] {
  const out = new Set<number>()
  for (let c = 0; c < 0x400; c++) out.add(c)
  for (const c of [0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xfeff, 0xffff, 0x10000, 0x1f600, 0x1d4b3, 0x10ffff]) out.add(c)
  if (fs.kind === 'ranges') {
    for (const r of fs.ranges) for (const c of [r.lo - 1, r.lo, r.hi, r.hi + 1]) if (c >= 0 && c <= 0x10ffff) out.add(c)
  }
  if (witnessLead !== undefined) out.add(witnessLead)
  for (let k = 0; k < 64; k++) out.add(Math.floor(rand() * 0x110000))
  return [...out]
}

/** Can `re` match at least one character at position 0 of an input led by `cp`? */
function startsWith(re: RegExp, cp: number, suffixes: readonly string[]): boolean {
  for (const suffix of suffixes) {
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
    let blind = 0
    let matched = 0
    const blindCases: string[] = []
    for (let n = 0; n < PATTERNS; n++) {
      const pattern = generate(rand)
      const source = pattern.source
      const named = source.includes('(?<n>')
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
        const unicode = flags.includes('u') || flags.includes('v')
        const witness = pattern.witness(flags, named)
        const witnessLead = witness.codePointAt(0)
        const rest = witnessLead === undefined ? '' : witness.slice(witnessLead > 0xffff ? 2 : 1)
        const suffixes = [rest, ...SUFFIXES]
        let hits = 0
        for (const cp of probes(fs, witnessLead, rand)) {
          if (!startsWith(re, cp, suffixes)) continue
          if (inSet(fs, cp, unicode)) { hits++; continue }
          failures.push(`seed ${SEED}: /${source}/${flags} can start with U+${cp.toString(16).toUpperCase()}, outside its first set`)
          break
        }
        matched += hits
        if (hits === 0) { blind++; blindCases.push(`/${source}/${flags} witness ${JSON.stringify(witness)}`) }
        if (failures.length >= 10) break
      }
      if (failures.length >= 10) break
    }
    // FIRST_SET_REPORT names a file to write the run's coverage and blind cases to.
    const report = process.env.FIRST_SET_REPORT
    if (report) writeFileSync(report, `seed ${SEED}: ${bounded} bounded, ${blind} blind (${(100 * blind / bounded).toFixed(1)}%), ${matched} matching probes\n${blindCases.join('\n')}\n`)
    expect(failures).toEqual([])
    expect(checked, 'patterns compiled under some flag set').toBeGreaterThan(PATTERNS)
    // A run in which every set widened to `any`, or no probe could match, would prove nothing.
    expect(bounded, 'pattern/flag pairs with a bounded first set').toBeGreaterThan(checked / 4)
    expect(blind, 'bounded pairs no probe matched').toBeLessThan(bounded / 8)
    expect(matched, 'probes inside a bounded set that matched').toBeGreaterThan(bounded * 2)
  }, 300_000)
})

type Tree = { readonly p: Combinator<unknown>; readonly source: string; readonly witness: (flags: string) => string; readonly kids: readonly Tree[] }

const TREE_FLAGS = ['', 'u', 'v', 's', 'm', 'us']
const LITERALS = ['a', 'b', 'é', 'K', 'ab', ' ', '-', '_', '😀', '😁', '𝒳']
const TREES = Number(process.env.FIRST_SET_TREES ?? 400)

/** A tree over generated regex atoms; `flags` is shared, since the tree's `RegExp` has one set. */
function tree(rand: () => number, flags: string, depth: number): Tree {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  const r = rand()
  const sub = (): Tree => tree(rand, flags, depth + 1)
  if (depth < 3 && r < 0.2) {
    const kids = [sub(), sub(), ...(rand() < 0.4 ? [sub()] : [])]
    const [first, ...rest] = kids.map(k => k.p)
    return { p: sequence(first!, ...rest), source: kids.map(k => k.source).join(''), witness: f => kids.map(k => k.witness(f)).join(''), kids }
  }
  if (depth < 3 && r < 0.35) {
    const kids = [sub(), sub()], arm = rand() < 0.5 ? 0 : 1
    return { p: choice(kids[0]!.p, kids[1]!.p), source: `(?:${kids[0]!.source}|${kids[1]!.source})`, witness: f => kids[arm]!.witness(f), kids }
  }
  if (depth < 3 && r < 0.42) {
    const k = sub()
    return { p: optional(k.p), source: `(?:${k.source})?`, witness: k.witness, kids: [k] }
  }
  if (depth < 3 && r < 0.55) {
    // A lookahead guards the term after it, so it stands in a sequence. Mostly it
    // looks for that term's lead, so the node can match at all: as the term itself,
    // as a literal (a code point) or as a regex (code units without `u`).
    const next = sub(), lead = next.witness(flags).codePointAt(0), q = rand()
    const k: Tree = q < 0.25 || lead === undefined ? next
      : q < 0.5 ? { p: literal(String.fromCodePoint(lead)), source: String.fromCodePoint(lead), witness: () => String.fromCodePoint(lead), kids: [] }
      : q < 0.75 ? { p: regex(String.fromCodePoint(lead).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'), flags), source: `(?:${String.fromCodePoint(lead).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')})`, witness: () => String.fromCodePoint(lead), kids: [] }
      : sub()
    return { p: sequence(peek(k.p), next.p), source: `(?=${k.source})${next.source}`, witness: next.witness, kids: [k, next] }
  }
  if (depth < 3 && r < 0.62) {
    const k = sub(), next = sub()
    return { p: sequence(not(k.p), next.p), source: `(?!${k.source})${next.source}`, witness: next.witness, kids: [k, next] }
  }
  if (r < 0.75) {
    const lit = pick(LITERALS)
    return { p: literal(lit), source: lit, witness: () => lit, kids: [] }
  }
  // Group names and backreferences cannot be repeated inside one `RegExp`.
  const usable = (source: string): boolean => {
    // An anchor at an atom's edge mostly makes the tree unsatisfiable mid-sequence.
    if (/\(\?<n>|\\k<n>|\\1/.test(source) || source.startsWith('^') || source.endsWith('$')) return false
    try { new RegExp(source, flags); return true } catch { return false }
  }
  let atom = generate(rand)
  while (!usable(atom.source)) atom = generate(rand)
  const source = atom.source
  return { p: regex(source, flags), source: `(?:${source})`, witness: f => atom.witness(f, false), kids: [] }
}

describe('composed first sets: no character outside the first set of a node starts a match (seed ' + SEED + ')', () => {
  it('holds at every node of generated combinator trees', () => {
    const rand = lcg(SEED ^ 0x7ee5)
    const failures: string[] = []
    let nodes = 0
    let bounded = 0
    let blind = 0
    let matched = 0
    const blindCases: string[] = []
    const check = (t: Tree, flags: string): void => {
      for (const k of t.kids) check(k, flags)
      let re: RegExp
      try { re = new RegExp(t.source, `${flags}y`) } catch { return }
      nodes++
      const fs = t.p._meta.firstSet
      if (fs.kind === 'any') return
      bounded++
      const witness = t.witness(flags)
      const witnessLead = witness.codePointAt(0)
      const rest = witnessLead === undefined ? '' : witness.slice(witnessLead > 0xffff ? 2 : 1)
      const suffixes = [rest, ...SUFFIXES]
      let hits = 0
      for (const cp of probes(fs, witnessLead, rand)) {
        const inside = inSet(fs, cp, false)
        if (startsWith(re, cp, suffixes)) {
          if (inside) { hits++; continue }
          failures.push(`seed ${SEED}: ${t.source} (/${flags}) can start with U+${cp.toString(16).toUpperCase()}, outside its first set`)
          return
        }
        if (inside) continue
        // The interpreter must not accept where the first set says nothing starts.
        for (const suffix of suffixes) {
          const res = run(t.p, String.fromCodePoint(cp) + suffix)
          if (res.ok && res.span.end > 0) {
            failures.push(`seed ${SEED}: ${t.source} (/${flags}) is accepted by the interpreter at U+${cp.toString(16).toUpperCase()}, outside its first set`)
            return
          }
        }
      }
      matched += hits
      if (hits === 0) { blind++; blindCases.push(`${t.source} (/${flags}) witness ${JSON.stringify(witness)}`) }
    }
    for (let n = 0; n < TREES && failures.length < 10; n++) {
      const flags = TREE_FLAGS[Math.floor(rand() * TREE_FLAGS.length)]!
      check(tree(rand, flags, 0), flags)
    }
    const report = process.env.FIRST_SET_REPORT
    if (report) writeFileSync(`${report}.trees`, `seed ${SEED}: ${nodes} nodes, ${bounded} bounded, ${blind} blind (${(100 * blind / bounded).toFixed(1)}%), ${matched} matching probes\n${blindCases.join('\n')}\n`)
    expect(failures).toEqual([])
    expect(bounded, 'tree nodes with a bounded first set').toBeGreaterThan(nodes / 4)
    expect(blind, 'bounded nodes no probe matched').toBeLessThan(bounded / 8)
    expect(matched, 'probes inside a bounded set that matched').toBeGreaterThan(bounded * 2)
  }, 300_000)
})
