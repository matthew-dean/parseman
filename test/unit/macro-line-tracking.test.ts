import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { cstBuildHost } from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'

type RuleFn = (input: string, pos: number, ctx: Record<string, unknown>) => {
  ok: boolean
  value?: unknown
  span: Record<string, unknown>
  expected?: string[]
}

type ModuleExports = Record<string, Record<string, RuleFn>>

async function build(code: string, id = 'macro-line-tracking.ts'): Promise<{ mod: ModuleExports; code: string; warnings: string[] }> {
  const out = transformMacro(code, id, new Set(['parseman']))
  if (!out) throw new Error('macro did not transform')
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`) as ModuleExports
  return { mod, code: out.code, warnings: out.warnings ?? [] }
}

const SHARED_FACTORY = `
import { literal, node, rules, sequence } from 'parseman' with { type: 'macro' }
const factory = (g) => ({
  Doc: node('Doc', sequence(literal('a'), literal('\\n'), literal('b')))
})
export const plain = rules(factory)
export const lines = rules({ trackLines: true }, factory)
`.trim()

describe('macro line tracking', () => {
  it('emits no line-tracking code for default rules() output', async () => {
    const { code, warnings } = await build(`
import { literal, node, rules, sequence } from 'parseman' with { type: 'macro' }
export const plain = rules((g) => ({
  Doc: node('Doc', sequence(literal('a'), literal('\\n'), literal('b')))
}))
`.trim())

    expect(warnings).toEqual([])
    expect(code).not.toContain('_trackLines')
    expect(code).not.toContain('_spanLines')
    expect(code).not.toContain('_lineStarts')
  })

  it('compiles one shared factory into plain and line-aware artifacts', async () => {
    const { mod, code, warnings } = await build(SHARED_FACTORY)
    expect(warnings).toEqual([])
    expect(code).toContain('_spanLines')

    const plain = mod.plain!.Doc!('a\nb', 0, { build: cstBuildHost() })
    expect(plain.ok).toBe(true)
    expect(plain.span).toEqual({ start: 0, end: 3 })
    expect((plain.value as { span: Record<string, unknown> }).span.startLine).toBeUndefined()

    const tracked = mod.lines!.Doc!('x\na\nb', 2, { build: cstBuildHost() })
    expect(tracked.ok).toBe(true)
    expect(tracked.span).toMatchObject({
      start: 2,
      end: 5,
      startLine: 2,
      startColumn: 1,
      endLine: 3,
      endColumn: 2,
    })
    expect((tracked.value as { span: Record<string, unknown> }).span).toMatchObject({
      startLine: 2,
      startColumn: 1,
      endLine: 3,
      endColumn: 2,
    })
  })

  it('reports line-aware failure spans from a line-aware macro artifact', async () => {
    const { mod } = await build(SHARED_FACTORY)
    const failed = mod.lines!.Doc!('x\na\nx', 2, { build: cstBuildHost() })

    expect(failed.ok).toBe(false)
    expect(failed.expected).toContain('"b"')
    expect(failed.span).toMatchObject({
      start: 4,
      end: 4,
      startLine: 3,
      startColumn: 1,
      endLine: 3,
      endColumn: 1,
    })
  })

  it('rejects non-literal rules({ trackLines }) under the macro', async () => {
    const out = transformMacro(`
import { literal, rules } from 'parseman' with { type: 'macro' }
const enabled = true
export const g = rules({ trackLines: enabled }, () => ({ Doc: literal('a') }))
`.trim(), 'macro-line-tracking.ts', new Set(['parseman']))

    expect(out!.warnings!.join('\n')).toContain('rules({ trackLines }) must be a boolean literal')
  })

  it('inlines a source-private imported factory into standalone entry artifacts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-imported-factory-lines-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      fs.writeFileSync(path.join(dir, 'grammar.ts'), `
import { literal, node, sequence } from 'parseman' with { type: 'macro' }
export const grammarFactory = (g) => ({
  Doc: node('Doc', sequence(literal('a'), literal('\\n'), literal('b')))
})
`)
      const { mod, code, warnings } = await build(`
import { rules } from 'parseman' with { type: 'macro' }
import { grammarFactory } from './grammar.js'
export const plain = rules(grammarFactory)
export const lines = rules({ trackLines: true }, grammarFactory)
`.trim(), path.join(dir, 'entry.ts'))

      expect(warnings).toEqual([])
      expect(code).not.toContain('./grammar')
      expect(code).not.toContain("from 'parseman'")
      expect(mod.plain!.Doc!('a\nb', 0, { build: cstBuildHost() }).span).toEqual({ start: 0, end: 3 })
      expect(mod.lines!.Doc!('a\nb', 0, { build: cstBuildHost() }).span).toMatchObject({
        startLine: 1,
        startColumn: 1,
        endLine: 2,
        endColumn: 2,
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applies other rules() settings to an imported factory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-imported-factory-settings-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      fs.writeFileSync(path.join(dir, 'grammar.ts'), `
import { literal, node, sequence } from 'parseman' with { type: 'macro' }
export const spacedFactory = (g) => ({
  Doc: node('Doc', sequence(literal('a'), literal('b')))
})
export const builtFactory = (g) => ({
  Built: node('Built', literal('x'), () => ({ mine: true }))
})
`)
      const { mod, code, warnings } = await build(`
import { regex, rules, trivia } from 'parseman' with { type: 'macro' }
import { builtFactory, spacedFactory } from './grammar.js'
const ws = trivia(regex(/[ \\t\\n]+/))
export const spaced = rules({ trivia: ws, trackLines: true }, spacedFactory)
export const cst = rules({ hostMode: 'cst' }, builtFactory)
`.trim(), path.join(dir, 'entry.ts'))

      expect(warnings).toEqual([])
      expect(code).not.toContain('./grammar')
      const spaced = mod.spaced!.Doc!('a \n b', 0, { build: cstBuildHost() })
      expect(spaced.ok).toBe(true)
      expect(spaced.span).toMatchObject({ startLine: 1, endLine: 2, endColumn: 3 })
      const cst = mod.cst!.Built!('x', 0, { build: cstBuildHost() })
      expect(cst.ok).toBe(true)
      expect(cst.value).toMatchObject({ _tag: 'node', type: 'Built' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses an imported factory artifact inside macro compose()', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-imported-factory-compose-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      fs.writeFileSync(path.join(dir, 'grammar.ts'), `
import { literal } from 'parseman' with { type: 'macro' }
export const baseFactory = (g) => ({ Atom: literal('a') })
`)
      const { mod, code, warnings } = await build(`
import { compose, literal, node, rules, sequence } from 'parseman' with { type: 'macro' }
import { baseFactory } from './grammar.js'
const base = rules(baseFactory)
export const grammar = compose([
  base,
  rules(g => ({ Doc: node('Doc', sequence(g.Atom, literal('!'))) })),
])
`.trim(), path.join(dir, 'entry.ts'))

      expect(warnings).toEqual([])
      expect(code).not.toContain('./grammar')
      expect(code).not.toMatch(/\bcompose\s*\(/)
      const result = mod.grammar!.Doc!('a!', 0, { build: cstBuildHost() })
      expect(result.ok).toBe(true)
      expect(result.value).toMatchObject({ _tag: 'node', type: 'Doc' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
