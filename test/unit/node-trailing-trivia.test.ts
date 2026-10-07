import { describe, expect, it } from 'vitest'
import { choice, classifiedTrivia, compile, label, literal, many, node, oneOrMore, regex, rules, run, sequence, trivia } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { tableRules } from '../../src/table/assemble.ts'
import type { Combinator } from '../../src/types.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'

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
    _children: readonly unknown[] | undefined,
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
    const macroGrammar = evalMacroModule<{ Doc: (input: string, pos: number, ctx: unknown) => { ok: boolean } }>(transformed!.code, 'grammar')
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

      const base = evalMacroModule<unknown>(baseCode, 'base')
      const mid = evalMacroModule<unknown>(midCode, 'mid', { base })
      const grammar = evalMacroModule<{
        Doc: (input: string, pos: number, ctx: unknown) => { ok: boolean }
      }>(outerCode, 'grammar', { mid })
      const { logs, build: host } = capture()
      const result = grammar.Doc(INPUT, 0, { trackLines: false, build: host })
      expect(result.ok).toBe(true)
      expectOwnership(logs)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * `trailingTrivia` decides WHERE the node ends: after the trivia that follows its
 * body. It does not decide whether the node keeps its own trivia log; that is the
 * reducer's business, as for every other node. A reducer declared not to read the
 * log had capture forced on anyway, which put the node on the generic capture
 * path at every match: jess's SCSS custom-property value, whose trailing comments
 * this keeps in place, paid about 2.5k instructions per declaration for a log its
 * three-argument reducer never read.
 */
describe('node({ trailingTrivia: true }) with a reducer that does not read trivia', () => {
  const seen: unknown[] = []
  const classified = classifiedTrivia({ space: regex(/[ ]+/), comment: regex(/\/\*[^]*?\*\//) })
  const lean = rules({ trivia: classified }, (g: any) => ({
    Doc: node('Doc', sequence(g.Value, literal(';')), children => children),
    Value: node('Value', oneOrMore(regex(/[a-z]+/)), function (children: readonly unknown[], _fields: unknown, span: { start: number; end: number }) {
      // `buildArity: 3` declares the log unread; the fifth argument is observed only
      // to tell an opened log from the shared empty one.
      // eslint-disable-next-line prefer-rest-params
      seen.push(arguments[4])
      return { words: children.length, span }
    }, { trailingTrivia: true, buildArity: 3 }),
  }))
  const SOURCE = 'a b /* c */ ;'
  const engines = (): [string, Combinator<unknown>][] => [
    ['interpreter', lean.Doc as Combinator<unknown>],
    ['table', tableRules(encodeTable(lean)).Doc as unknown as Combinator<unknown>],
    ['reference', execRules(encodeTable(lean)).Doc as unknown as Combinator<unknown>],
  ]

  it('still ends the node after the trivia that follows it, in every engine', () => {
    for (const [name, entry] of engines()) {
      const result = run(entry, SOURCE)
      expect(result.ok, name).toBe(true)
      expect((result.value as [{ span: { end: number } }, string])[0].span.end, name).toBe(SOURCE.indexOf(';'))
    }
  })

  it('still records that trivia in the root trivia table, in every engine', () => {
    for (const [name, entry] of engines()) {
      const result = run(entry, SOURCE, { rootTrivia: { select: ['comment'] } })
      expect(result.rootTrivia?.rows, name).toEqual([3, 12, 4, 11, 0])
    }
  })

  it('hands the reducer no trivia log it did not ask for, in every engine', () => {
    for (const [name, entry] of engines()) {
      seen.length = 0
      expect(run(entry, SOURCE).ok, name).toBe(true)
      expect(seen.map(log => (log as readonly number[] | undefined)?.length ?? 0), name).toEqual([0])
    }
  })
})
