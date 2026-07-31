/**
 * SPELLING DIFFERENTIAL — the G20 gate
 * ====================================
 *
 * G20: equivalent grammars must emit equivalent artifacts. Two spellings that
 * accept the same language, apply the same boundary policy and produce the same
 * tree should compile to nearly the same bytes. When they do not, the gap is not
 * an authoring mistake — it NAMES A NORMALISATION CODEGEN IS NOT DOING.
 *
 *   pnpm spelling:gate            # table
 *   pnpm spelling:gate --json out.json
 *   pnpm spelling:gate --pair keywords-vs-word-arms
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS A GATE AND NOT A NOISE GENERATOR
 *
 * The temptation is to diff any two constructs that LOOK similar and call a big
 * ratio a bug. That produces a report everyone learns to ignore. The worked
 * counter-example is `node()` vs `transform()`: 3,425 B vs 46 B per site, a 74x
 * ratio, and NOT a violation — `node()` genuinely does more work, it builds a
 * tree node. Similar spelling is not equivalence.
 *
 * So equivalence here is ESTABLISHED, NEVER ASSUMED, and the proof runs BEFORE
 * the bytes are compared:
 *
 *   1. Both spellings are lowered through the real macro pipeline into real
 *      artifacts — the modules that actually ship.
 *   2. Both artifacts are IMPORTED and run over the pair's own corpus, which
 *      carries accepting AND rejecting inputs.
 *   3. The trees are compared with the tree-identity oracle's own serializer
 *      (`bench/tree-identity.ts`), the same instrument used for the 8,328-pair
 *      cross-parser gate.
 *   4. ONLY IF every input agrees does the pair earn a byte ratio.
 *
 * A pair whose trees diverge is reported as DISQUALIFIED and contributes no
 * ratio. `node-vs-transform` is carried in the table PERMANENTLY as exactly such
 * a case (`equivalent: false`): the gate asserts the trees DIFFER, which is the
 * standing proof that the gate can tell "does more work" from "spelled
 * differently". If that pair ever compares equal, the harness is broken.
 *
 * ---------------------------------------------------------------------------
 * WHY MACRO-LOWERED MODULES AND NOT `compile()`
 *
 * Same reason as `bench/size/probe.ts`: `compile()` returns a live object with
 * no source text to weigh, and the thing that ships — the thing V8 parses at
 * import, the thing that made 45 MB of ESM across jess's four parsers — is the
 * macro-lowered module. Measuring anything else measures a artifact nobody runs.
 *
 * ---------------------------------------------------------------------------
 * THE BAND IS A DECISION, NOT A CONSTANT
 *
 * `BAND` below is the point at which a ratio is called a missing normalisation.
 * It is deliberately a single named value at the top of the file so the owner
 * can see it and change it. Every pair reports its ratio whether or not it
 * breaches, so moving the band re-labels the table without hiding a row.
 */
import { writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { serializeTree, firstDivergence } from './tree-identity.ts'

/**
 * Ratio at or above which a proven-equivalent pair is called a MISSING
 * NORMALISATION. Two spellings of the same thing should land within measurement
 * noise of each other; the slack here is for genuinely unavoidable differences
 * (a named rule carries an exported wrapper function that an inline const does
 * not, a keyword table's IR payload is spelled differently from an arm list).
 * Those are tens of bytes on artifacts of several kilobytes.
 */
const BAND = 1.25

/** A pair whose corpus produced fewer real trees than this is not evidence. */
const MIN_REAL_TREES = 4

const MACRO_IMPORTS = [
  'rules', 'literal', 'regex', 'sequence', 'choice', 'many', 'oneOrMore',
  'optional', 'sepBy', 'oneOrMoreSep', 'node', 'transform', 'trivia',
  'keywords', 'word',
].join(', ')

const MACRO = `import { ${MACRO_IMPORTS} } from 'parseman' with { type: 'macro' }`

/** Shared preamble: trivia, so `many()` actually spans a multi-token corpus. */
const WS = `const _ws = trivia(oneOrMore(regex(/[ \\t\\n\\r]+/)))`

export type Pair = {
  id: string
  group: string
  /** Prose statement of WHY the two spellings should compile alike — or, for a
   *  deliberate non-pair, why they should not. Printed with the ratio. */
  mechanism: string
  /** The equivalence CLAIM. `false` marks a deliberate non-pair: the gate then
   *  asserts the trees DIFFER, and no ratio is reported. */
  equivalent: boolean
  /** Human names for the two spellings, in A/B order. */
  forms: [string, string]
  a: string
  b: string
  /** Inputs. Include rejecting inputs — agreeing on what to REFUSE is half of
   *  "accepts the same language", and a boundary-policy difference shows up
   *  ONLY on a rejecting input (`red` inside `redish`). */
  corpus: string[]
}

// ---------------------------------------------------------------------------
// Pair 1 — keywords([...]) vs N word() arms
//
// `word(s)` IS `keywords([s], { boundary: '_0-9A-Za-z' })` (src/combinators/
// keywords.ts). So N word() arms under a choice and one keywords() table over
// the same N words with that same boundary are the same dispatch table: same
// language, same boundary policy, same returned string, same single CST leaf.
//
// EQUIVALENCE PRECONDITION, and it is real: `keywords()` sorts LONGEST-FIRST,
// `choice()` is ordered first-match. On a set where one word prefixes another
// the two spellings genuinely differ. WORDS below is prefix-free by
// construction and `assertPrefixFree` enforces it, so the precondition is
// checked rather than asserted in a comment.
// ---------------------------------------------------------------------------

const WORDS_30 = [
  'aqua', 'beige', 'coral', 'cyan', 'darkred', 'gold', 'green', 'grey',
  'indigo', 'ivory', 'khaki', 'lavender', 'lime', 'linen', 'magenta',
  'maroon', 'navy', 'olive', 'orange', 'orchid', 'peru', 'pink', 'plum',
  'purple', 'salmon', 'sienna', 'silver', 'tan', 'teal', 'tomato',
]

function assertPrefixFree(words: readonly string[], where: string): void {
  for (const a of words) {
    for (const b of words) {
      if (a !== b && b.startsWith(a)) {
        die(`${where}: "${a}" prefixes "${b}". keywords() matches longest-first and choice() matches in order, so these two spellings are NOT equivalent on this set. Fix the word list rather than the comparison.`)
      }
    }
  }
}

const BOUNDARY = '_0-9A-Za-z'

function keywordTable(words: readonly string[]): string {
  return `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Kw: keywords(${JSON.stringify(words)}, { boundary: '${BOUNDARY}' }),
  Doc: node('Doc', many(g.Kw), (c) => ({ t: 'Doc', c })),
}))
`
}

function wordArms(words: readonly string[]): string {
  return `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Kw: choice(${words.map(w => `word('${w}', '${BOUNDARY}')`).join(', ')}),
  Doc: node('Doc', many(g.Kw), (c) => ({ t: 'Doc', c })),
}))
`
}

/** Corpus for the keyword pairs: every word, a boundary-violating input for
 *  each (the ONLY place a boundary-policy difference is observable), and junk. */
function keywordCorpus(words: readonly string[]): string[] {
  return [
    words.join(' '),
    ...words.map(w => w),
    ...words.slice(0, 6).map(w => `${w}ish`),
    ...words.slice(0, 6).map(w => `${w}-x`),
    ...words.slice(0, 6).map(w => `${w}_1`),
    '', 'zzz', '  ', `${words[0]} ${words[0]}`, words.slice().reverse().join('\n'),
  ]
}

// ---------------------------------------------------------------------------
// Pair 2 — choice of literals vs a keyword table
//
// NOT the same as pair 1, and the difference is the point: `literal()` has NO
// boundary guard. `choice(literal('aqua'), …)` accepts the `aqua` inside
// `aquatic`; `keywords([...], { boundary })` does not. Comparing those two
// directly would be exactly the unproven comparison this file exists to
// prevent — so the keyword side of THIS pair carries NO boundary, which makes
// the two genuinely the same language.
// ---------------------------------------------------------------------------

const PUNCTISH = ['aqua', 'beige', 'coral', 'gold', 'lime', 'navy', 'plum', 'teal']

function literalChoice(words: readonly string[]): string {
  return `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Kw: choice(${words.map(w => `literal('${w}')`).join(', ')}),
  Doc: node('Doc', many(g.Kw), (c) => ({ t: 'Doc', c })),
}))
`
}

function unboundedKeywords(words: readonly string[]): string {
  return `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Kw: keywords(${JSON.stringify(words)}),
  Doc: node('Doc', many(g.Kw), (c) => ({ t: 'Doc', c })),
}))
`
}

// ---------------------------------------------------------------------------
// Pair 3 — g.X vs a by-const reference
//
// A named rule is NEVER inlined (codegen.ts, emitLazy: "A named rule (in the
// rule map) is NEVER inlined: it must stay a standalone `_r_<Name>` function so
// it's addressable and overridable by name"). A by-const combinator is a
// private single-use/multi-use ref and takes the inlining path. Same combinator
// object either way, so same language and same tree — the ONLY difference is
// which emission path codegen picks, i.e. exactly the divergence G20 is about.
//
// KNOWN ASYMMETRY IN A's DISFAVOUR: the g.X form also EXPORTS `Item` as a rule
// (one extra wrapper function, ~250 B). It is left in rather than hidden,
// because it can only shrink the measured gap, never manufacture one.
//
// Parametrised by FANOUT (how many sites reference the shared body) to make the
// base x F^depth shape visible rather than asserted.
// ---------------------------------------------------------------------------

const SHARED_BODY = `sequence(literal('('), optional(regex(/[a-z]+/)), many(choice(literal('.'), literal(','), regex(/[0-9]+/))), literal(')'))`

function refByName(fanout: number): string {
  const uses = Array.from({ length: fanout }, (_, i) =>
    `  Use${i}: sequence(literal('${'!@#$%^&*<>?~|+='[i % 16]}'), g.Item),`).join('\n')
  return `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Item: ${SHARED_BODY},
${uses}
  Doc: node('Doc', many(choice(${Array.from({ length: fanout }, (_, i) => `g.Use${i}`).join(', ')})), (c) => ({ t: 'Doc', c })),
}))
`
}

function refByConst(fanout: number): string {
  const uses = Array.from({ length: fanout }, (_, i) =>
    `  Use${i}: sequence(literal('${'!@#$%^&*<>?~|+='[i % 16]}'), _item),`).join('\n')
  return `${MACRO}
${WS}
const _item = ${SHARED_BODY}
export const g = rules({ trivia: _ws }, (g) => ({
${uses}
  Doc: node('Doc', many(choice(${Array.from({ length: fanout }, (_, i) => `g.Use${i}`).join(', ')})), (c) => ({ t: 'Doc', c })),
}))
`
}

// ---------------------------------------------------------------------------
// Pair 3b — g.X vs by-const, at DEPTH.
//
// The fanout ladder above (F = 2/4/8) holds the shared body FLAT, and it shows
// a CONSTANT ~2.6 kB gap that does not grow with F — i.e. at depth 1 a by-const
// ref is already hoisted, not pasted F times. A separate lane's sweep reports
// the by-const cost as base x F^DEPTH, so the divergence must live in NESTING,
// not in fanout, and a ladder that never nests cannot see it.
//
// Each level references the level below it TWICE, so the transitive expanded
// size doubles per level: 2^depth leaf copies if every ref is pasted, and
// linear if they are hoisted. That makes the two hypotheses produce visibly
// different curves rather than one number to be interpreted.
// ---------------------------------------------------------------------------

const NEST_LEAF = `regex(/[a-z]/)`

function nestByName(depth: number): string {
  const lines = [`  I0: ${NEST_LEAF},`]
  for (let d = 1; d <= depth; d++) {
    lines.push(`  I${d}: sequence(literal('${d}'), g.I${d - 1}, g.I${d - 1}),`)
  }
  return `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
${lines.join('\n')}
  Doc: node('Doc', many(g.I${depth}), (c) => ({ t: 'Doc', c })),
}))
`
}

function nestByConst(depth: number): string {
  const lines = [`const _i0 = ${NEST_LEAF}`]
  for (let d = 1; d <= depth; d++) {
    lines.push(`const _i${d} = sequence(literal('${d}'), _i${d - 1}, _i${d - 1})`)
  }
  return `${MACRO}
${WS}
${lines.join('\n')}
export const g = rules({ trivia: _ws }, (g) => ({
  Doc: node('Doc', many(_i${depth}), (c) => ({ t: 'Doc', c })),
}))
`
}

/** One accepting string at each depth, built the same way the grammar is. */
function nestWord(depth: number, seed: { n: number }): string {
  if (depth === 0) return String.fromCharCode(97 + (seed.n++ % 26))
  return `${depth}${nestWord(depth - 1, seed)}${nestWord(depth - 1, seed)}`
}

function nestCorpus(depth: number): string[] {
  const seed = { n: 0 }
  const one = nestWord(depth, seed)
  const two = `${nestWord(depth, seed)} ${nestWord(depth, seed)}`
  return [
    one, two, `${one} ${one} ${one}`,
    '', ' ', 'z', String(depth),
    one.slice(0, -1),          // truncated — must fail on both sides
    `${one}Z`,                 // trailing junk
    one.replace(/[a-z]/, '9'), // wrong leaf char
    `9${one.slice(1)}`,        // wrong opener
  ]
}

function refCorpus(fanout: number): string[] {
  const opens = '!@#$%^&*<>?~|+='.split('').slice(0, fanout)
  const bodies = ['()', '(a)', '(ab.,12)', '(z9)', '(,,,)', '(q.1,2.3)']
  const out: string[] = []
  for (const o of opens) for (const b of bodies) out.push(o + b)
  out.push(opens.map(o => `${o}(a.1)`).join(' '))
  out.push('', 'nope', '!(', '!)', '!(a', opens[0] ?? '!')
  return out
}

// ---------------------------------------------------------------------------
// Pair 4 — oneOrMoreSep(item, sep) vs sequence(item, many(sequence(sep, item)))
//
// The cheat sheet already names this pair. NOTE the shapes of the two RESULTS
// differ (`T[]` vs `[T, [S, T][]]`), so the raw forms are NOT equivalent — the
// hand-rolled side is wrapped in a `transform` that flattens it to the same
// array. That transform is what MAKES them equivalent, and leaving it out would
// be the unproven comparison again.
// ---------------------------------------------------------------------------

const SEP_SUGAR = `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Item: regex(/[a-z]+/),
  List: oneOrMoreSep(g.Item, literal(',')),
  Doc: node('Doc', many(g.List), (c) => ({ t: 'Doc', c })),
}))
`

const SEP_MANUAL = `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Item: regex(/[a-z]+/),
  List: transform(sequence(g.Item, many(sequence(literal(','), g.Item))), (r) => [r[0], ...r[1].map((p) => p[1])]),
  Doc: node('Doc', many(g.List), (c) => ({ t: 'Doc', c })),
}))
`

const SEP_CORPUS = [
  'a', 'a,b', 'a,b,c', 'a, b , c', 'a,b,c,d,e,f',
  'a,', ',a', 'a,,b', '', ' ', 'a b', 'a,b c,d',
  'abc,def,ghi', 'q'.repeat(1) + ',' + 'r'.repeat(3),
]

// ---------------------------------------------------------------------------
// Controls. A gate with no controls cannot distinguish a real finding from its
// own harness drifting.
// ---------------------------------------------------------------------------

/** IDENTITY CONTROL. Same text both sides. Ratio MUST be exactly 1.000; any
 *  other value means the harness itself is non-deterministic and every number
 *  below it is worthless. */
const IDENTITY = keywordTable(WORDS_30.slice(0, 8))

/** SUGAR CONTROL — `word(s)` is DEFINED as `keywords([s], { boundary })`.
 *  A ratio above 1.0 here would mean the compiler distinguishes two spellings
 *  that construct the identical combinator object. */
const SUGAR_WORD = `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Kw: word('aqua', '${BOUNDARY}'),
  Doc: node('Doc', many(g.Kw), (c) => ({ t: 'Doc', c })),
}))
`
const SUGAR_KEYWORDS = `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Kw: keywords(['aqua'], { boundary: '${BOUNDARY}' }),
  Doc: node('Doc', many(g.Kw), (c) => ({ t: 'Doc', c })),
}))
`

/** SUGAR CONTROL — `oneOrMore(x)` is `many(x, { min: 1 })`. */
const SUGAR_ONEORMORE = `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Item: regex(/[a-z]+/),
  Doc: node('Doc', oneOrMore(g.Item), (c) => ({ t: 'Doc', c })),
}))
`
const SUGAR_MANYMIN = `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Item: regex(/[a-z]+/),
  Doc: node('Doc', many(g.Item, { min: 1 }), (c) => ({ t: 'Doc', c })),
}))
`

/** LEFT-FACTOR CONTROL. parseman auto-detects a shared leading term across bare
 *  `sequence` arms. This is a normalisation the compiler ALREADY does, so it is
 *  the positive control that a ~1.0 row means "normalised", not "nothing here". */
const FACTOR_UNFACTORED = `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Kw: choice(
    sequence(literal('@'), literal('media')),
    sequence(literal('@'), literal('supports')),
    sequence(literal('@'), literal('layer')),
    sequence(literal('@'), literal('import')),
  ),
  Doc: node('Doc', many(g.Kw), (c) => ({ t: 'Doc', c })),
}))
`
const FACTOR_FACTORED = `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Kw: transform(
    sequence(literal('@'), choice(literal('media'), literal('supports'), literal('layer'), literal('import'))),
    (r) => [r[0], r[1]],
  ),
  Doc: node('Doc', many(g.Kw), (c) => ({ t: 'Doc', c })),
}))
`
const FACTOR_CORPUS = [
  '@media', '@supports', '@layer', '@import', '@media @layer @import',
  '@', '@medi', 'media', '', '@@media', '@import\n@supports',
]

/**
 * DELIBERATE NON-PAIR — the worked counter-example.
 *
 * `node()` costs ~3,425 B/site and `transform()` ~46 B/site: a 74x ratio and
 * NOT a G20 violation, because node() builds a tree node and transform() does
 * not. The gate PROVES that here rather than special-casing it in prose: the
 * two are run over the same corpus and asserted to produce DIFFERENT trees.
 * They stay in the table with `equivalent: false` and no ratio.
 */
const NONPAIR_NODE = `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Item: node('Item', regex(/[a-z]+/), (c) => ({ t: 'Item', c })),
  Doc: node('Doc', many(g.Item), (c) => ({ t: 'Doc', c })),
}))
`
const NONPAIR_TRANSFORM = `${MACRO}
${WS}
export const g = rules({ trivia: _ws }, (g) => ({
  Item: transform(regex(/[a-z]+/), (c) => ({ t: 'Item', c })),
  Doc: node('Doc', many(g.Item), (c) => ({ t: 'Doc', c })),
}))
`

export function buildPairs(): Pair[] {
  assertPrefixFree(WORDS_30, 'WORDS_30')
  assertPrefixFree(PUNCTISH, 'PUNCTISH')

  const pairs: Pair[] = []

  for (const n of [5, 12, 30] as const) {
    const words = WORDS_30.slice(0, n)
    pairs.push({
      id: `keywords-vs-word-arms-${n}`,
      group: 'keyword-table',
      equivalent: true,
      forms: [`keywords([${n} words])`, `choice of ${n} word() arms`],
      mechanism:
        'word(s) IS keywords([s], { boundary }). N arms with a shared boundary policy are ONE dispatch table; ' +
        'emitKeywordsFast already unrolls a table into one labelled block, but N separate keywords() defs each get ' +
        'their own block plus the enclosing choice\'s per-arm dispatch scaffolding.',
      a: keywordTable(words),
      b: wordArms(words),
      corpus: keywordCorpus(words),
    })
  }

  pairs.push({
    id: 'literal-choice-vs-keyword-table',
    group: 'keyword-table',
    equivalent: true,
    forms: [`choice of ${PUNCTISH.length} literal() arms`, `keywords([${PUNCTISH.length} words]) (no boundary)`],
    mechanism:
      'literal() carries no boundary guard, so the equivalent keyword table must also carry none. Both are a ' +
      'fixed-string dispatch over a disjoint first-char set; only the keyword side gets the unrolled single-block form.',
    a: literalChoice(PUNCTISH),
    b: unboundedKeywords(PUNCTISH),
    corpus: keywordCorpus(PUNCTISH),
  })

  for (const f of [2, 4, 8] as const) {
    pairs.push({
      id: `ref-by-name-vs-by-const-f${f}`,
      group: 'rule-reference',
      equivalent: true,
      forms: [`g.Item at ${f} sites`, `by-const at ${f} sites`],
      mechanism:
        'Identical combinator object; only the emission path differs. A named rule is never inlined (emitLazy) so it ' +
        'costs one _r_<Name> function plus F call sites; a by-const ref takes the inlining path and pastes its ' +
        'transitive expansion at each of the F sites. Cost is base x F, and compounds with nesting depth.',
      a: refByName(f),
      b: refByConst(f),
      corpus: refCorpus(f),
    })
  }

  for (const d of [1, 2, 3, 4, 5, 6] as const) {
    pairs.push({
      id: `ref-by-name-vs-by-const-d${d}`,
      group: 'rule-reference',
      equivalent: true,
      forms: [`g.I* nested ${d} deep`, `by-const nested ${d} deep`],
      mechanism:
        'Each level references the level below TWICE, so the TRANSITIVE expanded size doubles per level while the ' +
        'named-rule form stays linear (one _r_<Name> function per level, called twice). If the by-const side tracks ' +
        '2^depth, refs are being pasted and transitive expanded size — not arity — is the key a dedup would need.',
      a: nestByName(d),
      b: nestByConst(d),
      corpus: nestCorpus(d),
    })
  }

  pairs.push({
    id: 'oneormoresep-vs-manual',
    group: 'repetition',
    equivalent: true,
    forms: ['oneOrMoreSep(item, sep)', 'sequence(item, many(sequence(sep, item))) + flatten'],
    mechanism:
      'The named combinator is sugar for the hand-rolled shape. The flattening transform on the manual side is what ' +
      'makes the RESULT shapes equal; without it the two are not equivalent and must not be compared.',
    a: SEP_SUGAR,
    b: SEP_MANUAL,
    corpus: SEP_CORPUS,
  })

  pairs.push({
    id: 'control-identity',
    group: 'control',
    equivalent: true,
    forms: ['keyword table', 'the same text again'],
    mechanism: 'HARNESS CONTROL. Byte-identical input. A ratio other than 1.000 means the harness is non-deterministic.',
    a: IDENTITY,
    b: IDENTITY,
    corpus: keywordCorpus(WORDS_30.slice(0, 8)),
  })

  pairs.push({
    id: 'control-sugar-word',
    group: 'control',
    equivalent: true,
    forms: [`word('aqua', '${BOUNDARY}')`, `keywords(['aqua'], { boundary })`],
    mechanism: 'SUGAR CONTROL. word() constructs the identical keywords() object, so these cannot differ.',
    a: SUGAR_WORD,
    b: SUGAR_KEYWORDS,
    corpus: keywordCorpus(['aqua']),
  })

  pairs.push({
    id: 'control-sugar-oneormore',
    group: 'control',
    equivalent: true,
    forms: ['oneOrMore(item)', 'many(item, { min: 1 })'],
    mechanism: 'SUGAR CONTROL. oneOrMore() is many() with min 1.',
    a: SUGAR_ONEORMORE,
    b: SUGAR_MANYMIN,
    corpus: ['a', 'a b', '', ' ', 'abc def ghi', '1', 'a1'],
  })

  pairs.push({
    id: 'left-factor-choice-arms',
    group: 'left-factor',
    equivalent: true,
    forms: ['4 unfactored sequence arms', 'hand-factored shared prefix'],
    mechanism:
      'sharedPrefix DOES fire — the emitted code matches the shared "@" exactly once (one `charCodeAt(_pos) !== 64`) ' +
      'and every arm reads the same `_lbl0v`. The left-factoring is a MATCHING optimisation ONLY: each arm still ' +
      're-emits the shared term\'s CST leaf push, its trivia skip and its result binding, so the shared prefix costs ' +
      'bytes once per arm even though it costs runtime once per position. That per-arm re-materialisation, not a ' +
      'failure to left-factor, is the missing normalisation this row names.',
    a: FACTOR_UNFACTORED,
    b: FACTOR_FACTORED,
    corpus: FACTOR_CORPUS,
  })

  pairs.push({
    id: 'nonpair-node-vs-transform',
    group: 'non-pair',
    equivalent: false,
    forms: ['node(...)', 'transform(...)'],
    mechanism:
      'DELIBERATE NON-PAIR. node() builds a tree node; transform() maps a value. The 74x per-site byte ratio is ' +
      'WORK, not spelling, and the gate proves it by asserting the two produce DIFFERENT trees. If this pair ever ' +
      'compares tree-equal, the harness has stopped distinguishing the two and every ratio above is suspect.',
    a: NONPAIR_NODE,
    b: NONPAIR_TRANSFORM,
    corpus: ['a', 'a b c', '', 'abc', 'x y'],
  })

  return pairs
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export type SideMeasure = {
  rawBytes: number
  gzipBytes: number
  /** Bytes of the embedded re-composition IR payload. Reported separately so a
   *  ratio is never explained away as "that's just the IR" without a number. */
  irBytes: number
  codeBytes: number
}

export type PairResult = {
  id: string
  group: string
  forms: [string, string]
  mechanism: string
  equivalent: boolean
  /** Did the tree oracle CONFIRM the equivalence claim? */
  proven: boolean
  realTrees: number
  compared: number
  divergence: { input: string; path: string; a: string; b: string } | null
  a: SideMeasure | null
  b: SideMeasure | null
  /** max/min of raw bytes. Null when the pair is not a proven equivalence. */
  rawRatio: number | null
  gzipRatio: number | null
  /** Which form is the LARGER one — the one codegen should stop emitting. */
  larger: 'a' | 'b' | null
  breaches: boolean
}

function die(msg: string): never {
  console.error(`\nspelling-equivalence: ${msg}\n`)
  process.exit(1)
}

const IR_MARKER = `Symbol.for('parseman.composedPieces')`

function weigh(code: string): SideMeasure {
  const raw = Buffer.byteLength(code, 'utf8')
  const i = code.indexOf(IR_MARKER)
  const irBytes = i === -1 ? 0 : Buffer.byteLength(code.slice(i), 'utf8')
  return { rawBytes: raw, gzipBytes: gzipSync(code).length, irBytes, codeBytes: raw - irBytes }
}

type Lowerer = (src: string, file: string, pkgs: Set<string>) => { code: string } | string | null

async function loadLowerer(): Promise<Lowerer> {
  const mod = await import('../src/plugin/index.ts')
  const fn = (mod as Record<string, unknown>).transformMacro
  if (typeof fn !== 'function') die('src/plugin/index.ts exports no transformMacro')
  return fn as Lowerer
}

/**
 * Deterministic, exclusive temp dir — same reasoning as `bench/size/probe.ts`:
 * the lowered module embeds its own source path, so a random directory changes
 * the emitted CONTENT and makes gzip wobble by a byte or two. A fixed path is
 * therefore shared, so it is locked rather than trampled.
 */
function withDir<T>(id: string, fn: (dir: string) => T): T {
  const dir = path.join(tmpdir(), `pm-spelling-${id}`)
  const lock = `${dir}.lock`
  for (;;) {
    try { mkdirSync(lock, { recursive: false }); break }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const st = statSync(lock, { throwIfNoEntry: false })
      if (st !== undefined && Date.now() - st.mtimeMs > 60_000) { rmSync(lock, { recursive: true, force: true }); continue }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  try { return fn(dir) } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(lock, { recursive: true, force: true })
  }
}

/**
 * The two sides MUST be written to paths of the same length. The lowered module
 * embeds its own source path, so `a.ts` vs `candidate.ts` would put a constant
 * byte difference into every ratio in the table — small, plausible, and
 * permanently wrong. `a.ts`/`b.ts` are the same length by construction.
 */
const SIDE_FILES = { a: 'a.ts', b: 'b.ts' } as const

function lowerSide(dir: string, side: 'a' | 'b', src: string, lower: Lowerer, id: string): string {
  const file = path.join(dir, SIDE_FILES[side])
  writeFileSync(file, src)
  let out: { code: string } | string | null
  try { out = lower(src, file, new Set(['parseman'])) }
  catch (e) { die(`pair ${id} side ${side}: macro lowering THREW: ${(e as Error).message.split('\n')[0]}`) }
  if (out === null) die(`pair ${id} side ${side}: lowering returned null — the unit never entered the macro path`)
  const code = typeof out === 'string' ? out : out.code
  if (code.trim().length === 0) die(`pair ${id} side ${side}: lowering produced EMPTY output`)
  // A grammar that failed static macro evaluation falls back to the interpreter and
  // still exports normally. Its bytes are then a DIFFERENT artifact's bytes, and its
  // tree is not the compiled tree — so the whole pair would be measuring nothing.
  if (/from ['"]parseman['"]/.test(code)) {
    die(`pair ${id} side ${side}: emitted artifact still imports parseman at runtime — this is an INTERPRETER FALLBACK, not compiled output. Its bytes and its trees are both unrepresentative.`)
  }
  return code
}

type Entry = (input: string, pos: number, ctx: Record<string, unknown>) => unknown

async function entryOf(url: string, id: string, side: string): Promise<Entry> {
  const mod = (await import(url)) as Record<string, unknown>
  const g = mod.g as Record<string, unknown> | undefined
  if (g === undefined || typeof g !== 'object') die(`pair ${id} side ${side}: artifact exports no rule map 'g'`)
  const doc = (g as Record<string, unknown>).Doc
  if (typeof doc !== 'function') die(`pair ${id} side ${side}: artifact has no 'Doc' entry rule`)
  return doc as Entry
}

/** Run one input through one side, collapsing a throw into a comparable value. */
function run(entry: Entry, input: string): { threw: string | null; value: unknown } {
  try { return { threw: null, value: entry(input, 0, {}) } }
  catch (e) { return { threw: (e as Error).message, value: undefined } }
}

export async function measurePair(pair: Pair, lower: Lowerer): Promise<PairResult> {
  // BYTES come from the locked, byte-deterministic directory: the lowered module
  // embeds its own source path, so the measurement is only reproducible at a
  // fixed path. EXECUTION needs importable files that outlive that directory, so
  // the same code is written a second time to a run directory. Both sides go
  // through `lowerSide` once each here; the run copy is a file write, not a
  // second lowering, so the two cannot drift.
  const [codeA, codeB] = withDir(pair.id, dir => [
    lowerSide(dir, 'a', pair.a, lower, pair.id),
    lowerSide(dir, 'b', pair.b, lower, pair.id),
  ] as const)
  const measA = weigh(codeA)
  const measB = weigh(codeB)

  const runDir = path.join(tmpdir(), `pm-spelling-run-${pair.id}`)
  rmSync(runDir, { recursive: true, force: true })
  mkdirSync(runDir, { recursive: true })
  writeFileSync(path.join(runDir, 'package.json'), '{"type":"module"}')
  writeFileSync(path.join(runDir, 'a.mjs'), codeA)
  writeFileSync(path.join(runDir, 'b.mjs'), codeB)
  const ea = await entryOf(pathToFileURL(path.join(runDir, 'a.mjs')).href, pair.id, 'a')
  const eb = await entryOf(pathToFileURL(path.join(runDir, 'b.mjs')).href, pair.id, 'b')
  rmSync(runDir, { recursive: true, force: true })

  let realTrees = 0
  let divergence: PairResult['divergence'] = null
  for (const input of pair.corpus) {
    const ra = run(ea, input)
    const rb = run(eb, input)
    if (ra.value !== undefined || rb.value !== undefined) realTrees++
    if (ra.threw !== null || rb.threw !== null) {
      if (ra.threw !== rb.threw) {
        divergence ??= { input, path: 'throw', a: String(ra.threw), b: String(rb.threw) }
      }
      continue
    }
    if (serializeTree(ra.value) !== serializeTree(rb.value)) {
      const d = firstDivergence(ra.value, rb.value)
      divergence ??= { input, path: d?.path ?? 'root', a: d?.a ?? '?', b: d?.b ?? '?' }
    }
  }

  const treesAgree = divergence === null
  const proven = pair.equivalent ? treesAgree : !treesAgree

  if (pair.equivalent && realTrees < MIN_REAL_TREES) {
    die(`pair ${pair.id}: only ${realTrees} of ${pair.corpus.length} inputs produced a tree on either side. A pair whose corpus does not actually exercise the construct proves nothing — widen the corpus rather than lowering MIN_REAL_TREES.`)
  }

  const canRatio = pair.equivalent && proven
  const rawRatio = canRatio ? +(Math.max(measA.rawBytes, measB.rawBytes) / Math.min(measA.rawBytes, measB.rawBytes)).toFixed(3) : null
  const gzipRatio = canRatio ? +(Math.max(measA.gzipBytes, measB.gzipBytes) / Math.min(measA.gzipBytes, measB.gzipBytes)).toFixed(3) : null

  return {
    id: pair.id,
    group: pair.group,
    forms: pair.forms,
    mechanism: pair.mechanism,
    equivalent: pair.equivalent,
    proven,
    realTrees,
    compared: pair.corpus.length,
    divergence,
    a: measA,
    b: measB,
    rawRatio,
    gzipRatio,
    larger: canRatio ? (measA.rawBytes >= measB.rawBytes ? 'a' : 'b') : null,
    breaches: canRatio && rawRatio !== null && rawRatio >= BAND,
  }
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + ' '.repeat(n - s.length) }
function lpad(s: string, n: number): string { return s.length >= n ? s : ' '.repeat(n - s.length) + s }

function report(results: PairResult[]): void {
  console.log('')
  console.log('SPELLING DIFFERENTIAL — G20 (equivalent grammars must emit equivalent artifacts)')
  console.log(`band ${BAND.toFixed(2)}x  |  ratio = max/min raw bytes of the macro-lowered artifact  |  AST host mode`)
  console.log('')
  const head = `${pad('pair', 34)} ${lpad('A raw', 8)} ${lpad('B raw', 8)} ${lpad('raw x', 8)} ${lpad('gzip x', 8)}  ${pad('proof', 10)} verdict`
  console.log(head)
  console.log('-'.repeat(head.length + 12))
  for (const r of results) {
    const proof = r.equivalent
      ? (r.proven ? `trees=${r.realTrees}` : 'DISQUAL')
      : (r.proven ? 'differ ✓' : 'BROKEN')
    const verdict = !r.equivalent
      ? (r.proven ? 'non-pair (expected; no ratio)' : 'HARNESS BROKEN — non-pair compared EQUAL')
      : !r.proven
        ? 'DISQUALIFIED — trees diverge, not an equivalence'
        : r.breaches
          ? `MISSING NORMALISATION — ${r.larger === 'a' ? r.forms[0] : r.forms[1]} is the fat form`
          : 'normalised'
    console.log(
      `${pad(r.id, 34)} ${lpad(String(r.a?.rawBytes ?? '-'), 8)} ${lpad(String(r.b?.rawBytes ?? '-'), 8)} ` +
      `${lpad(r.rawRatio === null ? '-' : `${r.rawRatio.toFixed(2)}x`, 8)} ${lpad(r.gzipRatio === null ? '-' : `${r.gzipRatio.toFixed(2)}x`, 8)}  ` +
      `${pad(proof, 10)} ${verdict}`,
    )
  }
  console.log('')
  const breaches = results.filter(r => r.breaches)
  const disqual = results.filter(r => r.equivalent && !r.proven)
  const broken = results.filter(r => !r.equivalent && !r.proven)
  const identity = results.find(r => r.id === 'control-identity')

  if (identity && identity.rawRatio !== 1) {
    console.log(`HARNESS: identity control measured ${identity.rawRatio}x, not 1.000x. The harness is non-deterministic; nothing above is evidence.`)
  }

  for (const r of disqual) {
    console.log(`DISQUALIFIED  ${r.id}`)
    console.log(`  claimed equivalent, but the trees diverge on ${JSON.stringify(r.divergence?.input)} at ${r.divergence?.path}`)
    console.log(`    A: ${r.divergence?.a}`)
    console.log(`    B: ${r.divergence?.b}`)
    console.log(`  A byte comparison between non-equivalent forms is meaningless, so no ratio is reported.`)
    console.log('')
  }
  for (const r of broken) {
    console.log(`HARNESS BROKEN  ${r.id}: declared a NON-pair but the trees compared EQUAL.`)
    console.log('')
  }

  if (breaches.length === 0) {
    console.log(`No proven-equivalent pair exceeds ${BAND.toFixed(2)}x.`)
  } else {
    console.log(`${breaches.length} MISSING NORMALISATION${breaches.length === 1 ? '' : 'S'}:`)
    for (const r of breaches) {
      const big = r.larger === 'a' ? r.a! : r.b!
      const small = r.larger === 'a' ? r.b! : r.a!
      const bigForm = r.larger === 'a' ? r.forms[0] : r.forms[1]
      const smallForm = r.larger === 'a' ? r.forms[1] : r.forms[0]
      console.log('')
      console.log(`  ${r.id}   ${r.rawRatio}x raw, ${r.gzipRatio}x gzip`)
      console.log(`    fat:  ${bigForm} — ${big.rawBytes} B raw / ${big.gzipBytes} B gzip (code ${big.codeBytes} B, IR ${big.irBytes} B)`)
      console.log(`    lean: ${smallForm} — ${small.rawBytes} B raw / ${small.gzipBytes} B gzip (code ${small.codeBytes} B, IR ${small.irBytes} B)`)
      console.log(`    mechanism: ${r.mechanism}`)
    }
  }
  console.log('')
}

function argValue(flag: string): string | undefined {
  const hit = process.argv.find(a => a.startsWith(`${flag}=`))
  if (hit) return hit.slice(flag.length + 1)
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const lower = await loadLowerer()
  const only = argValue('--pair')
  const pairs = buildPairs().filter(p => only === undefined || p.id === only)
  if (pairs.length === 0) die(`--pair ${only} matched no pair`)

  const results: PairResult[] = []
  for (const p of pairs) results.push(await measurePair(p, lower))

  report(results)

  const json = argValue('--json')
  if (json !== undefined) {
    writeFileSync(json, JSON.stringify({ band: BAND, results }, null, 2))
    console.log(`wrote ${json}`)
  }

  // A harness failure and a DISQUALIFIED claim are hard errors: both mean a
  // number in this table cannot be trusted. A BREACH is a FINDING and does not
  // fail the run — the list of missing normalisations is the deliverable, and a
  // gate that exits non-zero on its own findings just gets muted.
  const fatal = results.filter(r => !r.proven)
  if (fatal.length > 0) {
    console.error(`${fatal.length} pair(s) failed their equivalence proof — see above.`)
    process.exit(1)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e: unknown) => die((e as Error).stack ?? String(e)))
}
