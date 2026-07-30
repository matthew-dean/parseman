import { describe, it, expect } from 'vitest'
import {
  sequence, many, literal, regex, trivia, classifiedTrivia, label, parser, node, compile, rules, compose, cstBuildHost,
  oneOrMore, choice, triviaEntries, run, peek, attempt, optional, sepBy, leaf,
} from '../../src/index.ts'
import type { Runnable } from '../../src/index.ts'
import { compileRuleMap } from '../../src/compiler/codegen.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import {
  expectTriviaLogParity,
  runTriviaLogParity,
  triviaEntriesFromLog,
} from './helpers/trivia-log-parity.ts'

function labeledRw() {
  return trivia(oneOrMore(choice(
    label('whitespace', regex(/[ \t\n\r\f]+/)),
    label('blockComment', regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)),
  )))
}

const KIND_LABELS = ['whitespace', 'blockComment'] as const

describe('labeled trivia kinds — interpreter vs compiled', () => {
  it('records per-chunk kind indices in _triviaLog', () => {
    const rw = labeledRw()
    const g = rules(r => {
      const a = regex(/a/)
      const b = regex(/b/)
      const root = node(
        'Root',
        parser({ trivia: rw }, sequence(a, many(b))),
        (c, raw, s, tl) => ({ span: s, children: [...c], tl: [...tl] }),
      )
      return { a, b, root }
    })

    const input = 'a /*x*/ b '
    const log: number[] = []
    g.root.parse(input, 0, {
      trackLines: false,
      trivia: rw,
      triviaKindLabels: KIND_LABELS,
      _triviaLog: log,
    })

    const entries = triviaEntries(log, KIND_LABELS)
    expect(entries.length).toBe(3)
    expect(entries.kind(0)).toBe('whitespace')
    expect(entries.text(0, input)).toBe(' ')
    expect(entries.kind(1)).toBe('blockComment')
    expect(entries.text(1, input)).toBe('/*x*/')
    expect(entries.kind(2)).toBe('whitespace')
    expect(entries.text(2, input)).toBe(' ')
  })

  it('parity on CSS-like labeled ws + block comments', () => {
    const rw = labeledRw()
    const g = rules(r => {
      const basicSel = regex(/[a-z]+/)
      const compound = node(
        'Compound',
        parser({ trivia: rw }, oneOrMore(r.basicSel)),
        (c, raw, s, tl) => ({ span: s, tl: [...tl], children: [...c] }),
      )
      const cx = node(
        'Cx',
        parser({ trivia: rw }, sequence(r.compound, many(sequence(literal('>'), r.compound)))),
        (c, raw, s, tl) => ({ span: s, tl: [...tl], children: [...c] }),
      )
      return { basicSel, compound, cx }
    })

    const compiled = compile(g.cx)
    const { iLog, cLog } = runTriviaLogParity(g.cx, compiled, 'a/* { } */> b ', {
      trackLines: false,
      trivia: rw,
      triviaKindLabels: KIND_LABELS,
    })
    expectTriviaLogParity(iLog, cLog, KIND_LABELS)

    const interpreted = triviaEntriesFromLog(iLog, KIND_LABELS)
    expect(interpreted.map(e => KIND_LABELS[e.kindIndex!])).toEqual([
      'blockComment',
      'whitespace',
    ])
  })

  it('labeled regex arms (no fast path) still parity', () => {
    const rw = trivia(oneOrMore(choice(
      label('ws', regex(/[ \t]+/)),
      label('line', regex(/\/\/.*/)),
    )))
    const labels = ['ws', 'line'] as const
    const g = rules(r => {
      const tok = regex(/[a-z]+/)
      const root = node(
        'Root',
        parser({ trivia: rw }, sequence(tok, tok)),
        (c, raw, s, tl) => ({ span: s, tl: [...tl], children: [...c] }),
      )
      return { tok, root }
    })

    const compiled = compile(g.root)
    const { iLog, cLog } = runTriviaLogParity(g.root, compiled, 'aa //c\n bb', {
      trackLines: false,
      trivia: rw,
      triviaKindLabels: labels,
    })
    expectTriviaLogParity(iLog, cLog, labels)
  })
})

