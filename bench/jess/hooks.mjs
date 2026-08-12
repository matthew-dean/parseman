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
 * With `PM_MACRO=1` the macro-tagged modules are instead run through
 * `transformMacro` — the SAME lowering a build splices — so the module exports
 * the CODEGEN artifact rather than a combinator graph. That is the honest "old
 * compiled" leg. It is a whole-process mode because the macro replaces the
 * module: one process cannot hold both the combinator graph and its lowering.
 * Do NOT substitute `compose([ruleMap])` for it — `composeLeaf()` documents that
 * a leaf grammar never falls back to runtime codegen composition, so that path
 * builds a DIFFERENT parser and was observed to disagree with both other engines
 * on trees, spans and reducer throws.
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

/**
 * `pm-macro:<absolute path>` — the macro lowering of ONE module, as its own
 * module instance, WITHOUT putting the whole process into macro mode.
 *
 * `PM_MACRO=1` is a process-wide switch, so a timing run could hold the compiled
 * engine or the interpreted and table engines, never all three — and an A/B
 * across processes is not an A/B. This gives the lowered grammar a distinct URL
 * (the same file plus `?pm-macro=1`), so node keeps it as a SEPARATE module
 * instance alongside the plain one.
 *
 * Its relative imports resolve against the path, not the query, so the two
 * instances share `@jesscss/parser-shared` and `parseman` — which is what makes
 * the comparison fair (one runtime, one set of recognition pieces) and also what
 * makes cross-contamination possible. `speed.ts` therefore proves all three
 * engines still produce identical parses before it times anything.
 */
const MACRO_QUERY = '?pm-macro=1'

/**
 * `pm-capture:<absolute path>` — the macro lowering, loaded exactly as
 * `pm-macro:` loads it, with ONE substitution: the emitted
 * `import { tableRules } from 'parseman/table'` is repointed at
 * `bench/jess/capture.ts`, which records the COMPACT PROGRAM the macro printed
 * and then hands the call straight to `assembledRules`.
 *
 * This is how the emitted PROGRAM is obtained without `eval`. The literal the
 * macro prints references the grammar module's own imports (the author's
 * reducers close over `@jesscss/core/ast` builders), so it cannot be evaluated
 * outside that module — it has to be captured where it is evaluated. The
 * artifact is otherwise byte-identical to the `pm-macro:` one, and the module
 * still works, so a capture run can also be identity-checked.
 */
const CAPTURE_QUERY = '?pm-capture=1'
const CAPTURE_MODULE = resolvePath(here, 'capture.ts')

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('pm-macro:')) {
    const p = specifier.slice('pm-macro:'.length)
    return { url: pathToFileURL(p).href + MACRO_QUERY, format: 'module', shortCircuit: true }
  }
  if (specifier.startsWith('pm-capture:')) {
    const p = specifier.slice('pm-capture:'.length)
    return { url: pathToFileURL(p).href + CAPTURE_QUERY, format: 'module', shortCircuit: true }
  }
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
  // Detached authoritative Jess worktrees can be newer than their ignored
  // lib/ output. The census is over source, so bind the reducers' AST import to
  // that same worktree instead of mixing grammar source with a stale build.
  if (specifier === '@jesscss/core/ast') {
    return { url: pathToFileURL(resolvePath(JESS_ROOT, 'packages/core/src/ast.ts')).href, format: 'module', shortCircuit: true }
  }
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const asTs = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier.slice(0, -3) + '.ts')
    if (existsSync(asTs)) return { url: pathToFileURL(asTs).href, format: 'module', shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

const MACRO_MODE = process.env.PM_MACRO === '1'
/** Loaded lazily: importing the plugin pulls in oxc, which the default mode
 * never needs, and it must come through THESE hooks to see the worktree `src/`. */
let transformMacro

export async function load(url, context, nextLoad) {
  const perModuleCapture = url.endsWith(CAPTURE_QUERY)
  const perModuleMacro = url.endsWith(MACRO_QUERY) || perModuleCapture
  const bare = perModuleMacro ? url.slice(0, url.lastIndexOf('?')) : url
  if (bare.startsWith('file:') && (bare.endsWith('.ts') || bare.endsWith('.mts'))) {
    const path = fileURLToPath(bare)
    const raw = readFileSync(path, 'utf8')
    // A macro module under PM_MACRO: lower it exactly as a build would. The
    // emitted module keeps every non-macro import, so `@jesscss/core/ast` and
    // the grammar's own `./parse-error.js` still resolve through the rules above.
    if ((MACRO_MODE || perModuleMacro) && IMPORT_ATTRIBUTE.test(raw) && !path.startsWith(PM_SRC)) {
      IMPORT_ATTRIBUTE.lastIndex = 0
      transformMacro ??= (await import(pathToFileURL(resolvePath(PM_SRC, 'plugin/index.ts')).href)).transformMacro
      const lowered = transformMacro(raw, path, new Set(['parseman']))
      let code = typeof lowered === 'string' ? lowered : lowered?.code
      if (!code) throw new Error(`macro lowering produced nothing for ${path}`)
      if (perModuleCapture) {
        const before = code
        code = code.replace(
          /import \{ tableRules \} from ["']parseman\/table["']/,
          `import { captureTableRules as tableRules } from ${JSON.stringify(CAPTURE_MODULE)}`,
        )
        if (code === before) throw new Error(`pm-capture: ${path} emitted no \`tableRules\` import to capture`)
      }
      const js = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: path })
      return { format: 'module', source: js.code, shortCircuit: true }
    }
    IMPORT_ATTRIBUTE.lastIndex = 0
    const out = transformSync(raw.replace(IMPORT_ATTRIBUTE, ''), { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: path })
    return { format: 'module', source: out.code, shortCircuit: true }
  }
  return nextLoad(url, context)
}
