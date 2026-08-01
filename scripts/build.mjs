#!/usr/bin/env node
/**
 * Build script: esbuild for JS bundles, tsc --emitDeclarationOnly for .d.ts
 */
import { build } from 'esbuild'
import { execSync } from 'child_process'
import { chmodSync, readFileSync, rmSync } from 'fs'
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
  // The CLI resolves the TS loader at RUNTIME, from the user's project, and reports a
  // sentence when it is absent. Bundling it would both fail here (it is a devDependency)
  // and defeat the point — the loader has to be the consumer's.
  'tsx/esm/api',
]

const shared = {
  // `src/cli/index.ts` is the diagnostics bin and `src/analysis/diagnostics.ts` its
  // library twin. Both reach the COMPILER (the `--fix` loop recompiles to verify), and
  // both are deliberately their own entry points: nothing a library consumer imports may
  // pull the compiler in on their account. Keep them out of `src/index.ts`.
  entryPoints: ['src/index.ts', 'src/run/index.ts', 'src/plugin/index.ts', 'src/spec/index.ts', 'src/language-service/index.ts', 'src/oracle/index.ts', 'src/table/index.ts', 'src/analysis/diagnostics.ts', 'src/cli/index.ts'],
  bundle: true,
  external,
  sourcemap: true,
  target: 'es2022',
}

await Promise.all([
  build({ ...shared, format: 'esm', outdir: 'dist', outExtension: { '.js': '.js' }, banner: { js: '' } }),
  build({ ...shared, format: 'cjs', outdir: 'dist', outExtension: { '.js': '.cjs' } }),
])

// `src/cli/index.ts` carries the shebang and esbuild PRESERVES it through the bundle, so
// the line is part of the build and the source map already accounts for it. Assert that
// rather than prepending it here: a post-build prepend would push every mapping one line
// out, and the guarded version of it that used to live here was a silent no-op — a check
// that never ran, which is the same as no check.
{
  const binPath = 'dist/cli/index.js'
  if (!readFileSync(binPath, 'utf8').startsWith('#!/usr/bin/env node\n')) {
    throw new Error(`${binPath} lost its shebang — esbuild no longer preserves the entry point's`)
  }
  chmodSync(binPath, 0o755)
}

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
