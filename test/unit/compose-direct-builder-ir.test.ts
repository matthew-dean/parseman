/**
 * A macro-built grammar carries direct `node(..., build)` callbacks as IR so a
 * downstream compose can re-lower them. `_nd` used to restore only `buildSrc`,
 * leaving the live node structural; codegen then selected ctx.build/default CST
 * and silently erased the direct semantic value.
 */
import { describe, expect, it } from 'vitest'
import * as parseman from '../../src/index.ts'
import { isInterpretedFuse } from '../../src/compiler/linker.ts'
import { compileLinkableTable as compileLinkable } from '../../src/compiler/compile-linkable-table.ts'
import { evalRuleMapIR } from '../../src/compiler/ir-serialize.ts'
import { directBuilderUnsupportedBindings } from '../../src/plugin/direct-builder-static.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { evalMacroExports, evalMacroModule } from '../helpers/eval-macro-module.ts'

const COMPOSED_PIECES = Symbol.for('parseman.composedPieces')

function macroModule(source: string): Record<string, unknown> {
  const transformed = transformMacro(source, '/pkg/base.ts', new Set(['parseman']))!
  expect(transformed.warnings).toEqual([])
  const module = evalMacroExports(transformed.code, { ...parseman })
  return module
}

const BASE_SOURCE = `import { rules, literal, node } from 'parseman' with { type: 'macro' }
export const base = rules(g => ({
  Direct: node('Direct', literal('x'), (children, _fields, span) => ({
    kind: 'direct',
    span,
    children: [...children],
  })),
}))`

