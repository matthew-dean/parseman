/**
 * The four SHIPPING jess grammars, loaded from source against this worktree.
 * Requires `bench/jess/register.mjs` (see its header for why).
 *
 * Each dialect exposes `<x>Grammar`, a `composeLeaf([...])` map. Run outside a
 * macro build that is the INTERPRETED fuse — a combinator map — which is
 * exactly what `encodeTable()` wants. The fuse is lazy and MUTATES the shared
 * recognition pieces in place, so only ONE variant of one dialect may be
 * realised per process; `loadGrammar` takes the dialect and nothing else.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Combinator } from '../../src/types.ts'

export const JESS_ROOT = process.env.JESS_ROOT ?? '/Users/matthew/git/oss/jess'

export type Dialect = 'css' | 'less' | 'scss' | 'jess'
export const DIALECTS: readonly Dialect[] = ['css', 'less', 'scss', 'jess']

const MODULE: Record<Dialect, string> = {
  css: 'packages/syntax/css/css-parser/src/grammar.ts',
  less: 'packages/syntax/less/less-parser/src/grammar.ts',
  scss: 'packages/syntax/scss/scss-parser/src/grammar.ts',
  jess: 'packages/syntax/jess/jess-parser/src/grammar.ts',
}

/**
 * The `trackLines` × `hostMode` axis, as each dialect actually instantiates it.
 *
 * Both halves must move together. The grammar EXPORT carries the options the
 * `rules()` factory was given, and `encodeTable`'s `TableSettings` is a separate
 * argument (`src/table/encode.ts:697`) — pairing them wrongly is not a smaller
 * table, it is `encode.ts:589` throwing, because a `parser(trackLines: true)`
 * inside a table built without it is a scope switch the encoder refuses.
 *
 * AST is the canonical path by owner ruling; CST is here so the fold can be
 * measured rather than assumed.
 */
export const VARIANTS = ['ast', 'ast-lines', 'cst', 'cst-lines'] as const
export type Variant = (typeof VARIANTS)[number]

/** The `TableSettings` each variant is encoded with. */
export const VARIANT_SETTINGS: Record<Variant, { hostMode?: 'ast' | 'cst'; trackLines?: boolean }> = {
  'ast': {},
  'ast-lines': { trackLines: true },
  'cst': { hostMode: 'cst' },
  'cst-lines': { hostMode: 'cst', trackLines: true },
}

/** Export-name suffix per variant; the prefix is the dialect. */
const SUFFIX: Record<Variant, string> = {
  'ast': 'Grammar',
  'ast-lines': 'PositionsGrammar',
  'cst': 'CstGrammar',
  'cst-lines': 'CstPositionsGrammar',
}

export function exportName(dialect: Dialect, variant: Variant): string {
  return dialect + SUFFIX[variant]
}

/** The rule every dialect enters a whole stylesheet through. */
export const ENTRY = 'Stylesheet'

export type LoadedGrammar = {
  dialect: Dialect
  variant: Variant
  /** Every rule, forced through the lazy fuse so the map holds combinators. */
  rules: Record<string, Combinator<unknown>>
}

export async function loadGrammar(dialect: Dialect, variant: Variant = 'ast'): Promise<LoadedGrammar> {
  const mod = await import(resolvePath(JESS_ROOT, MODULE[dialect])) as Record<string, unknown>
  const name = exportName(dialect, variant)
  const grammar = mod[name] as Record<string, Combinator<unknown>> | undefined
  if (grammar === undefined) throw new Error(`${dialect}: no export ${name}`)
  // Realise the lazy getters. Reading ONE fuses all of them, but reading all of
  // them is what turns the map into a plain own-property record.
  const rules: Record<string, Combinator<unknown>> = {}
  for (const k of Object.keys(grammar)) rules[k] = grammar[k]!
  return { dialect, variant, rules }
}

/* ── Provenance ──────────────────────────────────────────────────────────── */

/**
 * PROVE which parseman is being measured, before any number is printed.
 *
 * jess's own install resolves `parseman` to a PUBLISHED copy in its pnpm store
 * (0.45.0 at the time of writing), not to this worktree. `hooks.mjs` short-
 * circuits the specifier into `../../src`, so a run through `register.mjs`
 * measures the worktree — but that is an assertion about a file, and a `link:`
 * mis-resolving upward into a sibling checkout has already produced one bogus
 * measurement here. So this reads the module that was ACTUALLY loaded and
 * refuses to continue if it is not the one under this worktree.
 */
