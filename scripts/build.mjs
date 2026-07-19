#!/usr/bin/env node
/**
 * Build script: esbuild for JS bundles, tsc --emitDeclarationOnly for .d.ts
 */
import { build } from 'esbuild'
import { execSync } from 'child_process'
import { readFileSync, rmSync } from 'fs'
import { builtinModules } from 'module'

rmSync('dist', { recursive: true, force: true })

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  // Node built-ins used by the plugin (fs/path) — keep external so esbuild
  // doesn't try to bundle them into the browser-agnostic library entry.
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
]

const shared = {
  entryPoints: ['src/index.ts', 'src/plugin/index.ts', 'src/spec/index.ts', 'src/language-service/index.ts'],
  bundle: true,
  external,
  sourcemap: true,
  target: 'es2022',
}

await Promise.all([
  build({ ...shared, format: 'esm', outdir: 'dist', outExtension: { '.js': '.js' } }),
  build({ ...shared, format: 'cjs', outdir: 'dist', outExtension: { '.js': '.cjs' } }),
])

console.log('JS bundles built.')

// The public runtime (including language-service) is browser-capable. Oxc is a
// macro/plugin implementation detail with native platform bindings; keep it out
// of these bundles even when runtime composition re-lowers artifact IR.
for (const file of ['dist/index.js', 'dist/index.cjs', 'dist/language-service/index.js', 'dist/language-service/index.cjs']) {
  if (readFileSync(file, 'utf8').includes('oxc-parser')) {
    throw new Error(`runtime bundle unexpectedly imports oxc-parser: ${file}`)
  }
}
console.log('Runtime bundles exclude oxc-parser.')

// Generate declarations via tsc
execSync('node_modules/.bin/tsc -p tsconfig.build.json --emitDeclarationOnly --declaration --declarationMap --outDir dist', { stdio: 'inherit' })
console.log('Declarations built.')
