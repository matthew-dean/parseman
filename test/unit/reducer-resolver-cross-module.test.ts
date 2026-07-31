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
import { parseSync } from 'oxc-parser'
import { transformMacro } from '../../src/plugin/index.ts'
import { createReducerResolver } from '../../src/plugin/reducer-resolver.ts'

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
// An imported `rules()` factory carries its own offsets
// ---------------------------------------------------------------------------
describe('a reducer named inside an IMPORTED factory resolves against that factory\'s module', () => {
  /*
   * An imported `rules()` factory is evaluated with `code: mod.src`, so every
   * `node(…, build)` inside it hands the resolver an offset into THAT file. 0.45 made
   * the resolver refuse such an offset rather than index it into the entry file's scope
   * tree and name whatever binding sat at the same absolute position. Refusing is sound
   * — it fails open to full capture — but it is a permanent fail-open for a shape that
   * is ordinary grammar authoring, which is exactly what the resolver exists to end.
   *
   * The plugin now REGISTERS the factory's module, so the offset resolves against the
   * scope tree it actually indexes.
   */

  /*
   * A factory is only shared across modules through `resolvePrivateSourceModule`, which
   * refuses to look outside the importing PACKAGE — so these fixtures need a real
   * package root. Without one the factory is never collected at all and the grammar
   * silently falls back to the interpreter, which would make every assertion below pass
   * or fail for the wrong reason.
   */
  beforeAll(() => { write('fpkg/package.json', '{ "name": "fpkg", "version": "1.0.0" }') })

  /*
   * `allocatesRaw` is NOT the probe here: a `rules()` artifact allocates `_raw` at every
   * arity, so it reads `false` throughout and would pass vacuously. The elision an arity
   * actually buys under this emission shape is the trivia log and the state snapshot —
   * `_EMPTY_TL` and a literal `undefined` in the builder call, in place of the live
   * `_tl`/`_nst` bindings.
   */
  const elidesTailTiers = (code: string): boolean => /_build\[0\]\([^;]*_EMPTY_TL/.test(code)

  /** Build an entry module that consumes a factory imported from `./<name>-factory.ts`. */
  const buildViaFactory = (name: string, factorySrc: string): string => {
    write(`fpkg/${name}-factory.ts`, factorySrc)
    const code = build(`fpkg/${name}.ts`, `
import { regex, rules } from 'parseman' with { type: 'macro' }
import { factory } from './${name}-factory.ts'
export const G = rules({ trivia: regex(/ +/) }, factory)
`)
    // The whole test is void if the factory did not lower — assert it compiled.
    expect(code).toContain('_r_Fold')
    return code
  }

  /*
   * NOT covered, because the plugin cannot reach it: a SHARED factory module may not
   * import anything but the parseman macro import — `sourceScopeUntil` returns null on
   * the first other `ImportDeclaration` (src/plugin/index.ts:636-637), so the factory is
   * never collected and the grammar falls back to the interpreter. A factory module
   * therefore declares its reducers locally, which is what the cases below use.
   */
  it('resolves a reducer declared LOCALLY in the factory module', () => {
    const code = buildViaFactory('fy', `
import { literal, node, sequence } from 'parseman' with { type: 'macro' }
const fold = children => ({ n: children.length })
export const factory = g => ({ Fold: node('Fold', sequence(literal('a'), literal('b')), fold) })
`)
    expect(code).toContain('buildArity: 1')
    expect(elidesTailTiers(code)).toBe(true)
  })

  it('KEEPS full capture for a full-arity reducer in an imported factory', () => {
    // Resolving must never make a node capture LESS than its reducer declares — the
    // registration is about answering correctly, not about answering cheaply.
    const code = buildViaFactory('fz', `
import { literal, node, sequence } from 'parseman' with { type: 'macro' }
const fold = (c, f, s, r, tl, st) => ({ c, f, s, r, tl, st })
export const factory = g => ({ Fold: node('Fold', sequence(literal('a'), literal('b')), fold) })
`)
    expect(code).toContain('buildArity: 6')
    expect(elidesTailTiers(code)).toBe(false)
  })

  it('emits the reducer SOURCE, because its NAME does not exist in the consuming module', () => {
    /*
     * `buildSrc` is the call site's expression text, and the call site is in the FACTORY's
     * module — so a named reducer emitted `const _build = [fold]` into the consuming
     * module, where `fold` is a module-private const of a file nothing imported. The
     * artifact threw `ReferenceError: fold is not defined` on import. Every assertion
     * above still passed: they read the emitted text and never ran it.
     *
     * Found by the emit-time scope check, which now refuses the shape outright if the
     * substituted source is not self-contained either.
     */
    const code = buildViaFactory('fs', `
import { literal, node, sequence } from 'parseman' with { type: 'macro' }
const fold = children => ({ n: children.length })
export const factory = g => ({ Fold: node('Fold', sequence(literal('a'), literal('b')), fold) })
`)
    expect(code).not.toMatch(/_build\s*=\s*\[\s*fold\s*\]/)
    expect(code).toContain('children => ({ n: children.length })')
  })

  it('still DECLINES an offset from a module nothing registered', () => {
    // Registration is explicit. A source the plugin never announced must keep failing
    // open rather than being matched by a guess.
    const src = 'const fold = (c, f, s, r, tl, st) => c'
    const parsed = parseSync('/virtual/g.ts', src)
    const r = createReducerResolver('/virtual/g.ts', parsed.program.body as unknown[], src)
    expect(r.resolve('fold', 6, 'const fold = c => c')).toEqual({
      arity: null, src: null, reason: 'foreign-source',
    })
    // An unreadable file cannot be registered, so it cannot turn a decline into a guess.
    expect(r.register('/nope/does-not-exist.ts')).toBe(false)
  })

  it('DECLINES a text key two distinct files both claim', () => {
    // The registry is keyed by module TEXT, which identifies a module for offsets but not
    // for import resolution: `fromBinding` follows a hop with `resolveImport(mod.file, …)`,
    // and identical text means identical RELATIVE specifiers, which resolve to different
    // absolute files from different directories. Letting the second registration overwrite
    // the first answers against the WRONG module and yields a wrong arity — and a wrong
    // arity under-captures, calling the reducer with arguments the compiler elided.
    const shared = "import { helper } from './helper.ts'\nexport const fold = helper\n"
    write('dupA/mod.ts', shared)
    write('dupA/helper.ts', 'export const helper = (c, f, s, r) => c')
    write('dupB/mod.ts', shared)
    write('dupB/helper.ts', 'export const helper = c => c')

    const entrySrc = 'const x = 1'
    const parsed = parseSync('/virtual/g.ts', entrySrc)
    const r = createReducerResolver('/virtual/g.ts', parsed.program.body as unknown[], entrySrc)

    expect(r.register(path.join(dir, 'dupA/mod.ts'))).toBe(true)
    // The second file holds byte-identical text, so the key can no longer name a module.
    expect(r.register(path.join(dir, 'dupB/mod.ts'))).toBe(false)
    // And the offset is refused rather than answered from whichever registration won.
    const offset = shared.trim().indexOf('helper\n')
    expect(r.resolve('helper', offset, shared.trim())).toEqual({
      arity: null, src: null, reason: 'ambiguous-source',
    })
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

  it('outranks the RESOLVER too, not just the source reader', () => {
    // The resolver decides a real arity here (6), so before the guard it overwrote the
    // author's `{ buildArity: 1 }` — authority 2 quietly demoting authority 1. The
    // declaration is only an escape hatch if nothing overrides it.
    write('r24.ts', 'export const fold = (c, f, s, r, tl, st) => c')
    const code = build('g24.ts', `
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
import { fold } from './r24.ts'
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), fold, { buildArity: 1 }))
`)
    expect(allocatesRaw(code)).toBe(false)
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
