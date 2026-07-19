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

  it('uses the default CST fallback in compiled output without a build host', () => {
    // `trailingTrivia` is grammar-owned structural capture, not a requirement
    // that a caller provide a CST host. This exercises the generated node-local
    // trivia-mask installation when `_ctx.build` is absent.
    const result = compile(grammar.Doc).parse(INPUT)
    expect(result).toMatchObject({
      ok: true,
      span: { start: 0, end: 26 },
      value: {
        _tag: 'node',
        type: 'Doc',
        span: { start: 0, end: 26 },
      },
    })
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

  it('preserves terminal ownership when a composed artifact IR is re-lowered', async () => {
    // This intentionally crosses *two* compiled-artifact boundaries:
    //
    //   base (Block) → mid (Doc with trailingTrivia) → outer (re-lowers mid IR)
    //
    // Merely checking the `trailingTrivia: true` text in serialized IR would not
    // prove that the re-lowered rule installs the node-local collector, consumes
    // ambient grammar trivia at EOF, and returns the correct insertion indices.
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-trailing-ir-'))
    const build = (name: string, source: string) => {
      const out = transformMacro(source, path.join(dir, `${name}.js`), new Set(['parseman']))
      expect(out, `${name} must macro-compile`).not.toBeNull()
      expect(out!.warnings).toEqual([])
      fs.writeFileSync(path.join(dir, `${name}.js`), out!.code)
      return out!.code
    }
    const strip = (code: string) => code.replace(/^import[^\n]*\n/gm, '').replace(/export const/g, 'var')

    try {
      const baseCode = build('base', `
import { choice, label, literal, many, node, oneOrMore, regex, rules, sequence, trivia } from 'parseman' with { type: 'macro' }
const rw = trivia(oneOrMore(choice(label('space', regex(/[ ]+/)), label('comment', regex(/\\/\\*[^]*?\\*\\//)))))
export const base = rules({ trivia: rw }, g => ({
  Block: node('Block', sequence(literal('{'), many(literal('a')), literal('}'))),
}))
`)
      const midCode = build('mid', `
import { choice, compose, label, node, oneOrMore, regex, rules, trivia } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
const rw = trivia(oneOrMore(choice(label('space', regex(/[ ]+/)), label('comment', regex(/\\/\\*[^]*?\\*\\//)))))
export const mid = compose([base, rules({ trivia: rw }, g => ({
  Doc: node('Doc', g.Block, undefined, { trailingTrivia: true }),
}))])
`)
      const outerCode = build('outer', `
import { choice, compose, label, oneOrMore, regex, rules, trivia } from 'parseman' with { type: 'macro' }
import { mid } from './mid.js'
const rw = trivia(oneOrMore(choice(label('space', regex(/[ ]+/)), label('comment', regex(/\\/\\*[^]*?\\*\\//)))))
export const grammar = compose([mid, rules({ trivia: rw }, g => ({ Pass: regex(/z/) }))])
`)

      // `outer` must statically fuse the carried IR from `mid`; a residual runtime
      // compose call would exercise a different path and make this regression weak.
      expect(outerCode).not.toMatch(/\bcompose\s*\(/)

      const base = new Function(`${strip(baseCode)}\nreturn base`)()
      const mid = new Function('base', `${strip(midCode)}\nreturn mid`)(base)
      const grammar = new Function('mid', `${strip(outerCode)}\nreturn grammar`)(mid) as {
        Doc: (input: string, pos: number, ctx: unknown) => { ok: boolean }
      }
      const { logs, build: host } = capture()
      const result = grammar.Doc(INPUT, 0, { trackLines: false, build: host })
      expect(result.ok).toBe(true)
      expectOwnership(logs)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