describe('strict selected root trivia scopes', () => {
  const blockComment = regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)
  const outer = classifiedTrivia({
    whitespace: regex(/[ \t\n\r\f]+/),
    blockComment,
  })
  const collapsed = trivia(label(
    'whitespace',
    regex(/(?:(?:[ \t\n\r\f]+)|(?:\/\*(?:[^*]|\*(?!\/))*\*\/))+/),
  ))

  it('rejects a local composite matcher that erases a selected category', () => {
    const entry = parser({ trivia: outer }, sequence(
      literal('a'),
      parser({ trivia: collapsed }, sequence(literal('b'), literal('c'))),
    ))

    expect(() => run(entry, 'a b/* hidden */c', {
      trivia: outer,
      rootTrivia: { select: ['blockComment'], strictScopes: true },
    })).toThrow(/classifiedTrivia\(\).*rootCapture: 'opaque'/)
  })

  it('keeps classified selected markers out of an explicit opaque local scope', () => {
    const entry = parser({ trivia: outer }, sequence(
      literal('a'),
      parser({ trivia: outer, rootCapture: 'opaque' }, sequence(literal('b'), literal('c'))),
    ))
    const options = { rootTrivia: { select: ['blockComment'] as const, strictScopes: true } }
    const compiled = compileRuleMap([['Entry', entry]])!
    const compiledGrammar = new Function(`return ${compiled.replacement}`)() as { Entry: Runnable }
    for (const [engine, root] of [['interpreter', entry], ['compiled', compiledGrammar.Entry]] as const) {
      const result = run(root, 'a b/* hidden */c', options)
      expect(result.ok, engine).toBe(true)
      expect(result.rootTrivia, engine).toEqual({ mode: 'selected', rows: [], select: ['blockComment'] })
    }
  })

  it('requires opaque scopes to declare the trivia they make opaque', () => {
    expect(() => parser({ rootCapture: 'opaque' }, literal('a')))
      .toThrow(/requires an explicit trivia scope/)
  })

  it('rejects nullable or overlapping arms before they can masquerade as classified trivia', () => {
    expect(() => classifiedTrivia({
      whitespace: regex(/[ \t]+/),
      broad: regex(/[ \t/]+/),
    })).toThrow(/overlaps/)
    expect(() => classifiedTrivia({
      optionalWhitespace: regex(/[ \t]*/),
    })).toThrow(/non-nullable/)
  })

  it('accepts a classified whitespace-only local scope', () => {
    const local = classifiedTrivia({ whitespace: regex(/[ \t]+/) })
    const entry = parser({ trivia: outer }, sequence(
      literal('a'),
      parser({ trivia: local }, sequence(literal('b'), literal('c'))),
    ))
    const result = run(entry, 'a b c', {
      trivia: outer,
      rootTrivia: { select: ['blockComment'], strictScopes: true },
    })

    expect(result.ok).toBe(true)
    expect(result.rootTrivia).toEqual({ mode: 'selected', rows: [], select: ['blockComment'] })
  })

  it('rejects a selected label the root trivia does not define', () => {
    const entry = parser({ trivia: outer }, literal('a'))
    expect(() => run(entry, 'a', {
      trivia: outer,
      rootTrivia: { select: ['missing'] },
    })).toThrow(/unknown trivia label "missing"/)
  })
})

describe('label() vs node() — no conflict', () => {
  it('node type and trivia label occupy separate namespaces', () => {
    const rw = labeledRw()
    const g = rules(r => {
      const item = regex(/x/)
      const root = node(
        'Expr',
        parser({ trivia: rw }, r.item),
        (c, raw, s, tl) => ({ type: 'Expr', span: s, tl: [...tl], children: [...c] }),
      )
      return { item, root }
    })

    const built = g.root.parse('x', 0, {
      trackLines: false,
      trivia: rw,
      triviaKindLabels: KIND_LABELS,
      _triviaLog: [],
    })
    expect(built.ok && built.value).toMatchObject({ type: 'Expr' })
    expect(rw._meta.triviaKindLabels).toEqual([...KIND_LABELS])
  })
})

