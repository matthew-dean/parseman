/**
 * Shapes where one fault in one engine moved the result and no other test noticed.
 * Each row runs the interpreter and the three table readers and requires one answer,
 * and writes that answer down where a fault in every engine would still agree.
 */
import { describe, expect, it } from 'vitest'
import {
  attempt, choice, classifiedTrivia, dispatch, expect as expectOr, field, leaf, literal, many, node, not, optional, otherwise, parser,
  regex, routed, rules, sepBy, sequence, sourceLeaf, token, transform, when,
} from '../../src/index.ts'
import { compile } from '../../src/table/compile.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { run } from '../../src/functional/run.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable } from '../../src/table/program.ts'
import type { Combinator } from '../../src/types.ts'
import { readers } from '../helpers/table-readers.ts'

type G = Record<string, Combinator<unknown>>
type Options = { build?: unknown; rootTrivia?: { select: string[] } }

const host = Object.assign(
  (type: string, children: unknown, fields: unknown, span: unknown, raw: unknown, triviaLog: unknown) => ({ type, children, fields, span, raw, triviaLog }),
  { _parsemanCstOutput: true },
)
const spaces = regex(/[ ]+/)
const comments = (): Combinator<unknown> => classifiedTrivia({ whitespace: regex(/[ ]+/), comment: regex(/\/\*[^*]*\*\//) })

const outcome = (r: ReturnType<typeof run>): object => ({
  ok: r.ok,
  value: r.value,
  span: r.span,
  unconsumedFrom: r.unconsumedFrom,
  expected: [...(r.expected ?? [])].sort(),
  errors: r.errors,
  rootTrivia: (r.rootTrivia as { rows?: unknown } | undefined)?.rows,
})

/** The one answer every engine gives. A CST host in `options` builds the table for one. */
function agreed(g: G, input: string, options: Options = {}, skip?: string): Record<string, unknown> {
  const prog = encodeTable(g, options.build === undefined ? {} : { hostMode: 'cst' })
  const want = outcome(run(g.R as never, input, options as never))
  for (const [name, table] of readers(prog)) {
    if (name === skip) continue
    expect(outcome(run(table.R as never, input, options as never)), name).toEqual(want)
  }
  return want as Record<string, unknown>
}

const leaves = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(leaves)
  if (v === null || typeof v !== 'object') return v
  const n = v as { type?: string; children?: unknown; value?: unknown }
  return n.children !== undefined ? { [n.type ?? '']: leaves(n.children) } : 'value' in n ? n.value : v
}

describe('token and leaf captures', () => {
  it('a token over a body the lexer cannot take still leaves its leaf', () => {
    const g = rules({ trivia: spaces }, () => ({
      R: node('N', sequence(token(sequence(literal('a'), parser({ captureTrivia: true }, literal('b')))), literal('c'))),
    })) as G
    expect(leaves(agreed(g, 'ab c', { build: host }).value)).toEqual({ N: ['ab', 'c'] })
  })

  it('a source leaf under a CST host captures the source, not the value', () => {
    const g = rules({}, () => ({ R: node('N', sourceLeaf(regex(/a+/), v => v.length)) })) as G
    expect(leaves(agreed(g, 'aaa', { build: host }).value)).toEqual({ N: ['aaa'] })
  })

})

describe('rollback', () => {
  const armThenRegex = (): G => rules({ trivia: spaces }, () => ({
    R: node('O', sequence(literal('p'), choice(sequence(literal('a'), literal('b')), sequence(regex(/a/), literal('c')), literal('q'), literal('r')))),
  })) as G
  it('a failed arm of a masked choice leaves nothing in the frame', () => {
    expect(leaves(agreed(armThenRegex(), 'pac', { build: host }).value)).toEqual({ O: ['p', 'a', 'c'] })
  })

  it('a rule row reached twice keeps its answer about failing', () => {
    const g = rules({ trivia: spaces }, (r: G) => ({
      R: node('O', sequence(optional(sequence(r.C!, r.B!)), optional(sequence(r.C!, r.B!)), regex(/a/), literal('z'))),
      B: literal('b'),
      C: regex(/a/),
    })) as G
    expect(leaves(agreed(g, 'az', { build: host }).value)).toEqual({ O: ['a', 'z'] })
  })

  // Emitted keeps the item: https://github.com/matthew-dean/parseman/issues/282
  it('a failed sepBy with a minimum takes back the items it kept', () => {
    const g = rules({}, () => ({ R: node('N', choice(sepBy(literal('a'), literal(','), { min: 2 }), literal('a'))) })) as G
    expect(leaves(agreed(g, 'a', { build: host }, 'emitted').value)).toEqual({ N: ['a'] })
  })

  it('a choice that fails inside another takes back what its arm kept', () => {
    const inner = (): Combinator<unknown> => choice(sequence(literal('a'), literal('b')), literal('x'))
    const shapes: Record<string, () => Combinator<unknown>> = {
      choice: () => choice(inner(), literal('a')),
      optional: () => sequence(optional(inner()), literal('a')),
      attempt: () => choice(attempt(inner()), literal('a')),
    }
    for (const shape of Object.values(shapes)) {
      const g = rules({}, () => ({ R: node('N', shape()) })) as G
      expect(leaves(agreed(g, 'a', { build: host }).value)).toEqual({ N: ['a'] })
      expect(leaves(agreed(g, 'a').value)).toEqual({ N: ['a'] })
      expect(leaves((compile(g.R as never).parse('a') as { value: unknown }).value)).toEqual({ N: ['a'] })
    }
  })

  it('a choice factored as an attempt restores for itself, so the choice around it adds no mark', () => {
    const g = rules({}, () => ({
      R: node('N', many(choice(
        choice(sequence(literal('a'), literal('b')), sequence(literal('a'), literal('c'))),
        sequence(literal('a'), literal('d')),
      ))),
    })) as G
    for (const input of ['ad', 'adab', 'abad', 'acad', 'ae', 'a', 'ab', 'ac', 'adae', 'abae']) {
      agreed(g, input, { build: host })
      agreed(g, input)
    }
    const prog = encodeTable(g, {})
    const source = emitAssemblySource(resolveTable(prog), prog, defaultAssemblyCfgs(prog)[0]!, assemblyExtraIps(prog), true).source
    expect(source.match(/_rbBuf\(/g)).toHaveLength(7)
  })

  it('a dispatch that fails inside a choice takes back its selector', () => {
    const word = regex(/[a-z]+/)
    const inner = choice(dispatch(word, when('foo', sequence(routed(), literal('x')))), literal('1'))
    const g = rules({}, () => ({ R: node('N', choice(inner, word)) })) as G
    expect(leaves(agreed(g, 'k', { build: host }).value)).toEqual({ N: ['k'] })
    expect(leaves(agreed(g, 'k').value)).toEqual({ N: ['k'] })
    expect(leaves((compile(g.R as never).parse('k') as { value: unknown }).value)).toEqual({ N: ['k'] })
  })

  it('a dispatch with no fallback leaves no selector behind for the next arm', () => {
    const g = rules({}, () => ({
      R: node('N', choice(dispatch(regex(/[a-z]+/), when('foo', sequence(routed(), literal('x')))), regex(/[a-z]+/))),
    })) as G
    expect(leaves(agreed(g, 'k', { build: host }).value)).toEqual({ N: ['k'] })
  })

  it('an error recorded before a dispatch survives its rollback', () => {
    const g = rules({}, () => ({
      R: sequence(expectOr(literal('a'), 'want a'), choice(dispatch(regex(/[a-z]/), when('b', sequence(routed(), literal('x'))), otherwise(literal(','), { commit: false })), regex(/[a-z]/))),
    })) as G
    expect((agreed(g, 'b').errors as unknown[]).length).toBe(1)
  })

  // With no trivia the closure engine keeps it: https://github.com/matthew-dean/parseman/issues/278
  it('a repeat item that fails under trivia keeps no error', () => {
    const g = rules({ trivia: spaces }, (r: G) => ({ R: many(expectOr(r.A!, 'want')), A: sequence(literal('a'), literal('b')) })) as G
    expect(agreed(g, 'a').errors).toEqual([])
  })
})

describe('first-set gates', () => {
  // The tables only: the interpreter rejects this input, https://github.com/matthew-dean/parseman/issues/258
  it('a gate tests the first set past the live trivia', () => {
    const g = rules({ trivia: spaces }, () => ({
      R: sequence(optional(sequence(optional(literal('z')), literal('b'))), literal('d')),
    })) as G
    for (const [name, table] of readers(encodeTable(g))) {
      expect(run(table.R as never, ' b d').value, name).toEqual([[null, 'b'], 'd'])
    }
  })

  it('an item that can match empty has no first-set gate', () => {
    const g = rules({}, () => ({ R: sequence(optional(sequence(optional(literal('z')), optional(literal('b')))), literal('d')) })) as G
    expect(agreed(g, 'd').value).toEqual([[null, null], 'd'])
  })

  it('a leading-trivia field is held across a gap', () => {
    const g = rules({ trivia: spaces }, () => ({
      R: node('N', sequence(literal('a'), not(literal('z')), field('f', literal('b'), { leadingTrivia: true }))),
    })) as G
    const fields = (agreed(g, 'a b', { build: host }).value as { fields: unknown }).fields
    expect(JSON.stringify(fields)).toContain('leading')
  })
})

describe('reducers', () => {
  it('transform receives the span of what it matched', () => {
    const g = rules({}, () => ({ R: transform(sequence(literal('a')), (v, s) => [v, s]) })) as G
    expect(agreed(g, 'a').value).toEqual([['a'], { start: 0, end: 1 }])
  })

  it('a transform over one token receives the span of that token', () => {
    const g = rules({}, () => ({ R: transform(regex(/a+/), (v, s) => [v, s]) })) as G
    expect(agreed(g, 'aa').value).toEqual(['aa', { start: 0, end: 2 }])
    const h = rules({}, () => ({ R: transform(literal('a'), (v, s) => [v, s]) })) as G
    expect(agreed(h, 'a').value).toEqual(['a', { start: 0, end: 1 }])
    const l = rules({}, () => ({ R: leaf(regex(/a+/), (v, s) => [v, s]) })) as G
    expect(agreed(l, 'aa').value).toEqual(['aa', { start: 0, end: 2 }])
  })
})

describe('root trivia', () => {
  it('a result that carries root trivia carries its value too', () => {
    const g = rules({ trivia: comments() }, () => ({ R: node('O', sequence(literal('a'), literal('b'))) })) as G
    const r = agreed(g, 'a /*1*/ b', { rootTrivia: { select: ['comment'] } })
    expect(r.value).not.toBeUndefined()
    expect(r.rootTrivia).toBeDefined()
  })

  it('a parser scope with opaque root capture restores the capture', () => {
    const g = rules({ trivia: comments() }, () => ({
      R: sequence(parser({ trivia: comments(), rootCapture: 'opaque' }, sequence(literal('a'), literal('b'))), literal('c'), literal('d')),
    })) as G
    const r = agreed(g, 'a /*1*/ b /*2*/ c /*3*/ d', { rootTrivia: { select: ['comment'] } })
    expect(r.ok).toBe(true)
    expect(r.rootTrivia).toBeDefined()
  })

  it('a token over a body with its own trivia records none of it at the root', () => {
    const g = rules({ trivia: comments() }, (r: G) => ({
      R: sequence(literal('a'), token(r.S!), literal('d')),
      S: sequence(literal('b'), parser({ trivia: comments() }, sequence(literal('c'), literal('e')))),
    })) as G
    expect(agreed(g, 'a /*1*/ bc /*2*/ e /*3*/ d', { rootTrivia: { select: ['comment'] } }).ok).toBe(true)
  })
})

describe('expected sets', () => {
  it('a choice failing at its start reports the arms after the last it tried', () => {
    const g = rules({}, () => ({
      R: choice(attempt(sequence(literal('a'), literal('x'))), dispatch(regex(/b/), when('b', sequence(routed(), literal('y')))), literal('c'), literal('d'), literal('e')),
    })) as G
    expect(agreed(g, 'aq').expected).toEqual(['"c"', '"d"', '"e"', '"x"', '/b/'])
  })

  // The tables only: the interpreter's set differs, https://github.com/matthew-dean/parseman/issues/256
  it('a choice failing at its start reports the arm the mask skipped before the last it tried', () => {
    const g = rules({}, () => ({
      R: choice(literal(';'), sequence(not(regex(/[a-z]+/)), regex(/[+*-]/)), literal('+'), leaf(literal('if'), (v, s) => [v, s])),
    })) as G
    for (const [name, table] of readers(encodeTable(g))) {
      expect([...(run(table.R as never, 'i)').expected ?? [])].sort(), name).toEqual(['"+"', '";"', '"if"', '/[+*-]/'])
    }
  })
})

describe('scan shapes', () => {
  it('a string regex without an escaped line terminator rejects one', () => {
    const g = rules({}, () => ({ R: regex(/"(?:[^"\\\n]|\\.)*"/) })) as G
    expect(agreed(g, '"a\\\nb"').ok).toBe(false)
    expect(agreed(g, '"a\\b"').ok).toBe(true)
  })
})

describe('line tracking', () => {
  const lined = (): G => rules({ trackLines: true }, () => ({ R: node('N', literal('a')) })) as G
  // The interpreter only. The tables leave line fields off a leaf.
  it('an interpreted node and its leaf carry line fields', () => {
    const value = run(lined().R as never, 'a', { build: host } as never).value as { span: object; children: Array<{ span: object }> }
    expect(value.span).toMatchObject({ startLine: 1 })
    expect(value.children[0]!.span).toMatchObject({ startLine: 1 })
  })
})

describe('a caller-installed sink', () => {
  const withSink = (key: string, entry: unknown, input: string): { value: unknown; sink: unknown[] } => {
    const ctx = createParseContext() as unknown as Record<string, unknown>
    const sink: unknown[] = []
    ctx[key] = sink
    const parse = (entry as { parse?: (i: string, p: number, c: unknown) => unknown }).parse
    const value = typeof parse === 'function' ? parse.call(entry, input, 0, ctx) : (entry as (i: string, p: number, c: unknown) => unknown)(input, 0, ctx)
    return { value, sink }
  }

  it('an interpreted node pushes itself into the caller\'s children', () => {
    const g = rules({}, () => ({ R: node('T', literal('a')) })) as G
    expect(withSink('_cstChildren', g.R, 'a').sink).toHaveLength(1)
  })

  it('a token run as a scan program pushes its leaf into the caller\'s leaves', () => {
    const g = rules({}, () => ({ R: token(sequence(regex(/[a-z]+/), optional(regex(/[0-9]+/)))) })) as G
    const want = withSink('_cstLeaves', g.R, 'ab12')
    expect(want.sink).toHaveLength(1)
    for (const [name, table] of readers(encodeTable(g))) expect(withSink('_cstLeaves', table.R, 'ab12'), name).toEqual(want)
  })
})

describe('a table with no direct builder, driven by a CST host it was not built for', () => {
  // A projecting node under an 'ast' table sets no capture bits, and no direct builder
  // makes this pair an error, so the host alone decides that its fields and trivia are kept.
  // A bare `tableRules` emits for the host it meets; the other legs fall to the closure engine.
  const g = rules({ trivia: spaces }, () => ({
    R: node('N', sequence(field('a', literal('x')), literal('y')), { project: 0 }),
  })) as G
  const built = (read: (v: Record<string, unknown>) => unknown): void => {
    const prog = encodeTable(g)
    const want = run(g.R as never, 'x y', { build: host } as never).value as Record<string, unknown>
    expect(read(want)).toBeDefined()
    const legs = [...readers(prog), ['emitted for this host', tableRules(prog)]] as const
    for (const [name, table] of legs) {
      const got = run(table.R as never, 'x y', { build: host } as never).value as Record<string, unknown>
      expect(read(got), name).toEqual(read(want))
    }
  }

  it('hands the host the fields of a projecting node', () => {
    built(v => v.fields)
  })

  it('hands the host the trivia of a projecting node', () => {
    built(v => (v.triviaLog as unknown[]).length > 0 ? v.triviaLog : undefined)
  })
})
