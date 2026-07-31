/**
 * Branch coverage for `src/plugin/reducer-resolver.ts` — the declines it has not
 * been asked for yet, plus the scope-walk shapes that must NOT change an answer.
 *
 * A wrong arity here UNDER-captures: the compiler elides arguments the reducer then
 * reads as `undefined`. So every case asserts the specific reason string or the
 * specific arity, never merely "it returned something".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseSync } from 'oxc-parser'
import { createReducerResolver } from '../../src/plugin/reducer-resolver.ts'

let dir: string
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugincov-reducers-')) })
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function write(rel: string, src: string): string {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, src)
  return file
}

/** Resolve `expr` at the `/*HERE*\/` marker of a virtual entry module. */
function resolveAt(src: string, expr: string, file = '/virtual/entry.ts') {
  const code = src.trim()
  const offset = code.indexOf('/*HERE*/')
  if (offset < 0) throw new Error('test source needs a /*HERE*/ marker')
  const parsed = parseSync(file, code)
  expect(parsed.errors).toHaveLength(0)
  const r = createReducerResolver(file, parsed.program.body as unknown[], code)
  return r.resolve(expr, offset, code)
}

const reasonOf = (src: string, expr: string, file?: string) => resolveAt(src, expr, file)?.reason
const arityOf = (src: string, expr: string, file?: string) => resolveAt(src, expr, file)?.arity

// ---------------------------------------------------------------------------
// Scope-walk shapes that must not perturb an answer
// ---------------------------------------------------------------------------

describe('reassignment detection targets bindings, not arbitrary assignment targets', () => {
  it('does not treat a member assignment as a reassignment of the object binding', () => {
    // `patternNames` on a MemberExpression target yields no names; if it ever yielded
    // `helpers`, this arrow would decline as `reassigned` and lose its arity.
    expect(arityOf(`
const fold = (c, f) => 0
const bag = {}
bag.fold = 1
const g = /*HERE*/fold
`, 'fold')).toBe(2)
  })

  it('treats an update expression as a reassignment', () => {
    expect(reasonOf(`
let fold = (c) => 0
fold++
const g = /*HERE*/fold
`, 'fold')).toBe('reassigned')
  })

  it('tolerates an assignment to a name that is not declared anywhere', () => {
    expect(arityOf(`
const fold = (c, f, s) => 0
undeclaredGlobal = 1
const g = /*HERE*/fold
`, 'fold')).toBe(3)
  })

  it('is unaffected by an anonymous class declaration in the module', () => {
    expect(arityOf(`
export default class {}
const fold = (c) => 0
const g = /*HERE*/fold
`, 'fold')).toBe(1)
  })

  it('does not mistake a non-AST object inside a body for an `arguments` read', () => {
    // The regex literal carries a plain `{ pattern, flags }` child with no `type`.
    expect(arityOf(`
function fold(c, f) { return /x/.test(c) }
const g = /*HERE*/fold
`, 'fold')).toBe(2)
  })
})

describe('a binding with no initializer is not a function', () => {
  it('declines a declared-but-uninitialised binding', () => {
    expect(reasonOf(`
let fold
const g = /*HERE*/fold
`, 'fold')).toBe('not-a-function')
  })
})

// ---------------------------------------------------------------------------
// Member-expression initializers
// ---------------------------------------------------------------------------

describe('a reducer initialised from a member expression', () => {
  it('follows a static member through the object binding', () => {
    expect(reasonOf(`
const helpers = { fold: (c) => 0 }
const fold = helpers.fold
const g = /*HERE*/fold
`, 'fold')).toBe('not-a-function')
  })

  it('reports a missing object binding as not-found, not as computed', () => {
    expect(reasonOf(`
const fold = missingHelpers.fold
const g = /*HERE*/fold
`, 'fold')).toBe('not-found')
  })

  it('reports a nested member path as computed rather than guessing', () => {
    expect(reasonOf(`
const fold = a.b.c
const g = /*HERE*/fold
`, 'fold')).toBe('computed')
  })

  it('reports a computed member access as computed', () => {
    expect(reasonOf(`
const helpers = { fold: (c) => 0 }
const fold = helpers['fold']
const g = /*HERE*/fold
`, 'fold')).toBe('computed')
  })
})

