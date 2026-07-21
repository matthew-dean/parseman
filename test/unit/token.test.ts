import { beforeAll, describe, it, expect } from 'vitest'
import {
  choice, compile, leaf, literal, many, node, noTrivia, oneOrMore, optional, parse, parser, regex, sequence, token, trivia,
  sepBy, transform,
} from '../../src/index.ts'
import type { CSTLeaf, ParseContext } from '../../src/index.ts'

type CstNode = {
  _tag: 'node'
  type: string
  span: { start: number; end: number }
  children: unknown[]
}

const mkNode = (type: string) =>
  (children: readonly unknown[], _fields: unknown, span: { start: number; end: number }, _raw: readonly unknown[]): CstNode =>
    ({ _tag: 'node', type, span, children: [...children] })

const ws = trivia(regex(/[ \t\n]+/))
const important = token(sequence(literal('!'), regex(/important/i)))
const decl = parser(
  { trivia: ws },
  node('Decl', sequence(literal('color'), literal(':'), optional(important)), mkNode('Decl')),
)
const compiled = compile(decl)
const specialToken = token(sequence(literal('$.*['), regex(/[0-9]+/), literal(']^')))
const specialCompiled = compile(specialToken)
const specialRunToken = token(many(sequence(literal('$.*['), regex(/[0-9]+/), literal(']^'))))
const specialRunCompiled = compile(specialRunToken)
const optionalToken = token(optional(sequence(literal('$.*['), regex(/[0-9]+/), literal(']^'))))
const optionalCompiled = compile(optionalToken)
const sepToken = token(sepBy(regex(/[a-z]+/), literal('|.$|')))
const sepCompiled = compile(sepToken)
const fallbackToken = token(optional(regex(/a/g)))
const fallbackCompiled = compile(fallbackToken)
const throwingToken = token(transform(literal('a'), () => { throw new Error('boom') }))
const throwingCompiled = compile(throwingToken)
const nestedTriviaToken = token(sequence(literal('a'), parser({ trivia: ws }, sequence(literal('['), literal(']')))))
const nestedTriviaCompiled = compile(nestedTriviaToken)
const commentGap = oneOrMore(choice(
  regex(/[ \t\n]+/),
  sequence(literal('//'), many(regex(/[^\n]/)), optional(literal('\n'))),
))
const mathOperator = leaf(
  noTrivia(sequence(optional(commentGap), choice(literal('*'), literal('/'), literal('%')), optional(commentGap))),
  (parts) => parts[1] as string,
)
const mathExpression = parser(
  { trivia: ws },
  node('Math', noTrivia(sequence(literal('a'), mathOperator, literal('b'))), mkNode('Math')),
)
const mathExpressionCompiled = compile(mathExpression)
const gluedLeaf = parser({ trivia: ws }, noTrivia(sequence(literal('a'), leaf(sequence(literal('['), literal(']')), () => '[]'), literal('b'))))
const gluedLeafCompiled = compile(gluedLeaf)
type ParseFn = (input: string, pos: number, ctx: object) =>
  { ok: boolean; value?: unknown; span: { start: number; end: number } }
let macroFn: ParseFn

const MACRO_CODE = `
import { literal, node, optional, parser, regex, sequence, token, trivia } from 'parseman' with { type: 'macro' }
const ws = trivia(regex(/[ \\t\\n]+/))
const important = token(sequence(literal('!'), regex(/important/i)))
const decl = parser(
  { trivia: ws },
  node('Decl', sequence(literal('color'), literal(':'), optional(important)), (children, _fields, span, _raw) => ({ _tag: 'node', type: 'Decl', span, children: [...children] })),
)
`.trim()

beforeAll(async () => {
  const { transformMacro } = await import('../../src/plugin/index.ts')
  const result = transformMacro(MACRO_CODE, 'token-test.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null')
  if (result.code.includes("from 'parseman'")) throw new Error('macro transform did not remove import')
  const fnBody = result.code.replace(/\bconst\b/g, 'var') + '\nreturn decl'
  macroFn = new Function(fnBody)() as ParseFn
})

function leafValues(value: unknown): string[] {
  return (value as CstNode).children
    .filter((child): child is CSTLeaf => (child as CSTLeaf)._tag === 'leaf')
    .map(child => child.value)
}

