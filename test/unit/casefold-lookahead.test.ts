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
