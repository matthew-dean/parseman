/**
 * SHARED SHAPES — one grammar shape, many dialect bindings.
 *
 * A package can export a `rules()` map that references a rule it does NOT define
 * (`g.Value`): the shape `<ratio> = <value> '/' <value>` written once, with each
 * consuming dialect binding `Value` to its own value/interpolation rule. The shape
 * can't be inlined as a standalone parser (the hole has no body), so its runtime
 * value stays the `rules(…)` map — but it still carries fully compiled pieces, so a
 * downstream `compose()` / `composeLeaf()` macro-fuses it with zero runtime work.
 *
 * The second half of this file guards the SAFETY property that makes the above
 * sound: `composeLeaf` only accepts pre-final pieces that PROVE recognition-only.
 * An unresolved external ref is a hole, not a proof of purity — everything else
 * still has to prove it.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as parseman from '../../src/index.ts'
import { literal, ref, rules, sequence, node, transform, choice, guard, withCtx } from '../../src/index.ts'
import { compileLinkable } from '../../src/compiler/codegen.ts'
import { transformMacro } from '../../src/plugin/index.ts'

type Parse = (input: string, pos: number, ctx: object) => { ok: boolean; value: unknown }

const RATIO_SHAPE = `
import { literal, rules, sequence } from 'parseman' with { type: 'macro' }
export const ratioShape = rules(g => ({ Ratio: sequence(g.Value, literal('/'), g.Value) }))
`

const leafSource = (valueRegex: string): string => `
import { composeLeaf, node, regex, rules } from 'parseman' with { type: 'macro' }
import { ratioShape } from './shape.js'
export const parser = composeLeaf([ratioShape, rules(g => ({
  Value: regex(${valueRegex}),
  Document: node('Document', g.Ratio, (children, _fields, span) => ({ type: 'Ratio', parts: children.map(c => c.value), span })),
}))])
`

/** Run emitted module code and hand back its `parser` export. Parseman's own
 * exports are supplied as locals so a module that legitimately KEEPS a `rules(…)`
 * call (a shared shape's standalone value) still evaluates. */
const makeParser = (code: string): Record<string, Parse> =>
  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(parseman), code.replace(/^import[^\n]*\n/gm, '').replace(/export const/g, 'var') + '\nreturn parser')(
    ...Object.values(parseman),
  ) as Record<string, Parse>

