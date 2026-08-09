import { describe, expect, it } from 'vitest'
import { dispatch, literal, otherwise, regex, token, when } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { ownTableProgram, type TableProgram, type TokenPlanWire } from '../../src/table/program.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_DISPATCH, OP_RX, OP_TOKEN } from '../../src/table/ops.ts'
import { run } from '../../src/functional/run.ts'

function manualPlan(): { readonly parser: ReturnType<typeof dispatch>; readonly prog: TableProgram } {
  const selector = token(regex(/[a-z]+/))
  const parser = dispatch(selector, when('foo', literal('!')), otherwise(literal('?')))
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
  return { parser, prog: ownTableProgram({ ...raw, k: [...raw.k, 'foo'], tokenPlan: plan }) }
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
})
