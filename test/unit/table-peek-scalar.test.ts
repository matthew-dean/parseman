/**
 * `peek()` of a direct literal or regex is decided by the terminal's match alone
 * in both table engines, as `not()` of one is: no rollback mark, and no CST leaf
 * captured only to be rolled back (`scalarTerminalPeekChild`).
 */
import { describe, expect, it } from 'vitest'
import { cstBuildHost, literal, node, peek, regex, run, sequence } from '../../src/index.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { AssemblyCache, tableRules, type RunCfg } from '../../src/table/assemble.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_PEEK } from '../../src/table/ops.ts'
import type { TableProgram } from '../../src/table/program.ts'
import type { Combinator } from '../../src/types.ts'

type Entry = Parameters<typeof run>[0]
const CLOSURE_CFG: RunCfg = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false, hostReadsChildren: true }

const program = (g: Combinator<unknown>, settings: Parameters<typeof encodeTable>[1] = {}): TableProgram => encodeTable({ Entry: g }, settings)
const peekIp = (prog: TableProgram): number => [...reachableIps(prog)].find(ip => prog.code[ip] === OP_PEEK)!

function agree(g: Combinator<unknown>, prog: TableProgram, inputs: readonly string[], opts: Parameters<typeof run>[2] = {}): void {
  const es: Record<string, Entry> = {
    reference: execRules(prog).Entry! as Entry,
    closure: tableRules({ ...prog, asm: [] }).Entry! as Entry,
    emitted: tableRules(prog).Entry! as Entry,
  }
  for (const input of inputs) {
    const want = digestValue(run(es.reference!, input, opts))
    for (const [name, e] of Object.entries(es)) expect(digestValue(run(e, input, opts)), `${name} ${JSON.stringify(input)}`).toBe(want)
    const i = run(g, input, opts)
    expect(digestValue([i.ok, i.ok ? i.value : null, i.span]), `interpreter ${JSON.stringify(input)}`)
      .toBe(digestValue(((r) => [r.ok, r.ok ? r.value : null, r.span])(run(es.reference!, input, opts))))
  }
}

describe('direct-terminal peek() scalar consumer', () => {
  it('never links the terminal under the peek, in any option set', () => {
    for (const child of [literal('x'), regex(/[ \t]|\/[/*]/)]) {
      const prog = program(sequence(peek(child), regex(/[^;]+/)))
      const ip = peekIp(prog)
      for (const cfg of [CLOSURE_CFG, { ...CLOSURE_CFG, hostCst: true }, { ...CLOSURE_CFG, tolerant: true }, { ...CLOSURE_CFG, probe: true }]) {
        expect(new AssemblyCache(prog).for(cfg).reached.has(prog.code[ip + 1]!), JSON.stringify(cfg)).toBe(false)
      }
    }
  })

  it('parses what the full lookahead parses, under AST, CST and tolerant capture', () => {
    const g = node('Run', sequence(peek(regex(/[ \t]|\/[/*]/)), regex(/[ \t]+|\/\/[^\n]*/), literal('a')), children => children)
    for (const [settings, opts] of [
      [{}, {}],
      [{}, { tolerant: true }],
      [{ hostMode: 'cst' as const }, { build: cstBuildHost({ tags: true }) }],
    ] as const) {
      agree(g, program(g, settings), [' a', '\ta', '// x', 'a', '', '/a'], opts)
    }
    const bare = peek(literal('x'))
    agree(bare, program(bare), ['x', 'y', ''])
    expect(run(tableRules(program(bare)).Entry! as Entry, 'y')).toMatchObject({ ok: false, span: { start: 0, end: 0 } })
  })
})
