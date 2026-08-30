import { describe, expect, it } from 'vitest'
import {
  choice, literal, many, node, run, sequence, type Combinator,
} from '../../src/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import {
  ownTableProgram, resolveTable, type PrecompiledAssembly, type TableProgram, type TableRule,
} from '../../src/table/program.ts'

type Entry = Parameters<typeof run>[0]
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }

function grammar(): Record<string, Combinator<unknown>> {
  return {
    // Pools a finite class before Repeated asks for the same leading `a` class.
    Prime: choice(literal('a'), literal('b')),
    Gated: node('Gated', sequence(literal('g'), literal('!'))),
    Repeated: many(sequence(literal('a'), literal('!'))),
    Masked: choice(
      sequence(literal('m'), literal('?')),
      sequence(literal('m'), literal('.')),
    ),
  }
}

function emitted(prog: TableProgram, staticBuild: boolean): ReturnType<typeof emitAssemblySource> {
  return emitAssemblySource(resolveTable(prog), prog, STRICT, [], staticBuild)
}

function installed(prog: TableProgram): Record<string, TableRule> {
  const owned = ownTableProgram(prog)
  const out = emitted(owned, true)
  const factory = new Function(...EMITTED_PARAMS, out.source) as PrecompiledAssembly['factory']
  return tableRules(ownTableProgram({
    ...owned,
    asm: [{ key: 0, factory, plan: out.plan, reached: [...out.reached] }],
  }))
}

function outcome(entry: Entry, input: string): unknown {
  const r = run(entry, input)
  return {
    ok: r.ok,
    value: r.value,
    span: r.span,
    expected: r.expected,
    errors: r.errors,
    unconsumedFrom: r.unconsumedFrom,
  }
}

function assertDirectCodeUnits(source: string): void {
  expect((source.match(/\.ascii\[input\.charCodeAt\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
  expect((source.match(/const c=input\.charCodeAt\(pos\)/g) ?? []).length).toBeGreaterThanOrEqual(2)
  expect(source).not.toMatch(/classHas\([^\n]+lead\(input/)
  expect(source).not.toContain('function _asciiGate')
}

describe('static emitted ASCII code-unit gates', () => {
  it('replaces lead/classHas at proven ASCII-only sites without adding a helper', () => {
    const prog = encodeTable(grammar())
    const runtime = emitted(prog, false).source
    const staticallyEmitted = emitted(prog, true).source

    // RED control: the runtime emitter remains the surrogate-aware general
    // shape and proves this grammar really carries gate/choice/repeat checks.
    expect(runtime).toMatch(/classHas\([^\n]+lead\(input/)
    expect(runtime).toContain('const c=lead(input,pos)')
    assertDirectCodeUnits(staticallyEmitted)

    // Deliberate structural plant: restoring one lead() call must make the
    // assertion fail even though all ordinary ASCII parses still agree.
    const planted = staticallyEmitted.replaceAll('input.charCodeAt(', 'lead(input,')
    expect(() => assertDirectCodeUnits(planted)).toThrow()
  })

  it('preserves EOF, lone-surrogate and astral failures in all table engines', () => {
    const prog = encodeTable(grammar())
    const engines = {
      emitted: installed(prog),
      closure: tableRules({ ...prog, asm: [] }),
      reference: execRules(prog),
    }
    const cases: Record<string, readonly string[]> = {
      Prime: ['', 'a', 'b', '\ud800', '\udc00', '😀', 'é'],
      Gated: ['', 'g!', 'g?', '\ud800!', '\udc00!', '😀!', 'é!'],
      Repeated: ['', 'a!', 'a!a!', 'a?tail', '\ud800!', '\udc00!', '😀!'],
      Masked: ['', 'm?', 'm.', 'm!', '\ud800?', '\udc00?', '😀?', 'é?'],
    }
    for (const [rule, inputs] of Object.entries(cases)) {
      for (const input of inputs) {
        const expected = outcome(engines.reference[rule]! as Entry, input)
        expect(outcome(engines.emitted[rule]! as Entry, input), `emitted ${rule} ${JSON.stringify(input)}`)
          .toEqual(expected)
        expect(outcome(engines.closure[rule]! as Entry, input), `closure ${rule} ${JSON.stringify(input)}`)
          .toEqual(expected)
      }
    }
  })

  it('retains surrogate-aware lead() where a class can match lone or astral input', () => {
    const unicodeGrammar = {
      Astral: node('Astral', literal('😀')),
      Lone: node('Lone', literal('\ud800')),
      Either: choice(literal('😀'), literal('\ud800')),
    }
    const prog = encodeTable(unicodeGrammar)
    const source = emitted(prog, true).source
    expect(source).toMatch(/classHas\([^\n]+lead\(input,pos\)/)
    expect(source).toContain('const c=lead(input,pos)')

    const engines = {
      emitted: installed(prog),
      closure: tableRules({ ...prog, asm: [] }),
      reference: execRules(prog),
    }
    for (const rule of Object.keys(unicodeGrammar)) {
      for (const input of ['', '😀', '\ud800', '\udc00', 'a']) {
        const expected = outcome(engines.reference[rule]! as Entry, input)
        expect(outcome(engines.emitted[rule]! as Entry, input), `emitted ${rule} ${JSON.stringify(input)}`)
          .toEqual(expected)
        expect(outcome(engines.closure[rule]! as Entry, input), `closure ${rule} ${JSON.stringify(input)}`)
          .toEqual(expected)
      }
    }
  })
})
