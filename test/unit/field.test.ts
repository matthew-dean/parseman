import { describe, it, expect } from 'vitest'
import {
  choice,
  compile,
  field,
  leaf,
  literal,
  many,
  node,
  parse,
  parser,
  regex,
  rules,
  run,
  sequence,
} from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { parserEnablesTriviaCapture } from '../../src/compiler/fields.ts'

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

  it('captures a recursive static tail span only after its closing terminator', () => {
    const grammar = rules(g => {
      const atom = regex(/[a-z]/)
      return {
        Tail: sequence(literal('('), many(choice(atom, g.Tail)), literal(')')),
      }
    })
    const Import = node(
      'Import',
      sequence(literal('@import'), field('tail', grammar.Tail), literal(';')),
      (_children, fields) => fields,
    )

    expect(parse(Import, '@import(foo(bar));')).toMatchObject({
      ok: true,
      value: { tail: { value: ['(', ['f', 'o', 'o', ['(', ['b', 'a', 'r'], ')']], ')'], span: { start: 7, end: 17 } } },
    })
    // `field()` pushes after Tail succeeds, before the outer `;`; the enclosing
    // node rolls that capture back if a later term fails.
    expect(parse(Import, '@import(foo(bar);').ok).toBe(false)
    expect(parse(Import, '@import(foo(bar;));').ok).toBe(false)
    expect(parse(Import, '@import(foo(bar]);').ok).toBe(false)
    expect(parse(Import, '@import(foo(bar)));').ok).toBe(false)
  })

  it('macro-compiles recursive static-tail field capture without runtime fallback', () => {
    const code = `
import { choice, field, literal, many, node, regex, rules, sequence } from 'parseman' with { type: 'macro' }
const { Tail } = rules(g => {
  const atom = regex(/[a-z]/)
  return { Tail: sequence(literal('('), many(choice(atom, g.Tail)), literal(')')) }
})
const Import = node('Import', sequence(literal('@import'), field('tail', Tail), literal(';')), (_children, fields) => fields)
`.trim()
    const result = transformMacro(code, 'recursive-static-tail.ts', new Set(['parseman']))
    expect(result?.code).not.toMatch(/\bparseman\b/)
    expect(result?.code).not.toMatch(/\.parse(?:[A-Z]\w*)?\s*\(/)
    expect(result?.code).toContain('_fields')

    const Import = new Function(result!.code.replace(/\bconst\b/g, 'var') + '\nreturn Import')() as {
      (input: string, pos: number, ctx: { trackLines: boolean }): { ok: boolean; value?: unknown }
    }
    expect(Import('@import(foo(bar));', 0, { trackLines: false })).toMatchObject({
      ok: true,
      value: { tail: { span: { start: 7, end: 17 } } },
    })
    expect(Import('@import(foo(bar);', 0, { trackLines: false }).ok).toBe(false)
    expect(Import('@import(foo(bar;));', 0, { trackLines: false }).ok).toBe(false)
    expect(Import('@import(foo(bar]);', 0, { trackLines: false }).ok).toBe(false)
    expect(Import('@import(foo(bar)));', 0, { trackLines: false }).ok).toBe(false)
  })

  it('structural ctx.build can read fields without trivia/state capture', () => {
    const Doc = node('Doc', sequence(literal('['), field('name', ident), literal(']')))
    const compiled = compile(Doc)
    const host = (_type: string, _children: readonly unknown[] | undefined, fields: unknown) => fields

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

  it('does not allocate an outer trivia collector for a capture hidden by leaf()', () => {
    const ws = regex(/[ ]+/)
    const hidden = leaf(parser({ trivia: ws, captureTrivia: true }, sequence(literal('a'), literal('b'))), value => value)
    const visible = parser({ trivia: ws, captureTrivia: true }, sequence(literal('a'), literal('b')))
    expect(parserEnablesTriviaCapture(hidden)).toBe(false)
    expect(parserEnablesTriviaCapture(visible)).toBe(true)
  })
})
