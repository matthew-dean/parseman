/**
 * Diagnostic and refusal paths of `src/plugin/index.ts` — the macro driver.
 *
 * When the driver cannot statically build a declaration it must leave the runtime call
 * in place AND say why. Both halves matter: a silent decline ships a slow-but-correct
 * artifact nobody notices, and a decline with the wrong message sends the author to the
 * wrong fix. So every case here asserts the ACTUAL warning text, and — where the point
 * is that lowering did not happen — that the runtime call survives in the output.
 *
 * The message text is deliberately pinned. It is the entire user-facing contract of a
 * decline; changing it is a change to the product, not an implementation detail.
 */
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import plugin, { transformMacro } from '../../src/plugin/index.ts'

const ID = '/virtual/g.ts'

const run = (src: string, id = ID) => transformMacro(src.trim(), id, new Set(['parseman']))

/** Every warning the transform produced, joined — assertions match on substrings. */
const warningsOf = (src: string, id = ID): string[] => run(src, id)?.warnings ?? []

/** Run a macro source in a throwaway package directory (needed for cross-module hops). */
function inTempDir<T>(files: Record<string, string>, fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmcov-index-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    for (const [name, body] of Object.entries(files)) {
      const p = path.join(dir, name)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, body.trim())
    }
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// The unplugin hook — what it declines to even look at
// ---------------------------------------------------------------------------
describe('unplugin transform hook', () => {
  const viteTransform = () => {
    const p = plugin.vite({}) as unknown as {
      transformInclude?: (id: string) => boolean
      transform: (this: { warn?: (m: string) => void }, code: string, id: string) =>
        { code: string } | null
    }
    return p
  }

  it('includes only .js/.ts family files outside node_modules', () => {
    const include = (plugin.raw({}, { framework: 'vite' }) as unknown as
      { transformInclude: (id: string) => boolean }).transformInclude
    expect(include('/src/g.ts')).toBe(true)
    expect(include('/src/g.tsx')).toBe(true)
    expect(include('/src/g.mjs')).toBe(false)
    expect(include('/src/g.css')).toBe(false)
    expect(include('/node_modules/dep/g.ts')).toBe(false)
  })

  it('skips a file that never mentions parseman, without parsing it', () => {
    // Deliberately UNPARSEABLE: reaching the parser at all would be the bug.
    expect(viteTransform().transform.call({}, 'const {{{ // no marker here', ID)).toBeNull()
  })

  it('skips a file that mentions parseman but has no macro import', () => {
    expect(viteTransform().transform.call({}, "import { literal } from 'parseman'\nconst a = literal('a')", ID))
      .toBeNull()
  })

  it('returns null when the transform itself declines', () => {
    // Has both markers, so the early exits do not fire — but it cannot be parsed.
    expect(viteTransform().transform.call({}, "// parseman macro\nconst {{{", ID)).toBeNull()
  })

  it('routes warnings to the host warn hook, prefixed', () => {
    const warn = vi.fn()
    const src = "import { rules } from 'parseman' with { type: 'macro' }\nexport const g = rules()"
    const out = viteTransform().transform.call({ warn }, src, ID)
    expect(out).not.toBeNull()
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls[0]![0]).toMatch(/^\[parseman\] /)
  })

  it('falls back to console.warn when the host offers no warn hook', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const src = "import { rules } from 'parseman' with { type: 'macro' }\nexport const g = rules()"
      viteTransform().transform.call({}, src, ID)
      expect(spy).toHaveBeenCalled()
      expect(String(spy.mock.calls[0]![0])).toMatch(/^\[parseman\] /)
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// Warning shape — every decline carries a location and the recovery hint
// ---------------------------------------------------------------------------
describe('the decline message itself', () => {
  it('carries the file, a 1-based line, and the "running via the interpreter" hint', () => {
    const w = warningsOf(`
import { rules } from 'parseman' with { type: 'macro' }

export const g = rules()
`)
    expect(w).toHaveLength(1)
    expect(w[0]).toContain(`${ID}:3 — `)
    expect(w[0]).toContain('running via the interpreter')
  })
})

// ---------------------------------------------------------------------------
// compose() argument validation
// ---------------------------------------------------------------------------
describe('compose() declines', () => {
  it('refuses a non-array first argument and leaves the runtime call in place', () => {
    const out = run(`
import { compose, literal, rules } from 'parseman' with { type: 'macro' }
const a = rules(g => ({ A: literal('a') }))
export const p = compose(a)
`)
    expect(out!.warnings.some(w => w.includes('compose(): expected a static array of grammars/artifacts'))).toBe(true)
    // Declining means the ORIGINAL call survives — the artifact is slow, never wrong.
    expect(out!.code).toMatch(/\bcompose\s*\(/)
  })

  it('refuses a missing first argument', () => {
    expect(warningsOf(`
import { compose } from 'parseman' with { type: 'macro' }
export const p = compose()
`).some(w => w.includes('compose(): expected a static array of grammars/artifacts'))).toBe(true)
  })
})

/**
 * composeLeaf() is the one call that may NOT fall back: a runtime composeLeaf would
 * link a differently-lowered grammar than the one that was type-checked. So each decline
 * is a hard build failure whose message must carry BOTH the headline and the cause that
 * produced it — a headline alone tells the author nothing about which argument to fix.
 */
describe('composeLeaf() declines are build failures, with causes', () => {
  const head = "import { composeLeaf, literal, node, rules } from 'parseman' with { type: 'macro' }"
  const HEADLINE = 'composeLeaf() must macro-fuse; runtime composition is forbidden'

  it('refuses a non-array first argument', () => {
    expect(() => run(`
${head}
export const p = composeLeaf(somethingElse)
`)).toThrow(/composeLeaf\(\): expected a static array of grammars/)
  })

  it('refuses a single-element array — there is nothing to compose onto', () => {
    expect(() => run(`
${head}
export const p = composeLeaf([rules(g => ({ A: literal('a') }))])
`)).toThrow(/composeLeaf\(\): needs imported recognition grammar\(s\) and one local rules\(\) map/)
  })

  it('refuses a final argument that is not a local rules() map', () => {
    expect(() => run(`
${head}
import { recognition } from './nowhere.ts'
export const p = composeLeaf([recognition, 'not a grammar'])
`)).toThrow(/composeLeaf\(\): final argument must be a local rules\(\) map/)
  })

  it('leads with the headline and reports the cause underneath it', () => {
    let message = ''
    try {
      run(`
${head}
export const p = composeLeaf(somethingElse)
`)
    } catch (e) { message = (e as Error).message }
    expect(message).toContain(`${ID}:2 — ${HEADLINE}`)
    expect(message).toContain('\n  causes:\n  - ')
    expect(message).toContain('composeLeaf(): expected a static array of grammars')
  })

  it('names the offending argument index when a recognition grammar is not build-resolvable', () => {
    expect(() => run(`
${head}
import { recognition } from './does-not-exist.ts'
export const p = composeLeaf([
  recognition,
  rules(g => ({ Doc: node('Doc', literal('a'), (children) => children) })),
])
`)).toThrow(/composeLeaf\(\): argument 0 isn't a build-resolvable recognition grammar/)
  })

  it('refuses a pre-final grammar that does not prove recognition-only', () => {
    // The imported grammar carries a build callback, so it is NOT recognition-only —
    // fusing it would run its reducer under the leaf grammar's capture regime.
    inTempDir({
      'recognition.ts': `
import { literal, node, rules } from 'parseman' with { type: 'macro' }
export const recognition = rules(g => ({ Atom: node('Atom', literal('x'), (children) => children) }))
`,
      'leaf.ts': `
import { composeLeaf, literal, node, rules } from 'parseman' with { type: 'macro' }
import { recognition } from './recognition.ts'
export const p = composeLeaf([
  recognition,
  rules(g => ({ Doc: node('Doc', g.Atom, (children) => children) })),
])
`,
    }, dir => {
      const leaf = path.join(dir, 'leaf.ts')
      expect(() => transformMacro(fs.readFileSync(leaf, 'utf8'), leaf, new Set(['parseman'])))
        .toThrow(/composeLeaf\(\): every pre-final grammar must explicitly prove recognition-only/)
    })
  })

  it('compiles the well-formed shape with NO warnings — the declines are not blanket', () => {
    const out = inTempDir({
      'recognition.ts': `
import { literal, rules } from 'parseman' with { type: 'macro' }
export const recognition = rules(g => ({ Atom: literal('x') }))
`,
      'leaf.ts': `
import { composeLeaf, node, rules } from 'parseman' with { type: 'macro' }
import { recognition } from './recognition.ts'
export const p = composeLeaf([
  recognition,
  rules(g => ({ Doc: node('Doc', g.Atom, (children) => children) })),
])
`,
    }, dir => {
      const leaf = path.join(dir, 'leaf.ts')
      return transformMacro(fs.readFileSync(leaf, 'utf8'), leaf, new Set(['parseman']))!
    })
    expect(out.warnings).toEqual([])
    expect(out.code).not.toMatch(/\bcomposeLeaf\s*\(/)
  })
})

// ---------------------------------------------------------------------------
// rules() destructuring — the binding-level declines
// ---------------------------------------------------------------------------
describe('destructuring a rules() map', () => {
  it('lowers a clean destructure and emits both bindings', () => {
    const out = run(`
import { literal, rules } from 'parseman' with { type: 'macro' }
export const { A, B } = rules(g => ({ A: literal('a'), B: literal('b') }))
`)
    expect(out!.warnings).toEqual([])
    expect(out!.code).not.toMatch(/\brules\s*\(/)
  })

  it('declines a RENAMING destructure key that the factory does not define', () => {
    const w = warningsOf(`
import { literal, rules } from 'parseman' with { type: 'macro' }
export const { A: first, Missing: second } = rules(g => ({ A: literal('a') }))
`)
    expect(w.some(m => /Missing/.test(m))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Module aliases
// ---------------------------------------------------------------------------
describe('module aliases', () => {
  const ALIASED = `
import { literal, rules } from 'some-wrapper' with { type: 'macro' }
export const g = rules(f => ({ A: literal('a') }))
`.trim()

  it('does not treat a macro import from an unlisted module as parseman', () => {
    // No macro import the driver recognises → it declines the module entirely, so the
    // bundler keeps the ORIGINAL source and the runtime rules() call still runs.
    expect(transformMacro(ALIASED, ID, new Set(['parseman']))).toBeNull()
  })

  it('lowers through an alias when the caller lists it', () => {
    const out = transformMacro(ALIASED, ID, new Set(['parseman', 'some-wrapper']))!
    expect(out.warnings).toEqual([])
    // The macro import is gone and a compiled rule function took the call's place.
    expect(out.code).not.toContain("from 'some-wrapper'")
    expect(out.code).toContain('function _r_A(')
  })
})

// ---------------------------------------------------------------------------
// The version-lock banner — only on a module that actually lowered
// ---------------------------------------------------------------------------
describe('generated-artifact banner', () => {
  it('is stamped when something lowered', () => {
    const out = run(`
import { literal, rules } from 'parseman' with { type: 'macro' }
export const g = rules(f => ({ A: literal('a') }))
`)
    expect(out!.code).toContain('Generated by parseman v')
    expect(out!.code).toContain('DO NOT EDIT')
  })

  it('is NOT stamped on a module where nothing lowered', () => {
    const out = run(`
import { rules } from 'parseman' with { type: 'macro' }
export const g = rules(externalFactory)
`)
    expect(out!.code).not.toContain('Generated by parseman v')
  })
})

// ---------------------------------------------------------------------------
// Transform options — each one has to reach the compiler, not just the signature
// ---------------------------------------------------------------------------
describe('transform options', () => {
  const SRC = `
import { many, parser, regex, rules, trivia } from 'parseman' with { type: 'macro' }
const ws = trivia(regex(/[ ]+/))
export const g = rules(gr => ({ Doc: parser({ trivia: ws }, many(gr.W)), W: regex(/x{2,5}/) }))
`.trim()

  it('warnUnloweredRegex names the regex that stayed on RegExp.exec', () => {
    const quiet = transformMacro(SRC, ID, new Set(['parseman']), false)!
    const loud = transformMacro(SRC, ID, new Set(['parseman']), true)!
    expect(quiet.warnings.filter(w => /did not lower/.test(w))).toEqual([])
    expect(loud.warnings.some(w => /did not lower/.test(w) && w.includes('/x{2,5}/'))).toBe(true)
    // The OPTION is a diagnostic only — the emitted parser is unchanged by it.
    expect(loud.code).toBe(quiet.code)
  })

  it('grammarCoverage emits the coverage table; the default does not', () => {
    const plain = transformMacro(SRC, ID, new Set(['parseman']), false, false, false)!
    const covered = transformMacro(SRC, ID, new Set(['parseman']), false, false, true)!
    expect(plain.code).not.toContain('_grammarCoverage')
    expect(covered.code).toContain('_grammarCoverage')
    expect(covered.warnings).toEqual([])
  })

  it('recovery changes the emitted parser rather than only the options record', () => {
    const plain = transformMacro(SRC, ID, new Set(['parseman']), false, false)!
    const recovering = transformMacro(SRC, ID, new Set(['parseman']), false, true)!
    expect(recovering.warnings).toEqual([])
    expect(recovering.code).not.toBe(plain.code)
  })
})

// ---------------------------------------------------------------------------
// Reading carried pieces back out of an imported artifact
// ---------------------------------------------------------------------------
describe('compose() over an imported COMPILED artifact', () => {
  const PIECES = `[{ ns: "_imported_", ir: "rules((g) => ({\\n  \\"Atom\\": literal(\\"x\\")\\n}))" }]`

  const consumer = (specifier: string) => `
import { compose, rules, sequence, literal } from 'parseman' with { type: 'macro' }
import { recognition } from '${specifier}'
export const p = compose([recognition, rules(g => ({ Doc: sequence(g.Atom, literal('!')) }))])
`

  const build = (artifact: string, specifier = './artifact.js') => inTempDir({
    'artifact.js': artifact,
    'consumer.ts': consumer(specifier),
  }, dir => {
    const f = path.join(dir, 'consumer.ts')
    return transformMacro(fs.readFileSync(f, 'utf8'), f, new Set(['parseman']))!
  })

  it('reads the pieces from the CURRENT defineProperty form and fuses them', () => {
    const out = build(`
export const recognition = Object.defineProperty({}, Symbol.for('parseman.composedPieces'), { value: ${PIECES}, enumerable: false })
`)
    expect(out.warnings).toEqual([])
    // The imported rule was fused into THIS module — not left as a runtime compose().
    expect(out.code).not.toMatch(/\bcompose\s*\(/)
    expect(out.code).toContain('_r_Atom')
  })

  it('also reads the transitional Object.assign form', () => {
    const out = build(`
export const recognition = Object.assign({}, { [Symbol.for('parseman.composedPieces')]: ${PIECES} })
`)
    expect(out.warnings).toEqual([])
    expect(out.code).toContain('_r_Atom')
  })

  it('leaves the runtime compose() in place when the import carries no pieces', () => {
    const out = build('export const recognition = {}')
    expect(out.warnings.some(w => w.includes("compose(): argument 0 isn't a build-resolvable grammar"))).toBe(true)
    expect(out.code).toMatch(/\bcompose\s*\(/)
    expect(out.code).not.toContain('_r_Atom')
  })

  it('ignores a defineProperty for a DIFFERENT symbol', () => {
    const out = build(`
export const recognition = Object.defineProperty({}, Symbol.for('parseman.grammarReflection'), { value: ${PIECES}, enumerable: false })
`)
    expect(out.code).not.toContain('_r_Atom')
  })
})

// ---------------------------------------------------------------------------
// Importing a private SOURCE grammar module (the pre-bundle spelling)
// ---------------------------------------------------------------------------
describe('compose() over an imported SOURCE grammar module', () => {
  const RECOGNITION = `
import { literal, rules } from 'parseman' with { type: 'macro' }
export const recognition = rules(g => ({ Atom: literal('x') }))
`
  const consumer = (specifier: string) => `
import { compose, rules, sequence, literal } from 'parseman' with { type: 'macro' }
import { recognition } from '${specifier}'
export const p = compose([recognition, rules(g => ({ Doc: sequence(g.Atom, literal('!')) }))])
`

  const build = (files: Record<string, string>, specifier: string) => inTempDir(
    { ...files, 'consumer.ts': consumer(specifier) },
    dir => {
      const f = path.join(dir, 'consumer.ts')
      return transformMacro(fs.readFileSync(f, 'utf8'), f, new Set(['parseman']))!
    },
  )

  it('resolves the `.js` specifier of a colocated `.ts` source', () => {
    const out = build({ 'recognition.ts': RECOGNITION }, './recognition.js')
    expect(out.warnings).toEqual([])
    expect(out.code).toContain('_r_Atom')
  })

  it('resolves an extension-less specifier', () => {
    const out = build({ 'recognition.ts': RECOGNITION }, './recognition')
    expect(out.code).toContain('_r_Atom')
  })

  it('resolves a DIRECTORY specifier through its index.ts', () => {
    const out = build({ 'shapes/index.ts': RECOGNITION }, './shapes')
    expect(out.code).toContain('_r_Atom')
  })

  it('declines when no source spelling exists', () => {
    const out = build({}, './recognition')
    expect(out.warnings.some(w => w.includes("compose(): argument 0 isn't a build-resolvable grammar"))).toBe(true)
    expect(out.code).not.toContain('_r_Atom')
  })
})
