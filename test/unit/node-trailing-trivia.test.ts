import { describe, expect, it } from 'vitest'
import { choice, compile, label, literal, many, node, oneOrMore, regex, rules, sequence, trivia } from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'

const rw = trivia(oneOrMore(choice(
  label('space', regex(/[ ]+/)),
  label('comment', regex(/\/\*[^]*?\*\//)),
)))

const grammar = rules({ trivia: rw }, (g: any) => ({
  Doc: node('Doc', g.Block, undefined, { trailingTrivia: true }),
  Block: node('Block', sequence(literal('{'), many(literal('a')), literal('}'))),
}))

type Log = { span: { start: number; end: number }; trivia: readonly number[] }

function capture() {
  const logs = new Map<string, Log>()
  const build = (
    type: string,
    _children: readonly unknown[],
    _fields: unknown,
    span: { start: number; end: number },
    _rawChildren: readonly unknown[],
    triviaLog: readonly number[],
  ) => {
    logs.set(type, { span, trivia: [...triviaLog] })
    return { type }
  }
  return { logs, build }
}

function expectOwnership(logs: Map<string, Log>) {
  // The comment before `}` belongs to Block because `}` is its real following
  // grammar term. Only the EOF comment is Doc's explicitly opted-in boundary.
  expect(logs.get('Block')).toEqual({ span: { start: 0, end: 16 }, trivia: [2, 3, 2, 0, 3, 15, 2, 1] })
  expect(logs.get('Doc')).toEqual({ span: { start: 0, end: 26 }, trivia: [16, 17, 1, 0, 17, 26, 1, 1] })
}

const INPUT = '{a /* inside */} /* EOF */'

describe('node({ trailingTrivia: true })', () => {
  it('commits only the document-terminal active trivia to the opted-in node', () => {
    const { logs, build } = capture()
    const result = grammar.Doc.parse(INPUT, 0, {
      trackLines: false, trivia: rw, triviaKindLabels: rw._meta.triviaKindLabels, build
    })
    expect(result.ok).toBe(true)
    expectOwnership(logs)
  })

  it('has identical ownership and spans in compile() output', () => {
    const { logs, build } = capture()
    const result = compile(grammar.Doc).parseWithContext(INPUT, { trackLines: false, build }, 0)
    expect(result.ok).toBe(true)
    expectOwnership(logs)
  })

  it('macro-compiles the node option with the same ownership', () => {
    const source = `
import { choice, label, literal, many, node, oneOrMore, regex, rules, sequence, trivia } from 'parseman' with { type: 'macro' }
const rw = trivia(oneOrMore(choice(label('space', regex(/[ ]+/)), label('comment', regex(/\\/\\*[^]*?\\*\\//)))))
export const grammar = rules({ trivia: rw }, g => ({
  Doc: node('Doc', g.Block, undefined, { trailingTrivia: true }),
  Block: node('Block', sequence(literal('{'), many(literal('a')), literal('}'))),
}))
`
    const transformed = transformMacro(source, 'node-trailing-trivia.ts', new Set(['parseman']))
    expect(transformed).not.toBeNull()
    const body = transformed!.code.replace('export const grammar', 'const grammar') + '\nreturn grammar'
    const macroGrammar = new Function(body)() as { Doc: (input: string, pos: number, ctx: unknown) => { ok: boolean } }
    const { logs, build } = capture()
    const result = macroGrammar.Doc(INPUT, 0, { trackLines: false, build })
    expect(result.ok).toBe(true)
    expectOwnership(logs)
  })
})
