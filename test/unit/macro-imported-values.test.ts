/**
 * A terminal, a skip set or an options object IMPORTED into a macro grammar.
 *
 * The defect: an imported name evaluated to `null` at build time. In a rule body that
 * made the factory "not statically evaluable"; in `rules({ scanSkip })` it was worse —
 * the option became `undefined`, the build was green with no warning, and every string
 * and comment inside a `scanTo`/`balanced` region was live again. So a grammar family
 * could share a whole `rules()` map by `compose()`, but not one terminal.
 *
 * Covered, each from a RELATIVE source module and from a PUBLISHED package entry (a
 * compiled artifact, which carries each exported terminal's combinator IR):
 *   - an imported terminal inside a rule body;
 *   - an imported `scanSkip` array (and one built from imported units);
 *   - an imported options object passed to a combinator (`balanced`);
 *   - an imported boundary string passed to `word()`.
 * And every form the macro still cannot resolve FAILS THE BUILD naming the binding.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildSync } from 'esbuild'
import { transformMacro } from '../../src/plugin/index.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'

type Rule = (input: string, pos: number, ctx: object) => { ok: boolean; span: { end: number } }

const TERMINALS = `
import { literal, regex, sequence, scanTo } from 'parseman' with { type: 'macro' }
export const dq = sequence(literal('"'), regex(/[^"]*/), literal('"'))
export const ab = sequence(literal('a'), literal('b'))
export const toSemi = scanTo(literal(';'))
export const blockComment = regex(/\\/\\*(?:[^*]|\\*(?!\\/))*\\*\\//)
const sq = sequence(literal("'"), regex(/[^']*/), literal("'"))
export const skipUnits = [dq, blockComment, sq]
export const parenOpts = { skip: [dq] }
export const identBoundary = '-_a-zA-Z0-9'
`.trim()

const BUILDERS = (helper: string, builder = 'children => mkIdent(children)') => `
import { node, regex } from 'parseman' with { type: 'macro' }
import { mkIdent } from '${helper}'
export const ident = node('Ident', regex(/[a-z]+/), ${builder})
`.trim()

let dir: string
let seq = 0
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-imported-values-'))
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "app", "type": "module" }')
  fs.writeFileSync(path.join(dir, 'terminals.ts'), TERMINALS)
  fs.writeFileSync(path.join(dir, 'runtime-only.ts'), 'export const opaque = makeAtRuntime()\n')
  fs.writeFileSync(path.join(dir, 'barrel.ts'), "export * from './runtime-only.ts'\nexport * from './terminals.ts'\n")
  // A published package whose entry is the MACRO OUTPUT of the same terminals.
  const pkg = path.join(dir, 'node_modules', '@t', 'shared')
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@t/shared', type: 'module', exports: { '.': './lib/index.js' } }))
  const lib = transformMacro(TERMINALS, path.join(pkg, 'src', 'index.ts'), new Set(['parseman']))!
  expect(lib.warnings).toEqual([])
  fs.writeFileSync(path.join(pkg, 'lib', 'index.js'), lib.code)
  // The same entry as a bundler ships it: esbuild emits every top-level `const` as `var`.
  const bundled = path.join(dir, 'node_modules', '@t', 'bundled')
  fs.mkdirSync(path.join(bundled, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(bundled, 'package.json'), JSON.stringify({ name: '@t/bundled', type: 'module', exports: { '.': './lib/index.js' } }))
  buildSync({ stdin: { contents: lib.code, resolveDir: pkg }, bundle: true, format: 'esm', external: ['parseman', 'parseman/*'], outfile: path.join(bundled, 'lib', 'index.js'), logLevel: 'silent' })
  expect(fs.readFileSync(path.join(bundled, 'lib', 'index.js'), 'utf8')).toMatch(/^var dq = /m)
  // A `var` the module reassigns does not hold its initializer.
  const rebound = path.join(dir, 'node_modules', '@t', 'rebound')
  fs.mkdirSync(rebound, { recursive: true })
  fs.writeFileSync(path.join(rebound, 'package.json'), JSON.stringify({ name: '@t/rebound', type: 'module', exports: { '.': './index.js' } }))
  fs.writeFileSync(path.join(rebound, 'index.js'), "var identBoundary = '-_a-zA-Z0-9'\nidentBoundary = 'a-z'\nvar redeclared = 'a-z'\nif (globalThis.x) { var redeclared = '0-9' }\nexport { identBoundary, redeclared }\n")
  // A package whose terminal was compiled WITHOUT carried IR (an older parseman).
  const stale = path.join(dir, 'node_modules', '@t', 'stale')
  fs.mkdirSync(path.join(stale, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(stale, 'package.json'), JSON.stringify({ name: '@t/stale', type: 'module', exports: { '.': './lib/index.js' } }))
  fs.writeFileSync(path.join(stale, 'lib', 'index.js'), 'import { tableRules } from "parseman/table"\nexport const dq = /* @__PURE__ */ tableRules({ a: [] })["Entry"]\n')
  // A terminal whose node() builder calls a helper ITS module imports.
  fs.writeFileSync(path.join(dir, 'builders.ts'), BUILDERS('./ast.js'))
  fs.mkdirSync(path.join(dir, 'sub'))
  for (const [name, helper, builder] of [['builders', '@t/ast'], ['builders-rel', './ast.js'], ['builders-named', '@t/ast', 'mkIdent']]) {
    const p = path.join(dir, 'node_modules', '@t', name!)
    fs.mkdirSync(path.join(p, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name: `@t/${name}`, type: 'module', exports: { '.': './lib/index.js' } }))
    fs.writeFileSync(path.join(p, 'lib', 'index.js'), transformMacro(BUILDERS(helper!, builder), path.join(p, 'src', 'index.ts'), new Set(['parseman']))!.code)
  }
})
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function lower(src: string) {
  return transformMacro(src.trim(), path.join(dir, `entry${seq++}.ts`), new Set(['parseman']))!
}

function build(src: string): Record<string, Rule> {
  const out = lower(src)
  expect(out.warnings).toEqual([])
  expect(out.code).not.toMatch(/from ['"]parseman['"]/)
  return evalMacroModule<Record<string, Rule>>(out.code, 'grammar')
}

/** Two grammars returning the SAME terminals, one with options and one without.
 * `rules()` stamps options onto the rule object, so a shared one used to carry the
 * first grammar's trivia and scanSkip into the second. */
function expectOwnOptions(src: string): void {
  const out = lower(src)
  expect(out.warnings).toEqual([])
  const g = evalMacroModule<Record<string, Record<string, Rule>>>(out.code, '{ spaced, plain }')
  expect(endOf(g.spaced!.Pair!, 'a b')).toBe(3)
  expect(endOf(g.plain!.Pair!, 'a b')).toBeNull()
  expect(endOf(g.spaced!.Doc!, 'a ";" b;')).toBe(7)
  expect(endOf(g.plain!.Doc!, 'a ";" b;')).toBe(3)
}

const endOf = (rule: Rule, input: string): number | null => {
  const r = rule(input, 0, {})
  return r.ok ? r.span.end : null
}

describe.each([
  ['a relative source module', './terminals.ts'],
  ['a published package entry', '@t/shared'],
  ['a bundled package entry', '@t/bundled'],
])('imported from %s', (_, from) => {
  it('an imported terminal inside a rule body', () => {
    const g = build(`
import { rules, sequence, literal } from 'parseman' with { type: 'macro' }
import { dq } from '${from}'
export const grammar = rules(g => ({ Doc: sequence(literal('='), dq) }))
`)
    expect(endOf(g.Doc!, '="a b"')).toBe(6)
    expect(endOf(g.Doc!, '=x')).toBeNull()
  })

  it('an imported scanSkip array', () => {
    const g = build(`
import { rules, literal, scanTo } from 'parseman' with { type: 'macro' }
import { skipUnits as scanSkip } from '${from}'
export const grammar = rules({ scanSkip }, g => ({ Doc: scanTo(literal(';')) }))
`)
    const input = `a ";" /* ; */ ';' b;`
    // Up to (not including) the LAST `;`. Without the skip set the scan stops at the
    // `;` inside the string (end 3).
    expect(endOf(g.Doc!, input)).toBe(input.length - 1)
  })

  it('a scanSkip array of imported units', () => {
    const g = build(`
import { rules, literal, scanTo } from 'parseman' with { type: 'macro' }
import { dq, blockComment } from '${from}'
export const grammar = rules({ scanSkip: [dq, blockComment] }, g => ({ Doc: scanTo(literal(';')) }))
`)
    const input = `a ";" /* ; */ b;`
    expect(endOf(g.Doc!, input)).toBe(input.length - 1)
  })

  it('an imported options object passed to a combinator', () => {
    const g = build(`
import { rules, balanced } from 'parseman' with { type: 'macro' }
import { parenOpts } from '${from}'
export const grammar = rules(g => ({ Doc: balanced('(', ')', parenOpts) }))
`)
    // Without the options the ')' inside the string closes the region (end 5).
    expect(endOf(g.Doc!, '(a ")" b)')).toBe(9)
  })

  it('an imported boundary string passed to word()', () => {
    const g = build(`
import { rules, word } from 'parseman' with { type: 'macro' }
import { identBoundary } from '${from}'
export const grammar = rules(g => ({ Doc: word('if', identBoundary) }))
`)
    expect(endOf(g.Doc!, 'if')).toBe(2)
    expect(endOf(g.Doc!, 'if-x')).toBeNull()
  })

  it('two grammars returning the same imported terminal keep their own options', () => {
    expectOwnOptions(`
import { rules, regex } from 'parseman' with { type: 'macro' }
import { ab, toSemi, dq } from '${from}'
export const spaced = rules({ trivia: regex(/\\s+/), scanSkip: [dq] }, g => ({ Pair: ab, Doc: toSemi }))
export const plain = rules(g => ({ Pair: ab, Doc: toSemi }))
`)
  })

  it('drops the import the compiled grammar no longer reads', () => {
    const out = lower(`
import { rules, sequence, literal } from 'parseman' with { type: 'macro' }
import { dq } from '${from}'
export const grammar = rules(g => ({ Doc: sequence(literal('='), dq) }))
`)
    expect(out.code).not.toContain(from)
  })
})

describe('a composed dialect names the shared skip set by import', () => {
  // `scanSkip` is per-piece under compose (each dialect's set governs only its own
  // rules), so this is the family case: every dialect imports ONE skip set.
  it.each([
    ['compose', 'compose([base, rules({ scanSkip: skipUnits }, g => ({ Doc: scanTo(literal(\';\')) }))])'],
    ['composeLeaf', 'composeLeaf([base, rules({ scanSkip: skipUnits }, g => ({ Doc: scanTo(literal(\';\')) }))])'],
  ])('%s', (_, call) => {
    const g = build(`
import { rules, compose, composeLeaf, literal, regex, scanTo } from 'parseman' with { type: 'macro' }
import { skipUnits } from '@t/shared'
const base = rules(g => ({ Filler: regex(/#/) }))
export const grammar = ${call}
`)
    const input = `a ";" /* ; */ b;`
    expect(endOf(g.Doc!, input)).toBe(input.length - 1)
  })
})

describe('a local NAMED skip array', () => {
  it('is honoured by rules({ scanSkip }) — it was dropped as silently as an imported one', () => {
    const g = build(`
import { rules, literal, regex, sequence, scanTo } from 'parseman' with { type: 'macro' }
const dq = sequence(literal('"'), regex(/[^"]*/), literal('"'))
const SKIP = [dq]
export const grammar = rules({ scanSkip: SKIP }, g => ({ Doc: scanTo(literal(';')) }))
`)
    expect(endOf(g.Doc!, 'a ";" b;')).toBe(7)
  })

  it('an EMPTY named skip array means no skip units, exactly as `[]` does', () => {
    const g = build(`
import { rules, literal, scanTo } from 'parseman' with { type: 'macro' }
const SKIP = []
export const grammar = rules({ scanSkip: SKIP }, g => ({ Doc: scanTo(literal(';')) }))
`)
    expect(endOf(g.Doc!, 'a ";" b;')).toBe(3)
  })

  it('a named NULL option means no option, exactly as `null` does', () => {
    const g = build(`
import { rules, literal, scanTo } from 'parseman' with { type: 'macro' }
const NONE = null
export const grammar = rules({ trivia: NONE, scanSkip: NONE }, g => ({ Doc: scanTo(literal(';')) }))
`)
    expect(endOf(g.Doc!, 'a ";" b;')).toBe(3)
  })
})

describe('a LOCAL terminal returned by two grammars', () => {
  it('each grammar keeps its own options', () => {
    expectOwnOptions(`
import { rules, literal, regex, sequence, scanTo } from 'parseman' with { type: 'macro' }
const dq = sequence(literal('"'), regex(/[^"]*/), literal('"'))
const ab = sequence(literal('a'), literal('b'))
const toSemi = scanTo(literal(';'))
export const spaced = rules({ trivia: regex(/\\s+/), scanSkip: [dq] }, g => ({ Pair: ab, Doc: toSemi }))
export const plain = rules(g => ({ Pair: ab, Doc: toSemi }))
`)
  })
})

describe('an imported terminal whose node() builder calls a helper its module imports', () => {
  const grammar = (from: string) => `
import { rules, sequence, literal } from 'parseman' with { type: 'macro' }
import { ident } from '${from}'
export const grammar = rules(g => ({ Doc: sequence(literal('='), ident) }))
`
  const mkIdent = (children: unknown) => ({ made: children })

  it('re-imports the helper, re-spelled from this module, for a relative source', () => {
    const out = transformMacro(grammar('../builders.ts').trim(), path.join(dir, 'sub', 'entry.ts'), new Set(['parseman']))!
    expect(out.warnings).toEqual([])
    expect(out.code).toMatch(/^import \{ mkIdent \} from "\.\.\/ast\.js"$/m)
    const g = evalMacroModule<Record<string, (i: string, p: number, c: object) => { ok: boolean; value: unknown }>>(out.code, 'grammar', { mkIdent })
    expect(g.Doc!('=ab', 0, {}).value).toMatchObject(['=', { made: [{ value: 'ab' }] }])
  })

  it('re-imports a helper a package imports by name', () => {
    const out = lower(grammar('@t/builders'))
    expect(out.warnings).toEqual([])
    expect(out.code).toMatch(/^import \{ mkIdent \} from "@t\/ast"$/m)
  })

  it('refuses a helper a package imports by relative path, naming both', () => {
    expect(() => lower(grammar('@t/builders-rel'))).toThrow(/`ident` has a node\(\) builder reading `mkIdent` from '\.\/ast\.js' inside .*builders-rel/)
  })

  it('names the terminal whose carried builder IR cannot be rebuilt', () => {
    // A package builder that is an imported NAME, not an inline function, is carried
    // with a static error the IR cannot rebuild from.
    expect(() => lower(grammar('@t/builders-named'))).toThrow(/`ident` carries combinator IR that does not evaluate .*builders-named.*: IR direct node builder for Ident/)
  })
})

describe('ordinary code beside a grammar', () => {
  it('is evaluated only if a grammar reads it, so its imports are never resolved', () => {
    // `table` reads a static local and a runtime-only import. It is not grammar code,
    // and evaluating it anyway failed the build over a value nothing compiles.
    const out = lower(`
import { rules, literal } from 'parseman' with { type: 'macro' }
import { opaque } from './runtime-only.ts'
const N = 3
const table = opaque(N)
export const grammar = rules(g => ({ Doc: literal('a') }))
`)
    expect(out.warnings).toEqual([])
    expect(out.code).toContain('const table = opaque(N)')
  })

  it('a local read by two grammars resolves for both', () => {
    const out = lower(`
import { rules, word } from 'parseman' with { type: 'macro' }
const B = '-_a-zA-Z0-9'
export const one = rules(g => ({ Doc: word('if', B) }))
export const two = rules(g => ({ Doc: word('else', B) }))
`)
    expect(out.warnings).toEqual([])
    const g = evalMacroModule<Record<string, Record<string, Rule>>>(out.code, '{ one, two }')
    expect(endOf(g.one!.Doc!, 'if-x')).toBeNull()
    expect(endOf(g.two!.Doc!, 'else-x')).toBeNull()
    expect(endOf(g.two!.Doc!, 'else')).toBe(4)
  })

  it('a local a grammar reads is still resolved, after a ref() pre-pass has looked for it', () => {
    const g = build(`
import { rules, ref, literal, word } from 'parseman' with { type: 'macro' }
const B = '-_a-zA-Z0-9'
const r = ref()
r.define(literal('x'))
const kw = word('if', B)
export const grammar = rules(g => ({ Doc: kw }))
`)
    expect(endOf(g.Doc!, 'if')).toBe(2)
    expect(endOf(g.Doc!, 'if-x')).toBeNull()
  })
})

describe('a terminal re-exported by a barrel (`export * from`)', () => {
  it('resolves through the star export that has it', () => {
    const g = build(`
import { rules, sequence, literal } from 'parseman' with { type: 'macro' }
import { dq } from './barrel.ts'
export const grammar = rules(g => ({ Doc: sequence(literal('='), dq) }))
`)
    expect(endOf(g.Doc!, '="a b"')).toBe(6)
  })

  it('a name no star exports is still not exported by the barrel', () => {
    expect(() => lower(`
import { rules, sequence, literal } from 'parseman' with { type: 'macro' }
import { nope } from './barrel.ts'
export const grammar = rules(g => ({ Doc: sequence(literal('='), nope) }))
`)).toThrow(/`nope` is not exported by .*barrel\.ts/)
  })
})

describe('a compiled terminal carries its combinator IR only where another module can reach it', () => {
  it('an exported terminal, and one an exported array still names', () => {
    const code = fs.readFileSync(path.join(dir, 'node_modules', '@t', 'shared', 'lib', 'index.js'), 'utf8')
    for (const name of ['dq', 'blockComment', 'sq']) {
      expect(code, name).toMatch(new RegExp(`const ${name} = /\\* @__PURE__ \\*/ Object\\.defineProperty\\(`))
    }
  })

  it('not a terminal nothing outside the compiled grammar names', () => {
    const out = lower(`
import { rules, literal } from 'parseman' with { type: 'macro' }
const semi = literal(';')
export const grammar = rules(g => ({ Doc: semi }))
`)
    expect(out.code).not.toContain('parseman.combinatorIR')
  })

  it('not one named only by a shared rules() factory, whose text survives as dead code', () => {
    const out = lower(`
import { rules, literal } from 'parseman' with { type: 'macro' }
const semi = literal(';')
const factory = g => ({ Doc: semi })
export const grammar = rules(factory)
`)
    expect(out.warnings).toEqual([])
    expect(out.code).not.toContain('parseman.combinatorIR')
  })
})

describe('what the macro cannot resolve fails the build, naming the binding', () => {
  it('an imported terminal inside a rule body', () => {
    expect(() => lower(`
import { rules, sequence, literal } from 'parseman' with { type: 'macro' }
import { opaque } from './runtime-only.ts'
export const grammar = rules(g => ({ Doc: sequence(literal('='), opaque) }))
`)).toThrow(/grammar: rules\(\.\.\.\) factory can't be evaluated at build time; unresolved binding\(s\):\n {2}- `opaque` .*runtime-only\.ts/)
  })

  it('an imported scanSkip array', () => {
    expect(() => lower(`
import { rules, literal, scanTo } from 'parseman' with { type: 'macro' }
import { opaque } from './runtime-only.ts'
export const grammar = rules({ scanSkip: opaque }, g => ({ Doc: scanTo(literal(';')) }))
`)).toThrow(/grammar: rules\(\{ scanSkip \}\) can't be evaluated at build time; unresolved binding\(s\):\n {2}- `opaque` /)
  })

  it('an imported options object passed to a combinator', () => {
    expect(() => lower(`
import { rules, balanced } from 'parseman' with { type: 'macro' }
import { opaque } from './runtime-only.ts'
export const grammar = rules(g => ({ Doc: balanced('(', ')', opaque) }))
`)).toThrow(/grammar: rules\(\.\.\.\) factory can't be evaluated at build time; unresolved binding\(s\):\n {2}- `opaque` /)
  })

  it('a package terminal compiled without carried IR', () => {
    expect(() => lower(`
import { rules, sequence, literal } from 'parseman' with { type: 'macro' }
import { dq } from '@t/stale'
export const grammar = rules(g => ({ Doc: sequence(literal('='), dq) }))
`)).toThrow(/`dq` is a compiled parser in .*carries no combinator IR/)
  })

  it('a bundled `var` the module reassigns or redeclares', () => {
    expect(() => lower(`
import { rules, word } from 'parseman' with { type: 'macro' }
import { identBoundary } from '@t/rebound'
export const grammar = rules(g => ({ Doc: word('if', identBoundary) }))
`)).toThrow(/`identBoundary` could not be resolved in .*rebound/)
    expect(() => lower(`
import { rules, word } from 'parseman' with { type: 'macro' }
import { redeclared } from '@t/rebound'
export const grammar = rules(g => ({ Doc: word('if', redeclared) }))
`)).toThrow(/`redeclared` could not be resolved in .*rebound/)
  })

  it('a missing export and an unresolvable module', () => {
    expect(() => lower(`
import { rules, literal, scanTo } from 'parseman' with { type: 'macro' }
import { nope } from './terminals.ts'
export const grammar = rules({ scanSkip: [nope] }, g => ({ Doc: scanTo(literal(';')) }))
`)).toThrow(/`nope` is not exported by /)
    expect(() => lower(`
import { rules, literal, scanTo } from 'parseman' with { type: 'macro' }
import { nope } from '@t/absent'
export const grammar = rules({ scanSkip: [nope] }, g => ({ Doc: scanTo(literal(';')) }))
`)).toThrow(/`nope` is imported from '@t\/absent', which does not resolve/)
  })

  it('a trivia option, and an options spread that could hide one', () => {
    expect(() => lower(`
import { rules, literal } from 'parseman' with { type: 'macro' }
import { opaque } from './runtime-only.ts'
export const grammar = rules({ trivia: opaque }, g => ({ Doc: literal('a') }))
`)).toThrow(/grammar: rules\(\{ trivia \}\) can't be evaluated/)
    expect(() => lower(`
import { rules, literal } from 'parseman' with { type: 'macro' }
import { opaque } from './runtime-only.ts'
export const grammar = rules({ ...opaque }, g => ({ Doc: literal('a') }))
`)).toThrow(/grammar: an options spread can't be evaluated/)
    expect(() => lower(`
import { rules, compose, literal } from 'parseman' with { type: 'macro' }
import { opaque } from './runtime-only.ts'
const a = rules(g => ({ Doc: literal('a') }))
export const grammar = compose([a], { ...opaque })
`)).toThrow(/compose\(\): an options spread can't be evaluated/)
  })

  it('a trailing rules(factory, OPTS) options argument that is not an object literal', () => {
    expect(() => lower(`
import { rules, literal, regex, sequence, scanTo } from 'parseman' with { type: 'macro' }
const dq = sequence(literal('"'), regex(/[^"]*/), literal('"'))
const OPTS = { scanSkip: [dq] }
export const grammar = rules(g => ({ Doc: scanTo(literal(';')) }), OPTS)
`)).toThrow(/grammar: rules\(\) options can't be evaluated/)
  })

  it('a local declaration that reads an unresolvable import, named through the local', () => {
    expect(() => lower(`
import { rules, literal, scanTo } from 'parseman' with { type: 'macro' }
import { opaque } from './runtime-only.ts'
const SKIP = [opaque]
export const grammar = rules({ scanSkip: SKIP }, g => ({ Doc: scanTo(literal(';')) }))
`)).toThrow(/`SKIP` could not be evaluated at build time, because: `opaque` /)
  })
})
