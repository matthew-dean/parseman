import { describe, expect, it } from 'vitest'
import {
  adjacent, choice, dispatch, field, gate, literal, many, node, noTrivia, optional,
  otherwise, parser, regex, routed, sequence, transform, when, word,
  type Combinator,
} from '../../src/index.ts'
import { run } from '../../src/functional/run.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { AssemblyCache, tableRules, type RunCfg } from '../../src/table/assemble.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_OPT, OP_SEQ, OP_SEQV } from '../../src/table/ops.ts'
import { closureArtifact } from '../../src/table/program.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { FAIL } from '../../src/table/cell.ts'

const HOT: RunCfg = {
  hostCst: false,
  trackLines: false,
  tolerant: false,
  coverage: false,
  probe: false,
}

function engines(parser: Combinator<unknown>, settings: Record<string, unknown> = {}) {
  const prog = encodeTable({ Entry: parser }, settings)
  return {
    prog,
    source: parser,
    reference: execRules(prog).Entry!,
    closure: tableRules(closureArtifact(prog)).Entry!,
    emitted: tableRules(prog).Entry!,
  }
}

function agree(parser: Combinator<unknown>, inputs: readonly string[], settings: Record<string, unknown> = {}) {
  const entries = engines(parser, settings)
  for (const input of inputs) {
    const source = run(entries.source, input)
    expect(run(entries.reference, input), `reference ${JSON.stringify(input)}`).toEqual(source)
    expect(run(entries.closure, input), `closure ${JSON.stringify(input)}`).toEqual(source)
    expect(run(entries.emitted, input), `emitted ${JSON.stringify(input)}`).toEqual(source)
  }
  return entries.prog
}

function directOptionalIps(prog: ReturnType<typeof encodeTable>): number[] {
  const out: number[] = []
  for (const ip of reachableIps(prog)) {
    const op = prog.code[ip]
    if (op !== OP_SEQ && op !== OP_SEQV) continue
    const n = prog.code[ip + 1]!
    for (let i = 0; i < n; i++) {
      const child = prog.code[ip + 2 + i]!
      if (prog.code[child] === OP_OPT) out.push(child)
    }
  }
  return [...new Set(out)]
}

