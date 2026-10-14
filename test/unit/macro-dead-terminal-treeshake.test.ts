import { describe, it, expect } from 'vitest'
import { buildSync } from 'esbuild'
import { transformMacro } from '../../src/plugin/index.ts'
import { compile } from '../../src/table/compile.ts'
import { tableRules, emitTableExpression } from '../../src/table/index.ts'
import { expandCompact } from '../../src/table/program.ts'
import { regex, run, type Runnable } from '../../src/index.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'

/**
 * A standalone terminal whose pattern a `rules()` table also inlines is lowered to
 * its own table expression. When nothing references that binding, a bundler must
 * be able to drop the whole expression. `@__PURE__` covers a call and not a
 * property read after it, so the emitted entry is an argument of `tableRules`,
 * never a trailing `["Entry"]`.
 */
const SOURCE = `
import { regex, word, sequence, literal, rules } from 'parseman' with { type: 'macro' }
const ident = regex(/[a-z]+/)
const kw = word('if', 'a-z')
export const grammar = rules(g => {
  const Entry = sequence(kw, ident, literal(';'))
  return { Entry }
})
`.trim()

function bundle(code: string): string {
  return buildSync({
    stdin: { contents: code, loader: 'js' },
    bundle: true,
    format: 'esm',
    write: false,
    treeShaking: true,
    external: ['parseman', 'parseman/*'],
    logLevel: 'silent',
  }).outputFiles[0]!.text
}

const calls = (code: string) => code.match(/\btableRules\(/g)?.length ?? 0

describe('emitted terminal tables are tree-shakeable', () => {
  it('drops an unreferenced terminal table from a bundle', () => {
    const lowered = transformMacro(SOURCE, 'grammar.ts', new Set(['parseman']))!
    expect(lowered.warnings).toEqual([])
    // Three tables before bundling: two standalone terminals and the rule map.
    expect(calls(lowered.code)).toBe(3)
    const out = bundle(lowered.code)
    // Only the referenced rule map survives.
    expect(calls(out)).toBe(1)
    expect(out).not.toMatch(/\[\s*"Entry"\s*\]/)
  })

  it('prints the entry as an argument, and the expression still parses', () => {
    const expr = compile(regex(/[a-z]+/)).inlineExpression!
    expect(expr).toMatch(/\},"Entry"\)$/)
    const rule = evalMacroModule<Runnable>(`const r = ${expr}`, 'r')
    expect(run(rule, 'abc').ok).toBe(true)
    expect(run(rule, '1').ok).toBe(false)
  })

  it('tableRules(program, entry) returns that rule and refuses an unknown one', () => {
    const expr = compile(regex(/[a-z]+/)).inlineExpression!
    // Re-point the printed call at a driver that records the program it was given.
    let seen: Parameters<typeof tableRules>[0] | undefined
    const capture = (p: Parameters<typeof tableRules>[0]) => { seen = p }
    evalMacroModule(`const r = ${expr}`, 'r', { tableRules: capture })
    const single = tableRules(seen!, 'Entry')
    expect(typeof single).toBe('function')
    expect(() => tableRules(seen!, 'Nope')).toThrow(/no rule "Nope"/)
    for (const inherited of ['toString', 'constructor', '__proto__']) {
      expect(() => tableRules(seen!, inherited)).toThrow(/no rule/)
    }
    // Metadata belongs to the rule-map form; the emitter refuses to drop it.
    expect(() => emitTableExpression(expandCompact(seen!), { entry: 'Entry', metadataSource: '{}' })).toThrow(/metadataSource/)
  })
})
