/**
 * Cross-module reducer resolution.
 *
 * Importing shared reducers from another module is ordinary grammar authoring — jess's
 * own grammars do it — so "we cannot see another module's AST" was never an acceptable
 * answer. The macro plugin runs at `enforce: 'pre'` with the filesystem available, so it
 * resolves and parses the imported module and reads the real parameter list.
 *
 * Every case here writes REAL files and transforms with a real module path, because the
 * whole point is the filesystem hop. Assertions are on the emitted artifact: a resolved
 * arity-1 reducer must not allocate the raw-children collector; an unresolvable one must.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { transformMacro } from '../../src/plugin/index.ts'

let dir: string
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-reducers-')) })
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const write = (name: string, src: string): string => {
  const p = path.join(dir, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, src.trim())
  return p
}

/** Emitted source for a grammar module written at `dir/<name>`. */
const build = (name: string, src: string): string => {
  const file = write(name, src)
  const result = transformMacro(fs.readFileSync(file, 'utf8'), file, new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null')
  return result.code
}

/** Did the node allocate the raw-children collector it only needs at arity >= 4? */
const allocatesRaw = (code: string): boolean => (code.match(/_raw\d+ = \[\]/g) ?? []).length > 0

const GRAMMAR = (importLine: string, ref: string) => `
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
${importLine}
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), ${ref}))
`

describe('imported reducers resolve across module boundaries', () => {
  it('named import of a `const` arrow', () => {
    write('r1.ts', 'export const foldOperation = children => ({ n: children.length })')
    expect(allocatesRaw(build('g1.ts', GRAMMAR("import { foldOperation } from './r1.ts'", 'foldOperation')))).toBe(false)
  })

  it('named import of a `function` declaration', () => {
    write('r2.ts', 'export function foldOperation(children) { return { n: children.length } }')
    expect(allocatesRaw(build('g2.ts', GRAMMAR("import { foldOperation } from './r2.ts'", 'foldOperation')))).toBe(false)
  })

  it('a `.js` specifier that is really a `.ts` source file', () => {
    write('r3.ts', 'export const fold = children => ({ n: children.length })')
    expect(allocatesRaw(build('g3.ts', GRAMMAR("import { fold } from './r3.js'", 'fold')))).toBe(false)
  })

  it('ALIASED import (`{ foldOperation as fold }`)', () => {
    write('r4.ts', 'export const foldOperation = children => ({ n: children.length })')
    expect(allocatesRaw(build('g4.ts', GRAMMAR("import { foldOperation as fold } from './r4.ts'", 'fold')))).toBe(false)
  })

  it('DEFAULT import', () => {
    write('r5.ts', 'export default function (children) { return { n: children.length } }')
    expect(allocatesRaw(build('g5.ts', GRAMMAR("import fold from './r5.ts'", 'fold')))).toBe(false)
  })

  it('NAMESPACE import with a member expression (`helpers.fold`)', () => {
    write('r6.ts', 'export const fold = children => ({ n: children.length })')
    expect(allocatesRaw(build('g6.ts', GRAMMAR("import * as helpers from './r6.ts'", 'helpers.fold')))).toBe(false)
  })

  it('RE-EXPORT (`export { fold } from …`)', () => {
    write('r7-impl.ts', 'export const fold = children => ({ n: children.length })')
    write('r7.ts', "export { fold } from './r7-impl.ts'")
    expect(allocatesRaw(build('g7.ts', GRAMMAR("import { fold } from './r7.ts'", 'fold')))).toBe(false)
  })

  it('STAR re-export (`export * from …`)', () => {
    write('r8-impl.ts', 'export const fold = children => ({ n: children.length })')
    write('r8.ts', "export * from './r8-impl.ts'")
    expect(allocatesRaw(build('g8.ts', GRAMMAR("import { fold } from './r8.ts'", 'fold')))).toBe(false)
  })

  it('an index file (`./sub` → `./sub/index.ts`)', () => {
    write('sub/index.ts', 'export const fold = children => ({ n: children.length })')
    expect(allocatesRaw(build('g9.ts', GRAMMAR("import { fold } from './sub'", 'fold')))).toBe(false)
  })

  it('a TypeScript-annotated imported reducer', () => {
    write('r10.ts', 'export const fold = (children: readonly unknown[]): unknown => ({ n: children.length })')
    expect(allocatesRaw(build('g10.ts', GRAMMAR("import { fold } from './r10.ts'", 'fold')))).toBe(false)
  })

  it('an imported reducer that ALIASES another module', () => {
    write('r11-impl.ts', 'export function real(children) { return { n: children.length } }')
    write('r11.ts', "import { real } from './r11-impl.ts'\nexport const fold = real")
    expect(allocatesRaw(build('g11.ts', GRAMMAR("import { fold } from './r11.ts'", 'fold')))).toBe(false)
  })

  it('KEEPS full capture for an imported FULL-arity reducer (no under-capture)', () => {
    write('r12.ts', 'export const fold = (c, f, s, r, tl, st) => ({ c, f, s, r, tl, st })')
    // Arity 6 genuinely reads everything, so every tier must stay live. Resolving must
    // never make a node capture LESS than its reducer declares.
    expect(allocatesRaw(build('g12.ts', GRAMMAR("import { fold } from './r12.ts'", 'fold')))).toBe(true)
  })

  it('declines an imported reducer with a REST parameter', () => {
    write('r13.ts', 'export const fold = (...args) => args')
    expect(allocatesRaw(build('g13.ts', GRAMMAR("import { fold } from './r13.ts'", 'fold')))).toBe(true)
  })

  it('declines an imported binding that is not a function', () => {
    write('r14.ts', 'export const fold = someRuntimeFactory()')
    expect(allocatesRaw(build('g14.ts', GRAMMAR("import { fold } from './r14.ts'", 'fold')))).toBe(true)
  })

  it('BARE package specifier resolves through node resolution', () => {
    write('node_modules/fake-reducers/package.json', '{ "name": "fake-reducers", "version": "1.0.0", "main": "index.js" }')
    write('node_modules/fake-reducers/index.js', 'export const fold = children => ({ n: children.length })')
    expect(allocatesRaw(build('g16.ts', GRAMMAR("import { fold } from 'fake-reducers'", 'fold')))).toBe(false)
  })

  it('`export default <identifier>` resolves to the named declaration', () => {
    write('r17.ts', 'const impl = children => ({ n: children.length })\nexport default impl')
    expect(allocatesRaw(build('g17.ts', GRAMMAR("import fold from './r17.ts'", 'fold')))).toBe(false)
  })

  it('`export { local as fold }` resolves the LOCAL name', () => {
    write('r18.ts', 'const impl = children => ({ n: children.length })\nexport { impl as fold }')
    expect(allocatesRaw(build('g18.ts', GRAMMAR("import { fold } from './r18.ts'", 'fold')))).toBe(false)
  })

  it('a star re-export that does not carry the name falls through to the next one', () => {
    write('r19a.ts', 'export const other = (c, f, s, r, tl, st) => 0')
    write('r19b.ts', 'export const fold = children => ({ n: children.length })')
    write('r19.ts', "export * from './r19a.ts'\nexport * from './r19b.ts'")
    expect(allocatesRaw(build('g19.ts', GRAMMAR("import { fold } from './r19.ts'", 'fold')))).toBe(false)
  })

  it('a name a module does not export at all declines', () => {
    write('r22.ts', 'export const other = c => c')
    expect(allocatesRaw(build('g22.ts', GRAMMAR("import { fold } from './r22.ts'", 'fold')))).toBe(true)
  })

  it('a TypeScript constructor parameter property does not confuse the scope walk', () => {
    write('r23.ts', `
export class Holder { constructor(private readonly fold: unknown) {} }
export const fold = children => ({ n: children.length })
`)
    expect(allocatesRaw(build('g23.ts', GRAMMAR("import { fold } from './r23.ts'", 'fold')))).toBe(false)
  })

  it('survives an import CYCLE without hanging', () => {
    write('c1.ts', "export { fold } from './c2.ts'")
    write('c2.ts', "export { fold } from './c1.ts'")
    expect(allocatesRaw(build('g15.ts', GRAMMAR("import { fold } from './c1.ts'", 'fold')))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Resolution changes COST, never what the reducer receives
// ---------------------------------------------------------------------------
describe('a resolved reducer receives exactly what an unresolved one would', () => {
  /*
   * The failure mode resolution could introduce is UNDER-capture: eliding a tier the
   * reducer actually reads, so it silently gets an empty `rawChildren`/`triviaLog` or an
   * absent `state`. That is a correctness bug, not a cost, so it is asserted directly —
   * at every arity, the reducer records what it was handed and the result must match the
   * interpreter, which decides capture independently.
   */
  const SIGS = [
    ['c', 'c.length'],
    ['c, f', 'c.length'],
    ['c, f, s', 's.end'],
    ['c, f, s, r', 'r.length'],
    ['c, f, s, r, tl', 'tl.length'],
    ['c, f, s, r, tl, st', 'String(st === undefined)'],
  ] as const

  for (const [params, probe] of SIGS) {
    it(`arity ${params.split(',').length}: macro output matches the interpreter`, async () => {
      const n = SIGS.findIndex(s => s[0] === params)
      write(`p${n}.ts`, `export const fold = (${params}) => ({ got: ${probe} })`)
      const file = write(`gp${n}.ts`, `
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
import { fold } from './p${n}.ts'
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), fold))
`)
      const result = transformMacro(fs.readFileSync(file, 'utf8'), file, new Set(['parseman']))!
      const body = result.code
        .replace(/\bexport\s+/g, '')
        .replace(/\bconst\b/g, 'var')
        .replace(/import\s*\{[^}]*\}\s*from\s*'[^']*'\s*;?/g, '')
        + '\nreturn P'
      const compiled = (new Function(`var fold = (${params}) => ({ got: ${probe} });\n${body}`)()) as
        (input: string, pos: number, ctx: object) => { ok: boolean; value?: unknown }

      const { node: n2, literal, parser: parser2, regex: regex2, sequence: seq, run } = await import('../../src/index.ts')
      // eslint-disable-next-line no-new-func
      const interpFold = new Function(`return (${params}) => ({ got: ${probe} })`)() as never
      const g = parser2({ trivia: regex2(/ +/) }, n2('Fold', seq(literal('a'), literal('b')), interpFold))

      expect(compiled('a b', 0, {}).value).toEqual(run(g, 'a b').value)
    })
  }
})

// ---------------------------------------------------------------------------
// The escape hatch
// ---------------------------------------------------------------------------
describe('node(..., { buildArity }) declares what cannot be derived', () => {
  it('turns an undecidable rest-parameter reducer into a decided arity', () => {
    write('r20.ts', 'export const fold = (...args) => args[0]')
    const code = build('g20.ts', `
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
import { fold } from './r20.ts'
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), fold, { buildArity: 1 }))
`)
    // Declared arity 1 → children only; raw/trivia/state all elided despite the rest param.
    expect(allocatesRaw(code)).toBe(false)
  })

  it('silences the diagnostic it is the answer to', () => {
    const prev = process.env.PARSEMAN_DEGRADATION
    process.env.PARSEMAN_DEGRADATION = 'warn'
    try {
      write('r21.ts', 'export const fold = (...args) => args[0]')
      const file = write('g21.ts', `
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
import { fold } from './r21.ts'
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), fold, { buildArity: 1 }))
`)
      const r = transformMacro(fs.readFileSync(file, 'utf8'), file, new Set(['parseman']))!
      expect(r.warnings.join('\n')).not.toContain('build-arity-unconfirmed')
    } finally { process.env.PARSEMAN_DEGRADATION = prev }
  })

  it('rejects an out-of-range declaration rather than silently clamping', async () => {
    const { node, literal } = await import('../../src/index.ts')
    expect(() => node('T', literal('a'), (c: readonly unknown[]) => c, { buildArity: 7 })).toThrow(/buildArity must be an integer 0\.\.6/)
    expect(() => node('T', literal('a'), (c: readonly unknown[]) => c, { buildArity: -1 })).toThrow(/buildArity/)
  })

  it('an author declaration wins over what the source appears to say', async () => {
    const { node, literal, parser, compile } = await import('../../src/index.ts')
    // The reducer LOOKS arity-6; the author declares 1. The declaration is authoritative,
    // which is what makes it an escape hatch rather than a hint.
    const n = node('T', literal('a'), (c: readonly unknown[], _f, _s, _r, _tl, _st) => c, { buildArity: 1 })
    expect(compile(parser({}, n), undefined).source).toContain('_EMPTY_TL')
  })
})
