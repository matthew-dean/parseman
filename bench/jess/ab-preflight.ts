/**
 * Jess source/build skew check for `ab.ts`, deliberately run in a child process
 * so importing the source and built AST modules cannot contaminate timed graphs.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MODULE = {
  css: 'packages/syntax/css/css-parser/src/grammar.ts',
  less: 'packages/syntax/less/less-parser/src/grammar.ts',
  scss: 'packages/syntax/scss/scss-parser/src/grammar.ts',
  jess: 'packages/syntax/jess/jess-parser/src/grammar.ts',
} as const
type Dialect = keyof typeof MODULE

const rootArg = process.argv[2]
const dialectArg = process.argv[3]
if (rootArg === undefined || dialectArg === undefined) {
  throw new Error('usage: ab-preflight.ts <jess-root> <comma-separated dialects>')
}
const root = realpathSync(rootArg)
const dialects = dialectArg.split(',') as Dialect[]

const within = (file: string, parent: string): boolean => {
  const rel = path.relative(parent, file)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

const grammars = dialects.map(dialect => {
  const rel = MODULE[dialect]
  if (rel === undefined) throw new Error(`unknown dialect '${dialect}'`)
  const expected = path.join(root, rel)
  if (!existsSync(expected)) throw new Error(`${dialect} grammar is missing: ${expected}`)
  const real = realpathSync(expected)
  if (!within(real, root)) throw new Error(`${dialect} grammar escapes JESS_ROOT: ${real} (root ${root})`)
  return { dialect, real }
})
const parserShared = realpathSync(path.join(root, 'packages/parser-shared/src'))

// Resolve from the grammar, not from Parseman's node_modules. This is the same
// dependency search origin the grammar's `@jesscss/core/ast` import uses.
const requireFromGrammar = createRequire(grammars[0]!.real)
const packageJson = realpathSync(requireFromGrammar.resolve('@jesscss/core/package.json'))
const coreRoot = realpathSync(path.dirname(packageJson))
const expectedCoreRoot = realpathSync(path.join(root, 'packages/core'))
if (coreRoot !== expectedCoreRoot) {
  throw new Error(`@jesscss/core resolved outside this Jess checkout: ${coreRoot}; expected ${expectedCoreRoot}`)
}

const pkg = JSON.parse(readFileSync(packageJson, 'utf8')) as {
  exports?: { './ast'?: { source?: string; import?: string } }
}
const astExport = pkg.exports?.['./ast']
if (astExport?.source === undefined || astExport.import === undefined) {
  throw new Error(`${packageJson} must declare both exports['./ast'].source and .import`)
}
const requiredRealpath = (kind: string, file: string): string => {
  if (!existsSync(file)) {
    throw new Error(
      `@jesscss/core/ast ${kind} is missing: ${file}\n`
      + 'Build the checkout in dependency order: pnpm --filter @jesscss/awaitable-pipe build, then pnpm --filter @jesscss/core build.',
    )
  }
  return realpathSync(file)
}
const source = requiredRealpath('source', path.resolve(coreRoot, astExport.source))
const lib = requiredRealpath('lib', path.resolve(coreRoot, astExport.import))
const [sourceModule, libModule] = await Promise.all([
  import(`${pathToFileURL(source).href}?jess-ab-preflight=source`),
  import(`${pathToFileURL(lib).href}?jess-ab-preflight=lib`),
])
const sourceExports = Object.keys(sourceModule).sort()
const libExports = Object.keys(libModule).sort()
const sourceOnly = sourceExports.filter(k => !libExports.includes(k))
const libOnly = libExports.filter(k => !sourceExports.includes(k))
if (sourceOnly.length > 0 || libOnly.length > 0) {
  throw new Error(
    `@jesscss/core/ast source/lib export skew\n`
    + `  source ${source}\n  lib    ${lib}\n`
    + `  source-only: ${sourceOnly.join(', ') || '(none)'}\n`
    + `  lib-only: ${libOnly.join(', ') || '(none)'}\n`
    + 'Build the checkout in dependency order: pnpm --filter @jesscss/awaitable-pipe build, then pnpm --filter @jesscss/core build.',
  )
}

process.stdout.write(JSON.stringify({ root, grammars, parserShared, coreRoot, packageJson, source, lib, exports: sourceExports.length }))