export async function assertParseman(): Promise<{ root: string; version: string; installed: string }> {
  const here = realpathSync(resolvePath(dirname(fileURLToPath(import.meta.url)), '../..'))
  // Resolve the BARE specifier, through the same hooks a grammar module goes
  // through. Comparing two paths both derived from `import.meta.url` would prove
  // nothing; this asks the loader where `parseman` actually is.
  const resolved = fileURLToPath(import.meta.resolve('parseman'))
  const root = realpathSync(resolvePath(dirname(resolved), '..'))
  if (root !== here) {
    throw new Error(
      `'parseman' resolved to ${resolved} (root ${root}), not this worktree ${here}. `
      + 'Run through `--import ./bench/jess/register.mjs`; without it the specifier '
      + "finds jess's INSTALLED parseman and the measurement is of a different package.",
    )
  }
  const mod = await import('../../src/version.ts')
  // The discriminator, printed so a reader can see the two are not the same
  // package: jess's own install is a PUBLISHED parseman in its pnpm store.
  let installed = 'none'
  try {
    const p = resolvePath(JESS_ROOT, 'node_modules/parseman/package.json')
    installed = (JSON.parse(readFileSync(p, 'utf8')) as { version: string }).version
  } catch { /* not installed; the assertion above is the one that matters */ }
  return { root, version: mod.PARSEMAN_VERSION, installed }
}

/* ── Corpora ─────────────────────────────────────────────────────────────── */

const CORPUS: Record<Dialect, { roots: string[]; ext: string }> = {
  css: { roots: ['packages/syntax/css/css-parser/test/css'], ext: '.css' },
  less: { roots: ['node_modules/@less/test-data/tests-unit'], ext: '.less' },
  scss: { roots: ['packages/syntax/scss/scss-parser/.cache/sass-spec/inputs'], ext: '.scss' },
  // Three files is not a denominator. Every `.jess` the repo actually holds is
  // 24 across eight directories; these seven roots are all of them except
  // `jess-parser/test/errors`, which exists to FAIL to parse and so measures
  // error recovery rather than parsing. 22 files — still small, and said so.
  jess: {
    roots: [
      'packages/syntax/jess/jess-parser/test/data',
      'packages/jess/test/files',
      'packages/jess/benchmark',
      'packages/fns/test/files',
      'packages/rollup-plugin-jess/test',
    ],
    ext: '.jess',
  },
}

/**
 * NO CAP. `0` means every scss input the sass-spec cache holds.
 *
 * This was `400`, hardcoded, with the justification "the measured table is over
 * the first 400 in sorted order, so it is reproducible". That is not a reason:
 * all 2408 in sorted order is equally reproducible, and the cap silently dropped
 * 83% of the corpus while the output read as a corpus result. A defect hiding in
 * the 2008 unmeasured files is precisely what this exercise exists to find.
 *
 * `PM_SCSS_LIMIT=<n>` still takes the first n, for a quick loop. Whatever it is,
 * `corpus()`'s caller must print BOTH the taken count and `corpusTotal()` — a
 * workflow that bounds coverage has to log what it dropped, because a silent
 * truncation reads as "covered everything" when it did not.
 */
const SCSS_LIMIT = process.env.PM_SCSS_LIMIT === undefined ? 0 : Number(process.env.PM_SCSS_LIMIT)

export type CorpusFile = { name: string; input: string }

function walk(dir: string, ext: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, ext, out)
    else if (p.endsWith(ext)) out.push(p)
  }
}

export function corpus(dialect: Dialect): CorpusFile[] {
  const { roots, ext } = CORPUS[dialect]
  const files: string[] = []
  for (const r of roots) walk(resolvePath(JESS_ROOT, r), ext, files)
  const picked = dialect === 'scss' && SCSS_LIMIT > 0 ? files.slice(0, SCSS_LIMIT) : files
  return picked.map(p => ({ name: p.slice(JESS_ROOT.length + 1), input: readFileSync(p, 'utf8') }))
}

/** Files found before any cap, so a report can state the denominator honestly. */
export function corpusTotal(dialect: Dialect): number {
  const { roots, ext } = CORPUS[dialect]
  const files: string[] = []
  for (const r of roots) walk(resolvePath(JESS_ROOT, r), ext, files)
  return files.length
}
