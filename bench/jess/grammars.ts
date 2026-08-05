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
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
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

/* ── The load gate ───────────────────────────────────────────────────────── */

/**
 * The one load ceiling every `bench/jess/` harness is judged against.
 *
 * It lived as a private `const` in `speed.ts` and NOWHERE ELSE, and that asymmetry
 * is the whole reason the same fixture has two remembered numbers. `speed.ts`
 * refused to run above it; `fixture.ts` — the harness that produces the ABSOLUTE
 * millisecond figures anyone quotes — printed the load average and measured
 * anyway. A lane whose box sat at loadavg 7.0 got a number, and that number went
 * into a report next to one taken at ~1, 27% apart, with nothing in either output
 * saying which was which.
 *
 * A ceiling that only guards the harness nobody quotes is not a ceiling. This is
 * shared, and it is the SAME number for every harness here, so two results
 * printing "loadavg gate: 6" are comparable by construction.
 *
 * `PM_FORCE=1` overrides. It exists for the case where a busy box is all there
 * is, and the output says FORCED on every line that follows so a forced number
 * can never be pasted as a quiet-box one.
 */
export const LOAD_CEILING = 6

/** 1/5/15-minute load averages, formatted. */
export const loads = (): string => os.loadavg().map(n => n.toFixed(2)).join(' ')

/**
 * Refuse to measure on a busy box. Returns whether the run was FORCED past the
 * ceiling, so the caller can carry that into every figure it prints.
 *
 * Exit code 2 — distinct from a failure — because "the box was busy" is not a
 * result and is not a defect either.
 */
export function assertQuiet(): { forced: boolean; startLoad: number } {
  const startLoad = os.loadavg()[0]!
  if (startLoad <= LOAD_CEILING) return { forced: false, startLoad }
  if (process.env.PM_FORCE === '1') {
    console.error(`\nFORCED: 1-minute load average is ${startLoad.toFixed(2)}, over the ${LOAD_CEILING} ceiling, and PM_FORCE=1.`)
    console.error('Every figure below is marked FORCED. Do not quote it as a canonical number.\n')
    return { forced: true, startLoad }
  }
  console.error(`\nDEFERRED: 1-minute load average is ${startLoad.toFixed(2)}, over the ${LOAD_CEILING} ceiling.`)
  console.error('Nothing measured on a box this busy is a result — this is the measured cause of the')
  console.error('27% spread between two lanes\' figures for the same fixture. Re-run when it settles,')
  console.error('or PM_FORCE=1 to take a number that prints FORCED and cannot be quoted as canonical.')
  process.exit(2)
}

/** The commit a figure was taken at — provenance a pasted number carries with it. */
export function headSha(): string {
  try {
    const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..')
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: root, encoding: 'utf8' }).trim() !== ''
    return dirty ? `${sha}+dirty(src)` : sha
  } catch { return 'unknown' }
}

/* ── Corpora ─────────────────────────────────────────────────────────────── */

const CORPUS: Record<Dialect, { roots: string[]; ext: string }> = {
  css: { roots: ['packages/syntax/css/css-parser/test/css'], ext: '.css' },
  // The WHOLE of `@less/test-data`, not just `tests-unit`. `tests-unit` is 136
  // of the 314 `.less` files there; the rest are under `tests-error`, `plugin`,
  // `data`, `tests-config` and `tests-warnings`. Those are error fixtures,
  // plugin harnesses and import targets rather than a curated parse corpus —
  // which is a reason they are less INTERESTING, not a reason to leave them
  // unmeasured. Every one of them is a parseable input, and a three-way identity
  // comparison is exactly as valid on a file all three engines reject.
  //
  // NOTE this root is an UNPINNED sibling checkout: `@less/test-data` is a
  // `link:` to a live `~/git/oss/less.js`, so the denominator can move on its
  // own. That is why it is printed rather than assumed.
  less: { roots: ['node_modules/@less/test-data'], ext: '.less' },
  scss: { roots: ['packages/syntax/scss/scss-parser/.cache/sass-spec/inputs'], ext: '.scss' },
  // Three files is not a denominator — it is an ABSENCE of coverage, and no
  // statement about the jess dialect can rest on it. These roots are every
  // `.jess` the repo holds: 24 files. Error fixtures are in, on the same
  // reasoning as less's `tests-error` and css's `test/css/errors` — a file all
  // three engines reject is exactly as good an identity test as one they accept.
  //
  // 24 is still far too few to conclude anything about jess. That is a fact
  // about the repo, not about this harness, and the printed denominator is
  // there so it cannot be mistaken for coverage.
  jess: {
    roots: [
      'packages/syntax/jess/jess-parser/test',
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
