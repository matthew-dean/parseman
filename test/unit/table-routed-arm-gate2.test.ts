/**
 * A routed arm gate that reads TWO characters (`OP_RGATE2`).
 *
 * Jess's Less statement reads its name once and routes it; the spaced
 * declaration arm then wants `routed()` and a colon a gap follows,
 * `regex(/:(?=[ \t…])/)`. A one-character gate admits every `:`, so each glued
 * head (`div:hover`, `color:red`) entered the arm and failed at the colon. The
 * regex says its second character outright, so the gate tests it too, with no
 * scan, and reports the colon's set where entering the arm would.
 *
 * The reference driver tests the first character only. Every reader must give
 * the interpreter's whole RunResult, accepting and failing.
 */
import { describe, expect, it } from 'vitest'
import {
  choice, dispatch, endsWith, label, literal, many, node, otherwise, parser, regex, routed, rules, sequence, when,
} from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { cfgKey, countSiteVisits, tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource, EMITTED_PARAMS } from '../../src/table/emit-assembly.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { run, type Runnable } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { OP_RGATE2 } from '../../src/table/ops.ts'

type Comb = Combinator<unknown>

function readers(prog: TableProgram): ReadonlyArray<readonly [string, Record<string, Runnable>]> {
  const resolved = resolveTable(prog)
  const precompiled: PrecompiledAssembly[] = defaultAssemblyCfgs(prog).map(cfg => {
    const out = emitAssemblySource(resolved, prog, cfg, [])
    return {
      key: cfgKey(cfg),
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      factory: new Function(...EMITTED_PARAMS, out.source) as PrecompiledAssembly['factory'],
      plan: out.plan, reached: [...out.reached],
    }
  })
  return [
    ['reference', execRules(prog)],
    ['closure', tableRules({ ...prog, asm: [] })],
    ['emitted', tableRules({ ...prog, asm: precompiled })],
  ]
}

const value = regex(/[a-z0-9]+/)
const ws = regex(/[ \t]+/)
const spacedColon = label('":"', regex(/:(?=[ \t])/))
// A local const, as Jess's arm is: the gate walk does not follow rule references.
const spaced = node('Spaced', sequence(parser({ trivia: ws }, sequence(routed(), spacedColon)), value, literal(';')), c => ({ spaced: c }))
const sheet = rules({ trivia: regex(/[ \t\n]+/) }, (g: Record<string, Comb>) => ({
  Sheet: many(g.Statement!),
  Statement: dispatch(regex(/[a-z]+\(?/),
    when(endsWith('('), node('Call', sequence(routed(), value, literal(')'), literal(';')), c => ({ call: c }))),
    otherwise(choice(
      spaced,
      node('Rule', sequence(regex(/[a-z]+(?::[a-z]+)?/), literal('{'), literal('}')), c => ({ rule: c })),
      node('Decl', sequence(regex(/[a-z]+/), literal(':'), value, literal(';')), c => ({ decl: c })),
    ), { commit: false })),
})) as Record<string, Comb>

function inputs(): string[] {
  let seed = 5
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
  const stmt = (): string => [
    () => 'div:hover{}', () => 'a{}', () => 'color:red;', () => 'color: red;', () => 'color :\tred;',
    () => 'color:\tred;', () => 'f(x);', () => 'x :y;', () => 'p :hover{}',
  ][rnd(9)]!()
  const out = ['div:hover{}', 'color:red;', 'color: red;', 'a:', 'a: ', 'a:\t1;', 'a :', 'a', '', 'a:b', 'f(', 'a:{}']
  for (let i = 0; i < 200; i++) {
    const ok = Array.from({ length: 1 + rnd(4) }, stmt).join(' ')
    out.push(ok)
    const at = rnd(ok.length)
    out.push([ok.slice(0, at), `${ok.slice(0, at)}?${ok.slice(at)}`, ok.slice(0, at) + ok.slice(at + 1)][rnd(3)]!)
  }
  return out
}

describe('a routed arm gate that reads two characters', () => {
  it('gates the spaced declaration on the colon and the gap after it', () => {
    const prog = encodeTable(sheet)
    expect([...reachableIps(prog)].filter(ip => prog.code[ip] === OP_RGATE2)).toHaveLength(1)
    const gate = [...reachableIps(prog)].find(ip => prog.code[ip] === OP_RGATE2)!
    const arm = prog.code[gate + 2]!
    const glued = countSiteVisits(prog, rs => { run(rs.Sheet!, 'div:hover{} color:red;') })
    expect(glued[gate]).toBe(2)
    expect(glued[arm]).toBe(0)
    const spacedHit = countSiteVisits(prog, rs => { run(rs.Sheet!, 'color: red;') })
    expect(spacedHit[arm]).toBe(1)
  })

  it('parses and fails as the interpreter does in every reader', () => {
    const cases = inputs()
    const want = cases.map(input => digestValue(run(sheet.Sheet!, input)))
    for (const [name, entries] of readers(encodeTable(sheet))) {
      cases.forEach((input, i) => {
        expect(digestValue(run(entries.Sheet!, input)), `${name} ${JSON.stringify(input)}`).toBe(want[i])
      })
    }
  }, 60_000)
})
