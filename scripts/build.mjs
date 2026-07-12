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

// Generate declarations via tsc
execSync('node_modules/.bin/tsc -p tsconfig.build.json --emitDeclarationOnly --declaration --declarationMap --outDir dist', { stdio: 'inherit' })
console.log('Declarations built.')