describe('labeled trivia kinds — macro metadata', () => {
  it('requires labeled trivia for selected capture and keeps only requested marker kinds', () => {
    expect(() => run(literal('a'), 'a', {
      rootTrivia: { select: ['blockComment'] },
    })).toThrow('rootTrivia.select requires labeled grammar trivia')

    const rw = labeledRw()
    const grammar = rules({ trivia: rw }, () => ({
      Root: node('Root', sequence(literal('a'), literal('b'))),
    }))
    const result = run(grammar.Root, 'a /*x*/ b', {
      // The duplicate proves lookup uses one stable registered kind slot.
      rootTrivia: { select: ['blockComment', 'blockComment'] },
    })

    expect(result.rootTrivia).toEqual({
      mode: 'selected',
      rows: [1, 8, 2, 7, 0],
      select: ['blockComment', 'blockComment'],
    })
  })

  it('selected root capture survives composed factory grammars in AST and CST host modes', () => {
    const innerTrivia = labeledRw()
    const outerTrivia = trivia(oneOrMore(choice(
      label('blockComment', regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)),
      label('whitespace', regex(/[ \t\n\r\f]+/)),
    )))
    const base = rules({ trivia: innerTrivia }, () => ({
      // The comment is inside a semantic leaf. leaf() hides child CST capture,
      // but must not make root-source trivia disappear.
      Pair: leaf(sequence(literal('a'), literal('b')), () => ({ type: 'Pair' })),
    }))
    const delta = rules({ trivia: outerTrivia }, g => ({
      Doc: node('Doc', parser({ trivia: outerTrivia }, sequence(literal('x'), g.Pair, literal('y'))), () => ({ type: 'Doc' })),
    }))
    const ast = compose([base, delta]) as { Doc?: Runnable }
    const cst = compose([base, delta], { hostMode: 'cst' }) as { Doc?: Runnable }
    const input = 'x a /*x*/ b y'
    const opts = { rootTrivia: { select: ['blockComment'] as const } }
    const expected = { mode: 'selected', rows: [3, 10, 4, 9, 0], select: ['blockComment'] }

    expect(run(ast.Doc!, input, opts).rootTrivia).toEqual(expected)
    expect(run(cst.Doc!, input, { ...opts, build: cstBuildHost() }).rootTrivia).toEqual(expected)
  })

  it('selected root capture retains only selected labeled markers and their owning range', () => {
    const rw = labeledRw()
    const grammar = rules({ trivia: rw }, () => ({
      Root: node('Root', sequence(literal('a'), literal('b'))),
    }))
    const input = 'a /*x*/ b'
    const result = run(grammar.Root, input, { rootTrivia: { select: ['blockComment'] } })

    expect(result.ok).toBe(true)
    expect(result.triviaLog).toEqual([])
    expect(result.rootTrivia).toEqual({
      mode: 'selected',
      rows: [1, 8, 2, 7, 0],
      select: ['blockComment'],
    })
    expect(result.triviaMap.entries.length).toBe(1)
    expect(result.triviaMap.entries.kind(0)).toBe('blockComment')
    expect(result.triviaMap.gapBefore(8)?.text(input)).toBe(' /*x*/ ')
  })

  it('selected root capture has interpreter/compiled/macro parity and rolls no whitespace rows into the result', () => {
    const rw = labeledRw()
    const input = 'a /*x*/ b'
    const selected = { rootTrivia: { select: ['blockComment'] as const } }
    const grammar = rules({ trivia: rw }, () => ({
      Root: node('Root', sequence(literal('a'), literal('b'))),
    }))
    const compiled = compileRuleMap(Object.entries(grammar), { trivia: rw })!
    const compiledGrammar = new Function(`return ${compiled.replacement}`)() as { Root: Runnable }

    const interpreted = run(grammar.Root, input, selected)
    const macro = run(compiledGrammar.Root, input, selected)
    expect(macro.rootTrivia).toEqual(interpreted.rootTrivia)
    expect(macro.triviaMap.gapBefore(8)?.text(input)).toBe(' /*x*/ ')
  })

  it('selected root capture rolls back a zero-width probe before the real parse commits', () => {
    const rw = labeledRw()
    const body = () => sequence(literal('a'), literal('b'))
    const grammar = rules({ trivia: rw }, () => ({
      Root: node('Root', parser({ trivia: rw }, sequence(peek(body()), body()))),
    }))
    const input = 'a /*x*/ b'
    const selected = { rootTrivia: { select: ['blockComment'] as const } }
    const compiled = compileRuleMap(Object.entries(grammar), { trivia: rw })!
    const compiledGrammar = new Function(`return ${compiled.replacement}`)() as { Root: Runnable }

    const interpreted = run(grammar.Root, input, selected)
    const macro = run(compiledGrammar.Root, input, selected)
    const expected = { mode: 'selected', rows: [1, 8, 2, 7, 0], select: ['blockComment'] }
    expect(interpreted.rootTrivia).toEqual(expected)
    expect(macro.rootTrivia).toEqual(expected)
  })

  it('selected root capture leaves no markers from rejected transactional paths', () => {
    const rw = labeledRw()
    const selected = { rootTrivia: { select: ['blockComment'] as const } }
    const cases = [
      {
        name: 'ordered choice arm',
        root: choice(sequence(literal('a'), literal('b')), sequence(literal('a'), literal('c'))),
        input: 'a /*x*/ c',
        rows: [1, 8, 2, 7, 0],
      },
      {
        name: 'attempt arm',
        root: choice(attempt(sequence(literal('a'), literal('b'))), sequence(literal('a'), literal('c'))),
        input: 'a /*x*/ c',
        rows: [1, 8, 2, 7, 0],
      },
      {
        name: 'optional tail',
        root: sequence(literal('a'), optional(literal('b'))),
        input: 'a /*x*/ c',
        rows: [],
      },
      {
        name: 'repeat tail',
        root: sequence(literal('a'), many(literal('b'))),
        input: 'a /*x*/ c',
        rows: [],
      },
      {
        name: 'separator plus missing item',
        root: sepBy(literal('a'), literal(',')),
        input: 'a /*x*/, /*y*/',
        rows: [],
      },
    ] as const

    for (const testCase of cases) {
      const grammar = rules({ trivia: rw }, () => ({ Root: testCase.root }))
      const compiled = compileRuleMap(Object.entries(grammar), { trivia: rw })!
      const compiledGrammar = new Function(`return ${compiled.replacement}`)() as { Root: Runnable }
      for (const [engine, root] of [['interpreter', grammar.Root], ['compiled', compiledGrammar.Root]] as const) {
        const result = run(root, testCase.input, selected)
        expect(result.rootTrivia.mode, `${testCase.name}: ${engine}`).toBe('selected')
        if (result.rootTrivia.mode === 'selected') {
          expect(result.rootTrivia.rows, `${testCase.name}: ${engine}`).toEqual(testCase.rows)
        }
      }
    }
  })

  it('compileRuleMap preserves triviaKindLabels on public rule wrappers', () => {
    const rw = labeledRw()
    const compiled = compileRuleMap([['rw', rw]])!
    const grammar = new Function(`return ${compiled.replacement}`)() as {
      rw: { _meta?: { triviaKindLabels?: readonly string[] } }
    }

    expect(grammar.rw._meta?.triviaKindLabels).toEqual([...KIND_LABELS])
  })

  it('run(map.Root) decodes labeled ambient root trivia for interpreter, compiled map, and macro map', () => {
    const rw = labeledRw()
    const input = 'a /*x*/ b'
    const assertLabeledRootLog = (name: string, root: Runnable) => {
      const result = run(root, input)
      expect(result.ok, name).toBe(true)
      expect(result.triviaKindLabels, name).toEqual([...KIND_LABELS])
      expect(result.triviaMap.entries.stride, name).toBe(3)
      expect(result.triviaMap.entries.length, name).toBe(3)
      expect(result.triviaMap.entries.kind(0), name).toBe('whitespace')
      expect(result.triviaMap.entries.kind(1), name).toBe('blockComment')
      expect(result.triviaMap.entries.kind(2), name).toBe('whitespace')
      expect(result.triviaMap.gapBefore(8)?.hasKind('blockComment'), name).toBe(true)
      expect(result.triviaMap.gapBefore(8)?.text(input), name).toBe(' /*x*/ ')
    }

    const grammar = rules({ trivia: rw }, () => ({
      Root: node('Root', sequence(literal('a'), literal('b'))),
    }))
    assertLabeledRootLog('interpreter', grammar.Root)

    const compiled = compileRuleMap(Object.entries(grammar), { trivia: rw })!
    const compiledGrammar = new Function(`return ${compiled.replacement}`)() as { Root: Runnable }
    assertLabeledRootLog('compiled rule map', compiledGrammar.Root)

    const macroSource = `
import { choice, compose, label, literal, node, oneOrMore, regex, rules, sequence, trivia } from 'parseman' with { type: 'macro' }
const rw = trivia(oneOrMore(choice(
  label('whitespace', regex(/[ \\t\\n\\r\\f]+/)),
  label('blockComment', regex(/\\/\\*(?:[^*]|\\*(?!\\/))*\\*\\//)),
)))
export const grammar = compose([rules({ trivia: rw }, (g) => ({
  Root: node('Root', sequence(literal('a'), literal('b'))),
}))])
`.trim()
    const transformed = transformMacro(macroSource, 'root-trivia-labels-test.ts', new Set(['parseman']))
    if (!transformed) throw new Error('macro transform returned null')
    expect(transformed.warnings).toEqual([])
    expect(/\bcompose\s*\(/.test(transformed.code), transformed.code).toBe(false)
    const macroGrammar = new Function(
      transformed.code.replace(/^import[^\n]*\n/gm, '').replace(/export const/g, 'var') + '\nreturn grammar',
    )() as { Root: Runnable }
    assertLabeledRootLog('macro rule map', macroGrammar.Root)
  })
})
