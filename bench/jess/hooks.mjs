/**
 * ESM hooks that make jess's four SHIPPING grammars importable straight from
 * source, into THIS worktree's `src/`.
 *
 * Why this exists at all: the grammars are macro modules. They import parseman
 * with `with { type: 'macro' }`, which node refuses, and they are `.ts`. The
 * built `lib/` copies are compiled artifacts of an OLDER parseman and of an
 * older `@jesscss/parser-shared`, so loading those measures a grammar this
 * worktree never saw — less and scss do not even fuse against them
 * ("references missing rule"). Three previous lanes rebuilt this loader from
 * scratch after their worktree was deleted; it is committed so the fourth does
 * not have to.
 *
 * What it does, and nothing else:
 *   - `parseman` and `parseman/<sub>` resolve into this worktree's `src/`
 *   - `@jesscss/parser-shared/<x>` resolves to that package's `src/`, not `lib/`
 *   - a `./x.js` relative specifier falls back to `./x.ts` when only the TS exists
 *   - `.ts` sources are transpiled by esbuild with import ATTRIBUTES stripped
 *
 * `@jesscss/core/ast` is deliberately NOT redirected: the AST builders are a
 * plain runtime dependency of the reducers, `lib/` is current for them, and
 * building core from source here would drag in the whole package graph.
 *
 * Usage: `node --import ./bench/jess/register.mjs <script.ts>`
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { transformSync } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const PM_SRC = resolvePath(here, '../../src')
const JESS_ROOT = process.env.JESS_ROOT ?? '/Users/matthew/git/oss/jess'
const SHARED_SRC = resolvePath(JESS_ROOT, 'packages/parser-shared/src')

/** `import attributes` are erased, not honoured: a macro tag is a BUILD directive. */
const IMPORT_ATTRIBUTE = /\s+(?:with|assert)\s*\{\s*type\s*:\s*['"][a-z]+['"]\s*,?\s*\}/g

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'parseman') {
    return { url: pathToFileURL(resolvePath(PM_SRC, 'index.ts')).href, format: 'module', shortCircuit: true }
  }
  if (specifier.startsWith('parseman/')) {
    const sub = specifier.slice('parseman/'.length)
    return { url: pathToFileURL(resolvePath(PM_SRC, sub, 'index.ts')).href, format: 'module', shortCircuit: true }
  }
  if (specifier.startsWith('@jesscss/parser-shared/')) {
    const sub = specifier.slice('@jesscss/parser-shared/'.length)
    return { url: pathToFileURL(resolvePath(SHARED_SRC, `${sub}.ts`)).href, format: 'module', shortCircuit: true }
  }
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const asTs = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier.slice(0, -3) + '.ts')
    if (existsSync(asTs)) return { url: pathToFileURL(asTs).href, format: 'module', shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export function load(url, context, nextLoad) {
  if (url.startsWith('file:') && (url.endsWith('.ts') || url.endsWith('.mts'))) {
    const path = fileURLToPath(url)
    const src = readFileSync(path, 'utf8').replace(IMPORT_ATTRIBUTE, '')
    const out = transformSync(src, { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: path })
    return { format: 'module', source: out.code, shortCircuit: true }
  }
  return nextLoad(url, context)
}