describe('closure sequence-owned direct optional transaction', () => {
  it('removes the direct OP_OPT Piece only from the bounded hot parent shape', () => {
    const grammar = sequence(optional(literal('a')), literal('b'), optional(literal('c')))
    const prog = encodeTable({ Entry: grammar })
    const optionals = directOptionalIps(prog)
    expect(optionals).toHaveLength(2)

    const hot = new AssemblyCache(closureArtifact(prog)).for(HOT)
    for (const ip of optionals) expect(hot.reached.has(ip), `hot optional ip ${ip}`).toBe(false)

    for (const cfg of [
      { ...HOT, hostCst: true },
      { ...HOT, tolerant: true },
      { ...HOT, probe: true },
      { ...HOT, coverage: true },
      { ...HOT, trackLines: true },
    ]) {
      const cold = new AssemblyCache(closureArtifact(prog)).for(cfg)
      for (const ip of optionals) expect(cold.reached.has(ip), JSON.stringify(cfg)).toBe(true)
    }

    const adjacentProg = encodeTable({ Entry: sequence(literal('a'), optional(literal('b')), adjacent(), literal('c')) })
    const adjacentOpt = directOptionalIps(adjacentProg)
    expect(adjacentOpt).toHaveLength(1)
    expect(new AssemblyCache(closureArtifact(adjacentProg)).for(HOT).reached.has(adjacentOpt[0]!)).toBe(true)

    const projectedProg = encodeTable({
      Entry: transform(sequence(optional(literal('a')), literal('b')), values => values[1]),
    })
    const projectedOpt = [...reachableIps(projectedProg)].find(ip => projectedProg.code[ip] === OP_OPT)!
    expect(new AssemblyCache(closureArtifact(projectedProg)).for(HOT).reached.has(projectedOpt)).toBe(true)
  })

  it('preserves excluded finite leads, first/later hits, misses and expected order', () => {
    agree(sequence(optional(literal('a')), literal('b'), optional(literal('c'))), [
      'b', 'ab', 'bc', 'abc', '', 'a', 'ab?',
    ])
    agree(sequence(optional(regex(/[a-z]+/)), literal('!')), ['!', 'word!', '?'])

    const expected = sequence(literal('a'), optional(sequence(literal('b'), literal('!'))), literal('z'))
    agree(expected, ['az', 'ab!z', 'ab?', 'a?'])

    const important = sequence(
      literal('a'),
      optional(sequence(literal('!'), word('important', 'A-Za-z0-9_-'))),
      literal(';'),
    )
    agree(important, ['a;', 'a!important;', 'a!oops;', 'a!', 'aimportant;', 'a\u00a0;'])
  })

  it('preserves committed failure from the selected optional child', () => {
    const committed = sequence(
      literal('a'),
      optional(dispatch(literal('x'), when('x', sequence(routed(), literal('!'))))),
      literal('z'),
    )
    const entries = engines(committed)
    for (const input of ['az', 'ax!z', 'ax?']) {
      const source = run(entries.source, input)
      expect(run(entries.reference, input)).toEqual(source)
      expect(run(entries.closure, input)).toEqual(source)
      expect(run(entries.emitted, input)).toEqual(source)
    }
    const assembly = new AssemblyCache(closureArtifact(entries.prog)).for(HOT)
    const ctx = createParseContext()
    assembly.begin(ctx)
    try {
      expect(assembly.pieces.Entry!('ax?', 0, ctx)).toBe(FAIL)
      expect(ctx._fc).toBe(true)
    } finally {
      assembly.finish()
    }
  })

  it('keeps zero-width child effects while discarding only ambient trivia', () => {
    const ws = regex(/ +/)
    const zero = node(
      'Zero',
      field('seen', gate(() => true)),
      (children, fields, span, rawChildren) => ({ children, fields, span, rawChildren }),
    )
    const root = parser(
      { trivia: ws },
      node(
        'Root',
        sequence(literal('a'), optional(zero), literal('b')),
        (children, fields, span, rawChildren) => ({ children, fields, span, rawChildren }),
      ),
    ) as Combinator<unknown>
    agree(root, ['ab', 'a b'])
  })

  it('preserves first-term sign lookahead and repeated selector optionals', () => {
    const ws = regex(/(?:\s+|\/\*[^]*?\*\/)+/)
    const value = choice(literal('@x'), sequence(literal('('), literal('x'), literal(')')))
    const unary = parser(
      { trivia: ws },
      sequence(optional(noTrivia(regex(/-(?=[(@])/))), value),
    )
    agree(unary, ['@x', '-@x', '-(x)', '- @x', '-/*x*/@x', '(x)', ''])

    const compound = regex(/[.#]?[a-z]+/)
    const selectors = many(sequence(optional(regex(/[>+~|]/)), compound))
    agree(selectors, ['a', '>a', 'a+b', 'a~b|c', '#a.b', '', '?'])
  })

  it('rolls back speculative node, raw-child, field and trivia sinks', () => {
    const ws = regex(/ +/)
    const ghost = sequence(node('Ghost', literal('b')), field('ghost', literal('c')), literal('!'))
    const root = parser(
      { trivia: ws },
      node(
        'Root',
        sequence(literal('a'), optional(ghost), literal('b')),
        (children, fields, span, rawChildren, trivia) => ({ children, fields, span, rawChildren, trivia }),
        { captureTrivia: true },
      ),
    ) as Combinator<unknown>
    const entries = engines(root)
    for (const input of ['ab', 'a b', 'abc!b']) {
      const source = run(entries.source, input)
      expect(run(entries.reference, input)).toEqual(source)
      expect(run(entries.closure, input)).toEqual(source)
      expect(run(entries.emitted, input)).toEqual(source)
    }
    expect(JSON.stringify(run(entries.closure, 'a b').value)).not.toContain('Ghost')
  })

  it('rolls back every manually live sink, including errors and root-trivia rows', () => {
    const mutate = gate(state => {
      const ctx = (state as { ctx: ReturnType<typeof createParseContext> }).ctx
      ctx._cstLeaves!.push({ ghost: 'leaf' } as never)
      ctx._cstRawChildren!.push({ ghost: 'raw' } as never)
      ctx._cstTriviaLog!.push(7, 8, 0)
      ctx._fields!.push({ name: 'ghost', value: 1, span: { start: 1, end: 1 } })
      ctx._errors!.push({ message: 'ghost' } as never)
      ctx._triviaLog!.push(7, 8)
      ctx._rootTriviaLog!.push(7, 8, 7, 8, 0)
      return true
    })
    const grammar = sequence(literal('a'), optional(sequence(mutate, literal('!'))), literal('b'))
    const prog = encodeTable({ Entry: grammar })
    const assembly = new AssemblyCache(closureArtifact(prog)).for(HOT)
    const ctx = createParseContext()
    assembly.begin(ctx)
    try {
      ctx._cstLeaves = []
      ctx._cstRawChildren = []
      ctx._cstTriviaLog = []
      ctx._fields = []
      ctx._errors = []
      ctx._triviaLog = []
      ctx._rootTriviaLog = []
      ctx.state = { ctx }
      expect(assembly.pieces.Entry!('ab', 0, ctx)).not.toBe(FAIL)
      expect(ctx._errors).toEqual([])
      expect(ctx._fields).toEqual([])
      expect(ctx._triviaLog).toEqual([])
      expect(ctx._rootTriviaLog).toEqual([])
      expect(ctx._cstTriviaLog).toEqual([])
      expect(JSON.stringify(ctx._cstLeaves)).not.toContain('ghost')
      expect(JSON.stringify(ctx._cstRawChildren)).not.toContain('ghost')
    } finally {
      assembly.finish()
    }
  })

  it('keeps routed fallback and nullable values exact', () => {
    const grammar = sequence(
      literal('a'),
      optional(dispatch(regex(/[a-z]+/), when('x', routed()), otherwise(routed()))),
      literal('!'),
    )
    agree(grammar, ['a!', 'ax!', 'aother!', 'ax?'])
  })

  it('restores assembly-local transaction slots across nested parses', () => {
    let nested: ReturnType<typeof tableRules>[string] | undefined
    let nestedRuns = 0
    const grammar = sequence(
      literal('a'),
      optional(transform(literal('x'), value => {
        nestedRuns++
        expect(run(nested!, 'ab')).toMatchObject({ ok: true, unconsumedFrom: null })
        return value
      })),
      literal('b'),
    )
    const prog = encodeTable({ Entry: grammar })
    nested = tableRules(closureArtifact(prog)).Entry!
    expect(run(nested, 'axb')).toMatchObject({ ok: true, value: ['a', 'x', 'b'], unconsumedFrom: null })
    expect(nestedRuns).toBe(1)
  })
})
