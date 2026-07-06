/**
 * Escape-aware ident run (§8k): the css/less/scss/jess `ident`/`basicSel`/
 * `propName` regexes, whose every position is a class char OR a CSS escape
 * (`\` + 1–6 hex + optional ws, or `\` + one non-newline char).
 *
 * RIGOR: the lowered `compile()` output must (a) skip `RegExp.exec` and (b) agree
 * with the interpreter (raw RegExp = ground truth) on `{ok, value, end}` across a
 * corpus stressing escapes, boundaries, greedy hex, and non-BMP.
 */
import { describe, it, expect } from 'vitest'
import { regex, parse, compile } from '../../src/index.ts'

const IDENT = /-?(?:[_a-zA-Z-￿]|\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n]))(?:[-_a-zA-Z0-9-￿]|\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n]))*/
const BASICSEL = /(?:[.#]?-?(?:[_a-zA-Z-￿]|\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n]))(?:[-_a-zA-Z0-9-￿]|\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n]))*|\d+(?:\.\d+)?%|\*)/
const PROPNAME = /\*?-?(?:[_a-zA-Z-￿]|\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n]))(?:[-_a-zA-Z0-9-￿]|\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n]))*/

const INPUTS = [
  '', 'foo', 'Foo', 'FOO', '_x', '-x', '-', 'a1', 'foo-bar', 'foo bar', 'foo{', 'foo;',
  '3px', '123', 'a-1-b',
  // escapes: hex (1–6) + optional ws, greedy hex, non-hex escape, escaped backslash/dot
  'a\\41 b', '\\26 B', '\\41', '\\417', '\\4142434445 46', 'x\\g', 'a\\.b', 'a\\\\b',
  'end\\', '\\', 'a\\\nb', '\\\n', 'foo\\41', '\\41foo', 'a\\41b',
  // selector/prop prefixes
  '.foo', '#bar', '.foo\\.bar', '.a-b', '*', '50%', '12.5%', '.', '#',
  '*color', '*-x',
  // non-BMP tail/head
  'fooé', 'éx', 'café-au',
]

const norm = (r: ReturnType<typeof parse>) => ({ ok: r.ok, value: r.ok ? r.value : undefined, end: r.span.end })

describe('escape-aware ident run lowering', () => {
  for (const [name, re] of [['ident', IDENT], ['basicSel', BASICSEL], ['propName', PROPNAME]] as const) {
    it(`${name}: lowers (no RegExp.exec)`, () => {
      expect(compile(regex(re)).source).not.toContain('.exec(input)')
    })
    it(`${name}: matches the engine across escape/boundary/non-BMP inputs`, () => {
      const compiled = compile(regex(re))
      for (const input of INPUTS) {
        expect(norm(compiled.parse(input)), `${name} :: ${JSON.stringify(input)}`)
          .toEqual(norm(parse(regex(re), input)))
      }
    })
  }
})