describe('token()', () => {
  it('returns source text and captures one CST leaf instead of internal leaves', () => {
    const interp = parse(decl, 'color: !important')
    const comp = compiled.parse('color: !important', 0)
    const macro = macroFn('color: !important', 0, {})

    expect(interp.ok).toBe(true)
    expect(comp.ok).toBe(true)
    expect(macro.ok).toBe(true)
    if (!interp.ok || !comp.ok || !macro.ok) return

    expect(leafValues(interp.value)).toEqual(['color', ':', '!important'])
    expect(comp.value).toEqual(interp.value)
    expect(macro.value).toEqual(interp.value)
  })

  it('clears internal trivia so the token body must be contiguous', () => {
    const interp = parse(decl, 'color: ! important')
    const comp = compiled.parse('color: ! important', 0)
    const macro = macroFn('color: ! important', 0, {})

    expect(interp.ok).toBe(true)
    expect(comp.ok).toBe(true)
    expect(macro.ok).toBe(true)
    if (!interp.ok || !comp.ok || !macro.ok) return

    expect(leafValues(interp.value)).toEqual(['color', ':'])
    expect(comp.value).toEqual(interp.value)
    expect(macro.value).toEqual(interp.value)
  })

  it('matches regex-special literal text exactly across interpreter and compile()', () => {
    const input = '$.*[42]^'
    const interp = parse(specialToken, input)
    const comp = specialCompiled.parse(input, 0)

    expect(interp.ok).toBe(true)
    expect(comp.ok).toBe(true)
    if (!interp.ok || !comp.ok) return

    expect(interp.value).toBe(input)
    expect(comp.value).toBe(input)
    expect(parse(specialToken, '$xx[42]^').ok).toBe(false)
    expect(specialCompiled.parse('$xx[42]^', 0).ok).toBe(false)
  })

  it('lowers token(many(sequence(terminals))) to one escaped regex in compiled output', () => {
    const input = '$.*[1]^$.*[22]^'
    const interp = parse(specialRunToken, input)
    const comp = specialRunCompiled.parse(input, 0)

    expect(interp.ok).toBe(true)
    expect(comp.ok).toBe(true)
    if (!interp.ok || !comp.ok) return

    expect(comp.value).toBe(input)
    expect(comp.value).toBe(interp.value)
    expect(specialRunCompiled.source).toContain(String.raw`\$\.\*\[`)
    expect(specialRunCompiled.source).toContain('[0-9]+')
    expect(specialRunCompiled.source).toContain(String.raw`\]\^`)
  })

  it('lowers token(optional(sequence(terminals))) without changing empty fallback', () => {
    const input = '$.*[42]^'
    const interp = parse(optionalToken, input)
    const comp = optionalCompiled.parse(input, 0)

    expect(interp.ok).toBe(true)
    expect(comp.ok).toBe(true)
    if (!interp.ok || !comp.ok) return

    expect(comp.value).toBe(input)
    expect(comp.value).toBe(interp.value)
    expect(parse(optionalToken, '$.*[]^')).toMatchObject({ ok: true, span: { start: 0, end: 0 } })
    expect(optionalCompiled.parse('$.*[]^', 0)).toMatchObject({ ok: true, span: { start: 0, end: 0 } })
    expect(optionalCompiled.source).toContain(String.raw`\$\.\*\[`)
  })

  it('lowers token(sepBy(terminals, separator)) and preserves trailing separator rollback', () => {
    const input = 'alpha|.$|beta|.$|gamma'
    const interp = parse(sepToken, input)
    const comp = sepCompiled.parse(input, 0)

    expect(interp.ok).toBe(true)
    expect(comp.ok).toBe(true)
    if (!interp.ok || !comp.ok) return

    expect(comp.value).toBe(input)
    expect(comp.value).toBe(interp.value)
    expect(parse(sepToken, 'alpha|.$|')).toMatchObject({ ok: true, value: 'alpha', span: { start: 0, end: 5 } })
    expect(sepCompiled.parse('alpha|.$|', 0)).toMatchObject({ ok: true, value: 'alpha', span: { start: 0, end: 5 } })
    expect(sepCompiled.source).toContain(String.raw`\|\.\$\|`)
  })

  it('falls back to compiled inner parsing when token body is not regex-collapsible', () => {
    expect(parse(fallbackToken, 'a')).toMatchObject({ ok: true, value: 'a', span: { start: 0, end: 1 } })
    expect(fallbackCompiled.parse('a', 0)).toMatchObject({ ok: true, value: 'a', span: { start: 0, end: 1 } })
    expect(parse(fallbackToken, 'b')).toMatchObject({ ok: true, value: '', span: { start: 0, end: 0 } })
    expect(fallbackCompiled.parse('b', 0)).toMatchObject({ ok: true, value: '', span: { start: 0, end: 0 } })
  })

  it('restores context when the token body throws', () => {
    for (const run of [
      (ctx: ParseContext) => throwingToken.parse('a', 0, ctx),
      (ctx: ParseContext) => throwingCompiled.parseWithContext('a', ctx, 0),
    ]) {
      const cstChildren: unknown[] = []
      const cstLeaves: unknown[] = []
      const rawChildren: unknown[] = []
      const cstTriviaLog: number[] = []
      const triviaLog: number[] = []
      const ctx: ParseContext = {
        trackLines: false,
        trivia: ws,
        _cstChildren: cstChildren,
        _cstLeaves: cstLeaves,
        _cstRawChildren: rawChildren,
        _cstTriviaLog: cstTriviaLog,
        _triviaLog: triviaLog,
      }

      expect(() => run(ctx)).toThrow('boom')
      expect(ctx.trivia).toBe(ws)
      expect(ctx._cstChildren).toBe(cstChildren)
      expect(ctx._cstLeaves).toBe(cstLeaves)
      expect(ctx._cstRawChildren).toBe(rawChildren)
      expect(ctx._cstTriviaLog).toBe(cstTriviaLog)
      expect(ctx._triviaLog).toBe(triviaLog)
    }
  })

  it('does not leak nested parser trivia into the outer trivia log', () => {
    for (const run of [
      (ctx: ParseContext) => nestedTriviaToken.parse('a[ ]', 0, ctx),
      (ctx: ParseContext) => nestedTriviaCompiled.parseWithContext('a[ ]', ctx, 0),
    ]) {
      const triviaLog: number[] = []
      const ctx: ParseContext = { trackLines: false, _triviaLog: triviaLog }
      expect(run(ctx)).toMatchObject({ ok: true, value: 'a[ ]', span: { start: 0, end: 4 } })
      expect(ctx._triviaLog).toBe(triviaLog)
      expect(triviaLog).toEqual([])
    }
  })
})

