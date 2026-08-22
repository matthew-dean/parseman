/**
 * TWO-SIDED ESM hooks: the same jess grammar source, loaded twice, each copy
 * bound to a DIFFERENT parseman `src/`.
 *
 * `bench/jess/hooks.mjs` binds `parseman` to one worktree — this one. That is
 * everything `bench/jess/*` needed while every leg was built at HEAD, and it is
 * exactly what makes those harnesses unable to answer "versus the last release".
 *
 * The mechanism is URL tagging. A module imported through `pm-side:ref:<path>`
 * gets the URL `file://<path>?pm-side=ref`, and every specifier resolved FROM a
 * tagged parent inherits the tag — so `parseman` resolves into the reference
 * worktree's `src/`, `@jesscss/parser-shared` gets its own instance, and the
 * grammar module itself is a second module instance node keeps alongside the
 * untagged one. Two whole graphs, one process, no cross-talk.
 *
 * NOTHING IS SHARED between graphs except node builtins. That includes
 * `@jesscss/core/ast`, and sharing it was tried first, on the reasoning that the
 * AST builders are identical on both sides so one copy is fairer and cheaper.
 * MEASURED, that reasoning is wrong: with the builders shared, the reference
 * codegen leg read 5.34 ms on benchmark.css beside a TABLE head leg and 20.61 ms
 * — the same leg, the same code, the same fixture — beside a CODEGEN head leg.
 * Two parsers feeding one set of builder call sites make those sites
 * polymorphic, and how badly depends on what the NEIGHBOUR is. A leg whose time
 * depends on its opponent is not a measurement.
 *
 * So every graph gets its own everything, and the isolation is verified rather
 * than asserted: `ab.ts --self` must read flat, and the reference leg's absolute
 * milliseconds must not move when `--head-engine` changes.
 *
 * Sides:
 *   head       untagged — this worktree's `src/`, for anything not being timed
 *   h1, h2, …  this worktree's `src/`, one INDEPENDENT graph per number
 *   r1, r2, …  the reference `src/`, one INDEPENDENT graph per number
 *
 * Every timed leg takes its own numbered graph, on both sides. See `srcOf`.
 *
 * `:macro:` in the specifier adds `&pm-macro=1`, which runs that ONE module
 * through the SIDE'S OWN `transformMacro` — the reference side must be lowered
 * by the reference compiler, or the leg is HEAD's codegen wearing 0.46's name.
 *
 * Usage: `node --import ./bench/jess/ab-register.mjs bench/jess/ab.ts`
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { transformSync } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const HEAD_SRC = resolvePath(here, '../../src')
const JESS_ROOT = process.env.JESS_ROOT ?? '/Users/matthew/git/oss/jess'
const SHARED_SRC = resolvePath(JESS_ROOT, 'packages/parser-shared/src')

/**
 * Where the reference side's `src/` is, resolved LAZILY.
 *
 * Hooks run on their own thread and take a snapshot of `process.env` when
 * `register()` spawns them, so the harness cannot set this after the fact — and
 * it cannot set it BEFORE, because the path is `materialise()`'s return value and
 * `materialise` lives in a `.ts` module that only loads once these hooks exist.
 *
 * So the harness writes the path to a pointer file and the first TAGGED resolve
 * reads it. Nothing untagged touches this, which is why a head-only run needs no
 * reference worktree at all.
 */
const POINTER = resolvePath(here, '../../.cache/jess-ab-refsrc')

/**
 * A POINTER OLDER THAN THIS PROCESS IS THE PREVIOUS RUN'S, and reading it is how
 * this harness produced a published, wrong result.
 *
 * `load()` asks `refSrcPath()` for EVERY module, including the untagged ones —
 * `ab.ts` itself, `ab-harness.ts`, `grammars.ts`, `digest.ts`. Those load before
 * `main()` runs, and `main()` is what writes the pointer. So the value memoised
 * was the PREVIOUS invocation's reference, and the run then measured against it
 * while the protocol block printed the sha that had been asked for. Nothing
 * errored and nothing warned.
 *
 * Demonstrated, back to back, same command, same commit: `ab.ts less --self`
 * immediately after a `--ref=a5dc9bd` run read 2.199x / 3.426x with
 * `three-way agreement: *** NO ***` — it was measuring HEAD against 0.46 and
 * calling it a self-check — and the same command again, pointer now holding its
 * own sha, read 0.998x / 0.992x.
 *
 * The old guard anticipated the wrong failure: it special-cased EMPTY (never
 * cache an absent reference) and had nothing at all to say about STALE.
 */
const PROCESS_START_MS = Date.now()
let refSrc = ''

