/** Build first: these teeth exercise the package exactly through its export map. */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PUBLIC_SPECIFIERS = [
  'parseman',
  'parseman/diagnostics',
  'parseman/plugin',
  'parseman/run',
  'parseman/table',
  'parseman/spec',
  'parseman/language-service',
  'parseman/oracle',
] as const

function filesBelow(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) files.push(...filesBelow(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

describe('published module format', () => {
  it('ships one ESM implementation without duplicate CommonJS artifacts', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      main: string
      engines: { node: string }
      exports: Record<string, { import: string; require: string }>
    }
    expect(pkg.main).toBe('./dist/index.js')
    expect(pkg.engines.node).toBe('^20.19.0 || >=22.13.0')
    for (const entry of Object.values(pkg.exports)) {
      expect(entry.require).toBe(entry.import)
      expect(extname(entry.import)).toBe('.js')
    }
    expect(filesBelow(resolve(ROOT, 'dist')).filter(path => path.endsWith('.cjs'))).toEqual([])
  })

  it('loads every public subpath through both import and synchronous require', () => {
    const probe = `
      import { createRequire } from 'node:module'
      const require = createRequire(import.meta.url)
      const specifiers = ${JSON.stringify(PUBLIC_SPECIFIERS)}
      for (const specifier of specifiers) {
        const imported = await import(specifier)
        const required = require(specifier)
        if (!imported || !required || typeof imported !== 'object' || typeof required !== 'object') {
          throw new Error('invalid namespace for ' + specifier)
        }
        if (specifier === 'parseman/plugin' && typeof required.default?.webpack !== 'function') {
          throw new Error('CommonJS plugin usage lost its default export')
        }
      }
      process.stdout.write(JSON.stringify({ loaded: specifiers }))
    `
    const loaded = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', probe], {
      cwd: ROOT,
      encoding: 'utf8',
    })) as { loaded: string[] }
    expect(loaded.loaded).toEqual(PUBLIC_SPECIFIERS)
  })
})
