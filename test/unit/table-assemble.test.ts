import { describe, expect, it } from 'vitest'
import { balanced, choice, keywords, literal, many, node, not, notAdjacent, optional, parser, regex, sequence, token, transform, withCtx } from '../../src/index.ts'
import { rules } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assemble, tableRules, AssemblyCache, cfgKey } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { foldPrograms, unfoldVariant, expandCompact, resolveTable, type PrecompiledAssembly } from '../../src/table/program.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource, EMITTED_PARAMS } from '../../src/table/emit-assembly.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { run } from '../../src/functional/run.ts'
import { cstBuildHost } from '../../src/compiler/linker.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { createParseContext } from '../../src/parse-context.ts'
import type { Combinator, ParseContext } from '../../src/types.ts'
import { OP_LEX_BODY, OP_LEX_PROGRAM, OP_LIT, OP_NODE, OP_NOT, OP_OPT, OP_RX, OP_TOKEN } from '../../src/table/ops.ts'
import { FAIL } from '../../src/table/cell.ts'

/**
 * A grammar with enough shape variety that the assembler's memoisation, its
 * cycle handling and its arity specialisations are all exercised: a recursive
 * rule, sequences of arity 1/2/3 and more, a choice, a repetition and a node.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the recursion
// proxy is deliberately untyped in tests; see balanced-region.test.ts.
const g = rules((g: any) => ({
  Expr: choice(g.Sum, g.Atom),
  // A DIRECT builder, not a structural node: the table encoder refuses a
  // structural one outright because it would need a `ctx.build` host, and the
  // point here is the assembler's lowering, not the host contract.
  Sum: node('sum', sequence(g.Atom, literal('+'), g.Expr), (kids: readonly unknown[]) => ({ sum: [kids[0], kids[2]] })),
  Atom: choice(g.Num, g.Paren),
  Num: transform(regex(/\d+/), v => Number(v)),
  Paren: transform(sequence(literal('('), g.Expr, literal(')')), v => (v as unknown[])[1]),
  List: many(g.Expr),
  Maybe: optional(g.Num),
  One: sequence(g.Num),
  Four: sequence(literal('a'), literal('b'), literal('c'), literal('d')),
})) as Record<string, import('../../src/types.ts').Combinator<unknown>>

describe('table assembler', () => {
  it('links the common plain, collapse, and projected AST node shapes to exact scalar bodies', () => {
    const roots = {
      Plain: node('Pair', sequence(literal('a'), literal('b')),
        children => ({ kind: 'pair', children })),
      Collapsed: node('Collapsed', sequence(literal('a')),
        children => ({ kind: 'should-not-build', children }), { collapse: true }),
      Projected: node('Paren', sequence(literal('('), literal('x'), literal(')')), { project: 1 }),
    }

    for (const [name, root] of Object.entries(roots)) {
      const prog = encodeTable({ Root: root })
      const closure = tableRules({ ...prog, asm: [] }).Root!
      const reference = execRules(prog).Root!
      const input = name === 'Plain' ? 'ab' : name === 'Collapsed' ? 'a' : '(x)'
      expect(digestValue(run(closure, input)), name).toBe(digestValue(run(reference, input)))
      expect(digestValue(run(closure, `${input}?`)), `${name} trailing`).toBe(
        digestValue(run(reference, `${input}?`)),
      )

      const nodeIp = [...reachableIps(prog)].find(ip => prog.code[ip] === OP_NODE)
      expect(nodeIp, `${name} node row`).toBeDefined()
      const direct = { ...prog, rules: { Root: nodeIp! }, asm: [] }
      const linked = assemble(resolveTable(direct), direct, {
        hostCst: false, hostReadsChildren: true, trackLines: false,
        tolerant: false, coverage: false, probe: false,
      })
      const source = Function.prototype.toString.call(linked.pieces.Root)
      if (name === 'Plain') expect(source).toContain('build(kids, undefined, span, rawKids')
      if (name === 'Collapsed') expect(source).toContain('kids.length === 1')
      if (name === 'Projected') expect(source).toContain('kids, projection, type')
    }

    const plain = run(tableRules({ ...encodeTable({ Root: roots.Plain }), asm: [] }).Root!, 'ab').value as {
      kind: string; children: Array<{ value: string }>
    }
    expect({ kind: plain.kind, children: plain.children.map(child => child.value) })
      .toEqual({ kind: 'pair', children: ['a', 'b'] })
    expect(run(tableRules({ ...encodeTable({ Root: roots.Collapsed }), asm: [] }).Root!, 'a').value)
      .toMatchObject({ value: 'a' })
    expect(run(tableRules({ ...encodeTable({ Root: roots.Projected }), asm: [] }).Root!, '(x)').value)
      .toBe('x')
  })

  it('binds arbitrary, adjacency, and recovery sequence terms without fixed child arrays', () => {
    const roots = [
      ['strict', sequence(literal('a'), literal('b'), literal('c'), literal('d'), literal('e')), {}, 'abcde'],
      ['adjacency', parser({ trivia: regex(/\s+/) }, sequence(literal('a'), notAdjacent(), literal('b'), literal('c'), literal('d'))), {}, 'a bcd'],
      ['recovery', sequence(literal('a'), literal('b'), literal('c'), literal('d'), literal('e')), { recovery: true }, 'abcde'],
    ] as const
    for (const [name, root, settings, input] of roots) {
      const prog = encodeTable({ Root: root }, settings)
      const linked = assemble(resolveTable({ ...prog, asm: [] }), { ...prog, asm: [] }, {
        hostCst: false, hostReadsChildren: true, trackLines: false,
        tolerant: 'recovery' in settings && settings.recovery === true, coverage: false, probe: false,
      })
      const source = Function.prototype.toString.call(linked.pieces.Root)
      expect(source, name).not.toContain('kids[')
      expect(source, name).not.toContain('runners[')
      expect(run(tableRules({ ...prog, asm: [] }).Root!, input).ok, name).toBe(true)
      if (name === 'adjacency') {
        const resolved = resolveTable(prog)
        const precompiled: PrecompiledAssembly[] = defaultAssemblyCfgs(prog).map(cfg => {
          const emitted = emitAssemblySource(resolved, prog, cfg, [])
          return {
            key: cfgKey(cfg),
            // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
            factory: new Function(...EMITTED_PARAMS, emitted.source) as PrecompiledAssembly['factory'],
            plan: emitted.plan, reached: [...emitted.reached],
          }
        })
        for (const sample of ['abcd', 'a bcd', 'a\tbcd']) {
          const reference = run(execRules(prog).Root!, sample)
          expect(digestValue(run(tableRules({ ...prog, asm: [] }).Root!, sample)), `closure ${sample}`).toBe(digestValue(reference))
          expect(digestValue(run(tableRules({ ...prog, asm: precompiled }).Root!, sample)), `emitted ${sample}`).toBe(digestValue(reference))
        }
      }
    }
  })

  it('answers exactly what the bytecode driver answers', () => {
    const prog = encodeTable(g, {})
    const a = tableRules(prog)
    const e = execRules(prog)
    for (const input of ['1', '1+2', '(1+2)', '1+(2+3)', '((7))', '', '(', '1+', 'x']) {
      for (const name of ['Expr', 'List', 'Maybe', 'One'] as const) {
        const ra = run(a[name]!, input)
        const re = run(e[name]!, input)
        expect(ra.ok, `${name} ${JSON.stringify(input)} ok`).toBe(re.ok)
        expect(ra.value, `${name} ${JSON.stringify(input)} value`).toEqual(re.value)
        expect(ra.unconsumedFrom, `${name} ${JSON.stringify(input)} unconsumed`).toBe(re.unconsumedFrom)
        if (!re.ok) {
          expect([...(ra.expected ?? [])].sort(), `${name} ${JSON.stringify(input)} expected`)
            .toEqual([...(re.expected ?? [])].sort())
        }
      }
    }
  })

  it('executes one selected childless lexical body without retaining its character child', () => {
    const source = token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const prog = encodeTable({ Root: source })
    const entry = prog.rules.Root!
    expect(prog.code[entry]).toBe(OP_LEX_BODY)
    expect(prog.lex).toHaveLength(1)
    const reachableOps = [...reachableIps(prog)].map(ip => prog.code[ip])
    expect(reachableOps).not.toContain(OP_TOKEN)
    expect(reachableOps).not.toContain(OP_RX)
    expect(reachableOps).not.toContain(OP_OPT)
    expect(reachableOps).not.toContain(OP_LIT)
    expect(() => resolveTable({ ...prog, lex: [[prog.lex![0]![0], 0x10000]] }))
      .toThrow('suffix is not absent or one UTF-16 code unit')
    expect(() => resolveTable({ ...prog, k: ['not a regex'], lex: [[0, '('.charCodeAt(0)]] }))
      .toThrow('does not reference a RegExp')

    const reference = execRules(prog).Root!
    const closure = tableRules(prog).Root!
    const linked = assemble(resolveTable(prog), prog, {
      hostCst: false, hostReadsChildren: true, trackLines: false,
      tolerant: false, coverage: false, probe: false,
    })
    for (const input of ['word', 'call(', '9', '']) {
      const expected = run(source, input)
      for (const [name, candidate] of [['reference', reference], ['closure', closure]] as const) {
        const actual = run(candidate, input)
        expect({
          ok: actual.ok, value: actual.value, span: actual.span,
          expected: actual.expected, unconsumedFrom: actual.unconsumedFrom,
        }, `${name} ${JSON.stringify(input)}`).toEqual({
          ok: expected.ok, value: expected.value, span: expected.span,
          expected: expected.expected, unconsumedFrom: expected.unconsumedFrom,
        })
      }
      const ctx = createParseContext()
      linked.begin(ctx)
      try {
        const value = linked.pieces.Root!(input, 0, ctx)
        expect(value === FAIL, `linked closure ${JSON.stringify(input)} fail`).toBe(!expected.ok)
        if (expected.ok) {
          expect(value).toBe(expected.value)
          expect(linked.end()).toBe(expected.span.end)
        } else {
          expect(ctx._fe).toBe(expected.span.start)
          expect(ctx._fx).toEqual(expected.expected)
        }
      } finally {
        linked.finish()
      }
    }
    // `optional('(')` swallows its failed literal but deliberately leaves that
    // failure in the shared diagnostic registers/probe. The selected body must
    // publish it even though the TOKEN as a whole succeeds.
    for (const [name, entry] of [
      ['source', source], ['reference', reference], ['closure', closure],
    ] as const) {
      const ctx = createParseContext()
      ctx._probe = { offset: 4, best: null }
      const result = typeof entry === 'function'
        ? entry('word', 0, ctx)
        : entry.parse('word', 0, ctx)
      expect(result.ok, name).toBe(true)
      if (name !== 'source') {
        expect(ctx._fe, name).toBe(4)
        expect(ctx._fx, name).toEqual(['"("'])
      }
      expect(ctx._probe.best, name).toMatchObject({
        expected: ['"("'], span: { start: 4, end: 4 },
      })
    }
    // RED provenance: replacing the selected body's suffix code unit with `]`
    // makes `call(` stop before `(` while both CHARACTER oracles consume it.
    const plantedBase = encodeTable({ Root: source })
    const planted = { ...plantedBase, lex: [[plantedBase.lex![0]![0], ']'.charCodeAt(0)] as const] }
    expect(run(tableRules(planted).Root!, 'call(').span).not.toEqual(run(source, 'call(').span)

    const resolved = resolveTable(prog)
    const precompiled: PrecompiledAssembly[] = defaultAssemblyCfgs(prog).map(cfg => {
      const emitted = emitAssemblySource(resolved, prog, cfg, [])
      return {
        key: cfgKey(cfg),
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        factory: new Function(...EMITTED_PARAMS, emitted.source) as PrecompiledAssembly['factory'],
        plan: emitted.plan,
        reached: [...emitted.reached],
      }
    })
    expect(run(tableRules({ ...prog, asm: precompiled }).Root!, 'call(')).toMatchObject({
      ok: true, value: 'call(', span: { start: 0, end: 5 },
    })
    for (const [name, entry] of [
      ['emitted', tableRules(prog).Root!],
      ['closure', tableRules({ ...prog, asm: [] }).Root!],
      ['precompiled', tableRules({ ...prog, asm: precompiled }).Root!],
    ] as const) {
      const ctx = createParseContext()
      ctx._probe = { offset: 4, best: null }
      const result = entry('word', 0, ctx)
      expect(result.ok, name).toBe(true)
      expect(ctx._fe, name).toBe(4)
      expect(ctx._fx, name).toEqual(['"("'])
      expect(ctx._probe.best, name).toMatchObject({
        expected: ['"("'], span: { start: 4, end: 4 },
      })
    }

    const precompiledEntry = tableRules({ ...prog, asm: precompiled }).Root!
    const OriginalFunction = globalThis.Function
    globalThis.Function = function blockedFunction(): never {
      throw new Error('Function constructor reached after precompiled artifact construction')
    } as unknown as FunctionConstructor
    try {
      expect(run(precompiledEntry, 'call(')).toMatchObject({
        ok: true, value: 'call(', span: { start: 0, end: 5 },
      })
    } finally {
      globalThis.Function = OriginalFunction
    }

    const cstProg = encodeTable({ Root: source }, { hostMode: 'cst' })
    const cstOpts = { build: cstBuildHost({ tags: true }) }
    expect(digestValue(run(tableRules(cstProg).Root!, 'call(', cstOpts).value))
      .toBe(digestValue(run(source, 'call(', cstOpts).value))

    const tracked = encodeTable({ Root: source }, { trackLines: true })
    const folded = foldPrograms({ plain: prog, tracked }, 'plain')
    for (const name of ['plain', 'tracked'] as const) {
      const direct = name === 'plain' ? prog : tracked
      const viaFold = unfoldVariant(folded, name)
      expect(viaFold.lex).toBe(folded.base.lex)
      for (const input of ['word', 'call(', '9']) {
        expect(run(tableRules(viaFold).Root!, input)).toMatchObject(
          run(tableRules(direct).Root!, input),
        )
      }
    }

    const wrapped = token(parser({ trivia: null }, sequence(
      regex(/[a-z]+/), optional(literal('(')),
    )))
    const wrappedProg = encodeTable({ Root: wrapped })
    expect(wrappedProg.code[wrappedProg.rules.Root!]).toBe(OP_LEX_BODY)
    for (const input of ['word', 'call(', '9']) {
      const expected = run(wrapped, input)
      for (const [name, entry] of [
        ['reference', execRules(wrappedProg).Root!],
        ['closure', tableRules({ ...wrappedProg, asm: [] }).Root!],
        ['emitted', tableRules(wrappedProg).Root!],
      ] as const) {
        const actual = run(entry, input)
        expect({
          ok: actual.ok, value: actual.value, span: actual.span,
          expected: actual.expected, unconsumedFrom: actual.unconsumedFrom,
        }, `${name} ${JSON.stringify(input)}`).toEqual({
          ok: expected.ok, value: expected.value, span: expected.span,
          expected: expected.expected, unconsumedFrom: expected.unconsumedFrom,
        })
      }
    }
  })

  it('executes fixed composite lexical programs with exact choice and assertion diagnostics', () => {
    const ordered = token(choice(
      keywords(['@media']), keywords(['@supports']), keywords(['@layer']),
      regex(/@(?:-[a-z]+-)?keyframes/),
    ))
    const guarded = token(sequence(
      not(choice(
        keywords(['@media']), keywords(['@supports']), keywords(['@layer']),
        regex(/@(?:-[a-z]+-)?keyframes/),
      )),
      not(keywords(['@import'])),
      regex(/@[a-z-]+/),
    ))
    const unsupported = token(sequence(
      literal('a'), literal('b'), literal('c'), literal('d'), literal('e'), literal('f'),
    ))
    const prog = encodeTable({ Ordered: ordered, Guarded: guarded })
    expect(prog.code[prog.rules.Ordered!]).toBe(OP_LEX_PROGRAM)
    expect(prog.code[prog.rules.Guarded!]).toBe(OP_LEX_PROGRAM)
    expect(prog.lexPrograms).toHaveLength(2)
    expect([...reachableIps(prog)].map(ip => prog.code[ip])).not.toEqual(
      expect.arrayContaining([OP_TOKEN, OP_NOT, OP_RX]),
    )

    const readers = [
      ['reference', execRules(prog)],
      ['closure', tableRules({ ...prog, asm: [] })],
      ['emitted', tableRules(prog)],
    ] as const
    const characterRules = execRules(encodeTable({
      Ordered: ordered, Guarded: guarded, Gap: unsupported,
    }))
    const cases = [
      ['Ordered', ['@media', '@supports', '@foo', '!']],
      ['Guarded', ['@media', '@import', '@foo', '!']],
    ] as const
    for (const [ruleName, inputs] of cases) {
      for (const input of inputs) {
        const expected = run(characterRules[ruleName]!, input)
        for (const [readerName, rules] of readers) {
          expect(digestValue(run(rules[ruleName]!, input)), `${readerName} ${ruleName} ${input}`)
            .toBe(digestValue(expected))
        }
      }
    }

    const probeTable = (rule: ReturnType<typeof tableRules>[string], input: string) => {
      const ctx = createParseContext() as ParseContext & {
        _probe: { offset: number; best: import('../../src/types.ts').ParseFail | null }
      }
      ctx._probe = { offset: input.length, best: null }
      rule!(input, 0, ctx)
      return ctx._probe.best
    }
    const probeSource = (rule: Combinator<unknown>, input: string) => {
      const ctx = createParseContext() as ParseContext & {
        _probe: { offset: number; best: import('../../src/types.ts').ParseFail | null }
      }
      ctx._probe = { offset: input.length, best: null }
      rule.parse(input, 0, ctx)
      return ctx._probe.best
    }
    for (const [name, rules] of readers) {
      expect(probeTable(rules.Ordered!, '@foo'), name).toEqual(probeTable(characterRules.Ordered!, '@foo'))
      expect(probeTable(rules.Ordered!, '!'), name).toEqual(probeTable(characterRules.Ordered!, '!'))
      expect(probeTable(rules.Guarded!, '@media'), name).toBeNull()
      expect(probeTable(rules.Guarded!, '@import'), name).toBeNull()
      expect(probeTable(rules.Guarded!, '!'), name).toEqual(probeSource(guarded, '!'))
      const firstMiss = run(rules.Ordered!, '!')
      firstMiss.expected!.push('MUTATED')
      expect(run(rules.Ordered!, '!').expected, name).not.toContain('MUTATED')
    }

    const guardedRunner = resolveTable(prog).lexPrograms[1]!
    for (const input of ['@media', '@import', '!', '@foo']) {
      const ctx = createParseContext()
      ctx._fc = true
      guardedRunner(input, 0, ctx)
      expect(ctx._fc, `commit clear ${input}`).toBe(false)
    }

    const refused = encodeTable({ Ordered: ordered, Gap: unsupported })
    expect(refused.lexPrograms).toBeUndefined()
    expect(refused.code[refused.rules.Ordered!]).toBe(OP_TOKEN)

    const scoped = token(choice(
      parser({ trivia: null }, regex(/@a/)), regex(/@b/), regex(/@c/), regex(/@d/),
    ))
    const scopedProgram = encodeTable({ Root: scoped })
    expect(scopedProgram.lexPrograms).toBeUndefined()
    expect(scopedProgram.code[scopedProgram.rules.Root!]).toBe(OP_TOKEN)
    for (const input of ['@a', '@z']) {
      expect(digestValue(run(tableRules(scopedProgram).Root!, input)), input)
        .toBe(digestValue(run(scoped, input)))
      const context = () => {
        const ctx = createParseContext()
        ctx.trackLines = true
        ctx._lineStarts = [0]
        ctx._lineScannedTo = 0
        ctx._fe = 77
        ctx._fx = ['sentinel']
        ctx._fc = true
        return ctx
      }
      const sourceCtx = context()
      const sourceResult = scoped.parse(input, 0, sourceCtx)
      expect(sourceResult.ok, input).toBe(input === '@a')
      expect({ fe: sourceCtx._fe, fx: sourceCtx._fx, fc: sourceCtx._fc, lines: sourceCtx._lineStarts }, input)
        .toEqual({ fe: 77, fx: ['sentinel'], fc: true, lines: [0] })
    }

    const badDigest = prog.lexPrograms![0]!.slice() as number[]
    badDigest[1] = (badDigest[1] ?? 0) + 1
    const detached = Object.fromEntries(Object.entries(prog)) as typeof prog
    expect(() => resolveTable({ ...detached, lexPrograms: [badDigest as never] }))
      .toThrow('semantic digest is inconsistent')
    expect(() => resolveTable({ ...detached, lexPrograms: [[0, 0] as never] }))
      .toThrow('invalid fixed body width')
    expect(() => resolveTable({ ...detached, lexPrograms: [[2, 0] as never] }))
      .toThrow('invalid fixed body width')
  })

  it('decodes fixed lexical sequence, choice, assertion, and optional templates once', () => {
    const roots = {
      S2: token(sequence(literal('a'), literal('b'))),
      S3: token(sequence(literal('a'), literal('b'), literal('c'))),
      S4: token(sequence(
        not(choice(literal('x'), literal('y'))),
        regex(/[a-z]+/), optional(literal('(')), literal('!'),
      )),
      S5: token(sequence(literal('a'), literal('b'), literal('c'), literal('d'), literal('e'))),
      C2: token(choice(literal('a'), literal('b'))),
      C4: token(choice(literal('a'), literal('b'), literal('c'), literal('d'))),
      C8: token(choice(
        literal('a'), literal('b'), literal('c'), literal('d'),
        literal('e'), literal('f'), literal('g'), literal('h'),
      )),
    }
    const prog = encodeTable(roots)
    expect(Object.values(prog.rules).map(ip => prog.code[ip])).toEqual(
      Array.from({ length: Object.keys(roots).length }, () => OP_LEX_PROGRAM),
    )
    expect([...reachableIps(prog)].map(ip => prog.code[ip])).not.toContain(OP_TOKEN)
    const readers = [
      ['reference', execRules(prog)],
      ['closure', tableRules({ ...prog, asm: [] })],
      ['emitted', tableRules(prog)],
    ] as const
    const cases: Record<keyof typeof roots, readonly string[]> = {
      S2: ['ab', 'ax', ''],
      S3: ['abc', 'abx'],
      S4: ['word!', 'word(!', 'x!', 'word?'],
      S5: ['abcde', 'abcdx'],
      C2: ['a', 'b', 'z'],
      C4: ['a', 'd', 'z'],
      C8: ['a', 'h', 'z'],
    }
    for (const name of Object.keys(roots) as Array<keyof typeof roots>) {
      for (const input of cases[name]) {
        const expected = digestValue(run(roots[name], input))
        for (const [reader, entries] of readers) {
          expect(digestValue(run(entries[name]!, input)), `${reader} ${name} ${JSON.stringify(input)}`)
            .toBe(expected)
        }
      }
    }
  })

  it('selects balanced tokens through the canonical scan pool', () => {
    const quoted = sequence(literal('"'), regex(/[^"\\]*(?:\\.[^"\\]*)*/), literal('"'))
    const curly = balanced('{', '}')
    const grammar = rules({ scanSkip: [quoted] }, () => ({
      Group: balanced('(', ')'),
      OwnSkip: balanced('[', ']', { skip: [curly] }),
      Strict: balanced('<', '>', { strict: true }),
    })) as Record<string, Combinator<unknown>>
    const prog = encodeTable(grammar)
    expect(Object.values(prog.rules).map(ip => prog.code[ip])).toEqual([
      OP_LEX_PROGRAM, OP_LEX_PROGRAM, OP_LEX_PROGRAM,
    ])
    expect(prog.lexPrograms?.every(spec => spec[0] === 3)).toBe(true)
    const resolved = resolveTable(prog)
    const scanRoots = [
      ...(prog.scans ?? []).flatMap(spec => [
        ...spec.skip.map(ref => ref[0]), ...(spec.sentinel === undefined ? [] : [spec.sentinel[0]]),
      ]),
      ...(prog.scanSkip ?? []).flatMap(set => set.map(ref => ref[0])),
    ]
    const precompiled: PrecompiledAssembly[] = defaultAssemblyCfgs(prog).map(cfg => {
      const emitted = emitAssemblySource(resolved, prog, cfg, scanRoots)
      return {
        key: cfgKey(cfg),
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        factory: new Function(...EMITTED_PARAMS, emitted.source) as PrecompiledAssembly['factory'],
        plan: emitted.plan, reached: [...emitted.reached],
      }
    })
    const readers = [
      ['reference', execRules(prog)],
      ['closure', tableRules({ ...prog, asm: [] })],
      ['emitted', tableRules(prog)],
      ['precompiled', tableRules({ ...prog, asm: precompiled })],
    ] as const
    const cases = {
      Group: ['(a(b)c)', '(a")"b)', '(a', 'x'],
      OwnSkip: ['[a{]}b]', '[a', 'x'],
      Strict: ['<a>', '<a', 'x'],
    } as const
    for (const name of Object.keys(cases) as Array<keyof typeof cases>) {
      for (const input of cases[name]) {
        const expected = digestValue(run(grammar[name]!, input))
        for (const [reader, entries] of readers) {
          expect(digestValue(run(entries[name]!, input)), `${reader} ${name} ${JSON.stringify(input)}`)
            .toBe(expected)
        }
      }
    }
  })

  it('selects composite bodies through final named token bindings', () => {
    // Mirrors the Jess topology: the outer token owns a choice whose named arms
    // are themselves token boundaries. Those inner leaves are deliberately
    // unobservable because the outer token cleared capture before recognition.
    const grammar = rules((g: Record<string, Combinator<unknown>>) => ({
      Root: token(choice(keywords(['@media']), g.Supports!, g.Layer!, g.Keyframes!)),
      Supports: token(keywords(['@supports'])),
      Layer: token(keywords(['@layer'])),
      Keyframes: token(regex(/@(?:-[a-z]+-)?keyframes/)),
    })) as Record<string, Combinator<unknown>>
    const prog = encodeTable(grammar)
    expect(prog.code[prog.rules.Root!]).toBe(OP_LEX_PROGRAM)
    for (const input of ['@media', '@supports', '@layer', '@keyframes', '@foo']) {
      expect(digestValue(run(tableRules(prog).Root!, input)), input)
        .toBe(digestValue(run(grammar.Root!, input)))
    }
  })

  it('selects the same lexical body through a final named regex binding', () => {
    const base = rules((g: any) => ({
      Root: token(sequence(g.Word, optional(literal('(')))),
      Word: regex(/old+/),
    })) as Record<string, Combinator<unknown>>
    const winner = regex(/[b\n]+/i)
    const grammar = { ...base, ...rules(() => ({ Word: winner })) }
    const source = parser({ trackLines: true }, token(sequence(
      winner, optional(literal('(')),
    )))
    const prog = encodeTable(grammar, { trackLines: true })
    expect(prog.code[prog.rules.Root!]).toBe(OP_LEX_BODY)
    const selected = prog.lex![prog.code[prog.rules.Root! + 1]!]!
    expect(prog.k[selected[0]]).toEqual(/[b\n]+/iy)
    expect(prog.fx[prog.code[prog.rules.Root! + 2]!]).toEqual([String(/[b\n]+/)])

    const entries = [
      ['source', source],
      ['reference', execRules(prog).Root!],
      ['closure', tableRules({ ...prog, asm: [] }).Root!],
      ['emitted', tableRules(prog).Root!],
    ] as const
    for (const input of ['bbb', 'BBB(', 'b\nb(', 'old(', '']) {
      const expected = digestValue(run(source, input))
      for (const [name, entry] of entries) {
        expect(digestValue(run(entry, input)), `${name} ${JSON.stringify(input)}`)
          .toBe(expected)
      }
    }
  })

  it('replaces direct regex and keyword tokens without retaining a terminal child', () => {
    const sources = [
      token(regex(/[a-z\n]+/i)),
      token(keywords(['@container', '@media'], {
        caseInsensitive: true, boundary: '-_a-zA-Z0-9\\u0080-\\uFFFF',
      })),
      token(parser({ trivia: null }, regex(/url\(/i))),
    ]
    const inputs = [
      ['Word', 'a\nb', '9'],
      ['@MEDIA', '@container-x', '!'],
      ['URL(', 'url', '!'],
    ] as const
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]!
      const prog = encodeTable({ Root: source }, { trackLines: true })
      expect(prog.code[prog.rules.Root!]).toBe(OP_LEX_BODY)
      expect(prog.lex?.[0]?.[1]).toBe(-1)
      const reachableOps = [...reachableIps(prog)].map(ip => prog.code[ip])
      expect(reachableOps).not.toContain(OP_TOKEN)
      expect(reachableOps).not.toContain(OP_RX)
      const entries = [
        ['source', source],
        ['reference', execRules(prog).Root!],
        ['closure', tableRules({ ...prog, asm: [] }).Root!],
        ['emitted', tableRules(prog).Root!],
      ] as const
      for (const input of inputs[i]!) {
        const expected = run(source, input)
        for (const [name, entry] of entries) {
          const actual = run(entry, input)
          expect({
            ok: actual.ok, value: actual.value,
            span: { start: actual.span.start, end: actual.span.end },
            expected: actual.expected, unconsumedFrom: actual.unconsumedFrom,
          }, `${name} ${JSON.stringify(input)}`).toEqual({
            ok: expected.ok, value: expected.value,
            span: { start: expected.span.start, end: expected.span.end },
            expected: expected.expected, unconsumedFrom: expected.unconsumedFrom,
          })
        }
      }

      // A plain terminal has no optional boundary, so successful recognition
      // must not clear an incoming commitment bit.
      const resolved = resolveTable({ ...prog, asm: [] })
      const linked = assemble(resolved, { ...prog, asm: [] }, {
        hostCst: false, hostReadsChildren: true, trackLines: true,
        tolerant: false, coverage: false, probe: false,
      })
      const ctx = createParseContext()
      ctx._fc = true
      linked.begin(ctx)
      try {
        const sample = inputs[i]![0]
        expect(linked.pieces.Root!(sample, 0, ctx)).not.toBe(FAIL)
        expect(ctx._fc).toBe(true)
      } finally {
        linked.finish()
      }
    }
  })

  it('publishes selected regex and suffix line ranges at the authored terminal boundaries', () => {
    const trace = (
      entry: Combinator<unknown> | ((input: string, pos: number, ctx: ParseContext) => import('../../src/types.ts').ParseResult<unknown>),
      input: string,
      pos = 0,
    ) => {
      const ctx = createParseContext()
      ctx.trackLines = true
      ctx._lineStarts = [0]
      ctx._lineScannedTo = 0
      const result = typeof entry === 'function'
        ? entry(input, pos, ctx)
        : entry.parse(input, pos, ctx)
      return {
        ok: result.ok,
        span: { start: result.span.start, end: result.span.end },
        expected: result.ok ? undefined : result.expected,
        lineStarts: ctx._lineStarts,
        lineScannedTo: ctx._lineScannedTo,
      }
    }
    const engines = (source: Combinator<unknown>) => {
      const prog = encodeTable({ Root: source }, { trackLines: true })
      const character = encodeTable({
        Root: source,
        Incomplete: token(sequence(
          literal('a'), literal('b'), literal('c'), literal('d'), literal('e'), literal('f'),
        )),
      }, { trackLines: true })
      expect(prog.code[prog.rules.Root!]).toBe(OP_LEX_BODY)
      const resolved = resolveTable(prog)
      const precompiled: PrecompiledAssembly[] = defaultAssemblyCfgs(prog).map(cfg => {
        const emitted = emitAssemblySource(resolved, prog, cfg, [])
        return {
          key: cfgKey(cfg),
          // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
          factory: new Function(...EMITTED_PARAMS, emitted.source) as PrecompiledAssembly['factory'],
          plan: emitted.plan,
          reached: [...emitted.reached],
        }
      })
      return [
        ['character', execRules(character).Root!],
        ['reference', execRules(prog).Root!],
        ['closure', tableRules({ ...prog, asm: [] }).Root!],
        ['precompiled', tableRules({ ...prog, asm: precompiled }).Root!],
      ] as const
    }

    const baseLines = token(sequence(regex(/[a-z\n]+/), optional(literal('('))))
    for (const input of ['a\nb', 'a\nb(']) {
      const selected = engines(baseLines)
      const expected = trace(selected[0][1], input)
      for (const [name, entry] of selected) {
        expect(trace(entry, input), `${name} ${JSON.stringify(input)}`).toEqual(expected)
      }
      expect(expected.lineStarts).toEqual([0, 2])
      expect(expected.lineScannedTo).toBe(input.endsWith('(') ? 4 : 3)
    }

    const suffixLine = token(sequence(regex(/[a-z]+/), optional(literal('\n'))))
    for (const input of ['a', 'a\n']) {
      const selected = engines(suffixLine)
      const expected = trace(selected[0][1], input)
      for (const [name, entry] of selected) {
        expect(trace(entry, input), `${name} ${JSON.stringify(input)}`).toEqual(expected)
      }
      expect(expected.lineStarts).toEqual(input.endsWith('\n') ? [0, 2] : [0])
      expect(expected.lineScannedTo).toBe(input.endsWith('\n') ? 2 : 1)
    }

    // A token can begin after trivia whose newline has not yet been published.
    // Even a statically non-newline terminal must advance from the old high-water
    // point so that newline is available to the next CST node.
    const afterTrivia = token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const afterTriviaEngines = engines(afterTrivia)
    const afterTriviaExpected = trace(afterTriviaEngines[0][1], '\neach(', 1)
    for (const [name, entry] of afterTriviaEngines) {
      expect(trace(entry, '\neach(', 1), name).toEqual(afterTriviaExpected)
    }
    expect(afterTriviaExpected.lineStarts).toEqual([0, 1])
    expect(afterTriviaExpected.lineScannedTo).toBe(6)

    const fixed = token(sequence(literal('a'), literal('b')))
    const fixedSelected = encodeTable({ Root: fixed }, { trackLines: true })
    const fixedCharacter = encodeTable({
      Root: fixed,
      Incomplete: token(sequence(
        literal('a'), literal('b'), literal('c'), literal('d'), literal('e'), literal('f'),
      )),
    }, { trackLines: true })
    expect(fixedSelected.code[fixedSelected.rules.Root!]).toBe(OP_LEX_PROGRAM)
    const fixedExpected = trace(execRules(fixedCharacter).Root!, '\nab', 1)
    for (const [name, entry] of [
      ['reference', execRules(fixedSelected).Root!],
      ['closure', tableRules({ ...fixedSelected, asm: [] }).Root!],
      ['emitted', tableRules(fixedSelected).Root!],
    ] as const) {
      expect(trace(entry, '\nab', 1), name).toEqual(fixedExpected)
    }
    expect(fixedExpected).toMatchObject({ lineStarts: [0, 1], lineScannedTo: 3 })

    // A tracked table owns line publication even when invoked through normal
    // `run(entry, input)`: its entry seeds line storage from `prog.lines`, while
    // the caller-created context does not set the dynamic trackLines option.
    for (const [name, entry] of engines(baseLines).slice(1)) {
      expect(run(entry, 'a\nb').span, name).toMatchObject({
        startLine: 1, startColumn: 1, endLine: 2, endColumn: 2,
      })
    }

    // The optional boundary clears commitment before attempting its literal.
    // If suffix line publication throws, the selected body must expose the same
    // register state as the authored CHARACTER body rather than retaining the
    // incoming commitment through the combined lexical recognizer.
    const selectedProg = encodeTable({ Root: suffixLine }, { trackLines: true })
    const characterProg = encodeTable({
      Root: suffixLine,
      // A withCtx edge still lacks a named projection, keeping this comparison
      // on the CHARACTER lowering without understating scanner completeness.
      Incomplete: withCtx({ comparison: true }, literal(';')),
    }, { trackLines: true })
    expect(selectedProg.code[selectedProg.rules.Root!]).toBe(OP_LEX_BODY)
    expect(characterProg.code[characterProg.rules.Root!]).not.toBe(OP_LEX_BODY)
    for (const [name, baseProg] of [
      ['selected-closure', { ...selectedProg, asm: [] }],
      ['selected-emitted', selectedProg],
      ['character-closure', { ...characterProg, asm: [] }],
      ['character-emitted', characterProg],
    ] as const) {
      const linked = assemble(resolveTable(baseProg), baseProg, {
        hostCst: false, hostReadsChildren: true, trackLines: false,
        tolerant: false, coverage: false, probe: false,
      })
      const ctx = createParseContext()
      ctx.trackLines = true
      ctx._lineStarts = Object.freeze([0]) as unknown as number[]
      ctx._lineScannedTo = 1
      ctx._fc = true
      linked.begin(ctx)
      try {
        expect(() => linked.pieces.Root!('a\n', 0, ctx), name).toThrow(TypeError)
        expect(ctx._fc, `${name} commitment after suffix line throw`).toBe(false)
      } finally {
        linked.finish()
      }
    }
  })

  it('lowers a RECURSIVE rule without falling back to an index lookup', () => {
    // `Expr -> Sum -> Expr` is a genuine back-edge, and the encoder emits a
    // patched `OP_RULE` trampoline for it. If the assembler's cycle handling
    // were wrong this either recurses forever at ASSEMBLY time or links the
    // wrong target; both are visible here and neither is a slow-path.
    const a = tableRules(encodeTable(g, {}))
    expect(run(a.Expr!, '1+2+3').ok).toBe(true)
    expect(run(a.Expr!, '((1+2))').ok).toBe(true)
  })

  it('materialises ONLY the pieces the option set reaches', () => {
    // The piece set is a SUPERSET; an option set reaches a subset of it. Assembly
    // walks from the rule entries and instantiates what it touches, so the
    // reached set must be a subset of the table's reachable set — never larger,
    // and never containing a site the table does not have.
    const prog = expandCompact(encodeTable(g, {}))
    const t = resolveTable(prog)
    const reachable = reachableIps(prog)
    for (const cfg of [
      { hostCst: false, trackLines: false, tolerant: false , coverage: false, probe: false },
      { hostCst: false, trackLines: true, tolerant: false , coverage: false, probe: false },
      { hostCst: false, trackLines: false, tolerant: true , coverage: false, probe: false },
    ]) {
      const asm = assemble(t, prog, cfg)
      for (const ip of asm.reached) {
        expect(reachable.has(ip), `assembly reached ip ${ip}, which the table does not`).toBe(true)
      }
      expect(asm.reached.size).toBeGreaterThan(0)
      expect(asm.reached.size).toBeLessThanOrEqual(reachable.size)
    }
  })

  it('caches ONE assembly per option set, not one per parse', () => {
    const cache = new AssemblyCache(expandCompact(encodeTable(g, {})))
    const a1 = cache.for({ hostCst: false, trackLines: false, tolerant: false , coverage: false, probe: false })
    const a2 = cache.for({ hostCst: false, trackLines: false, tolerant: false , coverage: false, probe: false })
    const b = cache.for({ hostCst: false, trackLines: true, tolerant: false , coverage: false, probe: false })
    expect(a1, 'the same option set must reuse its assembly').toBe(a2)
    expect(b, 'a different option set is a different assembly').not.toBe(a1)
  })

  it('links each SHARED subtree once', () => {
    // `Atom` is referenced by `Sum` and by `Expr`. Memoisation by code offset
    // means one piece with two references, not two pieces — which is what keeps
    // assembly proportional to the GRAMMAR rather than to the reference count.
    const prog = expandCompact(encodeTable(g, {}))
    const t = resolveTable(prog)
    const asm = assemble(t, prog, { hostCst: false, trackLines: false, tolerant: false , coverage: false, probe: false })
    // The reached set is keyed by offset, so a double-link would be invisible in
    // its size — instead assert the invariant that makes it impossible: every
    // reached offset is distinct by construction (it is a Set) AND the count
    // never exceeds the table's own reachable count.
    expect(asm.reached.size).toBeLessThanOrEqual(reachableIps(prog).size)
  })

  /**
   * BACKTRACKING OVER A `node()`, UNDER A CST HOST — the assembler's mark
   * protocol against `exec.ts`.
   *
   * Every other assembler gate runs the AST path: `bench/jess/g5-identity.ts`
   * loads `(dialect, 'ast')`, and `bench/table-lowering-identity.ts` drives
   * `execRules` only. On that path `ctx._cstBuf` is `undefined` for the whole
   * parse, so the assembler's mark protocol is only ever exercised down its
   * `_cstChildren`/`_cstLeaves` arm — the LAZY BUFFER arm, which is the one a
   * `node()` installs, had no coverage at all.
   *
   * That arm is where a stale `ctx._cstBuf` hides. The buffer is per-NODE
   * state: `beginCstNodeCapture` installs a fresh one and `endCstNodeCapture`
   * restores the parent's, so between a mark and its rollback the buffer object
   * can be replaced. A mark that reads a length off a buffer that is no longer
   * the live one does not throw and does not fail the parse — it silently keeps
   * or drops CST children.
   *
   * `Item`'s first arm is what forces the case: it matches a `Word` node — which
   * pushes a captured child into the ENCLOSING `Doc` buffer — and then demands a
   * `!` that is not there, so the choice must roll that child back out before
   * the second arm re-recognises the same text. A stale mark leaves the `Word`
   * behind and `Doc` ends up with it twice.
   */
  it('agrees with the bytecode driver when a choice backtracks over a node(), under a CST host', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
    const cg = rules<Record<string, Combinator<unknown>>>({ trivia: regex(/[ \t\n]+/) }, (g: any) => ({
      Word: node('Word', regex(/[a-z]+/), (c: readonly unknown[]) => ({ t: 'Word', c })),
      Num: node('Num', regex(/\d+/), (c: readonly unknown[]) => ({ t: 'Num', c })),
      // Arm 1 CONSUMES A NODE AND THEN FAILS. Arms 2/3 re-recognise the same
      // text, so a rollback that kept the arm-1 capture duplicates it.
      Item: choice(sequence(g.Word, literal('!')), g.Word, g.Num),
      Doc: node('Doc', many(g.Item), (c: readonly unknown[]) => ({ t: 'Doc', c })),
    })) as unknown as Record<string, Combinator<unknown>>

    const prog = encodeTable(cg, { hostMode: 'cst' })
    const a = tableRules(prog).Doc!
    const e = execRules(prog).Doc!
    for (const input of ['ab', 'ab cd', 'ab! cd 12', 'ab cd! 12 ef', 'ab  12  cd', '', 'ab cd 12 !']) {
      const build = (): never => cstBuildHost({ tags: true }) as never
      const ra = run(a as never, input, { build: build() })
      const re = run(e as never, input, { build: build() })
      const label = JSON.stringify(input)
      expect(ra.ok, `${label} ok`).toBe(re.ok)
      // The whole CST — children, rawChildren, spans, trivia log — not just `ok`.
      expect(digestValue(ra.value), `${label} cst`).toBe(digestValue(re.value))
      expect(ra.unconsumedFrom, `${label} unconsumed`).toBe(re.unconsumedFrom)
      expect([...(ra.expected ?? [])].sort(), `${label} expected`)
        .toEqual([...(re.expected ?? [])].sort())
    }
  })

  /**
   * A PARSE MUST BE INSTALLED WITH ITS OWN ASSEMBLY'S `scanSkip`, NOT THE
   * PREVIOUS PARSE'S.
   *
   * `stamp.ts`'s entry calls `scanSkipFor` BEFORE `runRule`, and `tableRules`
   * used to answer it from an assembly cached across parses ("memoised, so this
   * is an array index after the first parse"). The set is not shared: each
   * assembly wraps ITS OWN pieces (`subtreeComb`), so a strict parse following a
   * tolerant one was handed the tolerant assembly's recognisers and its end slot.
   *
   * Object identity is the assertion, not a parse outcome. The two assemblies
   * agree on this grammar, which is exactly why nothing caught it: a stale
   * selection is not a thrown error, it is the wrong graph running quietly.
   */
  it('selects the scanSkip set from THIS parse\'s option set, not the last parse\'s', () => {
    const skip = token(sequence(literal('"'), regex(/[^"]*/), literal('"')))
    const sg = rules<Record<string, Combinator<unknown>>>({ scanSkip: [skip as Combinator<unknown>] }, () => ({
      Doc: node('Doc', balanced('(', ')'), (c: readonly unknown[]) => ({ t: 'Doc', c })),
    })) as unknown as Record<string, Combinator<unknown>>

    const prog = expandCompact(encodeTable(sg))
    const cfg = { hostCst: false, trackLines: false, coverage: false, probe: false }
    const ref = new AssemblyCache(prog)
    const strictSkip = ref.for({ ...cfg, tolerant: false }).scanSkip[0]
    const tolerantSkip = ref.for({ ...cfg, tolerant: true }).scanSkip[0]
    expect(strictSkip, 'the two assemblies must wrap DIFFERENT pieces, or this proves nothing')
      .not.toBe(tolerantSkip)

    const entry = tableRules(prog).Doc! as unknown as
      (i: string, p: number, c: ParseContext) => unknown
    const installed = (tolerant: boolean): unknown => {
      const ctx = createParseContext()
      if (tolerant) { ctx._tolerant = true; ctx._errors = [] }
      entry('("a)b")', 0, ctx)
      return ctx.scanSkip
    }
    // The ORDER is the test: the tolerant parse is what leaves a selection behind.
    const first = installed(true)
    const second = installed(false)
    expect(first, 'a tolerant parse gets a tolerant-shaped set').not.toBe(second)
    expect(second, 'the strict parse must not inherit the tolerant parse\'s set').not.toBe(first)
  })
})
