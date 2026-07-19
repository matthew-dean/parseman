import { describe, it, expect } from 'vitest'
import { transformMacro } from '../../src/plugin/index.ts'

function transform(code: string) {
  return transformMacro(code, 'test.ts', new Set(['parseman']))
}

describe('transformMacro — import detection', () => {
  it('returns null for files without parseman', () => {
    expect(transform(`const x = 1`)).toBeNull()
  })

  it('returns null for regular (non-macro) parseman imports', () => {
    expect(transform(`import { literal } from 'parseman'`)).toBeNull()
  })

  it('detects with { type: "macro" } syntax', () => {
    const code = `
import { literal } from 'parseman' with { type: 'macro' }
const greeting = literal('hello')
`.trim()
    const result = transform(code)
    expect(result).not.toBeNull()
  })
})

describe('transformMacro — literal inlining', () => {
  it('inlines a simple literal() call', () => {
    const code = `
import { literal } from 'parseman' with { type: 'macro' }
const greeting = literal('hello')
`.trim()
    const result = transform(code)!
    // The import should be gone
    expect(result.code).not.toContain("from 'parseman'")
    // The declaration should be replaced with an inline function
    expect(result.code).toContain('const greeting =')
    expect(result.code).toContain('function(input')
    // 'hello' is 5 chars → still an unrolled charCodeAt chain (≤16 threshold)
    expect(result.code).toContain('charCodeAt')
    expect(result.code).not.toContain('startsWith')
  })

  it('inlines a long literal() (>16 chars uses startsWith)', () => {
    const code = `
import { literal } from 'parseman' with { type: 'macro' }
const kw = literal('Content-Disposition')
`.trim()
    const result = transform(code)!
    expect(result.code).toContain('startsWith("Content-Disposition"')
    expect(result.code).not.toContain("from 'parseman'")
  })

  it('inlines case-insensitive literal', () => {
    const code = `
import { literal } from 'parseman' with { type: 'macro' }
const method = literal('GET', { caseInsensitive: true })
`.trim()
    const result = transform(code)!
    // Case-insensitive literals lower to the ASCII bit-OR fold `(c | 32) === …`,
    // NOT Intl.Collator (removed — measured ~9× slower).
    expect(result.code).toContain('| 32) ===')
    expect(result.code).not.toContain('_collator')
    expect(result.code).not.toContain('Intl.Collator')
    expect(result.code).not.toContain("from 'parseman'")
  })
})

describe('transformMacro — choice inlining', () => {
  it('inlines a disjoint choice', () => {
    const code = `
import { literal, choice } from 'parseman' with { type: 'macro' }
const method = choice(literal('GET'), literal('POST'), literal('DELETE'))
`.trim()
    const result = transform(code)!
    expect(result.code).not.toContain("from 'parseman'")
    // Should have codePointAt dispatch
    expect(result.code).toContain('codePointAt')
  })
})

describe('transformMacro — sequence inlining', () => {
  it('inlines sequence of literals', () => {
    const code = `
import { literal, sequence } from 'parseman' with { type: 'macro' }
const pair = sequence(literal('foo'), literal('bar'))
`.trim()
    const result = transform(code)!
    expect(result.code).not.toContain("from 'parseman'")
    expect(result.code).toContain('const pair =')
  })
})

describe('transformMacro — cross-declaration references', () => {
  it('inlines a parser that references a previously inlined parser', () => {
    const code = `
import { literal, sequence, choice, regex } from 'parseman' with { type: 'macro' }
const method = choice(literal('GET'), literal('POST'), literal('PUT'))
const sp = literal(' ')
const target = regex(/[^\\s]+/)
const requestLine = sequence(method, sp, target)
`.trim()
    const result = transform(code)!
    expect(result.code).not.toContain("from 'parseman'")
    expect(result.code).toContain('const method =')
    expect(result.code).toContain('const requestLine =')
  })
})