describe('compose over a macro-built direct node builder', () => {
  const base = macroModule(BASE_SOURCE).base as Record<string | symbol, unknown>

  it('retains direct builder identity through IR rehydration and static compilation', () => {
    const carried = base[COMPOSED_PIECES] as Array<{ ir: string }>
    const ir = carried[0]!.ir
    expect(ir).toContain('_nd')

    const pieces = compileLinkable(evalRuleMapIR(ir), '_direct_')!
    // A direct builder carried as a live function cannot be printed; encoding proves
    // it round-tripped as SOURCE.
    expect(pieces.replacement).not.toBeNull()

    const rehydrated = parseman.compose([{ [COMPOSED_PIECES]: [{ ...carried[0], ir }] } as never]) as unknown as Record<
      string, (input: string, pos: number, ctx: object) => { ok: boolean; value: unknown }
    >
    const host = () => ({ kind: 'host' })
    expect(rehydrated.Direct!('x', 0, { build: host }).value).toEqual({
      kind: 'direct', span: { start: 0, end: 1 }, children: [{ _tag: 'leaf', value: 'x', span: { start: 0, end: 1 } }],
    })
  })

  it('carries an imported builder capture as import provenance, not a refusal', () => {
    // `importedFactory` is an IMPORT of the authoring module, so it is rescuable: the
    // carried IR records where it came from (`{ local, source, imported }`) instead of
    // marking the builder un-fusible. A downstream macro compose re-emits that import.
    const captured = macroModule(`import { rules, literal, node } from 'parseman' with { type: 'macro' }
import { importedFactory } from './ast-factory.ts'
export const base = rules(g => ({
  Direct: node('Direct', literal('x'), () => importedFactory()),
}))`).base as Record<string | symbol, unknown>
    const carried = captured[COMPOSED_PIECES] as Array<{ ir?: string }>
    expect(carried[0]!.ir).toContain('"local":"importedFactory"')
    expect(carried[0]!.ir).toContain('"source":"./ast-factory.ts"')
    // It is NOT recorded as a static-error refusal.
    expect(carried[0]!.ir).not.toContain('["importedFactory"]')
  })

  it('fails a RUNTIME compose() closed — it cannot supply the module import in-process', () => {
    // The provenance rescue is a BUILD-TIME (macro) mechanism: the plugin re-emits the
    // import into the generated module. A runtime compose() builds live functions with
    // no import to give, so it must refuse rather than defer a parse-time ReferenceError.
    const captured = macroModule(`import { rules, literal, node } from 'parseman' with { type: 'macro' }
import { importedFactory } from './ast-factory.ts'
export const base = rules(g => ({
  Direct: node('Direct', literal('x'), () => importedFactory()),
}))`).base as Record<string | symbol, unknown>
    expect(() => parseman.compose([captured as never])).toThrow(
      /references module import\(s\) importedFactory that a runtime compose\(\) cannot supply/,
    )
  })

  it('MACRO-fuses a compose over an imported builder, re-emitting the import (patch A)', () => {
    // The decisive positive: a base grammar whose reducer calls an imported factory,
    // composed downstream, fuses with NO interpreter fallback and re-emits the import
    // into the consuming module so the inlined builder source binds.
    const baseT = transformMacro(`import { rules, literal, node, regex, compose } from 'parseman' with { type: 'macro' }
import { importedFactory } from './ast-factory.js'
const ws = regex(/[ \\t\\n]*/)
export const base = compose([rules({ trivia: ws }, g => ({
  Direct: node('Direct', literal('x'), () => importedFactory()),
}))])`, '/pkg/base.ts', new Set(['parseman']))!
    expect(baseT.warnings).toEqual([])
    // Fused (no runtime compose() left in the output, no interpreter parse marker).
    expect(/\bcompose\s*\(/.test(baseT.code)).toBe(false)
    expect(/_rp\[\d+\]\.parse\(/.test(baseT.code)).toBe(false)
    // The builder source is inlined AND the import it needs is present.
    expect(baseT.code).toContain('importedFactory()')
    expect(/import \{[^}]*\bimportedFactory\b[^}]*\} from ["']\.\/ast-factory\.js["']/.test(baseT.code)).toBe(true)
  })

  it('MACRO-fuses a DOWNSTREAM compose over an imported ALREADY-COMPOSED base, re-emitting the base\'s imports (patch A, cross-module)', async () => {
    // The dialect pattern the lift exists for, exercised ACROSS A MODULE BOUNDARY.
    // The same-module test above never reaches the re-lower re-emit: the authoring
    // module already imports the factory, so `pendingBuilderImports` is skipped. Here
    // the base is COMPILED to its own file — its reducers' import provenance lives only
    // in its serialized `composedPieces` IR — and a SEPARATE downstream module imports
    // that base and composes a delta onto it. The downstream module does NOT import the
    // base's helpers itself, so fusion is possible only if the macro reads the base's
    // carried `buildImports` and re-emits those imports into the fused downstream module.
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-compose-imported-base-'))
    try {
      // The base: a composed grammar whose reducers call imported factories — an inline
      // arrow (`Leaf`) and a block-statement body reaching two imports (`Pair`), plus an
      // inherited-only rule (`Doc`). Its widened leaf `Leaf` is what the delta overrides.
      const baseT = transformMacro(
        `import { rules, node, regex, sequence, compose } from 'parseman' with { type: 'macro' }
import { mkLeaf, mkPair } from './ast-factory.js'
const ws = regex(/[ \\t\\n]*/)
export const base = compose([rules({ trivia: ws }, g => ({
  Leaf: node('Leaf', regex(/[a-z]+/), children => mkLeaf(children)),
  Pair: node('Pair', sequence(g.Leaf, g.Leaf), children => {
    const kids = [...children]
    return mkPair(kids)
  }),
  Doc: node('Doc', g.Pair, children => children[0]),
}))])`,
        path.join(dir, 'base.ts'), new Set(['parseman']),
      )!
      expect(baseT.warnings).toEqual([])
      // The base's import provenance survives ONLY in its carried IR (positional, escaped),
      // never as a live import the downstream could copy by reading base.js's import lines.
      expect(baseT.code).toContain('\\"local\\":\\"mkPair\\"')
      fs.writeFileSync(path.join(dir, 'base.js'), baseT.code)
      fs.writeFileSync(path.join(dir, 'ast-factory.js'),
        'export const mkLeaf = (c) => ({ type: \'Leaf\', text: c[0]?.value })\n'
        + 'export const mkPair = (c) => ({ type: \'Pair\', kids: c })\n')

      // The downstream delta: override the ONE leaf `Leaf` (open-recursion widening),
      // inherit `Pair` and `Doc` by name from the base. This module imports NEITHER
      // `mkLeaf` nor `mkPair`; the inherited `Pair` reducer needs `mkPair` re-emitted.
      const downT = transformMacro(
        `import { rules, node, regex, choice, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
const ws = regex(/[ \\t\\n]*/)
export const parser = compose([base, rules({ trivia: ws }, g => ({
  Leaf: node('Leaf', choice(regex(/[a-z]+/), regex(/%[a-z]+/)), children => ({ type: 'WideLeaf', text: children[0]?.value })),
}))])`,
        path.join(dir, 'down.ts'), new Set(['parseman']),
      )!
      // No refusal warning: not "bound by nothing", not "ref() used before .define()",
      // not "falling back to runtime".
      expect(downT.warnings).toEqual([])
      // Fully fused: no runtime compose() left, no interpreter parse marker.
      expect(/\bcompose\s*\(/.test(downT.code)).toBe(false)
      expect(/_rp\[\d+\]\.parse\(/.test(downT.code)).toBe(false)
      // The base's helper import used by an INHERITED rule (`mkPair`, via `Pair`) is
      // re-emitted into the downstream module; `mkLeaf`, used only by the OVERRIDDEN
      // `Leaf`, is not carried into the fused table and so is not re-emitted.
      expect(/import \{[^}]*\bmkPair\b[^}]*\} from ["']\.\/ast-factory\.js["']/.test(downT.code)).toBe(true)
      expect(/\bmkLeaf\b/.test(downT.code)).toBe(false)

      // Behaviour: the fused downstream parses through the INHERITED `Doc`/`Pair` and the
      // OVERRIDDEN `Leaf`, producing the widened leaf node — proof the re-emitted `mkPair`
      // binds and open recursion routed the inherited parent at the delta's leaf.
      const base = evalMacroExports(baseT.code, {
        mkLeaf: (c: Array<{ value: unknown }>) => ({ type: 'Leaf', text: c[0]?.value }),
        mkPair: (c: unknown[]) => ({ type: 'Pair', kids: c }),
      }).base
      const parser = evalMacroModule<Record<string, (input: string, pos: number, ctx: object) => { ok: boolean; value: unknown }>>(
        downT.code, 'parser',
        { base, mkPair: (c: unknown[]) => ({ type: 'Pair', kids: c }) },
      )
      const doc = parser.Doc!('foo bar', 0, {})
      expect(doc.ok).toBe(true)
      expect(doc.value).toEqual({
        type: 'Pair',
        kids: [
          { type: 'WideLeaf', text: 'foo' },
          { type: 'WideLeaf', text: 'bar' },
        ],
      })
      // The widened leaf admits the placeholder token CSS's base leaf did not.
      expect(parser.Leaf!('%ph', 0, {}).value).toEqual({ type: 'WideLeaf', text: '%ph' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports lexical reads from Oxc AST, without mistaking keys or member names for bindings', () => {
    expect(directBuilderUnsupportedBindings(
      '(children, _fields, span) => ({ kind: "Direct", span, values: children.map(item => ({ item })) })',
    )).toEqual([])
    expect(directBuilderUnsupportedBindings(
      '(_children) => importedFactory.create()',
    )).toEqual(['importedFactory'])
    expect(directBuilderUnsupportedBindings(
      '(value) => (value += 1, { value })',
    )).toEqual([])
    expect(directBuilderUnsupportedBindings('() => {')).toEqual(['invalid callback source'])
  })

  it('rejects a captured helper when compose lowers a macro-built grammar', () => {
    const captured = macroModule(`import { rules, literal, node } from 'parseman' with { type: 'macro' }
const lexicalHelper = () => 'captured'
export const base = rules(g => ({
  Direct: node('Direct', literal('x'), () => lexicalHelper()),
}))`).base as Record<string | symbol, unknown>
    const carried = captured[COMPOSED_PIECES] as Array<{ ir?: string }>
    expect(carried[0]!.ir).toContain('["lexicalHelper"]')
    const delta = parseman.rules(() => ({ Tail: parseman.literal('z') }))
    expect(() => parseman.compose([captured as never, delta])).toThrow(
      'IR direct node builder for Direct must be macro-static and self-contained; unsupported binding(s): lexicalHelper',
    )
  })

  it('keeps the direct value after composition with a second grammar', () => {
    const delta = parseman.rules(() => ({ Tail: parseman.literal('z') }))
    const composed = parseman.compose([base as never, delta]) as unknown as Record<
      string, (input: string, pos: number, ctx: object) => { ok: boolean; value: unknown }
    >
    const host = () => ({ kind: 'host' })
    expect(composed.Direct!('x', 0, { build: host }).value).toEqual({
      kind: 'direct', span: { start: 0, end: 1 }, children: [{ _tag: 'leaf', value: 'x', span: { start: 0, end: 1 } }],
    })
    expect(composed.Tail!('z', 0, {}).ok).toBe(true)
  })
})

describe('composeLeaf over imported recognition IR', () => {
  it('is macro-only as a COMPILED artifact and never delegates to runtime compose()', () => {
    // Without the macro, composeLeaf() materializes the INTERPRETED fuse (a combinator
    // map) — never runtime codegen. Its rules are combinators, not fused functions, and
    // no carried IR is produced, so the reason it was macro-only (keeping lexical
    // builders out of carried IR) still holds.
    const leaf = parseman.composeLeaf([
      parseman.rules(() => ({ Tail: parseman.literal('y') })),
      parseman.rules(g => ({ Doc: parseman.sequence(parseman.literal('x'), g.Tail) })),
    ]) as unknown as Record<string, parseman.Combinator<unknown>>
    expect(typeof leaf.Doc).toBe('object')
    expect(parseman.run(leaf.Doc!, 'xy').ok).toBe(true)
    expect(isInterpretedFuse(leaf)).toBe(true)
    expect(() => transformMacro(
      `import { composeLeaf, literal, rules } from 'parseman' with { type: 'macro' }
export const parser = composeLeaf([unresolvedSyntax, rules(g => ({ Document: literal('x') }))])`,
      '/pkg/leaf-unresolved.ts', new Set(['parseman']),
    )).toThrow('composeLeaf() must macro-fuse; runtime composition is forbidden')
  })

  it('rejects direct builders in every pre-final grammar', async () => {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-compose-leaf-reject-'))
    try {
      const directBase = transformMacro(
        `import { literal, node, rules } from 'parseman' with { type: 'macro' }
export const directBase = rules(g => ({ Atom: node('Atom', literal('x'), () => ({ type: 'base' })) }))`,
        path.join(dir, 'direct-base.js'), new Set(['parseman']),
      )!
      expect(directBase.warnings).toEqual([])
      fs.writeFileSync(path.join(dir, 'direct-base.js'), directBase.code)

      expect(() => transformMacro(
        `import { composeLeaf, literal, rules } from 'parseman' with { type: 'macro' }
import { directBase } from './direct-base.js'
export const parser = composeLeaf([directBase, rules(g => ({ Document: literal('x') }))])`,
        path.join(dir, 'imported-direct.ts'), new Set(['parseman']),
      )).toThrow('composeLeaf() must macro-fuse; runtime composition is forbidden')

      const semanticBase = transformMacro(
        `import { literal, rules, transform } from 'parseman' with { type: 'macro' }
export const semanticBase = rules(g => ({ Atom: transform(literal('x'), value => value.toUpperCase()) }))`,
        path.join(dir, 'semantic-base.js'), new Set(['parseman']),
      )!
      expect(semanticBase.warnings).toEqual([])
      fs.writeFileSync(path.join(dir, 'semantic-base.js'), semanticBase.code)
      expect(() => transformMacro(
        `import { composeLeaf, literal, rules } from 'parseman' with { type: 'macro' }
import { semanticBase } from './semantic-base.js'
export const parser = composeLeaf([semanticBase, rules(g => ({ Document: literal('x') }))])`,
        path.join(dir, 'semantic-transform.ts'), new Set(['parseman']),
      )).toThrow('composeLeaf() must macro-fuse; runtime composition is forbidden')

      // A carried full piece from before the recognition-only marker is unknown,
      // even if it happens not to contain a builder. Leaf fusion must reject it
      // rather than infer safety from generated source text.
      fs.writeFileSync(path.join(dir, 'legacy.js'), `
export const legacy = Object.defineProperty({}, Symbol.for('parseman.composedPieces'), {
  value: [{ ns: 'legacy', keys: [], external: [], prog: null, rules: null, replacement: null, ir: null, hostMode: 'ast', hostBranchElided: false }],
  enumerable: false,
})`)
      expect(() => transformMacro(
        `import { composeLeaf, literal, rules } from 'parseman' with { type: 'macro' }
import { legacy } from './legacy.js'
export const parser = composeLeaf([legacy, rules(g => ({ Document: literal('x') }))])`,
        path.join(dir, 'legacy-unknown.ts'), new Set(['parseman']),
      )).toThrow('composeLeaf() must macro-fuse; runtime composition is forbidden')

      expect(() => transformMacro(
        `import { composeLeaf, literal, node, rules } from 'parseman' with { type: 'macro' }
export const parser = composeLeaf([
  rules(g => ({ Prior: node('Prior', literal('x'), () => ({ type: 'prior' })) })),
  rules(g => ({ Document: literal('x') })),
])`,
        path.join(dir, 'local-direct.ts'), new Set(['parseman']),
      )).toThrow('composeLeaf() must macro-fuse; runtime composition is forbidden')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a local direct wrapper\'s imported named recognition rule in the fused closure', async () => {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-compose-leaf-'))
    try {
      const base = transformMacro(
        `import { regex, rules } from 'parseman' with { type: 'macro' }
export const syntax = rules(g => ({ Atom: regex(/[a-z]+/) }))`,
        path.join(dir, 'syntax.js'), new Set(['parseman']),
      )!
      expect(base.warnings).toEqual([])
      fs.writeFileSync(path.join(dir, 'syntax.js'), base.code)

      const leaf = transformMacro(
        `import { composeLeaf, node, rules } from 'parseman' with { type: 'macro' }
import { syntax } from './syntax.js'
import { makeAst } from './ast.js'
export const parser = composeLeaf([syntax, rules(g => ({ Document: node('Document', g.Atom, (children, _fields, span) => makeAst(children.map(child => child.value), span)) }))])`,
        path.join(dir, 'leaf.js'), new Set(['parseman']),
      )!
      expect(leaf.warnings).toEqual([])
      expect(/\bcomposeLeaf\s*\(/.test(leaf.code)).toBe(false)
      expect(/new Function/.test(leaf.code)).toBe(false)
      expect(leaf.code).not.toContain('Object.defineProperty')
      expect(leaf.code).not.toContain('composedPieces')
      expect(leaf.code).toContain('leafComposed')
      // `g.Atom` is intentionally absent from the local rules map. The evaluator
      // leaves it as a named external placeholder; leaf fusion must close that
      // placeholder over the imported recognition piece, not delegate to a host
      // parser or runtime composition.

      const parser = evalMacroModule<Record<string | symbol, (input: string, pos: number, ctx: object) => { ok: boolean; value: unknown }> & Record<symbol, unknown>>(
        leaf.code, 'parser', { makeAst: (value: unknown, span: unknown) => ({ type: 'Ast', value, span }) },
      )
      expect(parser.Document!('token', 0, {}).value).toEqual({
        type: 'Ast',
        value: ['token'],
        span: { start: 0, end: 5 },
      })

      const marker = Symbol.for('parseman.leafComposed')
      expect(parser[marker]).toBe(true)
      expect(() => parseman.compose([parser as never])).toThrow(
        'compose: a composeLeaf() result is terminal and cannot be composed again',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('captures imported recognition sequence tokens in order without trivia', async () => {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-compose-leaf-trivia-'))
    try {
      const base = transformMacro(
        `import { regex, rules, sequence } from 'parseman' with { type: 'macro' }
export const syntax = rules(g => ({ Pair: sequence(regex(/[a-z]+/), regex(/[0-9]+/)) }))`,
        path.join(dir, 'syntax.js'), new Set(['parseman']),
      )!
      expect(base.warnings).toEqual([])
      fs.writeFileSync(path.join(dir, 'syntax.js'), base.code)

      const leaf = transformMacro(
        `import { composeLeaf, node, regex, rules, trivia } from 'parseman' with { type: 'macro' }
import { syntax } from './syntax.js'
import { makeAst } from './ast.js'
const whitespace = trivia(regex(/\\s+/))
export const parser = composeLeaf([syntax, rules({ trivia: whitespace }, g => ({ Document: node('Document', g.Pair, children => makeAst(children.map(child => child.value))) }))])`,
        path.join(dir, 'leaf.js'), new Set(['parseman']),
      )!
      expect(leaf.warnings).toEqual([])

      const parser = evalMacroModule<Record<string, (input: string, pos: number, ctx: object) => { ok: boolean; value: unknown }>>(
        leaf.code, 'parser', { makeAst: (value: unknown) => ({ type: 'Ast', value }) },
      )
      expect(parser.Document!('word  42', 0, {}).value).toEqual({
        type: 'Ast',
        value: ['word', '42'],
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('builder-import provenance is scoped and collision-safe (P1 regressions)', () => {
  it('does NOT record a same-named ENTRY import as a foreign NAMED reducer\'s provenance', async () => {
    // Greptile P1 (evaluator provenance scope): a base module M exports a NAMED
    // reducer whose body calls `dimension`, a helper M imports from `./ast-correct.js`.
    // The consuming entry imports that reducer AND, coincidentally, a DIFFERENT
    // `dimension` from `./ast-wrong.js`. The reducer runs as a live `f:[mk]` binding in
    // M's own scope, so its body is never inlined here — resolving its free names
    // against THIS module's imports recorded `./ast-wrong.js` as `dimension`'s
    // provenance, which a downstream compose would then re-emit and bind the builder to
    // the WRONG helper. The fix carries NO provenance for a non-inlined (named) body.
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-p1-provenance-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      fs.writeFileSync(path.join(dir, 'm.ts'),
        'import { dimension } from \'./ast-correct.js\'\n'
        + 'export function mk(children) { return dimension(children[0]) }\n')
      fs.writeFileSync(path.join(dir, 'ast-correct.js'), 'export const dimension = (x) => ({ tag: \'CORRECT\', x })\n')
      fs.writeFileSync(path.join(dir, 'ast-wrong.js'), 'export const dimension = (x) => ({ tag: \'WRONG\', x })\n')
      const out = transformMacro(
        `import { rules, literal, node } from 'parseman' with { type: 'macro' }
import { mk } from './m.ts'
import { dimension } from './ast-wrong.js'
export const grammar = rules(g => ({ X: node('X', literal('x'), mk) }))
export const unused = dimension`,
        path.join(dir, 'entry.ts'), new Set(['parseman']),
      )!
      expect(out.warnings).toEqual([])
      // The carried IR must NOT bind `dimension` to the entry's wrong-source import.
      // (escaped form is how a builder-import provenance is spelled inside the IR string)
      expect(out.code).not.toContain('\\"local\\":\\"dimension\\"')
      expect(out.code).not.toContain('\\"source\\":\\"./ast-wrong.js\\"')
      // The named reducer is kept as a live binding that runs in M's own scope, so it
      // reaches M's correct `dimension` at runtime.
      expect(out.code).toMatch(/f:\[mk\]/)
      expect(out.code).toContain("import { mk } from './m.ts'")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('REFUSES to re-emit a carried builder import that collides with a different same-named local import', async () => {
    // Greptile P1 (re-emit filter) + CodeRabbit (duplicate local declaration): a base
    // grammar's INLINE reducer calls `mkNode` from `./ast-a.js`. A downstream module
    // inherits that rule (composes a delta on a DIFFERENT rule) while importing an
    // UNRELATED `mkNode` from `./ast-b.js`. The old filter skipped the re-emit because
    // the local name was already present, silently binding the inlined builder to
    // ast-b's `mkNode`. The inlined source spells `mkNode` verbatim, so the import
    // cannot be aliased — the collision is refused rather than mis-bound.
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-p1-collision-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      fs.writeFileSync(path.join(dir, 'ast-a.js'), 'export const mkNode = (c) => ({ tag: \'A\', c })\n')
      fs.writeFileSync(path.join(dir, 'ast-b.js'), 'export const mkNode = (c) => ({ tag: \'B\', c })\n')
      const baseT = transformMacro(
        `import { rules, node, regex, compose } from 'parseman' with { type: 'macro' }
import { mkNode } from './ast-a.js'
const ws = regex(/[ \\t]*/)
export const base = compose([rules({ trivia: ws }, g => ({
  Leaf: node('Leaf', regex(/[a-z]+/), children => mkNode([...children])),
}))])`,
        path.join(dir, 'base.ts'), new Set(['parseman']),
      )!
      expect(baseT.warnings).toEqual([])
      fs.writeFileSync(path.join(dir, 'base.js'), baseT.code)

      expect(() => transformMacro(
        `import { rules, node, regex, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
import { mkNode } from './ast-b.js'
const ws = regex(/[ \\t]*/)
export const parser = compose([base, rules({ trivia: ws }, g => ({
  Tail: node('Tail', regex(/[0-9]+/), children => ({ tag: 'T', c: [...children] })),
}))])
export const unused = mkNode`,
        path.join(dir, 'down.ts'), new Set(['parseman']),
      )).toThrow(/already binds `mkNode`/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still re-emits a carried builder import when the SAME import is already present (benign dedup)', async () => {
    // The exact import the inherited builder needs is already imported by the
    // downstream module (same source, same symbol): no collision, no duplicate — the
    // existing import satisfies the need and fusion proceeds.
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-p1-dedup-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      fs.writeFileSync(path.join(dir, 'ast.js'), 'export const mkNode = (c) => ({ tag: \'N\', c })\n')
      const baseT = transformMacro(
        `import { rules, node, regex, compose } from 'parseman' with { type: 'macro' }
import { mkNode } from './ast.js'
const ws = regex(/[ \\t]*/)
export const base = compose([rules({ trivia: ws }, g => ({
  Leaf: node('Leaf', regex(/[a-z]+/), children => mkNode([...children])),
}))])`,
        path.join(dir, 'base.ts'), new Set(['parseman']),
      )!
      expect(baseT.warnings).toEqual([])
      fs.writeFileSync(path.join(dir, 'base.js'), baseT.code)

      const downT = transformMacro(
        `import { rules, node, regex, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
import { mkNode } from './ast.js'
const ws = regex(/[ \\t]*/)
export const parser = compose([base, rules({ trivia: ws }, g => ({
  Tail: node('Tail', regex(/[0-9]+/), children => mkNode([...children])),
}))])`,
        path.join(dir, 'down.ts'), new Set(['parseman']),
      )!
      expect(downT.warnings).toEqual([])
      // Fully fused, and exactly ONE import of `mkNode` from `./ast.js` (no duplicate).
      expect(/\bcompose\s*\(/.test(downT.code)).toBe(false)
      expect((downT.code.match(/import \{[^}]*\bmkNode\b[^}]*\} from ["']\.\/ast\.js["']/g) ?? []).length).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
