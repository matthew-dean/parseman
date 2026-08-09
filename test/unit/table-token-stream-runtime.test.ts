import { describe, expect, it } from 'vitest'
import { dispatch, literal, otherwise, regex, token, when } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { ownTableProgram, type TableProgram, type TokenPlanWire } from '../../src/table/program.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_DISPATCH, OP_RX, OP_TOKEN } from '../../src/table/ops.ts'
import { run } from '../../src/functional/run.ts'

function manualPlan(native = false): { readonly parser: ReturnType<typeof dispatch>; readonly prog: TableProgram } {
  const selector = token(native ? regex(/([a-z])\1+/) : regex(/[a-z]+/))
  const exact = native ? 'ff' : 'foo'
  const parser = dispatch(selector, when(exact, literal('!')), otherwise(literal('?')))
  const raw = encodeTable({ Entry: parser })
  const sites = [...reachableIps(raw)]
  const dispatchIp = sites.find(ip => raw.code[ip] === OP_DISPATCH)!
  const tokenIp = raw.code[dispatchIp + 1]!
  const childIp = raw.code[tokenIp + 1]!
  expect(raw.code[tokenIp]).toBe(OP_TOKEN)
  expect(raw.code[childIp]).toBe(OP_RX)
  const regexK = raw.code[childIp + 1]!
  const exactK = raw.k.length
  const family = 3
  const exactId = 4, fallbackId = 5
  const plan: TokenPlanWire = {
    recognizerOffsets: [0],
    recognizerData: [2, 3, regexK],
    outcomeOffsets: [0, 5],
    outcomeData: [exactId, family, 0, exactK, 0, fallbackId, family, 4],
    tokenSites: [tokenIp, family],
    sites: [raw.code[dispatchIp + 2]!, family, 0, 2],
    routes: [0, 0, 0, 1, -1, 2, 1, 1],
    accepted: [exactId, fallbackId],
  }
  return { parser, prog: ownTableProgram({ ...raw, k: [...raw.k, exact], tokenPlan: plan }) }
}

describe('table token stream runtime', () => {
  it('routes one atomic range and preserves canonical miss diagnostics', () => {
    const { parser, prog } = manualPlan()
    const closure = tableRules({ ...prog, asm: [] }).Entry!
    const emitted = tableRules(prog).Entry!
    for (const input of ['foo!', 'bar?', '1']) {
      const source = run(parser, input)
      for (const actual of [run(closure, input), run(emitted, input)]) {
        expect(actual).toMatchObject({
          ok: source.ok,
          value: source.value,
          span: source.span,
          expected: source.expected,
          unconsumedFrom: source.unconsumedFrom,
        })
      }
    }
    expect(run(closure, 'foo!')).toMatchObject({ ok: true, unconsumedFrom: null })
    expect(run(closure, 'bar?')).toMatchObject({ ok: true, unconsumedFrom: null })
  })

  it('recognizes once on success, twice on miss, and releases the source at finish', () => {
    for (const mode of ['closure', 'emitted'] as const) {
      const { prog } = manualPlan(true)
      const re = prog.k.find(value => value instanceof RegExp && value.sticky) as RegExp
      const original = re.exec
      let calls = 0
      re.exec = function (input: string) { calls++; return original.call(this, input) }
      const entry = tableRules(mode === 'closure' ? { ...prog, asm: [] } : prog).Entry!

      expect(run(entry, 'ff!').ok, mode).toBe(true)
      expect(calls, `${mode} success scans`).toBe(1)
      expect(run(entry, '1').ok, mode).toBe(false)
      expect(calls, `${mode} miss scans`).toBe(3)
      expect(run(entry, 'ff!').ok, mode).toBe(true)
      expect(calls, `${mode} fresh begin rescans`).toBe(4)
    }
  })

  it('has a behavior-bearing route-wire RED plant', () => {
    const { parser, prog } = manualPlan()
    const routes = [...prog.tokenPlan!.routes]
    routes[0] = -1
    const planted = ownTableProgram({ ...prog, tokenPlan: { ...prog.tokenPlan!, routes } })
    const authority = run(parser, 'foo!')
    expect(authority.ok).toBe(true)
    for (const entry of [tableRules({ ...planted, asm: [] }).Entry!, tableRules(planted).Entry!]) {
      expect(run(entry, 'foo!').ok).toBe(false)
    }
  })
})
