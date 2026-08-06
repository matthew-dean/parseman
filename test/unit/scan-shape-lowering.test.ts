/**
 * SHAPE LOWERING — recognition, and the emitted scan against the regex it replaces.
 *
 * `emit-assembly.ts` replaces an `OP_RX` row's `RegExp.exec` with straight-line
 * `charCodeAt` source whenever `scanShapeFromRegex` recognises the pattern. Two
 * things can go wrong and they need separate gates:
 *
 *   - it stops RECOGNISING a shape it used to lower — silent, costs only speed,
 *     and no end-to-end test would ever notice. Pinned by `kind` below.
 *   - it recognises a shape and matches it WRONGLY — silent on any input the
 *     grammar happens not to drive the row to. Pinned by walking EVERY position
 *     of a corpus and comparing to the sticky `exec` the row would have run.
 *
 * The broad version of the second gate — every regex constant of every workload
 * grammar over its own 50–65 KB corpus — is `bench/scan-shape-oracle.ts`. This
 * file is its CI-sized twin, plus the recognition pins.
 */
import { describe, it, expect } from 'vitest'
import { emitShapeMatch, scanShapeFromRegex, SPACE_RANGES, parseScanShape } from '../../src/table/scan-shapes.ts'

/** Compile a shape's emitted match: `end` on a match, −1 on none. */
function probeOf(source: string, flags: string): ((input: string, pos: number) => number) | null {
  const shape = scanShapeFromRegex(source, flags)
  if (shape === null) return null
  let n = 0
  const m = emitShapeMatch(shape, 'pos', (prefix = '_v') => `${prefix}${n++}`, '  ')
  const body = [...m.setup, `  return (${m.ok}) ? (${m.end}) : -1`].join('\n')
  return new Function('input', 'pos', body) as (input: string, pos: number) => number
}

/** The emitted scan and the sticky regex must agree at EVERY position. */
function agreesEverywhere(source: string, flags: string, corpus: string): void {
  const probe = probeOf(source, flags)
  expect(probe, `/${source}/${flags} must lower`).not.toBeNull()
  const re = new RegExp(source, flags.includes('y') ? flags : `${flags}y`)
  for (let pos = 0; pos <= corpus.length; pos++) {
    re.lastIndex = pos
    const m = re.exec(corpus)
    const want = m === null ? -1 : pos + m[0].length
    expect(probe!(corpus, pos), `/${source}/${flags} at ${pos} in ${JSON.stringify(corpus.slice(pos, pos + 16))}`).toBe(want)
  }
}

describe('scanShapeFromRegex — recognition', () => {
  it('records the quantifier of a char run', () => {
    expect(parseScanShape('[0-9]+')).toEqual({ kind: 'chars', ranges: [[48, 57]], minOne: true })
    expect(parseScanShape('[0-9]*')).toEqual({ kind: 'chars', ranges: [[48, 57]], minOne: false })
  })

  it('expands the shorthand classes rather than reading them as letters', () => {
    expect(parseScanShape('\\d+')).toEqual({ kind: 'chars', ranges: [[48, 57]], minOne: true })
    expect(parseScanShape('\\s+')).toEqual({ kind: 'chars', ranges: SPACE_RANGES, minOne: true })
    // `[\d.]+` is digits or dot — NOT the letter `d`.
    expect(parseScanShape('[\\d.]+')).toEqual({ kind: 'chars', ranges: [[48, 57], [46, 46]], minOne: true })
  })

  it('names each of the shapes the emitter lowers', () => {
    const kindOf = (s: string, f = ''): string | null => scanShapeFromRegex(s, f)?.kind ?? null
    expect(kindOf('[0-9]+')).toBe('chars')
    expect(kindOf('//[^\\n\\r]*')).toBe('until')
    expect(kindOf('/\\*(?:[^*]|\\*(?!/))*\\*/')).toBe('delimited')
    expect(kindOf('"(?:[^"\\\\]|\\\\.)*"')).toBe('string')
    expect(kindOf('-?[_a-zA-Z][-_a-zA-Z0-9]*')).toBe('seq')
    expect(kindOf('url\\(', 'i')).toBe('litFold')
    expect(kindOf('#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])')).toBe('lookahead')
    expect(kindOf('and|or|not')).toBe('alt')
  })

  it('declines a flag that changes what matching means', () => {
    // `u` makes the scan a CODE POINT walk; this emitter walks code UNITS.
    expect(scanShapeFromRegex('[0-9]+', 'u')).toBeNull()
    expect(scanShapeFromRegex('[0-9]+', 'm')).toBeNull()
    expect(scanShapeFromRegex('[0-9]+', 's')).toBeNull()
    // `y`/`g` are stickiness only, and the row is sticky by construction.
    expect(scanShapeFromRegex('[0-9]+', 'y')).not.toBeNull()
  })

  /**
   * Both of these LOWERED, wrongly, until jess's four shipping grammars began to
   * emit and the oracle was pointed at them. Neither pattern occurs in the four
   * workload grammars, so nothing in this repo could have caught them; they are
   * pinned here because the jess oracle needs a checkout CI does not have.
   */
  it('declines a lookahead over an OPTIONAL trailing literal', () => {
    // `::?(?![ \t\n\r\f])` on `":: "` matches ONE colon — the engine gives the
    // second one back and the lookahead then sees `:`. A greedy scan that
    // resolves `::` once reports no match at all.
    expect(scanShapeFromRegex('::?(?![ \\t\\n\\r\\f])', '')).toBeNull()
    // The same shape without the lookahead has nothing to reconsider and stays.
    expect(scanShapeFromRegex('::?', '')?.kind).toBe('seq')
  })

  it('declines a lookahead whose body is a SEQUENCE, not one class', () => {
    // `[ \t\n\r\f]*[\$(]` opens with `[` and closes with `]` without being one
    // class. Read as one, its members become everything in between — whitespace
    // included — and `\+(?=…)` matched a `+` before a space.
    expect(scanShapeFromRegex('\\+(?=[ \\t\\n\\r\\f]*[\\$(])', '')).toBeNull()
    // A genuine single-class operand still lowers.
    expect(scanShapeFromRegex('\\+(?=[\\$(])', '')?.kind).toBe('lookahead')
  })

  it('declines rather than mis-lowering an ambiguous greedy chain', () => {
    // A group whose body ends in an unbounded run, followed by the same class:
    // greedy scanning and the backtracker disagree on where the group ends.
    expect(parseScanShape('(?:\\d+)\\d')).toBeNull()
    // A non-disjoint alt genuinely needs arm switching when something follows.
    expect(parseScanShape('(?:a|ab)c')).toBeNull()
  })
})

