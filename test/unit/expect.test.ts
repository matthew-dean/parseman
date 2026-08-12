/**
 * expect(child, label?) — required-token combinator.
 *
 * On success returns the inner value. On failure it records a ParseError (the
 * statically-derived expected set, or `label`) into ctx._errors and recovers in
 * place (zero-width success), so the enclosing sequence continues. Used to mark
 * required closers/terminators so a missing one is reported, not fatal.
 *
 * Verified across interpreter, compile(), and macro modes — the recover-in-place
 * and error-push live in separate code paths (runtime ctx vs codegen emit) that
 * can drift. deriveExpected() and furthestFail are exercised separately.
 */
import { describe, it, expect as vexpect, beforeAll } from 'vitest'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'
import {
  literal, regex, sequence, choice, many, optional,
  expect, compile, parse, isParseError, ref, keywords,
  not, peek,
} from '../../src/index.ts'
import type { ParseError } from '../../src/index.ts'
import type { ParserDef } from '../../src/types.ts'
import {
  assertionFailureExpected, deriveExpected, directTerminalFailureExpected,
} from '../../src/combinators/expect.ts'

// `{` then optional letters then a REQUIRED `}`. Missing `}` → recover in place.
const block = sequence(
  literal('{'),
  optional(regex(/[a-z]+/)),
  expect(literal('}')),
)
const compiled = compile(block)

type ParseFn = (input: string, pos: number, ctx: { _errors?: ParseError[] }) =>
  { ok: boolean; value?: unknown; span: { start: number; end: number } }
let macroFn: ParseFn

const MACRO_CODE = `
import { literal, regex, sequence, optional, expect } from 'parseman' with { type: 'macro' }
const block = sequence(
  literal('{'),
  optional(regex(/[a-z]+/)),
  expect(literal('}')),
)
`.trim()

beforeAll(async () => {
  const { transformMacro } = await import('../../src/plugin/index.ts')
  const result = transformMacro(MACRO_CODE, 'expect-test.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null — import not detected')
  if (result.code.includes("from 'parseman'"))
    throw new Error('macro transform did not remove the import — compilation failed')
  macroFn = evalMacroModule<ParseFn>(result.code, 'block')
})

function interpParse(input: string) {
  const errs: ParseError[] = []
  const r = parse(block, input, { recover: true })
  return { r, errors: (r.ok && r.errors) ? r.errors : errs }
}
function compiledParse(input: string) {
  const r = compiled.parseWithErrors(input)
  return { r, errors: r.errors }
}
function macroParse(input: string) {
  const _errors: ParseError[] = []
  const r = macroFn(input, 0, { _errors })
  return { r, errors: _errors }
}

const MODES: Array<[string, (i: string) => { r: { ok: boolean; value?: unknown; span: { end: number } }; errors: ParseError[] }]> = [
  ['interpreter', interpParse],
  ['compile()', compiledParse],
  ['macro', macroParse],
]

describe('expect() — across modes', () => {
  for (const [mode, run] of MODES) {
    it(`${mode}: present closer → no error, real value`, () => {
      const { r, errors } = run('{abc}')
      vexpect(r.ok).toBe(true)
      vexpect(r.span.end).toBe(5)
      vexpect(errors).toHaveLength(0)
    })

    it(`${mode}: missing closer → recovers in place + records expected '}'`, () => {
      const { r, errors } = run('{abc')
      vexpect(r.ok).toBe(true)
      vexpect(r.span.end).toBe(4)        // zero-width recover, stops at EOF
      vexpect(errors).toHaveLength(1)
      vexpect(errors[0]!.expected).toContain('"}"')
      vexpect(errors[0]!.span.start).toBe(4)  // error logged where the closer was due
      vexpect(isParseError(errors[0])).toBe(true)
    })
  }
})

