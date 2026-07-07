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
 * can drift. staticExpected() and furthestFail are exercised separately.
 */
import { describe, it, expect as vexpect, beforeAll } from 'vitest'
import {
  literal, regex, sequence, choice, many, optional, transform, parser, trivia,
  expect, staticExpected, compile, parse, isParseError, ref, keywords,
} from '../../src/index.ts'
import type { ParseError } from '../../src/index.ts'

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
  const fnBody = result.code.replace(/\bconst\b/g, 'var') + '\nreturn block'
  macroFn = new Function(fnBody)() as ParseFn
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

describe('staticExpected() — derives the expected set from structure', () => {
  it('literal → quoted value', () => {
    vexpect(staticExpected(literal('}'))).toEqual(['"}"'])
  })
  it('choice → all alternatives', () => {
    vexpect(staticExpected(choice(literal(';'), literal('}')))).toEqual(['";"', '"}"'])
  })
  it('sequence → first term only', () => {
    vexpect(staticExpected(sequence(literal('('), literal(')')))).toEqual(['"("'])
  })

  it('unwraps lazy refs and reads regex/keywords arms', () => {
    const slot = ref<unknown>()
    slot.define(literal('x'))
    vexpect(staticExpected(slot)).toEqual(['"x"'])
    vexpect(staticExpected(regex(/[0-9]+/))).toEqual(['/[0-9]+/'])
    vexpect(staticExpected(keywords(['if', 'else']))).toEqual(['"else"', '"if"'])
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
