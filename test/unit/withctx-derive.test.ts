/**
 * `withCtx(state => next, c)` — the DERIVE form.
 *
 * The replace form, `withCtx(extra, c)`, installs `extra` AS the subtree's state,
 * so every outer field — a document option, a sink reducers write to — is gone
 * inside. The derive form computes the subtree's state FROM the state in force
 * at entry, so a caller can add one field (a stop set, a mode) and keep the rest.
 *
 * One grammar, every engine. `Seq` is a run of words and `<`; its `<` arm is
 * gated off when the DERIVED field `stop` says so, and its `Item` reducer reads
 * the OUTER field `mode`. Under the derive wrapper the run must stop before `<`
 * and the reducer must still see `mode`; outside it, `<` joins the run and the
 * derived field is gone again (restore on exit).
 *
 * RED before the feature: a function `extra` was installed AS the state, so the
 * gate read `stop` off a function (undefined), the derived run swallowed every
 * `<`, and `Root` failed on its literal `<`.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as parseman from '../../src/index.ts'
import { choice, literal, many, node, regex, sequence, withCtx, type Combinator } from '../../src/index.ts'
import { run } from '../../src/functional/run.ts'
import { compile } from '../../src/table/compile.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { evalRuleMapIR } from '../../src/plugin/ir-eval.ts'
import { compileLinkableTable as compileLinkable } from '../../src/compiler/compile-linkable-table.ts'
import { evalMacroExports } from '../helpers/eval-macro-module.ts'
import { macroComposed } from '../helpers/macro-package.ts'
import type { FusedRule } from '../../src/index.ts'

type S = { mode?: string; stop?: string }

// Closure-free, so a printed module can carry it from its own source.
const stopAtComparison = (s: unknown): S => ({ ...(s as S), stop: 'comparison' })

const Item = node('Item', regex(/[a-z]+/), (_children, _fields, span, _raw, _tlog, state) =>
  `${(state as S | undefined)?.mode}:${(state as S | undefined)?.stop ?? '-'}@${span.start}`)
const Seq = many(choice(Item, { gate: s => (s as S | undefined)?.stop !== 'comparison', combinator: literal('<') }))
const Root = sequence(withCtx(stopAtComparison, Seq), literal('<'), Seq)
// The outer state arrives through an enclosing replace-form withCtx, so engines
// that take no initial state (compile().parse) see the same input as run().
const Doc = withCtx({ mode: 'm' }, Root)

const EXPECTED = [['m:comparison@0'], '<', ['m:-@2', '<', 'm:-@4']]

const priorEmit = process.env.PM_TABLE_EMIT
afterAll(() => {
  if (priorEmit === undefined) delete process.env.PM_TABLE_EMIT
  else process.env.PM_TABLE_EMIT = priorEmit
})

async function closureRules(map: Record<string, Combinator<unknown>>) {
  process.env.PM_TABLE_EMIT = '0'
  vi.resetModules()
  const fresh = await import('../../src/table/assemble.ts')
  const rules = fresh.tableRules(encodeTable(map))
  if (priorEmit === undefined) delete process.env.PM_TABLE_EMIT
  else process.env.PM_TABLE_EMIT = priorEmit
  return rules
}

describe('withCtx derive form — every engine', () => {
  it('interpreter: outer field survives into the reducer, derived field gates, both restore on exit', () => {
    const r = run(Doc, 'a<b<c')
    expect(r.ok).toBe(true)
    expect(r.value).toEqual(EXPECTED)
    // Initial state through run() — the same derivation from a caller-supplied state.
    expect(run(Root, 'a<b<c', { state: { mode: 'm' } }).value).toEqual(EXPECTED)
  })

  it('derives once per entry, never per token', () => {
    let derives = 0
    const counted = (s: unknown): S => { derives++; return stopAtComparison(s) }
    run(sequence(withCtx(counted, Seq), literal('<'), Seq), 'a<b<c')
    expect(derives).toBe(1)
    derives = 0
    run(many(sequence(withCtx(counted, Item), literal(';'))), 'a;b;c;')
    expect(derives).toBe(3)
  })

  it('table reference interpreter (execRules)', () => {
    expect(run(execRules(encodeTable({ Doc })).Doc as never, 'a<b<c').value).toEqual(EXPECTED)
  })

  it('assembled table (tableRules, default and closure fallback)', async () => {
    expect(run(tableRules(encodeTable({ Doc })).Doc as never, 'a<b<c').value).toEqual(EXPECTED)
    const closures = await closureRules({ Doc })
    expect(run(closures.Doc as never, 'a<b<c').value).toEqual(EXPECTED)
  })

  it('compile(): the live parser and the PRINTED module', () => {
    const p = compile(Doc)
    const r = p.parse('a<b<c')
    expect(r.ok && r.value).toEqual(EXPECTED)
    // The derive function is an author callback printed from its own source,
    // so the module is printable; the encoder parks it in `fns`, not the const pool.
    expect(p.source).toContain('stop: "comparison"')
    const printed = evalMacroExports(p.source, {}) as { grammar: Record<string, unknown> }
    expect(run(printed.grammar.Entry as never, 'a<b<c').value).toEqual(EXPECTED)
  })

  it('types: an unannotated deriver compiles, and a callable can never pass as a replacement value', () => {
    // Checked by `tsc` (test/ is in the project); never called.
    const typeLevel = (): void => {
      withCtx(s => ({ ...s, stop: 'comparison' }), Item)
      withCtx((s: { mode: string }) => ({ ...s, stop: 'x' }), Item)
      withCtx({ mode: 'm' }, Item)
      withCtx('less-var-fallback', Item)
      withCtx<{ on: boolean }, unknown>({ on: true }, Item)
      // @ts-expect-error — two required parameters: not a deriver, and the runtime would call it as one
      withCtx((_a: string, _b: string) => 'x', Item)
      const fnOrState = ((): ((a: string, b: string) => string) | { mode: string } => ({ mode: 'm' }))()
      // @ts-expect-error — may be callable at runtime, so it is not a replacement value either
      withCtx(fnOrState, Item)
    }
    expect(typeof typeLevel).toBe('function')
  })

  it('replace form is unchanged: the outer field is gone inside', () => {
    expect(run(withCtx({ mode: 'm' }, withCtx({ stop: 'comparison' }, Item)), 'a').value).toBe('undefined:comparison@0')
  })
})

describe('withCtx derive form — macro', () => {
  const SRC = `import { rules, choice, literal, many, node, regex, sequence, withCtx } from 'parseman' with { type: 'macro' }
export const g = rules(g => ({
  Item: node('Item', regex(/[a-z]+/), (_c, _f, span, _r, _t, state) => \`\${state && state.mode}:\${(state && state.stop) || '-'}@\${span.start}\`),
  Seq: many(choice(g.Item, { gate: s => !s || s.stop !== 'comparison', combinator: literal('<') })),
  Root: sequence(withCtx((s: { mode?: string }) => ({ ...s, stop: 'comparison' }), g.Seq), literal('<'), g.Seq),
}))`

  it('lowers clean and runs with the outer state the caller passes', () => {
    const out = transformMacro(SRC, '/pkg/base.ts', new Set(['parseman']))
    if (!out) throw new Error('transformMacro returned null')
    const advisory = /could not be serialized to IR, so it carries no composable pieces/
    expect(out.warnings.filter(w => !advisory.test(w))).toEqual([])
    const g = (evalMacroExports(out.code, { ...parseman }).g) as Record<string, FusedRule>
    expect(g.Root!('a<b<c', 0, { state: { mode: 'm' } }).value).toEqual(EXPECTED)
  })

  it('round-trips through the compose IR (`_wc`) as a derive function with its source', () => {
    const ir = `rules((g) => ({ "R": _wc("(s) => ({ ...s, stop: 1 })", regex("x", "")) }))`
    const [, wc] = evalRuleMapIR(ir).find(([name]) => name === 'R')!
    const def = wc._def as { extra?: unknown; extraSrc?: string }
    expect(typeof def.extra).toBe('function')
    expect(def.extraSrc).toBe('(s) => ({ ...s, stop: 1 })')
    // The derive source is printable, so the re-lowered piece stays static.
    expect(compileLinkable(evalRuleMapIR(ir), '_relow_')!.replacement).not.toBeNull()
  })

  it('a downstream compose() of the compiled base keeps the derived state', () => {
    const composed = macroComposed(SRC.replace('export const g', 'export const base'), `import { compose, rules, literal } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
export const composed = compose([base, rules(g => ({ Extra: literal('z') }))])`).composed as Record<string, FusedRule>
    expect(composed.Root!('a<b<c', 0, { state: { mode: 'm' } }).value).toEqual(EXPECTED)
  })
})
