/**
 * The lexical identity planner is shared by the BUILT compile-capable entries.
 * Source imports deliberately stay ordinary relative imports so source tests and
 * editors do not depend on a generated `dist/` file; scripts/build.mjs is the
 * boundary that externalizes the module into one static ESM/CJS implementation.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const esmPlanner = resolve(ROOT, 'dist/compiler/token-alphabet.js')
const cjsPlanner = resolve(ROOT, 'dist/compiler/token-alphabet.cjs')
const implementationMarker = 'recursive token body'
const sharedMarkers = [
  'removes a speculative arm:',
  'table char-class endpoint is outside Unicode',
  'a malformed token-plan recognizer',
  'table token recognizer offset does not span one TLV',
  'choice(autoNot: unmappable first set)',
] as const

const compileEntries = [
  'dist/index',
  'dist/plugin/index',
  'dist/table/index',
  'dist/analysis/diagnostics',
  'dist/cli/index',
] as const

describe('built lexical planner topology', () => {
  beforeAll(() => {
    for (const path of [esmPlanner, cjsPlanner]) {
      if (!existsSync(path)) throw new Error(`${path} is missing — run \`pnpm build\``)
    }
  })

  it('ships one private static planner per module format instead of five copies', () => {
    expect(readFileSync(esmPlanner, 'utf8')).toContain(implementationMarker)
    expect(readFileSync(cjsPlanner, 'utf8')).toContain(implementationMarker)

    for (const entry of compileEntries) {
      for (const extension of ['.js', '.cjs']) {
        const source = readFileSync(resolve(ROOT, `${entry}${extension}`), 'utf8')
        expect(source, `${entry}${extension} does not embed the planner`).not.toContain(implementationMarker)
      }
    }
    expect(readFileSync(resolve(ROOT, 'dist/table/encode.js'), 'utf8')).toContain('../compiler/token-alphabet.js')
    expect(readFileSync(resolve(ROOT, 'dist/table/encode.cjs'), 'utf8')).toContain('../compiler/token-alphabet.cjs')

    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }
    expect(Object.keys(pkg.exports)).not.toContain('./compiler/token-alphabet')
    expect(Object.keys(pkg.exports)).not.toContain('./internal/token-alphabet')
  })

  it('ships one private static table implementation per module format', () => {
    const modules = [
      ['program', 'table char-class endpoint is outside Unicode'],
      ['emit-assembly', 'a malformed token-plan recognizer'],
      ['assemble', 'table token recognizer offset does not span one TLV'],
      ['encode', 'choice(autoNot: unmappable first set)'],
    ] as const
    for (const [module, marker] of modules) {
      for (const extension of ['js', 'cjs']) {
        const source = readFileSync(resolve(ROOT, `dist/table/${module}.${extension}`), 'utf8')
        expect(source, `${module}.${extension} implementation`).toContain(marker)
        expect(source, `${module}.${extension} stays statically linked`).not.toMatch(/\bimport\s*\(/)
      }
      for (const entry of compileEntries) {
        for (const extension of ['js', 'cjs']) {
          const source = readFileSync(resolve(ROOT, `${entry}.${extension}`), 'utf8')
          expect(source, `${entry}.${extension} does not embed ${module}`).not.toContain(marker)
        }
      }
    }

    const esm = readFileSync(resolve(ROOT, 'dist/table/index.js'), 'utf8')
    const cjs = readFileSync(resolve(ROOT, 'dist/table/index.cjs'), 'utf8')
    for (const module of modules.map(([name]) => name)) {
      expect(esm).toContain(`./${module}.js`)
      expect(cjs).toContain(`./${module}.cjs`)
    }
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }
    for (const module of modules.map(([name]) => name)) {
      expect(Object.keys(pkg.exports)).not.toContain(`./table/${module}`)
      expect(Object.keys(pkg.exports)).not.toContain(`./internal/${module}`)
    }
  })

  it('shares the compiler duplication analysis without exporting its private path', () => {
    const marker = 'removes a speculative arm:'
    for (const extension of ['js', 'cjs']) {
      const implementation = readFileSync(resolve(ROOT, `dist/analysis/duplication.${extension}`), 'utf8')
      expect(implementation).toContain(marker)
      expect(implementation).not.toMatch(/\bimport\s*\(/)
      for (const entry of compileEntries) {
        const source = readFileSync(resolve(ROOT, `${entry}.${extension}`), 'utf8')
        expect(source, `${entry}.${extension} does not embed duplication analysis`).not.toContain(marker)
      }
    }
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }
    expect(Object.keys(pkg.exports)).not.toContain('./analysis/duplication')
    expect(Object.keys(pkg.exports)).not.toContain('./internal/duplication')
  })

  it('contains no dynamic-code or Node-only dependency in the shared planner', () => {
    for (const path of [esmPlanner, cjsPlanner]) {
      const source = readFileSync(path, 'utf8')
      expect(source).not.toMatch(/\b(?:eval|Function)\s*\(/)
      expect(source).not.toMatch(/(?:node:|require\(["'](?:fs|path|module|url)["']\))/)
    }
  })

  it('produces identical lexical tables through ESM and CommonJS entries', async () => {
    const esm = await import('parseman')
    const esmTable = await import('parseman/table')
    const require = createRequire(import.meta.url)
    const cjs = require(resolve(ROOT, 'dist/index.cjs')) as typeof esm
    const cjsTable = require(resolve(ROOT, 'dist/table/index.cjs')) as typeof esmTable

    const make = (lib: typeof esm) => {
      const selector = lib.token(lib.noTrivia(lib.sequence(
        lib.regex(/[A-Za-z]+/),
        lib.optional(lib.literal('(')),
      )))
      const classified = lib.dispatch(
        selector,
        lib.when(lib.endsWith('('), lib.literal(')')),
        lib.otherwise(lib.literal(':')),
      )
      return lib.choice(lib.transform(classified, value => value), selector)
    }
    const a = esmTable.encodeTable({ Entry: make(esm) })
    const b = cjsTable.encodeTable({ Entry: make(cjs) })
    expect(a.code).toEqual(b.code)
    expect(a.tokenPlan).toEqual(b.tokenPlan)
    expect(a.tokenPlan).toBeDefined()
  })

  it('bundles the public ESM entries for a browser with one planner implementation', async () => {
    const result = await build({
      stdin: {
        contents: `
          import { analyzeDuplication, literal } from './dist/index.js'
          import { encodeTable, emitTableModule, resolveTable, tableRules } from './dist/table/index.js'
          const program = encodeTable({ Entry: literal('x') })
          globalThis.__parsemanBrowserProbe = {
            analyzeDuplication, emitTableModule, resolveTable, tableRules, program,
          }
        `,
        resolveDir: ROOT,
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
    })
    const source = result.outputFiles[0]!.text
    expect(source).toContain('__parsemanBrowserProbe')
    expect(source.split(implementationMarker)).toHaveLength(2)
    for (const marker of sharedMarkers) expect(source.split(marker), marker).toHaveLength(2)
  })
})
