/**
 * RED TEST (Gap A) — compose over an ALIASED base rule, overridden by a
 * self-referencing node, under `trackLines`, must macro-fuse.
 *
 * The table encoder replaces every rule entry with `parser({ trackLines }, entry)`
 * under `trackLines` (encode.ts:199), carrying the same `_ruleName`. When a base
 * assigns ONE combinator object to TWO rule names (a recognition alias — exactly
 * `cssSyntax`'s `CustomPropertyName: cp, CustomPropertyToken: cp`) and a downstream
 * compose delta OVERRIDES one of those names with a `node()` that references itself,
 * the aliased object's stale `_ruleName` resolves BY NAME to the delta's wrapper.
 * The `winnerWrapsReference` guard (token-alphabet.ts:1276, used at encode.ts:1536)
 * does not recognise the cross-name alias, so `node()` hands back the in-flight
 * recursion trampoline, the `parser()` wrapper emits no row, and the trampoline is
 * patched to itself:
 *
 *   table lowering: alias cycle — lazy (rule 'Name') encodes to its own
 *   recursion trampoline at N
 *
 * `trackLines: false` fuses cleanly — this is a trackLines-only encoder defect.
 * It is what makes less's two `*PositionsGrammar` exports fall back to a runtime
 * compose() (jess grammar.ts:4953 / :4959).
 *
 * Fails on parseman 0.50.4. Passes when the encoder resolves an aliased-sibling
 * reference to its OWN rule rather than the overridden name's wrapper.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { transformMacro } from '../../src/plugin/index.ts'

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-alias-override-'))
  try { return fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

// A base compose whose rule map assigns the SAME `cp` combinator to two names.
const baseSource = `import { rules, regex, compose } from 'parseman' with { type: 'macro' }
const ws = regex(/[ \\t\\n]*/)
const cp = regex(/--[a-z]+/)
export const base = compose([rules({ trivia: ws }, g => ({
  Name: cp,
  Token: cp,
}))])`

// A downstream compose that overrides `Name` with a self-referencing node.
const deltaSource = (trackLines: boolean) =>
  `import { rules, regex, node, choice, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
const ws = regex(/[ \\t\\n]*/)
export const parser = compose([base, rules({ trivia: ws${trackLines ? ', trackLines: true' : ''} }, g => ({
  Name: node('Name', choice(g.Token, g.Name), children => ({ type: 'Name', kids: [...children] })),
}))])`

describe('compose: aliased base rule overridden by a self-referencing node under trackLines', () => {
  it('macro-fuses WITHOUT trackLines (control — passes today)', () => {
    withTmp(dir => {
      const baseT = transformMacro(baseSource, path.join(dir, 'base.ts'), new Set(['parseman']))!
      fs.writeFileSync(path.join(dir, 'base.js'), baseT.code)
      const out = transformMacro(deltaSource(false), path.join(dir, 'down.ts'), new Set(['parseman']))!
      expect(out.warnings).toEqual([])
      expect(/\bcompose\s*\(/.test(out.code)).toBe(false)
    })
  })

  it('macro-fuses WITH trackLines (RED — fails today with an alias-cycle trampoline)', () => {
    withTmp(dir => {
      const baseT = transformMacro(baseSource, path.join(dir, 'base.ts'), new Set(['parseman']))!
      fs.writeFileSync(path.join(dir, 'base.js'), baseT.code)
      const out = transformMacro(deltaSource(true), path.join(dir, 'down.ts'), new Set(['parseman']))!
      // Currently emits: "compose(): could not be lowered to a table … alias cycle
      // — lazy (rule 'Name') encodes to its own recursion trampoline".
      expect(out.warnings).toEqual([])
      expect(/\bcompose\s*\(/.test(out.code)).toBe(false)
    })
  })
})
