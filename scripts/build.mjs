#!/usr/bin/env node
/**
 * Build script: esbuild for JS bundles, tsc --emitDeclarationOnly for .d.ts
 */
import { build } from 'esbuild'
import { execSync } from 'child_process'
import { chmodSync, readFileSync, rmSync } from 'fs'
import { builtinModules } from 'module'
import { dirname, relative, resolve, sep } from 'path'

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

const entryPoints = [
  'src/index.ts',
  'src/run/index.ts',
  'src/plugin/index.ts',
  'src/spec/index.ts',
  'src/language-service/index.ts',
  'src/oracle/index.ts',
  'src/table/index.ts',
  'src/analysis/diagnostics.ts',
  'src/cli/index.ts',
]

const shared = {
  // `src/cli/index.ts` is the diagnostics bin and `src/analysis/diagnostics.ts` its
  // library twin. Both reach the COMPILER (the `--fix` loop recompiles to verify), and
  // both are deliberately their own entry points: nothing a library consumer imports may
  // pull the compiler in on their account. Keep them out of `src/index.ts`.
  bundle: true,
  external,
  sourcemap: true,
  // Every public entry point bundles much of the same module graph. Embedding that
  // graph in each source map duplicates the TypeScript sources eighteen times across
  // the ESM/CJS outputs. The package ships `src/` once instead, so debuggers can still
  // resolve the relative paths recorded by these external maps.
  sourcesContent: false,
  target: 'es2022',
}

const privateSources = [
  'src/analysis/duplication.ts',
  'src/compiler/token-alphabet.ts',
  'src/table/program.ts',
  'src/table/emit-assembly.ts',
  'src/table/assemble.ts',
  'src/table/encode.ts',
]
const privateModules = privateSources.map(source => ({ source: resolve(source), output: source.slice(4, -3) }))

/**
 * The compiler analyses, lexical planner and table compiler/runtime are reached by all five
 * compile-capable public entries. Bundling each entry independently copied the
 * same implementations into root/plugin/table/diagnostics/cli in both module
 * formats. Keep their synchronous APIs and singleton table caches shared while
 * making each module one static relative dependency of the public bundles.
 *
 * This is deliberately not a package export and not a dynamic import. The
 * generated bundles name files inside their own `dist/` tree, so Node ESM,
 * CommonJS, browsers/bundlers and CSP builds all execute the same implementation
 * without exposing another public API or adding a runtime loader branch.
 */
function externalPrivateModules(entry, format) {
  const extension = format === 'esm' ? '.js' : '.cjs'
  const entryOutput = `dist/${relative('src', entry).replace(/\.ts$/, extension)}`
  return {
    name: 'shared-private-modules',
    setup(ctx) {
      ctx.onResolve({ filter: /(?:duplication|token-alphabet|program|emit-assembly|assemble|encode)\.ts$/ }, args => {
        const source = resolve(args.resolveDir, args.path)
        if (source === resolve(entry)) return undefined
        const target = privateModules.find(module => module.source === source)
        if (target === undefined) return undefined
        const output = `dist/${target.output}${extension}`
        let ref = relative(dirname(entryOutput), output).split(sep).join('/')
        if (!ref.startsWith('.')) ref = `./${ref}`
        return { path: ref, external: true }
      })
    },
  }
}

async function buildPublicEntry(entry, format) {
  return build({
    ...shared,
    entryPoints: [entry],
    format,
    outdir: 'dist',
    outbase: 'src',
    outExtension: { '.js': format === 'esm' ? '.js' : '.cjs' },
    plugins: [externalPrivateModules(entry, format)],
  })
}

await Promise.all([
  ...[...entryPoints, ...privateSources].flatMap(entry => [
    buildPublicEntry(entry, 'esm'),
    buildPublicEntry(entry, 'cjs'),
  ]),
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