describe('transformMacro — transform() declarations', () => {
  it('inlines transform() with an inline callback', () => {
    const code = `
import { literal, transform } from 'parseman' with { type: 'macro' }
const upper = transform(literal('hello'), s => s.toUpperCase())
`.trim()
    const result = transform(code)
    // transform with an inline callback is now fully compilable
    expect(result).not.toBeNull()
    expect(result!.code).not.toContain('transform(')
    expect(result!.code).toContain('s => s.toUpperCase()')
    expect(result!.code).toContain('const _mf =')
  })
})

describe('transformMacro — rules() binding forms', () => {
  it('compiles a destructured rules() binding', () => {
    const code = `
import { regex, transform, rules } from 'parseman' with { type: 'macro' }
const { A, B } = rules(g => {
  const A = transform(regex(/a/), s => s)
  const B = transform(regex(/b/), s => s)
  return { A, B }
})
`.trim()
    const result = transform(code)!
    expect(result.code).not.toContain("from 'parseman'")
    expect(result.code).toContain('const A =')
    expect(result.code).toContain('const B =')
    expect(result.warnings).toEqual([])
  })

  it('compiles a simple `const x = rules(...)` binding to an object literal', () => {
    const code = `
import { regex, transform, rules } from 'parseman' with { type: 'macro' }
const grammar = rules(g => {
  const A = transform(regex(/a/), s => s)
  const B = transform(regex(/b/), s => s)
  return { A, B }
})
`.trim()
    const result = transform(code)!
    // import removed → fully compiled
    expect(result.code).not.toContain("from 'parseman'")
    // emitted as one shared expression whose result is the compiled rule map
    expect(result.code).toContain('const grammar =')
    expect(result.code).toContain('"A":')
    expect(result.code).toContain('"B":')
    expect(result.code).not.toContain('rules(')
    expect(result.warnings).toEqual([])
  })
})

describe('transformMacro — warnings on uncompilable shapes', () => {
  it('warns (and keeps a valid import) when a binding closes over a runtime value', () => {
    const code = `
import { regex } from 'parseman' with { type: 'macro' }
const dynamic = regex(externalPattern)
`.trim()
    const result = transform(code)!
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toContain('dynamic')
    expect(result.warnings[0]).toMatch(/test\.ts:2/)
    // the macro attribute is stripped so the interpreter import stays valid
    expect(result.code).toContain("from 'parseman'")
    expect(result.code).not.toContain('type: ')
  })

  it('does not warn when everything compiles', () => {
    const code = `
import { literal } from 'parseman' with { type: 'macro' }
const x = literal('x')
`.trim()
    const result = transform(code)!
    expect(result.warnings).toEqual([])
  })
})

describe('transformMacro — unresolved compose fallback', () => {
  it('keeps reachable local trivia combinators runtime and executable', async () => {
    const source = `
import { compose, regex, rules, trivia } from 'parseman' with { type: 'macro' }
const ws = regex(/\\s+/)
const rw = trivia(ws)
export const grammar = compose([externalGrammar, rules({ trivia: rw }, () => ({ Value: regex(/[a-z]+/) }))])
`.trim()
    const result = transform(source)!

    expect(result.warnings).toContainEqual(expect.stringContaining("compose(): argument 0 isn't a build-resolvable grammar"))
    expect(result.code).toContain('const ws = regex(/\\s+/)')
    expect(result.code).toContain('const rw = trivia(ws)')

    const runtime = await import('../../src/index.ts')
    const externalGrammar = runtime.rules(() => ({}))
    const executable = result.code
      .replace("import { compose, regex, rules, trivia } from 'parseman'", '')
      .replace('export const grammar =', 'return')
    const grammar = new Function('externalGrammar', 'compose', 'regex', 'rules', 'trivia', executable)(
      externalGrammar, runtime.compose, runtime.regex, runtime.rules, runtime.trivia,
    ) as { Value: unknown; rw: unknown }
    const parsed = runtime.run(grammar.Value as never, 'alpha', { trivia: grammar.rw as never })
    expect(parsed.ok).toBe(true)
    expect(parsed.unconsumedFrom).toBeNull()
  })

  it('keeps ref wiring and all local macro declarations when composition falls back', () => {
    const source = `
import { compose, literal, ref, rules } from 'parseman' with { type: 'macro' }
const atom = literal('a')
const loop = ref()
loop.define(atom)
export const grammar = compose([externalGrammar, rules(() => ({ Value: loop }))])
`.trim()
    const result = transform(source)!

    expect(result.code).toContain("from 'parseman'")
    expect(result.code).toContain("const atom = literal('a')")
    expect(result.code).toContain('const loop = ref()')
    expect(result.code).toContain('loop.define(atom)')
  })

  it('still statically fuses a fully-resolvable compose', () => {
    const source = `
import { compose, literal, rules } from 'parseman' with { type: 'macro' }
const base = rules(g => ({ Value: literal('a') }))
export const grammar = compose([base, rules(g => ({ Tail: literal('b') }))])
`.trim()
    const result = transform(source)!

    expect(result.warnings).toEqual([])
    expect(result.code).not.toContain("from 'parseman'")
    expect(result.code).not.toContain('compose([')
  })
})

