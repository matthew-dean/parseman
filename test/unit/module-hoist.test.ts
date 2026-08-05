/**
 * MODULE-LEVEL HOIST — the sentinel is all-or-nothing.
 *
 * `_pfFail` is an identity sentinel: a rule function signals failure by returning
 * it and every caller tests `v === _pfFail`. If SOME fused IIFEs in a module read
 * a module-level sentinel while OTHERS keep a local one, a rule that failed
 * returns object A and its caller compares against object B — the identity test
 * is false, so the FAILURE is read as a SUCCESS carrying the value `{}`. That is
 * silent wrong output, not a crash, and no "does it parse?" test finds it.
 *
 * The design makes the mixed state unrepresentable rather than merely unlikely:
 * `createModuleHoist` decides per DECLARED NAME, and hoists a name only when every
 * declaration of it in the module is byte-identical — so every occurrence is
 * removed together, or none is. These tests pin BOTH directions, plus the
 * end-to-end property the whole thing exists to protect: a real multi-variant
 * module's parse results, INCLUDING its failures, are unchanged by the hoist.
 */
import { describe, expect, it } from 'vitest'
import { createModuleHoist, declaredNames, HOIST_MARKER_PROBE } from '../../src/compiler/module-hoist.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { run } from '../../src/functional/run.ts'
import { cstBuildHost } from '../../src/compiler/linker.ts'
import type { Runnable } from '../../src/functional/run.ts'
import { resolveTableRuntime } from '../helpers/eval-macro-module.ts'

const FAIL = 'const _pfFail = {}'
const END = 'let _pfEnd'

describe('module hoist: declaration scanning', () => {
  it('reads the name off every top-level declaration form', () => {
    expect(declaredNames(FAIL)).toEqual(['_pfFail'])
    expect(declaredNames(END)).toEqual(['_pfEnd'])
    expect(declaredNames('function _r_Doc(input, _pos, _ctx) {\n  return 1\n}')).toEqual(['_r_Doc'])
  })

  it('reads BOTH names out of a two-declaration entry (LINE_SPAN_DECL)', () => {
    expect(declaredNames('const _lineCol = (a) => a\nconst _spanLines = (b) => b')).toEqual(['_lineCol', '_spanLines'])
  })

  it('does not mistake an indented inner declaration for a top-level one', () => {
    expect(declaredNames('function _r_A() {\n  const inner = 1\n  return inner\n}')).toEqual(['_r_A'])
  })
})

describe('module hoist: the sentinel is hoisted from every scope or from none', () => {
  it('hoists _pfFail out of ALL scopes when every scope declares it identically', () => {
    const h = createModuleHoist()
    const a = h.claim([FAIL, END]).join('\n')
    const b = h.claim([FAIL, END]).join('\n')
    const r = h.finalize()
    expect(r.hoistedNames).toEqual(['_pfFail', '_pfEnd'])
    // NEITHER scope keeps a copy. A test that only checked one would pass on the
    // exact bug this guards.
    expect(r.resolve(a)).not.toContain('_pfFail')
    expect(r.resolve(b)).not.toContain('_pfFail')
    expect(r.prelude).toContain(FAIL)
  })

  it('hoists from NO scope when one scope declares the name differently', () => {
    const h = createModuleHoist()
    const a = h.claim([FAIL]).join('\n')
    const b = h.claim([FAIL]).join('\n')
    const c = h.claim(['const _pfFail = Object.freeze({})']).join('\n')
    const r = h.finalize()
    expect(r.prelude).toBe('')
    // The two identical scopes must NOT be hoisted just because they agree with
    // each other: they would then read a module-level sentinel while the third
    // returned a local one.
    expect(r.resolve(a)).toContain(FAIL)
    expect(r.resolve(b)).toContain(FAIL)
    expect(r.resolve(c)).toContain('Object.freeze({})')
  })

  it('never hoists a subset: every occurrence of a hoisted text resolves away', () => {
    const h = createModuleHoist()
    const scopes = [0, 1, 2, 3].map(i => h.claim([FAIL, END, `function _r_Doc${i}() { return _pfFail }`]).join('\n'))
    const r = h.finalize()
    for (const s of scopes) {
      expect(r.resolve(s)).not.toMatch(/\bconst _pfFail\b/)
      expect(r.resolve(s)).not.toMatch(/\blet _pfEnd\b/)
    }
    // …and the module-level copy exists exactly once.
    expect(r.prelude.match(/const _pfFail = \{\}/g)).toHaveLength(1)
  })
})

