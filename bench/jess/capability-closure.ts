/**
 * Independent final-grammar capability census.
 *
 * Run with:
 *   JESS_ROOT=/private/tmp/jess-parseman-origin-dev node --import ./bench/jess/register.mjs --import tsx bench/jess/capability-closure.ts
 *
 * This intentionally reads raw ParserDef fields and never imports the production
 * candidate/child walker. PM_CAPABILITY_ORACLE_PLANT=omit-post-compose must fail.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import type { Combinator, ParserDef } from '../../src/types.ts'
import { compose, literal, rules, sequence, token } from '../../src/index.ts'
import { composedCoverageRules } from '../../src/compiler/linker.ts'
import { collectLexicalAlphabet } from '../../src/compiler/token-alphabet.ts'
import { assertParseman, JESS_ROOT, loadGrammar } from './grammars.ts'

type Comb = Combinator<unknown>
type Atom = 'terminal' | 'token' | 'choice' | 'dispatch'
type Context = {
  trivia: Comb | undefined
  scanSkip: readonly Comb[]
  trackLines: boolean
  captureTrivia: boolean
  rootCapture: boolean
  dynamicState: boolean
}
type Row = {
  atom: Atom
  parser: Comb
  path: string
  outer: string
  recognition: string
  context: Context
}

const EXPECTED = {
  css: {
    total: 842,
    counts: { terminal: 645, token: 39, choice: 147, dispatch: 11 },
    contexts: 9,
    digest: '797eacdf3610fff1b9da3e0052a7ade72891bba21924a88639a334385d1ac8fe',
  },
  less: {
    total: 1687,
    counts: { terminal: 1178, token: 62, choice: 418, dispatch: 29 },
    contexts: 11,
    digest: '6d97393cf6316dd57eacf4710db88119243050bcac3c9338ba524eacbc4178e0',
  },
} as const

const isComb = (value: unknown): value is Comb =>
  value !== null && typeof value === 'object' && '_def' in value && 'parse' in value

function rawEdges(parser: Comb): Array<{ label: string; parser: Comb }> {
  const def = parser._def as unknown as Record<string, unknown>
  const out: Array<{ label: string; parser: Comb }> = []
  const read = (value: unknown, label: string, depth: number): void => {
    if (isComb(value)) { out.push({ label, parser: value }); return }
    if (depth >= 2 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) read(value[i], `${label}[${i}]`, depth + 1)
    } else {
      for (const key of Object.keys(value).sort()) {
        read((value as Record<string, unknown>)[key], `${label}.${key}`, depth + 1)
      }
    }
  }
  for (const key of Object.keys(def).filter(key => key !== 'tag').sort()) read(def[key], key, 0)
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

function wrapsReference(winner: Comb, reference: Comb): boolean {
  let current = winner
  const seen = new Set<Comb>()
  while (!seen.has(current)) {
    if (current === reference) return true
    seen.add(current)
    const def = current._def
    if (def.tag !== 'grammar' && def.tag !== 'trivia') return false
    current = def.parser
  }
  return false
}

function lazyWinner(parser: Comb, resolve: (name: string) => Comb | undefined): Comb | undefined {
  const def = parser._def
  if (def.tag !== 'lazy') return undefined
  const name = (parser as Comb & { _ruleName?: string })._ruleName
  if (name !== undefined) {
    const winner = resolve(name)
    if (winner !== undefined && !wrapsReference(winner, parser)) return winner
  }
  try { return def.thunk() } catch { return undefined }
}

function atomOf(def: ParserDef): Atom | undefined {
  if (def.tag === 'literal' || def.tag === 'keywords' || def.tag === 'regex') return 'terminal'
  if (def.tag === 'token' || def.tag === 'choice' || def.tag === 'dispatch') return def.tag
  return undefined
}

function census(
  roots: ReadonlyArray<readonly [string, Comb]>,
  resolve: (name: string) => Comb | undefined,
): { rows: Row[]; bindingEdges: number } {
  const ids = new Map<Comb, number>()
  const id = (parser: Comb): number => {
    const prior = ids.get(parser)
    if (prior !== undefined) return prior
    const next = ids.size
    ids.set(parser, next)
    return next
  }
  const contextKey = (ctx: Context): string => [
    `trivia=${ctx.trivia === undefined ? '-' : id(ctx.trivia)}`,
    `scan=${ctx.scanSkip.map(id).join(',') || '-'}`,
    `lines=${ctx.trackLines ? 1 : 0}`,
    `capture=${ctx.captureTrivia ? 1 : 0}`,
    `root=${ctx.rootCapture ? 'opaque' : '-'}`,
    `state=${ctx.dynamicState ? 1 : 0}`,
  ].join('|')
  const seen = new Set<string>()
  const rows = new Map<string, Row>()
  let bindingEdges = 0
  let plantedOmission = false
  const visit = (parser: Comb, context: Context, path: string): void => {
    const outer = contextKey(context)
    const state = `${id(parser)}\u0000${outer}`
    const atom = atomOf(parser._def)
    if (atom !== undefined) {
      const recognitionContext = atom === 'token'
        ? { ...context, trivia: undefined, captureTrivia: false }
        : context
      const key = `${id(parser)}\u0000${outer}`
      const prior = rows.get(key)
      if (prior === undefined) rows.set(key, {
        atom, parser, path, outer, recognition: contextKey(recognitionContext), context,
      })
      else if (path < prior.path) prior.path = path
      if (atom === 'token') return
    }
    if (seen.has(state)) return
    seen.add(state)
    const def = parser._def
    let childContext = context
    if (def.tag === 'grammar') childContext = {
      ...context,
      trivia: def.clearTrivia ? undefined : (def.triviaParser ?? context.trivia),
      trackLines: context.trackLines || def.trackLines,
      captureTrivia: context.captureTrivia || def.captureTrivia === true,
      rootCapture: context.rootCapture || def.rootCapture === 'opaque',
    }
    if (def.tag === 'withCtx') childContext = { ...context, dynamicState: true }
    const omitThisWinner = def.tag === 'lazy'
      && process.env.PM_CAPABILITY_ORACLE_PLANT === 'omit-post-compose'
      && !plantedOmission
    if (omitThisWinner) plantedOmission = true
    const edges = def.tag === 'lazy'
      ? (omitThisWinner ? [] : [
          { label: `winner:${(parser as Comb & { _ruleName?: string })._ruleName ?? '?'}`, parser: lazyWinner(parser, resolve) },
        ].filter((edge): edge is { label: string; parser: Comb } => edge.parser !== undefined))
      : rawEdges(parser)
    for (const edge of edges) {
      bindingEdges++
      visit(edge.parser, childContext, `${path}/${edge.label}`)
    }
  }
  for (const [name, root] of [...roots].sort((a, b) => a[0].localeCompare(b[0]))) visit(root, {
    trivia: root._meta.grammarTrivia,
    scanSkip: root._meta.grammarScanSkip ?? [],
    trackLines: root._meta.grammarTrackLines === true,
    captureTrivia: false,
    rootCapture: false,
    dynamicState: false,
  }, `rule:${name}`)
  return {
    rows: [...rows.values()].sort((a, b) =>
      a.path.localeCompare(b.path) || a.recognition.localeCompare(b.recognition) || a.atom.localeCompare(b.atom)),
    bindingEdges,
  }
}

function counts(rows: readonly Row[]): Record<Atom, number> {
  const out = { terminal: 0, token: 0, choice: 0, dispatch: 0 }
  for (const row of rows) out[row.atom]++
  return out
}

function proveFinalWinner(): void {
  const base = rules((g: Record<string, Comb>) => ({
    Entry: sequence(g.Word!, literal('!')),
    Word: token(literal('a')),
  })) as unknown as Record<string, Comb>
  const overlay = rules(() => ({ Word: token(literal('b')) })) as unknown as Record<string, Comb>
  const composed = compose([base, overlay]) as unknown as Record<string, unknown>
  const finalRules = composedCoverageRules(composed)
  assert(finalRules !== undefined)
  const result = census(Object.entries(finalRules), name => finalRules[name])
  const has = (value: string): boolean => result.rows.some(row =>
    row.atom === 'token' && row.parser._def.tag === 'token'
    && rawEdges(row.parser).some(edge => edge.parser._def.tag === 'literal' && edge.parser._def.value === value))
  assert(has('b'), 'post-compose winner was omitted')
  assert(!has('a'), 'superseded pre-compose token remained reachable')
}

proveFinalWinner()
const loader = await assertParseman()
for (const dialect of ['css', 'less'] as const) {
  const grammar = await loadGrammar(dialect)
  const names = Object.keys(grammar.rules).sort()
  const roots = names.map(name => [name, grammar.rules[name]!] as const)
  const result = census(roots, name => grammar.rules[name])
  const digest = createHash('sha256').update(result.rows.map(row =>
    `${row.atom}\u0000${row.path}\u0000${row.outer}\u0000${row.recognition}`).join('\n')).digest('hex')
  const expected = EXPECTED[dialect]
  assert.equal(result.rows.length, expected.total)
  assert.deepEqual(counts(result.rows), expected.counts)
  assert.equal(new Set(result.rows.map(row => row.recognition)).size, expected.contexts)
  assert.equal(digest, expected.digest)

  // Comparison occurs only after the independent raw-def census is complete.
  const production = collectLexicalAlphabet(roots.map(([, parser]) => parser), name => grammar.rules[name])
  assert.equal(production.capabilities.length, result.rows.length)
  for (const row of result.rows) assert(production.capabilities.some(site =>
    site.parser === row.parser
    && site.atom === row.atom
    && site.context.trivia === row.context.trivia
    && site.context.trackLines === row.context.trackLines
    && site.context.captureTrivia === row.context.captureTrivia
    && site.context.opaqueRootCapture === row.context.rootCapture
    && site.context.dynamicState === row.context.dynamicState
    && site.context.scanSkip.length === row.context.scanSkip.length
    && site.context.scanSkip.every((entry, index) => entry === row.context.scanSkip[index])))
  console.log(JSON.stringify({ dialect, occurrences: result.rows.length, counts: expected.counts,
    contexts: expected.contexts, digest, bindingEdges: result.bindingEdges }))
}
console.log(JSON.stringify({
  parseman: realpathSync(process.cwd()),
  parsemanSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  jess: realpathSync(JESS_ROOT),
  jessSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: JESS_ROOT, encoding: 'utf8' }).trim(),
  loader,
  node: process.version,
}))