describe('transformMacro — keywords inlining', () => {
  it('inlines word()', () => {
    const code = `
import { word } from 'parseman' with { type: 'macro' }
const kw = word('true')
`.trim()
    const result = transform(code)!
    expect(result.code).not.toContain("from 'parseman'")
    expect(result.code).not.toContain('_rp[')
    // Fixed literal + boundary lowers to charCodeAt dispatch, not RegExp.exec —
    // see emitKeywordsFast (PERF_IDEAS §8b follow-up).
    expect(result.code).toContain('charCodeAt')
    expect(result.code).not.toContain('.exec(input)')
  })

  it('inlines makeWord() factory calls', () => {
    const code = `
import { makeWord } from 'parseman' with { type: 'macro' }
const kw = makeWord()
const ifKw = kw('if')
`.trim()
    const result = transform(code)!
    expect(result.code).not.toContain('_rp[')
    expect(result.code).toContain('const ifKw =')
    expect(result.code).toContain('charCodeAt')
    expect(result.code).not.toContain('.exec(input)')
  })

  it('inlines makeWord(boundary)(str) chained calls', () => {
    const code = `
import { makeWord } from 'parseman' with { type: 'macro' }
const color = makeWord('A-Za-z0-9_-')('color')
`.trim()
    const result = transform(code)!
    expect(result.code).not.toContain("from 'parseman'")
    expect(result.code).not.toContain('_rp[')
  })
})

describe('transformMacro — source maps', () => {
  it('returns a source map', () => {
    const code = `
import { literal } from 'parseman' with { type: 'macro' }
const x = literal('x')
`.trim()
    const result = transform(code)!
    expect(result.map).toBeDefined()
  })
})

describe('transformMacro — recovery option', () => {
  const grammar = `
import { sequence, many, regex, literal } from 'parseman' with { type: 'macro' }
const block = sequence(literal('{'), many(regex(/[a-z]+/)), literal('}'))
`.trim()

  it('bakes recovery into the inlined output when recovery=true (dormant/gated)', () => {
    const on = transformMacro(grammar, 'test.ts', new Set(['parseman']), false, true)!
    expect(on.code).toContain('function(input')  // still inlined
    expect(on.code).toContain('_ctx._tolerant')  // recovery branch, gated (strict = dormant)
    expect(on.code).toContain('_ctx._rec')       // sentinels/scan via _ctx …
    expect(on.code).not.toContain('_rp[')        // … NOT _rp → stays macro-inlinable
  })

  it('emits NO recovery code by default — byte-identical to before', () => {
    const off = transformMacro(grammar, 'test.ts', new Set(['parseman']))!
    expect(off.code).not.toContain('_ctx._tolerant')
    expect(off.code).not.toContain('_ctx._rec')
  })
})