describe('module hoist: free-variable fixpoint', () => {
  it('refuses to hoist a declaration that references a name which stayed local', () => {
    const h = createModuleHoist()
    // `_wcf0` has two different bodies (the un-namespaced `withCtx` wrapper can
    // collide across artifacts), so it cannot be hoisted — and neither can the
    // rule that calls it, even though that rule's own text IS identical.
    h.claim(['function _r_A() { return _wcf0() }', 'function _wcf0() { return 1 }'])
    h.claim(['function _r_A() { return _wcf0() }', 'function _wcf0() { return 2 }'])
    const r = h.finalize()
    expect(r.prelude).toBe('')
    expect(r.hoistedNames).toEqual([])
  })

  it('still hoists a declaration whose references are all themselves hoisted', () => {
    const h = createModuleHoist()
    h.claim(['function _r_A() { return _wcf0() }', 'function _wcf0() { return 1 }'])
    h.claim(['function _r_A() { return _wcf0() }', 'function _wcf0() { return 1 }'])
    const r = h.finalize()
    expect(r.hoistedNames.sort()).toEqual(['_r_A', '_wcf0'])
  })

  it('leaves a singleton declaration in place', () => {
    const h = createModuleHoist()
    const only = h.claim(['function _r_Doc() { return 1 }']).join('\n')
    const r = h.finalize()
    expect(r.prelude).toBe('')
    expect(r.resolve(only)).toContain('function _r_Doc()')
  })

  it('resolve() is total — no marker survives', () => {
    const h = createModuleHoist()
    const a = h.claim([FAIL, 'function _r_X() { return 1 }']).join('\n')
    const b = h.claim([FAIL, 'function _r_Y() { return 2 }']).join('\n')
    const r = h.finalize()
    for (const s of [a, b]) expect(HOIST_MARKER_PROBE.test(r.resolve(s))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// End to end: the shape the hoist exists for.
// ---------------------------------------------------------------------------

const MACRO = `import { rules, node, many, choice, sequence, literal, regex, trivia, oneOrMore, composeLeaf } from 'parseman' with { type: 'macro' }`

const RECOGNITION = `${MACRO}
export const recognition = rules((g) => ({
  Word: regex(/[A-Za-z_][A-Za-z0-9_]*/),
  Num: regex(/[0-9]+/),
  Atom: choice(g.Word, g.Num),
  List: sequence(literal('('), many(choice(g.Atom, g.List)), literal(')')),
}))
`

const VARIANT_OPTS = [
  '{ trivia: ws }',
  '{ trivia: ws, trackLines: true }',
  "{ trivia: ws, hostMode: 'cst' }",
  "{ trivia: ws, hostMode: 'cst', trackLines: true }",
]

/** The jess shape: shared recognition pieces plus N leaves differing ONLY in
 *  `trackLines` / `hostMode`. `which` selects which variant indices to emit, so a
 *  one-variant module can serve as the un-hoisted reference for variant `i`. */
function variantsModule(which: readonly number[]): string {
  return `${MACRO}
import { recognition } from './recognition.js'
const ws = trivia(oneOrMore(regex(/[ \\t\\n\\r]+/)))
${which.map(i => `export const variant${i} = composeLeaf([recognition, rules(${VARIANT_OPTS[i]!}, (g) => ({
  Doc: node('Doc${i}', many(choice(g.List, g.Atom)), (c) => ({ t: 'Doc${i}', c })),
}))])`).join('\n')}
`
}

const ALL_FOUR = [0, 1, 2, 3]

/** Macro-lower a variants module in a scratch package. The recognition grammar
 *  must be on disk as TypeScript — that is what the macro resolves and re-lowers. */
function lower(tag: string, src: string): { dir: string; code: string } {
  const dir = path.join(tmpdir(), `pm-hoist-${tag}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  writeFileSync(path.join(dir, 'recognition.ts'), RECOGNITION)
  writeFileSync(path.join(dir, 'variants.ts'), src)
  const out = transformMacro(src, path.join(dir, 'variants.ts'), new Set(['parseman']))
  return { dir, code: typeof out === 'string' ? out : out!.code }
}

/** …then load it. The `./recognition.js` import survives lowering, but the
 *  artifact is fully inlined and never reads the binding, so a stub satisfies it. */
async function loadVariants(tag: string, src: string): Promise<Record<string, { Doc: unknown }>> {
  const { dir, code } = lower(tag, src)
  writeFileSync(path.join(dir, 'recognition.js'), 'export const recognition = {}\n')
  writeFileSync(path.join(dir, 'variants.js'), resolveTableRuntime(code))
  return (await import(path.join(dir, 'variants.js'))) as unknown as Record<string, { Doc: unknown }>
}

/** Variants 2 and 3 are compiled `hostMode: 'cst'`, so they REQUIRE a build host. */
const hostFor = (i: number): { build?: typeof cstBuildHost } => (i >= 2 ? { build: cstBuildHost } : {})
const ruleOf = (m: { Doc: unknown }, name: string): Runnable => (m as unknown as Record<string, Runnable>)[name]!

describe('module hoist: a real 4-variant module', () => {
  const inputs = ['a b c', '(a 1 (b 2)) c', '', '   ', '(', '(a', 'a)', '((1 2) (3 zz))  x']

  it('emits ONE _pfFail for four variants, and one copy of each shared rule fn', () => {
    const { code } = lower('count', variantsModule(ALL_FOUR))
    expect(code.match(/const _pfFail = \{\}/g)).toHaveLength(1)
    expect(code.match(/let _pfEnd/g)).toHaveLength(1)
    // Word/Num/Atom/List are byte-identical across the four leaves; only Doc varies
    // by hostMode/trackLines. 20 rule functions collapse to 8.
    expect(code.match(/^function _r_/gm)).toHaveLength(8)
    expect(HOIST_MARKER_PROBE.test(code)).toBe(false)
  })

  it('parses identically to the un-hoisted build — successes AND failures', async () => {
    const hoisted = await loadVariants('e2e4', variantsModule(ALL_FOUR))
    // The reference: four SEPARATE single-variant modules. Nothing can be shared
    // in a one-variant module, so each keeps its own sentinel and its own copy of
    // every rule — i.e. exactly the pre-hoist emission.
    const solo = []
    for (const i of ALL_FOUR) solo.push((await loadVariants(`e2e1-${i}`, variantsModule([i])))[`variant${i}`]!)

    for (const i of ALL_FOUR) {
      for (const rule of ['Doc', 'List', 'Atom'] as const) {
        for (const inp of inputs) {
          const a = run(ruleOf(hoisted[`variant${i}`]!, rule), inp, hostFor(i))
          const b = run(ruleOf(solo[i]!, rule), inp, hostFor(i))
          expect(JSON.stringify(a), `variant${i}.${rule} ${JSON.stringify(inp)}`).toBe(JSON.stringify(b))
        }
      }
    }
  })

  it('a FAILING parse still reports ok:false (the mixed-sentinel symptom)', async () => {
    const mod = await loadVariants('e2efail', variantsModule(ALL_FOUR))
    // `Doc` is `many(…)` and therefore nullable — it cannot fail, so it cannot
    // show this. `List` requires a closing paren, so an unterminated list is a
    // genuine failure travelling back through the shared sentinel.
    for (const i of ALL_FOUR) {
      for (const inp of ['(a', '(', 'a', '']) {
        const r = run(ruleOf(mod[`variant${i}`]!, 'List'), inp, hostFor(i)) as { ok: boolean }
        // A partial hoist turns this into `{ ok: true, value: {} }`.
        expect(r.ok, `variant${i} ${JSON.stringify(inp)}`).toBe(false)
      }
    }
  })
})
