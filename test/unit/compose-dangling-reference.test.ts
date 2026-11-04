/**
 * A `g.X` that no composed piece defines is a grammar error, and the build says
 * which rule is missing and which rule asked for it.
 *
 * The shape is the one a dialect hits when it references a base sub-expression the
 * base never exported as a rule key: the base's function call is the key `VarCall`,
 * and the dialect's override of `VarFallback` reaches for `g.VarFunction`, a name
 * that exists only as a local const inside the base. The macro used to leave a
 * runtime `compose()` behind with "ref() used before .define()", which blames the
 * library rather than the grammar.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { compose, literal, regex, rules, sequence } from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'

const BASE = `import { rules, node, regex, literal, sequence, optional, compose } from 'parseman' with { type: 'macro' }
const ws = regex(/[ \\t\\n]*/)
export const base = compose([rules({ trivia: ws }, g => ({
  VarCall: node('VarCall', sequence(literal('var('), regex(/--[a-z-]+/), optional(g.VarFallback), literal(')'))),
  VarFallback: node('VarFallback', sequence(literal(','), regex(/[^)]*/))),
}))])`

const DIALECT = `import { rules, node, choice, literal, regex, sequence, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
const ws = regex(/[ \\t\\n]*/)
export const parser = compose([base, rules({ trivia: ws }, g => ({
  VarFallback: node('VarFallback', sequence(literal(','), choice(g.VarFunction, regex(/@[a-z]+/)))),
}))])`

describe('compose: a reference no piece defines fails the build', () => {
  it('names the missing rule and the rule that references it (macro fuse)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-dangling-ref-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      const base = transformMacro(BASE, path.join(dir, 'base.ts'), new Set(['parseman']))!
      expect(base.warnings).toEqual([])
      fs.writeFileSync(path.join(dir, 'base.js'), base.code)
      expect(() => transformMacro(DIALECT, path.join(dir, 'down.ts'), new Set(['parseman'])))
        .toThrow(/down\.ts:4 — compose\(\): rule "VarFallback" references missing rule "VarFunction"/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names a missing rule only a shadowed definition references (macro fuse)', () => {
    // The base's own `Value` reads `g.Typo`; the dialect replaces `Value`, so no live
    // rule reaches the hole. Runtime `compose()` refuses it all the same, and so does the build.
    const source = `import { rules, literal, regex, compose } from 'parseman' with { type: 'macro' }
export const parser = compose([
  rules(g => ({ Entry: g.Value, Value: g.Typo })),
  rules(g => ({ Value: regex(/[a-z]+/) })),
])`
    expect(() => transformMacro(source, path.join(os.tmpdir(), 'dangling-shadowed.ts'), new Set(['parseman'])))
      .toThrow(/compose\(\): rule\(s\) "Typo" are referenced but defined by no composed grammar/)
  })

  it('runtime compose() refuses the same grammar with the same words', () => {
    const base = rules(g => ({
      VarCall: sequence(literal('var('), regex(/--[a-z-]+/), g.VarFallback, literal(')')),
      VarFallback: sequence(literal(','), regex(/[^)]*/)),
    }))
    const dialect = rules(g => ({ VarFallback: sequence(literal(','), g.VarFunction) }))
    const composed = compose([base, dialect])
    expect(() => composed.VarCall).toThrow('compose: rule "VarFallback" references missing rule "VarFunction"')
  })
})
