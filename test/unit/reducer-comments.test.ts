/**
 * A reducer ships as text in the carried IR with its comments removed. That removal
 * must leave the reducer meaning what it meant: each row runs the reducer as written
 * and as lowered, and they must agree.
 */
import { describe, expect, it } from 'vitest'
import { transformMacro, type CarriedSink } from '../../src/plugin/index.ts'
import { run } from '../../src/functional/run.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'

const lower = (reducer: string, sink: CarriedSink = new Map()): unknown => {
  const source = `import { compose, regex, rules, transform } from 'parseman' with { type: 'macro' }
export const g = compose([rules(g => ({ Doc: transform(regex(/a+/), ${reducer}) }))])
`
  const out = transformMacro(source, '/tmp/reducer-comments.ts', new Set(['parseman']), false, false, false, undefined, 0, sink)!
  const g = evalMacroModule<Record<string, unknown>>(out.code, 'g')
  return (run(g.Doc as never, 'aa')).value
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ['a string holding //', `v => "a//b" + v`],
  ['a string holding a block comment', `v => '/* x */' + v`],
  ['a template holding both', 'v => `//${v}/* y */`'],
  ['a comment in a template hole', 'v => `x${v /* c */}y`'],
  ['a nested template', 'v => `${`//${v}`}/*`'],
  ['a regex holding //', `v => /\\/\\//.test(v + '//') ? 'yes' : 'no'`],
  ['a regex class holding /*', `v => (v + '/*').replace(/[/*]+/g, '!')`],
  ['a division, then a comment', `v => 4 / 2 // c\n`],
  ['divisions that look like a regex', `v => { const a = 8, g = 2; return a /2/ g /* c */ }`],
  ['a string, then a comment', `v => "//" /* c */ + v`],
  ['an escaped quote, then a comment', `v => "\\"//" /* c */ + v`],
  ['non-ASCII before a comment', `v => { const s = 'é'; /* c */ return s + v }`],
  ['astral text before a comment', `v => { const s = '😀😀'; /* c */ return s + v }`],
  ['CJK before a line comment', `v => { const s = '日本語'; // c\n return s + v }`],
  ['non-ASCII in comments', `v => { /* é😀 */ const s = 1; /* é */ return s + v }`],
  ['a line end before a block comment, between declarations', `v => { const a = v\n/* why */ const b = a\nreturn b }`],
  ['a line end before a block comment, between calls', `v => { const o = []\no.push(1)\n/* why */ o.push(2)\nreturn o.length }`],
  ['a line end after return, before a block comment', `v => {\n  return\n  /* c */ v\n}`],
  ['a line end inside a comment after return', `v => { return /* a\n b */ v }`],
  ['a line end before a comment and ++', `v => { let x = 1\n/* c */ ++x\nreturn x }`],
  ['a line comment after return', `v => { return // c\n v }`],
  ['a line comment between statements', `v => { const a = v // c\n  const b = a; return b }`],
  ['two comments between operators', `v => 1 - /* a */ /* b */-1`],
  ['two comments after typeof', `v => typeof /* a */ /* b */v`],
  ['two comments after typeof, a local', `v => { const u = 1; return typeof /* a */ /* b */u }`],
  ['one comment between plus signs', `v => 1 + /* a */+1`],
  ['one comment with no spaces', `v => typeof/* a */v`],
  ['two comments, one with a line end', `v => { return /* a */ /* b\n c */ v }`],
  ['line comments on their own lines', `v => {\n  // one\n  // two\n  return v\n}`],
]

const written = (reducer: string): unknown => (new Function(`return (${reducer})`)() as (v: string) => unknown)('aa')

describe('removing a comment from a reducer', () => {
  it.each(CASES)('keeps its meaning: %s', (_label, reducer) => {
    expect(lower(reducer)).toEqual(written(reducer))
  })

  it.each([
    ['comment by a cast', `v => (v /* c */ as string) + 'x'`, 'aax'],
    ['comment after an arrow with generics', `<T,>(v: T): T => /* c */ v`, 'aa'],
    ['comment in a type', `(v: /* c */ string) => v`, 'aa'],
  ])('keeps its meaning in TypeScript: %s', (_label, reducer, value) => {
    expect(lower(reducer)).toBe(value)
  })

  it('leaves the shipped text the same however long the comment is', () => {
    const carried = (reducer: string): string => {
      const sink: CarriedSink = new Map()
      lower(reducer, sink)
      return JSON.stringify([...sink.values()])
    }
    for (const [, reducer] of CASES) {
      const longer = reducer.replace(/\/\* ([abc]) \*\//g, '/* $1 and some more */')
      expect(carried(longer)).toBe(carried(reducer))
    }
  })

  it('ships what deleting the comment by hand ships', () => {
    const carried = (reducer: string): string => {
      const sink: CarriedSink = new Map()
      lower(reducer, sink)
      return JSON.stringify([...sink.values()])
    }
    for (const [commented, plain] of [
      [`v => { const a = v\n/* why */ const b = a\nreturn b }`, `v => { const a = v\n const b = a\nreturn b }`],
      [`v => {\n  // one\n  return v\n}`, `v => {\n  return v\n}`],
      [`v => 1 - /* a */ /* b */-1`, `v => 1 - -1`],
      [`v => v /* c */ + 1`, `v => v + 1`],
      [`v => { const a = v // c\n  return a }`, `v => { const a = v\n  return a }`],
    ] as const) {
      expect(carried(commented)).toBe(carried(plain))
    }
  })
})
