import { describe, it, expect } from 'vitest'
import {
  choice,
  compile,
  field,
  literal,
  node,
  parse,
  regex,
  run,
  sequence,
} from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'

describe('field()', () => {
  const ident = regex(/[a-z]+/)
  const attrOp = regex(/[*~|^$]?=/)
  const attr = node('Attr',
    sequence(
      literal('['),
      field('name', ident),
      field('op', attrOp),
      field('value', ident),
      literal(']'),
    ),
    (_children, fields) => fields
  )

  it('passes named captures with spans to node builders', () => {
    const r = parse(attr, '[href=link]')
    expect(r.ok && r.value).toEqual({
      name: { value: 'href', span: { start: 1, end: 5 } },
      op: { value: '=', span: { start: 5, end: 6 } },
      value: { value: 'link', span: { start: 6, end: 10 } },
    })
  })

  it('compiled output matches interpreter output', () => {
    expect(compile(attr).parse('[href=link]')).toEqual(parse(attr, '[href=link]'))
  })

  it('rolls back fields from failed choice arms', () => {
    const p = node('Doc',
      choice(
        sequence(field('bad', literal('a')), literal('x')),
        sequence(field('good', literal('a')), literal('b')),
      ),
      (_children, fields) => fields
    )
    const r = parse(p, 'ab')
    expect(r.ok && r.value).toEqual({
      good: { value: 'a', span: { start: 0, end: 1 } },
    })
  })

  it('does not emit field plumbing when a node subtree has no fields', () => {
    const p = node('Plain', sequence(literal('a'), literal('b')), children => children.length)
    expect(compile(p).source).not.toContain('_fields')
  })

  it('macro-compiles field() and preserves field capture', () => {
    const code = `
import { field, literal, node, regex, sequence } from 'parseman' with { type: 'macro' }
export const Attr = node('Attr', sequence(literal('['), field('name', regex(/[a-z]+/)), literal(']')), (_children, fields) => fields)
`.trim()
    const result = transformMacro(code, 'field-macro.ts', new Set(['parseman']))
    expect(result?.code).not.toContain("from 'parseman'")
    expect(result?.code).toContain('_fields')
  })

  it('structural ctx.build can read fields without trivia/state capture', () => {
    const Doc = node('Doc', sequence(literal('['), field('name', ident), literal(']')))
    const compiled = compile(Doc)
    const host = (_type: string, _children: readonly unknown[], fields: unknown) => fields

    const interpreted = run(Doc, '[href]', { build: host })
    expect(interpreted.ok && interpreted.value).toEqual({
      name: { value: 'href', span: { start: 1, end: 5 } },
    })
    const compiledResult = compiled.parseWithContext('[href]', { trackLines: false, build: host }, 0)
    expect(compiledResult.ok && compiledResult.value).toEqual({
      name: { value: 'href', span: { start: 1, end: 5 } },
    })
    expect(compiled.source).toContain('_hostReads(_ctx.build, 2)')
    expect(compiled.source).toContain('_hostReads(_ctx.build, 5)')
  })
})
