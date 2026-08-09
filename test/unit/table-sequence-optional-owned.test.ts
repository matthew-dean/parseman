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
import { markUnusedValues } from '../../src/compiler/value-usage.ts'

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

function directOptionalTerms(prog: ReturnType<typeof encodeTable>) {
  const out: Array<{ seq: number; op: number; index: number; optional: number }> = []
  for (const ip of reachableIps(prog)) {
    const op = prog.code[ip]
    if (op !== OP_SEQ && op !== OP_SEQV) continue
    const n = prog.code[ip + 1]!
    for (let i = 0; i < n; i++) {
      const child = prog.code[ip + 2 + i]!
      if (prog.code[child] === OP_OPT) out.push({ seq: ip, op, index: i, optional: child })
    }
  }
  return out
}

function activateAllSinks(ctx: ReturnType<typeof createParseContext>) {
  ctx._cstLeaves = []
  ctx._cstRawChildren = []
  ctx._cstTriviaLog = []
  ctx._fields = []
  ctx._errors = []
  ctx._triviaLog = []
  ctx._rootTriviaLog = []
}

function appendGhostSinks(ctx: ReturnType<typeof createParseContext>) {
  ctx._cstLeaves!.push({ ghost: 'leaf' } as never)
  ctx._cstRawChildren!.push({ ghost: 'raw' } as never)
  ctx._cstTriviaLog!.push(7, 8, 0)
  ctx._fields!.push({ name: 'ghost', value: 1, span: { start: 1, end: 1 } })
  ctx._errors!.push({ message: 'ghost' } as never)
  ctx._triviaLog!.push(7, 8)
  ctx._rootTriviaLog!.push(7, 8, 7, 8, 0)
}