describe('alias chains are bounded', () => {
  it('gives up on a chain longer than the hop limit instead of walking forever', () => {
    const links = Array.from({ length: 16 }, (_, i) => `const a${i + 1} = a${i}`).join('\n')
    expect(reasonOf(`
const a0 = (c, f) => 0
${links}
const g = /*HERE*/a16
`, 'a16')).toBe('not-found')
  })

  it('still resolves a chain inside the hop limit', () => {
    const links = Array.from({ length: 5 }, (_, i) => `const a${i + 1} = a${i}`).join('\n')
    expect(arityOf(`
const a0 = (c, f) => 0
${links}
const g = /*HERE*/a5
`, 'a5')).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Cross-module reading
// ---------------------------------------------------------------------------

describe('modules that cannot be read or parsed decline rather than guess', () => {
  it('reports an import of an unparseable module as unresolved', () => {
    write('broken/broken.ts', 'const = = =\n')
    const entry = path.join(dir, 'broken/entry.ts')
    expect(reasonOf(`
import { fold } from './broken.ts'
const g = /*HERE*/fold
`, 'fold', entry)).toBe('unresolved-import')
  })

  it('reports a re-export through an unparseable module as not-found', () => {
    write('reexport/broken.ts', 'function = =\n')
    write('reexport/mid.ts', "export { fold } from './broken.ts'\n")
    const entry = path.join(dir, 'reexport/entry.ts')
    expect(reasonOf(`
import { fold } from './mid.ts'
const g = /*HERE*/fold
`, 'fold', entry)).toBe('not-found')
  })
})

describe('what a module exports, by every spelling', () => {
  it('skips an export specifier for a different name before finding the wanted one', () => {
    write('specs/mod.ts', 'const other = 1\nconst fold = (c, f, s) => 0\nexport { other, fold }\n')
    const entry = path.join(dir, 'specs/entry.ts')
    expect(arityOf(`
import { fold } from './mod.ts'
const g = /*HERE*/fold
`, 'fold', entry)).toBe(3)
  })

  it('declines an export specifier whose local name is not declared', () => {
    write('specs2/mod.ts', 'export { fold } from "./nope-missing.ts"\n')
    const entry = path.join(dir, 'specs2/entry.ts')
    expect(reasonOf(`
import { fold } from './mod.ts'
const g = /*HERE*/fold
`, 'fold', entry)).toBe('not-found')
  })

  it('ignores a type-only export declaration while looking for the binding', () => {
    write('typeonly/mod.ts', 'export interface Shape { a: number }\nexport const fold = (c, f) => 0\n')
    const entry = path.join(dir, 'typeonly/entry.ts')
    expect(arityOf(`
import { fold } from './mod.ts'
const g = /*HERE*/fold
`, 'fold', entry)).toBe(2)
  })

  it('declines a default export that is neither a function nor a name', () => {
    write('defobj/mod.ts', 'export default { fold: (c) => 0 }\n')
    const entry = path.join(dir, 'defobj/entry.ts')
    expect(reasonOf(`
import fold from './mod.ts'
const g = /*HERE*/fold
`, 'fold', entry)).toBe('not-found')
  })

  it('declines `export default <name>` when the name is not declared', () => {
    write('defmissing/mod.ts', 'export default missingLocal\n')
    const entry = path.join(dir, 'defmissing/entry.ts')
    expect(reasonOf(`
import fold from './mod.ts'
const g = /*HERE*/fold
`, 'fold', entry)).toBe('not-found')
  })

  it('falls back to a module-scope declaration the export list does not mention', () => {
    write('fallback/mod.ts', 'const fold = (c, f, s, r) => 0\nexport default 1\n')
    const entry = path.join(dir, 'fallback/entry.ts')
    expect(arityOf(`
import { fold } from './mod.ts'
const g = /*HERE*/fold
`, 'fold', entry)).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

describe('register()', () => {
  it('accepts the entry file itself without displacing the caller-supplied pair', () => {
    const file = write('register/entry.ts', 'const fold = (c, f) => 0\n')
    const code = fs.readFileSync(file, 'utf8')
    const parsed = parseSync(file, code)
    const r = createReducerResolver(file, parsed.program.body as unknown[], code)
    expect(r.register(file)).toBe(true)
    expect(r.resolve('fold', code.length - 1, code)?.arity).toBe(2)
  })

  it('keeps declining a text key once two distinct files have claimed it', () => {
    const text = 'export const fold = (c, f) => 0\n'
    const a = write('amb/a/mod.ts', text)
    const b = write('amb/b/mod.ts', text)
    const entryCode = 'const x = 1\n'
    const parsed = parseSync('/virtual/amb-entry.ts', entryCode)
    const r = createReducerResolver('/virtual/amb-entry.ts', parsed.program.body as unknown[], entryCode)

    expect(r.register(a)).toBe(true)
    expect(r.register(b)).toBe(false)
    // A THIRD attempt must not quietly re-admit the ambiguous text.
    expect(r.register(a)).toBe(false)
    expect(r.resolve('fold', 0, text)).toEqual({ arity: null, src: null, reason: 'ambiguous-source' })
  })
})
