/**
 * `choice(sequence(X, a), X)` inside a node: the first arm becomes
 * `sequence(X, optional(a))`, so an `X` with no `a` after it is parsed once
 * instead of twice (`factor-choice.ts` `factorPrefixArms`). The SCSS mixin
 * argument (`$name: v`, `v...`, `v`) is this shape.
 *
 * Every reader — reference `execRules`, closure and precompiled emitted
 * `tableRules` — must give the interpreter's whole RunResult over generated
 * argument lists, accepting and failing alike.
 */
import { describe, expect, it } from 'vitest'
import { choice, literal, many, node, regex, rules, sepBy, sequence } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { cfgKey, countSiteVisits, tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource, EMITTED_PARAMS } from '../../src/table/emit-assembly.ts'
import { run, type Runnable } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { OP_NODE } from '../../src/table/ops.ts'

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

const call = rules({ trivia: regex(/[ \t]+/) }, (g: Record<string, Comb>) => ({
  Call: sequence(regex(/[a-z]+/), literal('('), sepBy(g.Arg!, literal(',')), literal(')')),
  Arg: node('Arg', choice(
    sequence(literal('$'), regex(/[a-z]+/), literal(':'), g.Term!),
    sequence(g.Term!, literal('...')),
    g.Term!,
  ), children => ({ arg: children })),
  // A second argument shape whose next arm is NOT its prefix.
  Flag: node('Flag', choice(sequence(g.Word!, literal('!')), g.Num!), children => ({ flag: children })),
  Term: node('Term', many(choice(g.Word!, g.Num!, g.Flag!), { min: 1 }), children => ({ term: children })),
  Word: regex(/[a-z]+/),
  Num: regex(/[0-9]+/),
})) as Record<string, Comb>

function inputs(): string[] {
  let seed = 11
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
  const atom = (): string => [() => 'a', () => 'bc', () => String(rnd(99)), () => 'x!'][rnd(4)]!()
  const term = (): string => Array.from({ length: 1 + rnd(3) }, atom).join(' ')
  const arg = (): string => [() => term(), () => `${term()}...`, () => `$k: ${term()}`, () => `${term()} ...`][rnd(4)]!()
  const out = ['f()', 'f(a)', 'f(a...)', 'f($a: b)', 'f(a, b...)', 'f(a..)', 'f(a ...)', 'f($a b)', 'f(x!)', 'f(x)', 'f(1!)', 'f(', 'f(a,)']
  for (let i = 0; i < 250; i++) {
    const ok = `f(${Array.from({ length: 1 + rnd(3) }, arg).join(', ')})`
    out.push(ok)
    const at = rnd(ok.length)
    out.push([ok.slice(0, at), `${ok.slice(0, at)}.${ok.slice(at)}`, ok.slice(0, at) + ok.slice(at + 1)][rnd(3)]!)
  }
  return out
}

describe('an arm whose next sibling is its own prefix', () => {
  it('parses the shared term once when the rest is absent', () => {
    const prog = encodeTable(call)
    const term = Object.entries(prog.rules).find(([name]) => name === 'Term')![1]
    // The Term rule's node row, through its entry wrappers.
    let ip = term
    for (let n = 0; n < 6 && prog.code[ip] !== OP_NODE; n++) ip = prog.code[ip + 2]!
    expect(prog.code[ip]).toBe(OP_NODE)
    const counts = countSiteVisits(prog, rs => { run(rs.Call!, 'f(a, b, c)') })
    expect(counts[ip]).toBe(3)
  })

  it('parses and fails as the interpreter does in every reader', () => {
    const cases = inputs()
    const want = cases.map(input => digestValue(run(call.Call!, input)))
    for (const [name, entries] of readers(encodeTable(call))) {
      cases.forEach((input, i) => {
        expect(digestValue(run(entries.Call!, input)), `${name} ${JSON.stringify(input)}`).toBe(want[i])
      })
    }
  }, 60_000)
})