describe('closure sequence-owned direct optional transaction', () => {
  it('removes the direct OP_OPT Piece only from the bounded hot parent shape', () => {
    const grammar = sequence(optional(literal('a')), literal('b'), optional(literal('c')))
    const prog = encodeTable({ Entry: grammar })
    const optionals = directOptionalTerms(prog)
    expect(optionals.map(x => x.index)).toEqual([0, 2])

    const hot = new AssemblyCache(closureArtifact(prog)).for(HOT)
    expect(hot.reached.has(optionals[0]!.optional), 'first optional stays legacy').toBe(true)
    // RED plant: link the OP_OPT row rather than its child in assemble.ts. This
    // exact assertion then observes the wrapper in `reached` and fails.
    expect(hot.reached.has(optionals[1]!.optional), 'later optional wrapper').toBe(false)

    for (const cfg of [
      { ...HOT, hostCst: true },
      { ...HOT, tolerant: true },
      { ...HOT, probe: true },
      { ...HOT, coverage: true },
      { ...HOT, trackLines: true },
    ]) {
      const cold = new AssemblyCache(closureArtifact(prog)).for(cfg)
      for (const term of optionals) expect(cold.reached.has(term.optional), JSON.stringify(cfg)).toBe(true)
    }

    const adjacentProg = encodeTable({ Entry: sequence(literal('a'), optional(literal('b')), adjacent(), literal('c')) })
    const adjacentOpt = directOptionalTerms(adjacentProg)
    expect(adjacentOpt).toHaveLength(1)
    expect(new AssemblyCache(closureArtifact(adjacentProg)).for(HOT).reached.has(adjacentOpt[0]!.optional)).toBe(true)

    const projectedProg = encodeTable({
      Entry: transform(sequence(optional(literal('a')), literal('b')), values => values[1]),
    })
    const projectedOpt = [...reachableIps(projectedProg)].find(ip => projectedProg.code[ip] === OP_OPT)!
    expect(new AssemblyCache(closureArtifact(projectedProg)).for(HOT).reached.has(projectedOpt)).toBe(true)
  })

  it('executes a real value-unused SEQV while owning its later optional', () => {
    const seq = sequence(optional(literal('a')), literal('b'), optional(literal('c')))
    const grammar = node('N', seq)
    markUnusedValues(grammar)
    const entries = engines(grammar)
    const terms = directOptionalTerms(entries.prog)
    expect(terms).toHaveLength(2)
    expect(terms.every(term => term.op === OP_SEQV)).toBe(true)
    const hot = new AssemblyCache(closureArtifact(entries.prog)).for(HOT)
    expect(hot.reached.has(terms[0]!.optional)).toBe(true)
    expect(hot.reached.has(terms[1]!.optional)).toBe(false)
    for (const input of ['b', 'ab', 'bc', 'abc', 'ab?']) {
      const source = run(entries.source, input)
      expect(run(entries.reference, input)).toEqual(source)
      expect(run(entries.closure, input)).toEqual(source)
      expect(run(entries.emitted, input)).toEqual(source)
    }
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
      appendGhostSinks(ctx)
      return true
    })
    const grammar = sequence(literal('a'), optional(sequence(mutate, literal('!'))), literal('b'))
    const prog = encodeTable({ Entry: grammar })
    const assembly = new AssemblyCache(closureArtifact(prog)).for(HOT)
    const ctx = createParseContext()
    assembly.begin(ctx)
    try {
      activateAllSinks(ctx)
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

  it('clears stale transaction scalars and publishes an absent later value', () => {
    const prog = encodeTable({
      Seed: sequence(literal('q'), literal('s')),
      Entry: sequence(literal('a'), optional(literal('x')), literal('b')),
      TriviaEntry: parser({ trivia: regex(/ +/) }, sequence(literal('a'), optional(literal('x')), literal('b'))),
    })
    const assembly = new AssemblyCache(closureArtifact(prog)).for(HOT)
    const ctx = createParseContext()
    assembly.begin(ctx)
    try {
      expect(assembly.pieces.Seed!('qs', 0, ctx)).toEqual(['q', 's'])
      ctx._fc = true
      // RED plants: remove `ctx._fc = false` or `TERMV = null` from the
      // optional miss transaction. The stale cut/value escapes into this row.
      expect(assembly.pieces.Entry!('ab', 0, ctx)).toEqual(['a', null, 'b'])
      expect(ctx._fc).toBe(false)
    } finally {
      assembly.finish()
    }

    const triviaCtx = createParseContext()
    assembly.begin(triviaCtx)
    try {
      expect(assembly.pieces.Seed!('qs', 0, triviaCtx)).toEqual(['q', 's'])
      triviaCtx._fc = true
      expect(assembly.pieces.TriviaEntry!('a  b', 0, triviaCtx)).toEqual(['a', null, 'b'])
      expect(triviaCtx._fc).toBe(false)
    } finally {
      assembly.finish()
    }
  })

  it('retains committed child sink effects instead of rolling them back', () => {
    const mutate = gate(state => {
      appendGhostSinks((state as { ctx: ReturnType<typeof createParseContext> }).ctx)
      return true
    })
    const grammar = sequence(
      literal('a'),
      optional(sequence(
        mutate,
        dispatch(literal('x'), when('x', sequence(routed(), literal('!')))),
      )),
      literal('z'),
    )
    const prog = encodeTable({ Entry: grammar })
    const assembly = new AssemblyCache(closureArtifact(prog)).for(HOT)
    const ctx = createParseContext()
    activateAllSinks(ctx)
    ctx.state = { ctx }
    assembly.begin(ctx)
    try {
      expect(assembly.pieces.Entry!('ax?', 0, ctx)).toBe(FAIL)
      expect(ctx._fc).toBe(true)
      // RED plant: roll the optional marks back before propagating a committed
      // child failure. Every deliberately appended sink below disappears.
      expect(JSON.stringify(ctx._cstLeaves)).toContain('ghost')
      expect(JSON.stringify(ctx._cstRawChildren)).toContain('ghost')
      expect(ctx._cstTriviaLog).toContain(7)
      expect(JSON.stringify(ctx._fields)).toContain('ghost')
      expect(JSON.stringify(ctx._errors)).toContain('ghost')
      expect(ctx._triviaLog).toContain(7)
      expect(ctx._rootTriviaLog).toContain(7)
    } finally {
      assembly.finish()
    }
  })

  it('restores local rollback marks after nested reentry then child failure', () => {
    let assembly: ReturnType<AssemblyCache['for']>
    const mutate = gate(state => {
      appendGhostSinks((state as { ctx: ReturnType<typeof createParseContext> }).ctx)
      return true
    })
    const nested = transform(literal('x'), value => {
      const inner = createParseContext()
      assembly.begin(inner)
      try {
        expect(assembly.pieces.Seed!('qst', 0, inner)).toEqual(['q', 's', 't'])
      } finally {
        assembly.finish()
      }
      return value
    })
    const grammar = sequence(
      literal('a'),
      optional(sequence(mutate, nested, literal('!'))),
      literal('x'),
    )
    const prog = encodeTable({
      Entry: grammar,
      Seed: sequence(literal('q'), optional(literal('s')), literal('t')),
    })
    assembly = new AssemblyCache(closureArtifact(prog)).for(HOT)
    const ctx = createParseContext()
    activateAllSinks(ctx)
    ctx.state = { ctx }
    assembly.begin(ctx)
    try {
      // RED plant: use post-child MRAW/MTL/MLV rather than the copied local
      // marks in optionalNext. The nested parse overwrites them and ghosts leak.
      expect(assembly.pieces.Entry!('ax', 0, ctx)).toEqual(['a', null, 'x'])
      expect(JSON.stringify(ctx._cstLeaves)).not.toContain('ghost')
      expect(ctx._cstLeaves?.map(leaf => (leaf as { value?: unknown }).value)).toEqual(['a', 'x'])
      expect(JSON.stringify(ctx._cstRawChildren)).not.toContain('ghost')
      expect(ctx._cstTriviaLog).not.toContain(7)
      expect(JSON.stringify(ctx._fields)).not.toContain('ghost')
      expect(JSON.stringify(ctx._errors)).not.toContain('ghost')
      expect(ctx._triviaLog).not.toContain(7)
      expect(ctx._rootTriviaLog).not.toContain(7)
    } finally {
      assembly.finish()
    }
  })

  it('leaves trailing ambient trivia unconsumed for zero-width or absent optionals', () => {
    const ws = regex(/ +/)
    const prog = encodeTable({
      Zero: sequence(literal('a'), optional(gate(() => true))),
      Miss: sequence(literal('a'), optional(literal('!'))),
    })
    const assembly = new AssemblyCache(closureArtifact(prog)).for(HOT)
    for (const [rule, input, expectedAt] of [['Zero', 'a  ', undefined], ['Miss', 'a  ?', 3]] as const) {
      const ctx = createParseContext()
      ctx.trivia = ws
      activateAllSinks(ctx)
      assembly.begin(ctx)
      try {
        expect(assembly.pieces[rule]!(input, 0, ctx)).not.toBe(FAIL)
        expect(assembly.end()).toBe(1)
        expect(ctx._triviaLog).toEqual([])
        expect(ctx._cstTriviaLog).toEqual([])
        if (expectedAt !== undefined) expect(ctx._fe).toBe(expectedAt)
      } finally {
        assembly.finish()
      }
    }
    // RED plants: return scanEnd rather than cur, or omit the scanned-trivia
    // rollback in optionalNext. The consumed span/result above changes.
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