/**
 * The reference `src/`, or `''` when there is not a usable one YET.
 *
 * Never memoises a non-answer, and never returns a pointer written before this
 * process started. Returning `''` rather than throwing is deliberate: `load()`
 * calls this for head-side modules too, purely to classify a path, and a
 * head-only run legitimately has no reference at all. The loud failure belongs at
 * the TAGGED resolve, which is the only place a reference is actually required —
 * see `requireRefSrc`.
 */
function refSrcPath() {
  if (refSrc !== '') return refSrc
  const env = process.env.PM_REF_SRC
  if (env !== undefined && env !== '') { refSrc = env; return refSrc }
  if (!existsSync(POINTER)) return ''
  if (statSync(POINTER).mtimeMs < PROCESS_START_MS) return ''
  refSrc = readFileSync(POINTER, 'utf8').trim()
  return refSrc
}

/**
 * The reference `src/` for a leg that genuinely needs one — or a THROW naming
 * which of the two failure modes happened. A stale pointer must never be
 * substituted silently for the one that was requested.
 */
function requireRefSrc(side) {
  const s = refSrcPath()
  if (s !== '') return s
  const stale = process.env.PM_REF_SRC === undefined && existsSync(POINTER)
    && statSync(POINTER).mtimeMs < PROCESS_START_MS
  if (stale) {
    throw new Error(
      `side '${side}': the reference pointer ${POINTER} was written BEFORE this process started `
      + `(${new Date(statSync(POINTER).mtimeMs).toISOString()} < ${new Date(PROCESS_START_MS).toISOString()}), `
      + 'so it belongs to a PREVIOUS run and will not be used. Its content is a reference this run never '
      + 'asked for, and measuring against it while reporting the requested sha is exactly the defect this '
      + 'check exists to stop. Let the harness write the pointer for THIS run, or set PM_REF_SRC explicitly.',
    )
  }
  throw new Error(`side '${side}': no reference src — set PM_REF_SRC or write ${POINTER}`)
}

/**
 * Which `src/` a side's `parseman` specifier lands in.
 *
 * `h<n>` is HEAD, `r<n>` is the reference, and the NUMBER is an independent
 * graph. Every timed leg gets its own, and that is not tidiness — it is the
 * difference between this harness working and not.
 *
 * Measured: with the head legs sharing ONE graph, a HEAD-vs-HEAD self-check read
 * 3.70x. The cause is that `composeLeaf()`'s interpreted fuse MUTATES the shared
 * `@jesscss/parser-shared` recognition pieces in place (grammars.ts says so in
 * its header), so building an interpreter leg for the identity check silently
 * de-optimised the codegen leg sitting next to it in the same graph — while the
 * reference side, which had no interpreter leg, kept its pristine lowering. A
 * per-leg graph makes the two sides symmetric by construction, which is the only
 * thing that makes a self-check meaningful.
 */
const srcOf = (side) =>
  side === 'head' ? HEAD_SRC
    : /^h\d+$/.test(side) ? HEAD_SRC
      : /^r\d+$/.test(side) ? refSrcPath()
        : undefined

