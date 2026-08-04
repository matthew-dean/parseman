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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
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

const EXPORT: Record<Dialect, string> = {
  css: 'cssGrammar',
  less: 'lessGrammar',
  scss: 'scssGrammar',
  jess: 'jessGrammar',
}

/** The rule every dialect enters a whole stylesheet through. */
export const ENTRY = 'Stylesheet'

export type LoadedGrammar = {
  dialect: Dialect
  /** Every rule, forced through the lazy fuse so the map holds combinators. */
  rules: Record<string, Combinator<unknown>>
}

export async function loadGrammar(dialect: Dialect): Promise<LoadedGrammar> {
  const mod = await import(resolvePath(JESS_ROOT, MODULE[dialect])) as Record<string, unknown>
  const grammar = mod[EXPORT[dialect]] as Record<string, Combinator<unknown>> | undefined
  if (grammar === undefined) throw new Error(`${dialect}: no export ${EXPORT[dialect]}`)
  // Realise the lazy getters. Reading ONE fuses all of them, but reading all of
  // them is what turns the map into a plain own-property record.
  const rules: Record<string, Combinator<unknown>> = {}
  for (const name of Object.keys(grammar)) rules[name] = grammar[name]!
  return { dialect, rules }
}

/* ── Corpora ─────────────────────────────────────────────────────────────── */

const CORPUS: Record<Dialect, { roots: string[]; ext: string }> = {
  css: { roots: ['packages/syntax/css/css-parser/test/css'], ext: '.css' },
  less: { roots: ['node_modules/@less/test-data/tests-unit'], ext: '.less' },
  scss: { roots: ['packages/syntax/scss/scss-parser/.cache/sass-spec/inputs'], ext: '.scss' },
  jess: { roots: ['packages/syntax/jess/jess-parser/test/data'], ext: '.jess' },
}

/** How many scss inputs to take. The sass-spec cache holds thousands; the
 * measured table is over the first 400 in sorted order, so it is reproducible. */
const SCSS_LIMIT = 400

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
  const picked = dialect === 'scss' ? files.slice(0, SCSS_LIMIT) : files
  return picked.map(p => ({ name: p.slice(JESS_ROOT.length + 1), input: readFileSync(p, 'utf8') }))
}