/** Emit `sources` into a throwaway package (keys are file names) and run `body`. */
const withPackage = <T>(sources: Record<string, string>, body: (dir: string, emitted: Record<string, ReturnType<typeof transformMacro>>) => T): T => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-shared-shape-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    const emitted: Record<string, ReturnType<typeof transformMacro>> = {}
    for (const [name, source] of Object.entries(sources)) {
      const out = transformMacro(source, path.join(dir, `${name}.ts`), new Set(['parseman']))
      emitted[name] = out
      fs.writeFileSync(path.join(dir, `${name}.js`), out!.code)
    }
    return body(dir, emitted)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('shared shape with unresolved external g. refs', () => {
  it('the shape module compiles clean and carries its linkable pieces', () => {
    withPackage({ shape: RATIO_SHAPE }, (_dir, emitted) => {
      const shape = emitted.shape!
      // Nothing FAILED — the shape is fully compiled for downstream use, it just has
      // no standalone inlined form, so no interpreter-fallback warning is emitted.
      expect(shape.warnings).toEqual([])
      expect(shape.code).toContain('parseman.composedPieces')
      // The carried IR keeps the hole as a by-name reference.
      expect(shape.code).toContain(String.raw`g[\"Value\"]`)
      // Its own runtime value stays the interpreter map, so the import must survive
      // (with the macro attribute stripped, as for any interpreter downgrade).
      expect(shape.code).toMatch(/\brules\s*\(/)
      expect(shape.code).toMatch(/^import .* from 'parseman'$/m)
      expect(shape.code).not.toContain("with { type: 'macro' }")
    })
  })

  it('composeLeaf fully macro-fuses the shape against a local Value binding', () => {
    withPackage({ shape: RATIO_SHAPE }, dir => {
      const leaf = transformMacro(leafSource('/[0-9]+/'), path.join(dir, 'leaf.ts'), new Set(['parseman']))!
      expect(leaf.warnings).toEqual([])
      expect(leaf.code).not.toMatch(/\bcomposeLeaf\s*\(/)
      expect(leaf.code).not.toContain('new Function')
      expect(leaf.code).toContain('_r_Ratio')

      const r = makeParser(leaf.code).Document!('16/9', 0, {})
      expect(r.ok).toBe(true)
      // Children are PRESERVED across the fuse: the externally-supplied `Value`
      // terminals reach the local node()'s collector, not just the literal.
      expect(r.value).toEqual({ type: 'Ratio', parts: ['16', '/', '9'], span: { start: 0, end: 4 } })
    })
  })

  it('two dialects bind DIFFERENT Value rules to the same shape', () => {
    withPackage({ shape: RATIO_SHAPE }, dir => {
      const numeric = transformMacro(leafSource('/[0-9]+/'), path.join(dir, 'numeric.ts'), new Set(['parseman']))!
      const interp = transformMacro(leafSource(String.raw`/@\{[a-z]+\}|[0-9]+/`), path.join(dir, 'interp.ts'), new Set(['parseman']))!
      expect(numeric.warnings).toEqual([])
      expect(interp.warnings).toEqual([])

      const numericParser = makeParser(numeric.code)
      const interpParser = makeParser(interp.code)

      expect(numericParser.Document!('16/9', 0, {}).ok).toBe(true)
      expect(interpParser.Document!('16/9', 0, {}).ok).toBe(true)

      // The Less-shaped dialect accepts an interpolated numerator…
      const withInterp = interpParser.Document!('@{w}/9', 0, {})
      expect(withInterp.ok).toBe(true)
      expect(withInterp.value).toEqual({ type: 'Ratio', parts: ['@{w}', '/', '9'], span: { start: 0, end: 6 } })
      // …and the numeric dialect REJECTS it. Same shape, genuinely different bindings.
      expect(numericParser.Document!('@{w}/9', 0, {}).ok).toBe(false)
    })
  })

  it('a same-file compose() fuses a local shared shape too', () => {
    const out = transformMacro(`
import { compose, literal, regex, rules, sequence } from 'parseman' with { type: 'macro' }
const ratioShape = rules(g => ({ Ratio: sequence(g.Value, literal('/'), g.Value) }))
export const parser = compose([ratioShape, rules(g => ({ Value: regex(/[0-9]+/) }))])
`, '/pkg/local.ts', new Set(['parseman']))!
    expect(out.warnings).toEqual([])
    expect(out.code).not.toMatch(/\bcompose\s*\(\s*\[/)
    expect(makeParser(out.code).Ratio!('16/9', 0, {}).ok).toBe(true)
  })

  it('a hole NOBODY binds fails loudly — it is never silently dropped', () => {
    withPackage({ shape: RATIO_SHAPE }, dir => {
      expect(() => transformMacro(`
import { composeLeaf, node, rules } from 'parseman' with { type: 'macro' }
import { ratioShape } from './shape.js'
export const parser = composeLeaf([ratioShape, rules(g => ({
  Document: node('Document', g.Ratio, (_children, _fields, span) => ({ type: 'Ratio', span })),
}))])
`, path.join(dir, 'leaf.ts'), new Set(['parseman']))).toThrow(/composeLeaf\(\) must macro-fuse/)
    })
  })
})

describe('recognition-only gate stays sound', () => {
  const entriesOf = (m: unknown): never => Object.entries(m as Record<string, never>) as never

  it('a shape whose ONLY unknown is an external ref proves recognition-only', () => {
    const piece = compileLinkable(entriesOf(rules(g => ({ Ratio: sequence(g.Value, literal('/'), g.Value) }))), '_ext_')!
    expect(piece.isRecognitionOnly).toBe(true)
    expect(piece.hasDirectBuilders).toBe(false)
  })

  it('a semantic reduction ALONGSIDE an external ref is still detected', () => {
    const cases: Array<[string, unknown]> = [
      ['node build', rules(g => ({ R: node('R', sequence(g.Value, literal('/')), (_c, _f, span) => ({ span })) }))],
      ['transform', rules(g => ({ R: transform(sequence(g.Value, literal('/')), v => v) }))],
      ['gated choice', rules(g => ({ R: choice({ gate: () => true, combinator: g.Value }, literal('/')) }))],
      ['guard', rules(g => ({ R: sequence(guard(() => true), g.Value) }))],
      ['withCtx', rules(g => ({ R: withCtx({ x: 1 }, g.Value) }))],
    ]
    for (const [label, map] of cases) {
      const piece = compileLinkable(entriesOf(map), `_sem_${label.replace(/\W/g, '')}_`)
      // Either the piece refuses to compile statically at all, or it compiles and
      // honestly reports itself semantic. Never "compiles AND claims pure".
      expect(piece === null || piece.isRecognitionOnly === false, label).toBe(true)
    }
  })

  it('an UNNAMED undefined ref() never presents as a recognition-only piece', () => {
    // A bare `ref()` that was never `.define()`d is NOT an external ref: it carries no
    // rule name, so nothing can bind it by name at fuse time. `hasSemanticReduction`
    // deliberately does not fail open for it (only refs the external-ref pre-pass
    // CLASSIFIED are exempt), and codegen independently refuses to inline it — so it
    // can never reach `composeLeaf`'s gate wearing a recognition-only badge.
    const orphan = ref<unknown>()
    expect(compileLinkable([['A', sequence(literal('x'), orphan)]] as never, '_orphan_')).toBeNull()
    expect(compileLinkable(entriesOf(rules(_g => ({ A: sequence(literal('x'), orphan) }))), '_orphan2_')).toBeNull()
  })

  it('composeLeaf REJECTS a pre-final shape that carries its own reduction', () => {
    // A/B against the passing case above: SAME leaf source, only the imported shape
    // differs — recognition-only fuses, semantic is refused.
    const semanticShape = `
import { literal, node, rules, sequence } from 'parseman' with { type: 'macro' }
export const ratioShape = rules(g => ({
  Ratio: node('Ratio', sequence(g.Value, literal('/'), g.Value), (_children, _fields, span) => ({ kind: 'ratio', span })),
}))
`
    withPackage({ shape: semanticShape }, dir => {
      expect(() => transformMacro(leafSource('/[0-9]+/'), path.join(dir, 'leaf.ts'), new Set(['parseman'])))
        .toThrow(/composeLeaf\(\) must macro-fuse/)
    })
  })

  it('composeLeaf REJECTS a semantic pre-final piece that BINDS the hole', () => {
    // The other leg of the soundness argument: whoever supplies the missing name is
    // either the local leaf (allowed to be semantic) or another PRE-FINAL piece —
    // and a pre-final piece goes through the very same gate.
    const semanticValues = `
import { node, regex, rules } from 'parseman' with { type: 'macro' }
export const values = rules(g => ({
  Value: node('Value', regex(/[0-9]+/), (_children, _fields, span) => ({ kind: 'value', span })),
}))
`
    withPackage({ shape: RATIO_SHAPE, values: semanticValues }, dir => {
      expect(() => transformMacro(`
import { composeLeaf, node, rules } from 'parseman' with { type: 'macro' }
import { ratioShape } from './shape.js'
import { values } from './values.js'
export const parser = composeLeaf([ratioShape, values, rules(g => ({
  Document: node('Document', g.Ratio, (_children, _fields, span) => ({ type: 'Ratio', span })),
}))])
`, path.join(dir, 'leaf.ts'), new Set(['parseman']))).toThrow(/composeLeaf\(\) must macro-fuse/)
    })
  })

  it('…but the same chain fuses when the binding pre-final piece is recognition-only', () => {
    const plainValues = `
import { regex, rules } from 'parseman' with { type: 'macro' }
export const values = rules(g => ({ Value: regex(/[0-9]+/) }))
`
    withPackage({ shape: RATIO_SHAPE, values: plainValues }, dir => {
      const leaf = transformMacro(`
import { composeLeaf, node, rules } from 'parseman' with { type: 'macro' }
import { ratioShape } from './shape.js'
import { values } from './values.js'
export const parser = composeLeaf([ratioShape, values, rules(g => ({
  Document: node('Document', g.Ratio, (children, _fields, span) => ({ type: 'Ratio', parts: children.map(c => c.value), span })),
}))])
`, path.join(dir, 'leaf.ts'), new Set(['parseman']))!
      expect(leaf.warnings).toEqual([])
      expect(leaf.code).not.toMatch(/\bcomposeLeaf\s*\(/)
      const r = makeParser(leaf.code).Document!('16/9', 0, {})
      expect(r.ok).toBe(true)
      expect(r.value).toEqual({ type: 'Ratio', parts: ['16', '/', '9'], span: { start: 0, end: 4 } })
    })
  })
})
