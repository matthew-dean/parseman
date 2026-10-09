/**
 * MACRO OUTPUT CARRIES NO STATEMENT WHOSE RESULT NOTHING USES — once bundled.
 *
 * A module-level combinator const that only feeds a lowered grammar is dead after
 * lowering, and its standalone table must disappear with it. It did not: the entry
 * was selected by a member access on the pure call (`tableRules(…)["Entry"]`),
 * which a bundler may not drop, so every such const still built a table at import
 * (≈2,100 lines in jess's css `ast.js`). A dropped table also left its class
 * pool's `"…".split("|")` behind as a bare statement, because a call in the
 * arguments survives the pure call it sat in.
 */
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { transformMacro } from '../../src/plugin/index.ts'

const SOURCE = `import { compose, literal, regex, rules, sequence, choice } from 'parseman' with { type: 'macro' }
const ident = choice(regex(/[a-z]+/), regex(/[A-Z]+/), regex(/[0-9]+/))
const semi = literal(';')
export const grammar = compose([rules(g => ({ Doc: sequence(ident, semi, g.Tail), Tail: choice(ident, regex(/_+/)) }))])
`

describe('bundled macro output has no dead statements', () => {
  it('drops a dead standalone table and leaves no stray call behind', async () => {
    const out = transformMacro(SOURCE, '/pkg/dead.ts', new Set(['parseman']))!
    expect(out.warnings).toEqual([])
    // The dead consts WERE lowered to standalone tables — the case under test.
    expect(out.code.match(/tableEntry\(/g)!.length).toBeGreaterThan(0)

    const bundled = await build({
      stdin: { contents: out.code, loader: 'js', resolveDir: '/' },
      bundle: true, format: 'esm', write: false, treeShaking: true, external: ['parseman/table'],
    })
    const code = bundled.outputFiles[0]!.text
    expect(code.match(/table(?:Rules|Entry)\(/g), code).toHaveLength(1)
    expect(code).not.toContain('.split(')
    expect(code).not.toContain('["Entry"]')
  })
})
