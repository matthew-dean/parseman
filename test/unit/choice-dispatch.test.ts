/**
 * Disjoint-choice dispatch: the compiler picks a `switch` jump table when arms
 * key off a few discrete first code points (keyword/operator dispatch) and keeps
 * an `if/else if` range-comparison chain when an arm is a wide char class.
 *
 * Both forms must be behaviorally identical to the interpreter and macro. These
 * tests lock in the codegen SHAPE (switch vs if) and cross-mode parity.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { literal, regex, choice, compile } from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { csvField } from '../../examples/csv/parser.ts'

type ParseFn = (
  input: string,
  pos: number,
  ctx: Record<string, unknown>,
) => { ok: boolean; value?: unknown; span: { start: number; end: number } }

function makeMacroParser(code: string, exportName: string): ParseFn {
  const result = transformMacro(code, 'choice-dispatch-test.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null')
  const fnBody = result.code
    .replace(/\bexport const\b/g, 'var')
    .replace(/\bconst\b/g, 'var') + `\nreturn ${exportName}`
  return new Function(fnBody)() as ParseFn
}

function modesFor<T>(combinator: Combinator<T>, macroCode: string, exportName: string) {
  const compiled = compile(combinator)
  let macroFn: ParseFn
  beforeAll(() => {
    macroFn = makeMacroParser(macroCode, exportName)
  })
  return [
    ['interpreter', (input: string, pos = 0) => {
      const r = combinator.parse(input, pos, { trackLines: false })
      return { ok: r.ok, value: r.ok ? r.value : undefined, end: r.span.end }
    }],
    ['compile()', (input: string, pos = 0) => {
      const r = compiled.parse(input, pos)
      return { ok: r.ok, value: r.ok ? r.value : undefined, end: r.span.end }
    }],
    ['macro', (input: string, pos = 0) => {
      const r = macroFn(input, pos, {})
      return { ok: r.ok, value: r.ok ? r.value : undefined, end: r.span.end }
    }],
  ] as const
}

// ---------------------------------------------------------------------------
// switch dispatch — multi-arm keyword / operator choices
// ---------------------------------------------------------------------------

const methods = choice(literal('GET'), literal('POST'), literal('DELETE'))
const ops = choice(literal('+'), literal('-'), literal('*'), literal('/'), literal('%'))

describe('choice dispatch — keyword switch', () => {
  it('compiles to a switch', () => {
    expect(compile(methods).source).toContain('switch (')
  })

  const modes = modesFor(
    methods,
    `import { literal, choice } from 'parseman' with { type: 'macro' }
export const methods = choice(literal('GET'), literal('POST'), literal('DELETE'))`,
    'methods',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: dispatches each arm`, () => {
      expect(run('GET').value).toBe('GET')
      expect(run('POST').value).toBe('POST')
      expect(run('DELETE').value).toBe('DELETE')
    })
    it(`${mode}: unmatched first char hits default → fail at pos`, () => {
      const r = run('XYZ') // 'X' matches no case
      expect(r.ok).toBe(false)
      expect(r.end).toBe(0)
    })
    it(`${mode}: EOF fails (default case)`, () => {
      expect(run('').ok).toBe(false)
    })
    it(`${mode}: right first char but wrong body fails`, () => {
      expect(run('GOT').ok).toBe(false) // 'G' dispatches to GET arm, body mismatch
    })
  }
})

describe('choice dispatch — operator switch', () => {
  it('compiles to a switch', () => {
    expect(compile(ops).source).toContain('switch (')
  })

  const modes = modesFor(
    ops,
    `import { literal, choice } from 'parseman' with { type: 'macro' }
export const ops = choice(literal('+'), literal('-'), literal('*'), literal('/'), literal('%'))`,
    'ops',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: each operator matches`, () => {
      for (const op of ['+', '-', '*', '/', '%']) expect(run(op).value).toBe(op)
    })
    it(`${mode}: non-operator fails`, () => {
      expect(run('=').ok).toBe(false)
    })
  }
})

// ---------------------------------------------------------------------------
// if/else dispatch — a wide char-class arm keeps range comparisons
// ---------------------------------------------------------------------------

const litOrDigits = choice(literal('x'), regex(/[0-9]+/))

describe('choice dispatch — char-class arm keeps if/else', () => {
  it('does NOT compile to a switch (range arm)', () => {
    const src = compile(litOrDigits).source
    expect(src).not.toContain('switch (')
    expect(src).toContain('>= 48 && ')
  })

  const modes = modesFor(
    litOrDigits,
    `import { literal, regex, choice } from 'parseman' with { type: 'macro' }
export const litOrDigits = choice(literal('x'), regex(/[0-9]+/))`,
    'litOrDigits',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: literal arm`, () => {
      expect(run('x').value).toBe('x')
    })
    it(`${mode}: digit-run arm`, () => {
      expect(run('420').value).toBe('420')
    })
    it(`${mode}: neither fails`, () => {
      expect(run('z').ok).toBe(false)
    })
  }
})

// ---------------------------------------------------------------------------
// Two-arm choice stays if/else (below the switch threshold)
// ---------------------------------------------------------------------------

const twoLit = choice(literal('a'), literal('b'))

describe('choice dispatch — small choice stays if/else', () => {
  it('does NOT switch for only two single-char arms', () => {
    expect(compile(twoLit).source).not.toContain('switch (')
  })

  const modes = modesFor(
    twoLit,
    `import { literal, choice } from 'parseman' with { type: 'macro' }
export const twoLit = choice(literal('a'), literal('b'))`,
    'twoLit',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: both arms + failure`, () => {
      expect(run('a').value).toBe('a')
      expect(run('b').value).toBe('b')
      expect(run('c').ok).toBe(false)
    })
  }
})

// ---------------------------------------------------------------------------
// firstMatch optimizations — leaf recording skip + first-set arm guards
// ---------------------------------------------------------------------------

describe('choice firstMatch — leaf fail-at-start skips _ctx recording', () => {
  const twoRegex = choice(regex(/[0-9]+/), regex(/[a-z]+/))
  it('compiled firstMatch leaf arms do not write _ctx._fe on miss', () => {
    const src = compile(twoRegex).source
    // Arms are failsAtStart — miss path must not record into _ctx on the hot path.
    expect(src).not.toMatch(/_ctx\._fe =/)
  })
})

describe('choice firstMatch — first-set arm guard (partial dispatch)', () => {
  it('csv field skips quoted arm when input does not start with "', () => {
    const src = compile(csvField).source
    // Quoted arm gated on `"` — unquoted hot path never enters the quoted parser.
    expect(src).toMatch(/if \(_chcode\d+ === 34\)/)
  })

  const modes = modesFor(
    csvField,
    `import { literal, regex, sequence, choice, many, transform } from 'parseman' with { type: 'macro' }
const quotedField = transform(sequence(literal('"'), many(choice(transform(literal('""'), () => '"'), regex(/[^"]+/))), literal('"')), ([, parts]) => parts.join(''))
const unquotedField = regex(/[^,\\r\\n]*/)
export const csvField = choice(quotedField, unquotedField)`,
    'csvField',
  )
  for (const [mode, run] of modes) {
    it(`${mode}: unquoted field parses without trying quoted path`, () => {
      expect(run('hello').value).toBe('hello')
    })
    it(`${mode}: quoted field still wins at "`, () => {
      expect(run('"hi"').value).toBe('hi')
    })
  }
})
