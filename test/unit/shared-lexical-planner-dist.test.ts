/**
 * The lexical identity planner is shared by the BUILT compile-capable entries.
 * Source imports deliberately stay ordinary relative imports so source tests and
 * editors do not depend on a generated `dist/` file; scripts/build.mjs is the
 * boundary that externalizes the module into one static ESM/CJS implementation.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const esmPlanner = resolve(ROOT, 'dist/compiler/token-alphabet.js')
const cjsPlanner = resolve(ROOT, 'dist/compiler/token-alphabet.cjs')
const esmTokenWire = resolve(ROOT, 'dist/table/token-outcome.js')
const cjsTokenWire = resolve(ROOT, 'dist/table/token-outcome.cjs')
const implementationMarker = 'recursive token body'
const tokenWireMarker = 'function runtimeRangeOutcomeKind'
const tableChoiceMarker = 'function runtimeChoiceAnchorsSite'

const compileEntries = [
  'dist/index',
  'dist/plugin/index',
  'dist/table/index',
  'dist/analysis/diagnostics',
  'dist/cli/index',
] as const

const treeShakenEntries = [
  'dist/spec/index',
  'dist/language-service/index',
] as const

function staticDependencies(path: string): string[] {
  const source = readFileSync(path, 'utf8')
  const refs = new Set<string>()
  const pattern = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\()\s*["'](\.[^"']+)["']/g
  for (const match of source.matchAll(pattern)) {
    const ref = match[1]!
    refs.add(resolve(dirname(path), ref))
  }
  return [...refs]
}

function staticLoadGraph(entry: string): Set<string> {
  const seen = new Set<string>()
  const visit = (path: string): void => {
    if (seen.has(path)) return
    seen.add(path)
    for (const dependency of staticDependencies(path)) visit(dependency)
  }
  visit(entry)
  return seen
}

describe('built lexical planner topology', () => {
  beforeAll(() => {
    for (const path of [esmPlanner, cjsPlanner, esmTokenWire, cjsTokenWire]) {
      if (!existsSync(path)) throw new Error(`${path} is missing — run \`pnpm build\``)
    }
  })

  it('shares only the dependency-light token wire proof and preserves entry tree-shaking', () => {
    for (const path of [esmTokenWire, cjsTokenWire]) {
      const source = readFileSync(path, 'utf8')
      expect(source).toContain(tokenWireMarker)
      expect(source).not.toContain(tableChoiceMarker)
      expect(source).not.toMatch(/\b(?:import|require)\s*(?:\(|["'{*])/)
      expect(source).not.toMatch(/\b(?:eval|Function)\s*\(/)
    }

    for (const entry of compileEntries) {
      for (const extension of ['.js', '.cjs']) {
        const path = resolve(ROOT, `${entry}${extension}`)
        const source = readFileSync(path, 'utf8')
        expect(source, `${entry}${extension} imports the wire proof`).toMatch(/token-outcome\.(?:js|cjs)/)
        expect(source, `${entry}${extension} does not embed the wire proof`).not.toContain(tokenWireMarker)
        // Choice validation and the closure/emitted consumers stay entry-local;
        // extracting them would widen hot function/module boundaries.
        expect(source, `${entry}${extension} keeps table choice linking local`).toContain(tableChoiceMarker)
      }
    }

    for (const entry of treeShakenEntries) {
      for (const extension of ['.js', '.cjs']) {
        const source = readFileSync(resolve(ROOT, `${entry}${extension}`), 'utf8')
        expect(source).not.toMatch(/token-(?:alphabet|outcome)\.(?:js|cjs)/)
        expect(source).not.toContain(tokenWireMarker)
        expect(source).not.toContain(tableChoiceMarker)
      }
    }

    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }
    expect(Object.keys(pkg.exports)).not.toContain('./table/token-outcome')
    expect(Object.keys(pkg.exports)).not.toContain('./internal/token-outcome')
  })

  it('loads the same narrow private graph through every ESM and CommonJS entry', () => {
    for (const extension of ['.js', '.cjs']) {
      const planner = extension === '.js' ? esmPlanner : cjsPlanner
      const tokenWire = extension === '.js' ? esmTokenWire : cjsTokenWire
      for (const entry of compileEntries) {
        const graph = staticLoadGraph(resolve(ROOT, `${entry}${extension}`))
        expect(graph.has(planner), `${entry}${extension} planner`).toBe(true)
        expect(graph.has(tokenWire), `${entry}${extension} token wire`).toBe(true)
        expect([...graph].filter(path => extname(path) === extension)).toHaveLength(3)
      }
      for (const entry of treeShakenEntries) {
        const graph = staticLoadGraph(resolve(ROOT, `${entry}${extension}`))
        expect(graph).toEqual(new Set([resolve(ROOT, `${entry}${extension}`)]))
      }
    }
  })

  it('ships one private static planner per module format instead of five copies', () => {
    expect(readFileSync(esmPlanner, 'utf8')).toContain(implementationMarker)
    expect(readFileSync(cjsPlanner, 'utf8')).toContain(implementationMarker)

    for (const entry of compileEntries) {
      for (const extension of ['.js', '.cjs']) {
        const source = readFileSync(resolve(ROOT, `${entry}${extension}`), 'utf8')
        expect(source, `${entry}${extension} imports the planner`).toMatch(/compiler\/token-alphabet\.(?:js|cjs)/)
        expect(source, `${entry}${extension} does not embed the planner`).not.toContain(implementationMarker)
      }
    }

    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }
    expect(Object.keys(pkg.exports)).not.toContain('./compiler/token-alphabet')
    expect(Object.keys(pkg.exports)).not.toContain('./internal/token-alphabet')
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
          import { literal } from './dist/index.js'
          import { encodeTable } from './dist/table/index.js'
          globalThis.__parsemanBrowserProbe = encodeTable({ Entry: literal('x') })
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
    expect(source.split(tokenWireMarker)).toHaveLength(2)
  })
})
