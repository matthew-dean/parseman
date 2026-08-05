/**
 * Branch coverage for the imported-`rules()`-factory path in `src/plugin/index.ts`
 * (`sourceScopeUntil` and the import scan that feeds it).
 *
 * A `rules()` factory can live in a sibling source module and be shared by several
 * consumers. To lower `rules(sharedFactory)` the macro must rebuild that module's
 * lexical scope from ITS source — and it may only do so for module shapes it can
 * fully account for. Anything else has to fall back to the runtime `rules()` call,
 * because a partially-reconstructed scope would compile the factory against
 * bindings it does not actually have.
 *
 * So each case here asserts which of the two happened, by looking at whether the
 * `rules(` call survives in the emitted code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { transformMacro } from '../../src/plugin/index.ts'
import { isCompiledRule } from '../helpers/eval-macro-module.ts'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugincov-factory-'))
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
})
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

let seq = 0
const ENTRY = `
import { rules } from 'parseman' with { type: 'macro' }
import { shared } from './FACTORY.ts'
export const grammar = rules(shared)
`.trim()

/** Transform an entry that lowers `rules(shared)` against a sibling factory module. */
function lower(factorySource: string) {
  const name = `factory${seq++}`
  fs.writeFileSync(path.join(dir, `${name}.ts`), `${factorySource.trim()}\n`)
  const result = transformMacro(
    ENTRY.replace('FACTORY', name),
    path.join(dir, `${name}-entry.ts`),
    new Set(['parseman']),
  )
  if (!result) throw new Error('transformMacro returned null')
  return result
}

/**
 * Did the macro statically lower the imported factory, or leave the runtime call?
 * The fallback emits `export const grammar = rules(shared)` verbatim; a lowered
 * grammar emits a compiled rule map instead.
 */
const wasLowered = (code: string): boolean => !code.includes('export const grammar = rules(shared)')

/** A lowered artifact really is compiled code for the rule, not a re-spelled call. */
function expectCompiled(out: { code: string; warnings: string[] }): void {
  expect(out.warnings).toEqual([])
  expect(wasLowered(out.code)).toBe(true)
  // Artifact-neutral: `function _r_Atom(input, …)` was a CODEGEN spelling, and the
  // question this file asks is "did the macro lower it or leave the runtime call",
  // which the table answers differently. See `isCompiledRule`.
  expect(isCompiledRule(out.code, 'Atom'), out.code).toBe(true)
}

const MACRO_IMPORT = "import { literal, regex, rules, makeWord, makeWhen, balanced, scanTo } from 'parseman' with { type: 'macro' }"

describe('an imported rules() factory whose module the macro can fully account for', () => {
  it('lowers a factory declared as an exported arrow', () => {
    const out = lower(`
${MACRO_IMPORT}
export const shared = g => ({ Atom: literal('x') })
`)
    expectCompiled(out)
    expect(out.code).toContain('export const grammar')
  })

  it('lowers a function declaration exported through a specifier list', () => {
    const out = lower(`
${MACRO_IMPORT}
function shared(g) { return { Atom: literal('x') } }
export { shared }
`)
    expectCompiled(out)
  })

  it('carries a combinator declared before the factory into the factory scope', () => {
    const out = lower(`
${MACRO_IMPORT}
const atom = literal('x')
export const shared = g => ({ Atom: atom })
`)
    expectCompiled(out)
  })

  it('carries a makeWord factory, a makeWhen factory, and a combinator array', () => {
    const out = lower(`
${MACRO_IMPORT}
const kw = makeWord('A-Za-z')
const mkWhen = makeWhen({ caseInsensitive: true })
const skips = [balanced('(', ')')]
export const shared = g => ({ Atom: kw('if'), Body: scanTo(literal(';'), { skip: skips }) })
`)
    expectCompiled(out)
  })

  it('skips helper function declarations and local arrow consts in the factory module', () => {
    const out = lower(`
${MACRO_IMPORT}
function helper(x) { return x }
export function otherHelper(x) { return x }
const inlineHelper = x => x
export const shared = g => ({ Atom: literal('x') })
`)
    expectCompiled(out)
  })

  it('tolerates a bare `export { … }` list with no source', () => {
    const out = lower(`
${MACRO_IMPORT}
const shared = g => ({ Atom: literal('x') })
export { shared }
`)
    expectCompiled(out)
  })
})

describe('an imported rules() factory whose module the macro cannot account for', () => {
  const expectFallback = (out: { code: string; warnings: string[] }) => {
    expect(out.code).toContain('export const grammar = rules(shared)')
    expect(out.warnings.some(w => w.includes(
      "grammar: rules(...) factory isn't statically evaluable",
    ))).toBe(true)
  }

  it('falls back when the factory module imports something other than the macro entry', () => {
    fs.writeFileSync(path.join(dir, 'sidecar.ts'), 'export const extra = 1\n')
    expectFallback(lower(`
${MACRO_IMPORT}
import { extra } from './sidecar.ts'
export const shared = g => ({ Atom: literal('x') })
`))
  })

  it('falls back when the factory module re-exports from elsewhere', () => {
    fs.writeFileSync(path.join(dir, 'sidecar2.ts'), 'export const extra = 1\n')
    expectFallback(lower(`
${MACRO_IMPORT}
const shared = g => ({ Atom: literal('x') })
export { extra } from './sidecar2.ts'
export { shared }
`))
  })

  it('falls back on a non-const top-level declaration', () => {
    expectFallback(lower(`
${MACRO_IMPORT}
let counter = 1
export const shared = g => ({ Atom: literal('x') })
`))
  })

  it('falls back on a destructured top-level const', () => {
    expectFallback(lower(`
${MACRO_IMPORT}
const { a } = { a: 1 }
export const shared = g => ({ Atom: literal('x') })
`))
  })

  it('falls back on a top-level const the evaluator cannot resolve', () => {
    expectFallback(lower(`
${MACRO_IMPORT}
const opaque = someUnknownCall()
export const shared = g => ({ Atom: literal('x') })
`))
  })

  it('falls back when the exported binding is not a function at all', () => {
    expectFallback(lower(`
${MACRO_IMPORT}
export const shared = literal('x')
`))
  })

  it('falls back when the module does not export the imported name', () => {
    expectFallback(lower(`
${MACRO_IMPORT}
export const somethingElse = g => ({ Atom: literal('x') })
`))
  })
})

describe('the macro-import attribute check on a factory module', () => {
  it('accepts a quoted `type` attribute key', () => {
    const out = lower(`
import { literal, rules } from 'parseman' with { 'type': 'macro' }
export const shared = g => ({ Atom: literal('x') })
`)
    expectCompiled(out)
  })

  it('falls back when the factory module imports parseman without the macro attribute', () => {
    const out = lower(`
import { literal, rules } from 'parseman'
export const shared = g => ({ Atom: literal('x') })
`)
    expect(out.code).toContain('export const grammar = rules(shared)')
    expect(out.warnings.some(w => w.includes(
      "grammar: rules(...) factory isn't statically evaluable",
    ))).toBe(true)
  })
})