describe('deriveExpected() — derives the expected set from structure', () => {
  it('shares direct terminal/assertion failure spelling without changing composite keywords', () => {
    vexpect(directTerminalFailureExpected(literal('}')._def as Extract<ParserDef, { tag: 'literal' }>)).toEqual(['"}"'])
    vexpect(directTerminalFailureExpected(regex(/[0-9]+/)._def as Extract<ParserDef, { tag: 'regex' }>)).toEqual(['/[0-9]+/'])
    vexpect(directTerminalFailureExpected(keywords(['if', 'else'])._def as Extract<ParserDef, { tag: 'keywords' }>)).toEqual(['keyword'])
    vexpect(assertionFailureExpected(false, 'literal')).toEqual(['not(literal)'])
    vexpect(assertionFailureExpected(true, 'literal')).toEqual(['peek(literal)'])
    vexpect(not(literal('x')).parse('x', 0, {} as never)).toMatchObject({ ok: false, expected: ['not(literal)'] })
    vexpect(peek(literal('x')).parse('y', 0, {} as never)).toMatchObject({ ok: false, expected: ['peek(literal)'] })
    vexpect(deriveExpected(keywords(['if', 'else']))).toEqual(['"else"', '"if"'])
  })

  it('preserves fresh failure arrays for source terminals/assertions and literal reuse', () => {
    const rx = regex(/[0-9]+/)
    const kw = keywords(['if'])
    const fresh = [
      [rx, '?'], [kw, '?'],
      [not(literal('x')), 'x'], [peek(literal('x')), '?'],
    ] as const
    for (const [parser, input] of fresh) {
      const first = parser.parse(input, 0, {} as never)
      const second = parser.parse(input, 0, {} as never)
      vexpect(first.ok).toBe(false)
      vexpect(second.ok).toBe(false)
      if (first.ok || second.ok) throw new Error('test setup: expected source failure')
      vexpect(first.expected).not.toBe(second.expected)
      first.expected.push('__plant__')
      vexpect(second.expected).not.toContain('__plant__')
    }
    const fixed = literal('x')
    const one = fixed.parse('?', 0, {} as never)
    const two = fixed.parse('?', 0, {} as never)
    if (one.ok || two.ok) throw new Error('test setup: expected literal failure')
    vexpect(one.expected).toBe(two.expected)
    for (const parser of [rx, kw]) {
      const source = parser.parse.toString()
      vexpect(source).toMatch(/directTerminalFailureExpected\)\(def\)|directTerminalFailureExpected\(def\)/)
      vexpect(source).not.toMatch(/directTerminalFailureExpected(?:\))?\s*\(\s*\{/)
    }
  })
  it('literal → quoted value', () => {
    vexpect(deriveExpected(literal('}'))).toEqual(['"}"'])
  })
  it('choice → all alternatives', () => {
    vexpect(deriveExpected(choice(literal(';'), literal('}')))).toEqual(['";"', '"}"'])
  })
  it('sequence → first term only', () => {
    vexpect(deriveExpected(sequence(literal('('), literal(')')))).toEqual(['"("'])
  })

  it('unwraps lazy refs and reads regex/keywords arms', () => {
    const slot = ref<unknown>()
    slot.define(literal('x'))
    vexpect(deriveExpected(slot)).toEqual(['"x"'])
    vexpect(deriveExpected(regex(/[0-9]+/))).toEqual(['/[0-9]+/'])
    vexpect(deriveExpected(keywords(['if', 'else']))).toEqual(['"else"', '"if"'])
  })

  it('expect without a label uses the derived set', () => {
    const e = expect(choice(literal(';'), literal('}')))
    const r = parse(sequence(literal('@'), e), '@!', { recover: true })
    vexpect(r.ok).toBe(true)
    if (r.ok && r.errors) {
      vexpect(r.errors[0]!.expected).toEqual(['";"', '"}"'])
    }
  })
})

describe('furthestFail — interpreter recover mode', () => {
  it('reports the furthest stuck position + expected when top rule stops short', () => {
    // many() stops at the first thing it cannot parse; the parse still "succeeds"
    // with unconsumed input, but furthestFail pinpoints where it gave up.
    const item = sequence(literal('('), regex(/[a-z]+/), literal(')'))
    const list = many(item)
    const r = parse(list, '(ab)(cd)(x!', { recover: true })
    vexpect(r.ok).toBe(true)
    if (r.ok) {
      vexpect(r.span.end).toBe(8)               // consumed (ab)(cd), stopped at (x!
      vexpect(r.furthestFail).not.toBeNull()
      vexpect(r.furthestFail!.expected).toContain('")"')
    }
  })
})