describe('scanShapeFromRegex — the emitted scan is the regex, position for position', () => {
  const CORPUS = [
    '.hero, #main > a[href^="/x"] { color: #a0f; margin: -1.5em 0 .25em; }',
    '@media (min-width:640px){ --gap: 4px; content: "a\\"b"; }',
    "@import url(\"x.css\"); /* c */ // line\n\t p::before { }",
    'a{b:c}--x-1:0;u+0025-00FF; 1e10 -.5 12.5% and or not GET POST',
    '"", \'\', ``, "\\n", "unterminated, /*, */, [^], (?:), |, {2,4}',
    'éĀ ￿  progid:DX.Alpha e+3 E-7 0x n+1 2n-1 even odd',
    // Every printable ASCII code point, and the code units either side of the
    // ranges these patterns are written over. A hand-written corpus exercises
    // the MIDDLE of a class; a range is got wrong at its EDGE.
    Array.from({ length: 0x60 }, (_, i) => String.fromCharCode(0x20 + i)).join(''),
    Array.from({ length: 0x60 }, (_, i) => String.fromCharCode(0x20 + i)).join(' '),
    // Doubled, so a `+`/`*` run has a second character to take or leave.
    Array.from({ length: 0x60 }, (_, i) => String.fromCharCode(0x20 + i).repeat(2)).join(''),
    // The edges of the `\u0080-\uffff` tail these grammars are written over, as
    // ESCAPES: a raw 0x7f in a tracked file makes it binary to git and to grep.
    '~\u007f\u0080\u00ff\u0100\ufffe\uffff',
  ].join('\n')

  const PATTERNS: Array<[string, string]> = [
    // chars / ident / seq
    ['[0-9]+', ''],
    ['[0-9]*', ''],
    ['\\s+', ''],
    ['\\w*', ''],
    ['-?[_a-zA-Z\\u0080-\\uffff][-_a-zA-Z0-9\\u0080-\\uffff]*', ''],
    ['@-?[_a-zA-Z\\u0080-\\uffff][-_a-zA-Z0-9\\u0080-\\uffff]*', ''],
    ['--[-_a-zA-Z0-9\\u0080-\\uffff]*', ''],
    ['::?', ''],
    ['[*~|^$]?=', ''],
    ['[^)"\'\\s]+', ''],
    ['[+-]?(?:\\d*\\.\\d+(?:[eE][+-]?\\d+)?|\\d+(?:[eE][+-]?\\d+)?|\\d+)', ''],
    ['-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?', ''],
    ['[uU]\\+[0-9a-fA-F?]{1,6}(?:-[0-9a-fA-F]{1,6})?', ''],
    // until / delimited / string
    ['//[^\\n\\r]*', ''],
    ['/\\*(?:[^*]|\\*(?!/))*\\*/', ''],
    ['"(?:[^"\\\\]|\\\\.)*"', ''],
    ["'(?:[^'\\\\]|\\\\.)*'", ''],
    ['`(?:[^`\\\\]|\\\\.)*`', ''],
    // lookahead / alt / litFold
    ['#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])', ''],
    ['[-+](?=[.\\d@(])', ''],
    ['and|or|not', ''],
    ['>>>|\\|\\||[>+~]', ''],
    ['[<>]=?|=<|=', ''],
    ['-?[_a-zA-Z\\u0080-\\uffff][-_a-zA-Z0-9\\u0080-\\uffff]*|%', ''],
    ['url\\(', 'i'],
    ['media|container|supports', 'i'],
  ]

  for (const [source, flags] of PATTERNS) {
    it(`/${source}/${flags}`, () => {
      agreesEverywhere(source, flags, CORPUS)
    })
  }
})
