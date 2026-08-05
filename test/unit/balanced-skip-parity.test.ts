/**
 * balanced(open, close, opts?) — the 3rd `opts` argument (notably opts.skip)
 * MUST be honored identically across interpreter, compile(), and the macro.
 *
 * Regression guard for a silent macro parity bug: the macro plugin's `balanced`
 * handler previously read only args[0]/args[1] and dropped `opts`, so a macro
 * grammar using `balanced('(', ')', { skip: [stringLit] })` would stop at a
 * quoted close-paren instead of skipping over the string — a wrong result with
 * NO error. This proves all three modes now agree.
 *
 * Demonstrating input: `(a ')' b)`. With opts.skip respected, the `'...'` arm
 * consumes the quoted `)` so the whole region matches. Without it, the scan
 * stops at the quoted `)` and matches only `(a ')`.
 */
import { describe, it, expect as vexpect, beforeAll } from 'vitest'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'
import {
  balanced, regex, sequence, literal, parse, compile,
} from '../../src/index.ts'

// singleStr matches a single-quoted string: '...'
const singleStr = sequence(literal("'"), regex(/[^']*/), literal("'"))
const region = balanced('(', ')', { skip: [singleStr] })
const compiled = compile(region)

type ParseFn = (input: string, pos: number, ctx: Record<string, unknown>) =>
  { ok: boolean; value?: unknown; span: { start: number; end: number } }
let macroFn: ParseFn

const MACRO_CODE = `
import { balanced, regex, sequence, literal } from 'parseman' with { type: 'macro' }
const singleStr = sequence(literal("'"), regex(/[^']*/), literal("'"))
export const region = balanced('(', ')', { skip: [singleStr] })
`.trim()

beforeAll(async () => {
  const { transformMacro } = await import('../../src/plugin/index.ts')
  const result = transformMacro(MACRO_CODE, 'balanced-skip-test.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null — import not detected')
  if (result.code.includes("from 'parseman'"))
    throw new Error('macro transform did not remove the import — compilation failed')
  macroFn = evalMacroModule<ParseFn>(result.code, 'region')
})

function interp(input: string) {
  const r = parse(region, input)
  return { ok: r.ok, value: r.ok ? r.value : undefined, end: r.span.end }
}
function comp(input: string) {
  const r = compiled.parse(input)
  return { ok: r.ok, value: r.ok ? r.value : undefined, end: r.span.end }
}
function macro(input: string) {
  const r = macroFn(input, 0, {})
  return { ok: r.ok, value: r.ok ? r.value : undefined, end: r.span.end }
}

const MODES: Array<[string, (i: string) => { ok: boolean; value?: unknown; end: number }]> = [
  ['interpreter', interp],
  ['compile()', comp],
  ['macro', macro],
]

describe('balanced() opts.skip — across modes', () => {
  for (const [mode, run] of MODES) {
    it(`${mode}: skips a string holding a close-delimiter → whole region matches`, () => {
      const r = run("(a ')' b)")
      vexpect(r.ok).toBe(true)
      vexpect(r.end).toBe(9)            // consumed the entire input
      vexpect(r.value).toBe("(a ')' b)")
    })

    it(`${mode}: plain balanced still works (no string)`, () => {
      const r = run('(a b)')
      vexpect(r.ok).toBe(true)
      vexpect(r.value).toBe('(a b)')
    })
  }

  it('all three modes produce identical value', () => {
    const input = "(a ')' (b) c)"
    const vals = MODES.map(([, run]) => run(input).value)
    vexpect(vals[0]).toBe(input)
    vexpect(new Set(vals).size).toBe(1)
  })
})