describe('leaf()', () => {
  it('does not propagate inner grammar metadata onto the leaf boundary', () => {
    const inner = parser({ trivia: ws }, sequence(literal('a'), literal('b')))
    const wrapped = leaf(inner, value => value)
    expect(wrapped._meta).toMatchObject({
      firstSet: inner._meta.firstSet,
      canMatchNewline: inner._meta.canMatchNewline,
      isTrivia: false,
    })
    expect(wrapped._meta.grammarTrivia).toBeUndefined()
  })

  it('reduces a comment-aware structural operator to one semantic CST leaf with its full span', () => {
    const input = 'a * // explanation\n b'
    const interp = parse(mathExpression, input)
    const compiled = mathExpressionCompiled.parse(input, 0)
    expect(interp.ok).toBe(true)
    expect(compiled.ok).toBe(true)
    if (!interp.ok || !compiled.ok) return
    expect(leafValues(interp.value)).toEqual(['a', '*', 'b'])
    const operator = (interp.value as CstNode).children[1] as CSTLeaf
    expect(operator.span).toEqual({ start: 1, end: input.length - 1 })
    expect(compiled.value).toEqual(interp.value)
  })

  it('keeps noTrivia containment when the enclosing structural run is also glued', () => {
    expect(parse(gluedLeaf, 'a[]b').ok).toBe(true)
    expect(gluedLeafCompiled.parse('a[]b', 0).ok).toBe(true)
    expect(parse(gluedLeaf, 'a []b').ok).toBe(false)
    expect(gluedLeafCompiled.parse('a []b', 0).ok).toBe(false)
  })
})
