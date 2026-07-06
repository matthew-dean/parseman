/**
 * `/i` case-fold literal/alternation with an optional trailing lookahead
 * boundary (the regex spelling of `makeWord`) — added to scanShapeFromRegex.
 *
 * Rigor: for each regex, the LOWERED `compile()` output must (a) skip
 * `RegExp.exec` and (b) agree with the interpreter (raw RegExp = ground truth)
 * on `{ok, value, end}` for a corpus of case / boundary / partial inputs.
 */
import { describe, it, expect } from 'vitest'
import { regex, parse, compile } from '../../src/index.ts'

const CASES: Array<{ re: RegExp; inputs: string[] }> = [
  { re: /not(?![-\w])/i, inputs: ['not', 'NOT', 'Not', 'note', 'not-x', 'not ', 'no', 'nots', 'not1', '', 'xnot'] },
  { re: /of(?![-\w])/i,  inputs: ['of', 'OF', 'off', 'of ', 'o', 'of-', 'of_'] },
  { re: /calc(?=\()/i,   inputs: ['calc(', 'CALC(', 'calc', 'calcx', 'calc (', 'cal', 'Calc('] },
  { re: /even|odd/i,     inputs: ['even', 'EVEN', 'odd', 'ODD', 'odds', 'eve', 'even ', 'Odd', 'x'] },
  { re: /(?:and|or)(?![-\w])/i, inputs: ['and', 'AND', 'or', 'OR', 'andx', 'and ', 'ord', 'or-', 'an', 'o'] },
  // switch-dispatch fast path: shared first chars (s→supports/scope, p→page/property).
  { re: /(?:media|container|supports|scope|page|property)(?![-\w])/i,
    inputs: ['media', 'MEDIA', 'container', 'supports', 'SUPPORTS', 'scope', 'Scope', 'page', 'property',
             'sup', 'support', 'supportsx', 'pa', 'pages', 'x', '', 'PAGE '] },
  // ordered-choice within a first-char group: `even` (len 4) tried before `eve` (len 3).
  { re: /even|eve/i, inputs: ['even', 'EVEN', 'eve', 'EVE', 'ev', 'evening', 'e'] },
]

describe('/i case-fold + trailing lookahead lowering', () => {
  for (const { re, inputs } of CASES) {
    it(`${re} lowers (no RegExp.exec)`, () => {
      expect(compile(regex(re)).source).not.toContain('.exec(input)')
    })

    it(`${re} matches the engine across inputs`, () => {
      const compiled = compile(regex(re))
      for (const input of inputs) {
        const i = parse(regex(re), input)
        const c = compiled.parse(input)
        const norm = (r: typeof i) => ({ ok: r.ok, value: r.ok ? r.value : undefined, end: r.span.end })
        expect(norm(c), `input ${JSON.stringify(input)} for ${re}`).toEqual(norm(i))
      }
    })
  }
})

// A non-ASCII letter with a Unicode case pair must NOT lower — `foldEq` only
// folds ASCII (65–122), so a lowered scan would emit an exact compare and miss
// the alternate case (`café` would silently fail to match `CAFÉ`). It must fall
// back to `RegExp.exec`, which folds Unicode correctly.
describe('/i non-ASCII case pairs decline to lower (never mis-lower)', () => {
  const NON_ASCII: Array<{ re: RegExp; inputs: string[] }> = [
    { re: /café/i,          inputs: ['café', 'CAFÉ', 'Café', 'cafe', 'caf'] },
    { re: /straße/i,        inputs: ['straße', 'STRAßE', 'Straße', 'strasse'] },
    { re: /(?:über|oder)/i, inputs: ['über', 'ÜBER', 'oder', 'ODER', 'ober'] },
  ]
  for (const { re, inputs } of NON_ASCII) {
    it(`${re} stays on RegExp.exec`, () => {
      expect(compile(regex(re)).source).toContain('.exec(input)')
    })
    it(`${re} matches the engine (case variants included)`, () => {
      const compiled = compile(regex(re))
      for (const input of inputs) {
        const i = parse(regex(re), input)
        const c = compiled.parse(input)
        const norm = (r: typeof i) => ({ ok: r.ok, value: r.ok ? r.value : undefined, end: r.span.end })
        expect(norm(c), `input ${JSON.stringify(input)} for ${re}`).toEqual(norm(i))
      }
    })
  }
})