/** `import attributes` are erased, not honoured: a macro tag is a BUILD directive. */
const IMPORT_ATTRIBUTE = /\s+(?:with|assert)\s*\{\s*type\s*:\s*['"][a-z]+['"]\s*,?\s*\}/g

const PREFIX = 'pm-side:'
const MACRO_LOWERING_EXPORT = '__parsemanBenchMacroLowering'

/** The side and macro flag a URL carries, from its query alone. */
function tagOf(url) {
  if (typeof url !== 'string') return { side: 'head', macro: false }
  const q = url.indexOf('?')
  if (q < 0) return { side: 'head', macro: false }
  const p = new URLSearchParams(url.slice(q + 1))
  return { side: p.get('pm-side') ?? 'head', macro: p.get('pm-macro') === '1' }
}

/** A file URL carrying the tag, so the tag survives into transitive imports. */
function tagged(path, side, macro) {
  const base = pathToFileURL(path).href
  if (side === 'head' && !macro) return base
  const parts = []
  if (side !== 'head') parts.push(`pm-side=${side}`)
  if (macro) parts.push('pm-macro=1')
  return `${base}?${parts.join('&')}`
}

const ok = (url) => ({ url, format: 'module', shortCircuit: true })

export async function resolve(specifier, context, nextResolve) {
  // `pm-side:<side>[:macro]:<absolute path>` — the entry into a tagged graph.
  if (specifier.startsWith(PREFIX)) {
    let rest = specifier.slice(PREFIX.length)
    const colon = rest.indexOf(':')
    const side = rest.slice(0, colon)
    rest = rest.slice(colon + 1)
    const macro = rest.startsWith('macro:')
    if (macro) rest = rest.slice('macro:'.length)
    const s = srcOf(side)
    if (s === undefined) throw new Error(`unknown side '${side}' in ${specifier}`)
    // A reference leg REQUIRES a reference, and a stale pointer is not one.
    if (s === '') requireRefSrc(side)
    return ok(tagged(rest, side, macro))
  }
  // `pm-macro:<path>` — HEAD's per-module macro lowering, same contract as
  // `hooks.mjs` so a script can use either loader unchanged.
  if (specifier.startsWith('pm-macro:')) return ok(tagged(specifier.slice('pm-macro:'.length), 'head', true))

  const { side } = tagOf(context.parentURL)
  const src = srcOf(side)

  if (specifier === 'parseman') return ok(tagged(resolvePath(src, 'index.ts'), side, false))
  if (specifier.startsWith('parseman/')) {
    return ok(tagged(resolvePath(src, specifier.slice('parseman/'.length), 'index.ts'), side, false))
  }
  if (specifier.startsWith('@jesscss/parser-shared/')) {
    return ok(tagged(resolvePath(SHARED_SRC, `${specifier.slice('@jesscss/parser-shared/'.length)}.ts`), side, false))
  }
  // Relative specifiers inherit the tag. `.js` falls back to `.ts` where only the
  // TS source exists — parseman's own `src/` imports itself with `.js` endings.
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const parentDir = dirname(fileURLToPath(context.parentURL.split('?')[0]))
    const direct = resolvePath(parentDir, specifier)
    const asTs = specifier.endsWith('.js') ? `${direct.slice(0, -3)}.ts` : null
    const target = existsSync(direct) ? direct : asTs !== null && existsSync(asTs) ? asTs : null
    // A module inside a tagged graph must never resolve to an untagged URL: that
    // is a silent join of the two graphs, and it would be invisible in the output.
    if (target !== null) return ok(tagged(target, side, false))
    if (side !== 'head') throw new Error(`${specifier} from ${context.parentURL} does not exist — a tagged graph cannot fall through to the untagged resolver`)
  }
  // Everything else resolves normally — and is then PULLED INTO the tagged graph
  // if it landed on a real file. `@jesscss/core/ast` is the one that matters: see
  // the header for the 5.34 ms / 20.61 ms measurement that made sharing it
  // untenable. Node builtins resolve to `node:` URLs and are left alone, which is
  // the only sharing that remains.
  const r = await nextResolve(specifier, context)
  if (side !== 'head' && typeof r.url === 'string' && r.url.startsWith('file:') && !r.url.includes('?')) {
    return { ...r, url: `${r.url}?pm-side=${side}`, shortCircuit: true }
  }
  return r
}

/** `transformMacro`, per side, from that side's OWN plugin. Loaded lazily: it pulls in oxc. */
const macroOf = new Map()
async function transformMacroFor(side) {
  if (!macroOf.has(side)) {
    const url = tagged(resolvePath(srcOf(side), 'plugin/index.ts'), side, false)
    macroOf.set(side, (await import(url)).transformMacro)
  }
  return macroOf.get(side)
}

export async function load(url, context, nextLoad) {
  const { side, macro } = tagOf(url)
  const bare = url.split('?')[0]
  if (bare.startsWith('file:') && (bare.endsWith('.ts') || bare.endsWith('.mts'))) {
    const path = fileURLToPath(bare)
    const raw = readFileSync(path, 'utf8')
    const r = refSrcPath()
    const inParseman = path.startsWith(HEAD_SRC) || (r !== '' && path.startsWith(r))
    IMPORT_ATTRIBUTE.lastIndex = 0
    if (macro && IMPORT_ATTRIBUTE.test(raw) && !inParseman) {
      IMPORT_ATTRIBUTE.lastIndex = 0
      const transformMacro = await transformMacroFor(side)
      const lowered = transformMacro(raw, path, new Set(['parseman']))
      const code = typeof lowered === 'string' ? lowered : lowered?.code
      if (!code) throw new Error(`macro lowering produced nothing for ${path} (side ${side})`)
      // Classify the ARTIFACT THAT WILL RUN, not the compiler generation. A table
      // macro can carry either a static assembly factory (`a:[{...}]`) or the
      // compact closure inventory (`a:[]`), and a compiler-generation heuristic
      // cannot distinguish those two. Export the answer from this benchmark-only module
      // graph so `ab.ts` can print the exact leg without building another graph.
      const realized = /\ba:\s*\[\s*\{/.test(code)
        ? 'macro→static-table-assembly'
        : /\ba:\s*\[\s*\]/.test(code)
          ? 'macro→closure-table'
          : 'macro→source'
      const taggedCode = `${code}\nexport const ${MACRO_LOWERING_EXPORT}=${JSON.stringify(realized)}`
      const js = transformSync(taggedCode, { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: path })
      return { format: 'module', source: js.code, shortCircuit: true }
    }
    IMPORT_ATTRIBUTE.lastIndex = 0
    const out = transformSync(raw.replace(IMPORT_ATTRIBUTE, ''), { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: path })
    return { format: 'module', source: out.code, shortCircuit: true }
  }
  return nextLoad(url, context)
}
