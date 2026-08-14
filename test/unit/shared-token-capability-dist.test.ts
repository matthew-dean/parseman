/** Build first: these teeth inspect the shipped static module graph. */
import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const esmLeaf = resolve(ROOT, 'dist/compiler/token-capability.js')
const marker = 'lexical capability census is incomplete'
const compileEntries = [
  'dist/index', 'dist/plugin/index', 'dist/table/index',
  'dist/analysis/diagnostics', 'dist/cli/index',
] as const
const noncompileEntries = [
  'dist/run/index', 'dist/spec/index', 'dist/language-service/index', 'dist/oracle/index',
] as const

function staticDependencies(path: string): string[] {
  const source = readFileSync(path, 'utf8')
  const refs = new Set<string>()
  const pattern = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\()\s*["'](\.[^"']+)["']/g
  for (const match of source.matchAll(pattern)) refs.add(resolve(dirname(path), match[1]!))
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

describe('built token-capability topology', () => {
  beforeAll(() => {
    if (!existsSync(esmLeaf)) throw new Error(`${esmLeaf} is missing — run pnpm build`)
  })

  it('loads one private static leaf only from compile-capable entries', () => {
    expect(readFileSync(esmLeaf, 'utf8')).toContain(marker)
    for (const entry of compileEntries) {
      const path = resolve(ROOT, `${entry}.js`)
      expect(staticLoadGraph(path), `${entry}.js`).toEqual(new Set([path, esmLeaf]))
      expect(readFileSync(path, 'utf8')).not.toContain(marker)
    }
    for (const entry of noncompileEntries) {
      const path = resolve(ROOT, `${entry}.js`)
      expect(staticLoadGraph(path), `${entry}.js`).toEqual(new Set([path]))
      expect(readFileSync(path, 'utf8')).not.toMatch(/compiler\/token-capability\.(?:js|cjs)/)
    }
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }
    expect(Object.keys(pkg.exports)).not.toContain('./compiler/token-capability')
  })

  it('keeps the private leaf CSP-safe across import and require entry points', async () => {
    const source = readFileSync(esmLeaf, 'utf8')
    expect(source).not.toMatch(/\b(?:eval|Function)\s*\(/)
    expect(source).not.toMatch(/(?:node:|require\(["'](?:fs|path|module|url)["']\))/)
    const esm = await import('parseman')
    const esmTable = await import('parseman/table')
    const a = esmTable.encodeTable({ Entry: esm.token(esm.literal('x')) })
    expect('tokenPlan' in a).toBe(false)
  })

  it('bundles compile-capable ESM entries for browsers with one capability implementation', async () => {
    const result = await build({
      stdin: {
        contents: `
          import { literal } from './dist/index.js'
          import { encodeTable } from './dist/table/index.js'
          globalThis.__parsemanCapabilityProbe = encodeTable({ Entry: literal('x') })
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
    expect(source).toContain('__parsemanCapabilityProbe')
    expect(source.split(marker)).toHaveLength(2)
  })
})
