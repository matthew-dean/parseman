/**
 * Static real-Jess census for the token-stream decision contract.
 *
 * This parses no fixture and measures no time. It walks the authored combinator
 * graph, stopping at named lazy refs, and reports atomic token() producers plus
 * dispatch sites that consume those producers. The shape key is test-local: it
 * is evidence about the exact Jess source, never compiler/runtime metadata.
 *
 * Usage (one dialect per process; compose mutates shared refs):
 *   JESS_ROOT=/private/tmp/jess-parseman-origin-dev \
 *   node --import ./bench/jess/register.mjs bench/jess/token-stream-contract.ts less
 * Add --plant to prove the pinned topology gate goes RED.
 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { childrenOf } from '../../src/analysis/gating.ts'
import type { Combinator, ParserDef } from '../../src/types.ts'
import { JESS_ROOT, assertParseman, loadGrammar, type Dialect } from './grammars.ts'

const EXPECTED_JESS = '93c67d0ae7be0360a6db35f0cfa055043bca8025'
const EXPECTED = {
  css: { producers: 18, families: 12, dispatches: 7 },
  less: { producers: 28, families: 28, dispatches: 8 },
} as const

type Found = {
  parser: Combinator<unknown>
  roots: Set<string>
  shape: string
}

function esc(value: string): string { return JSON.stringify(value) }

function parserShape(parser: Combinator<unknown>, seen = new Set<Combinator<unknown>>()): string {
  if (seen.has(parser)) return '@cycle'
  seen.add(parser)
  const d = parser._def as ParserDef
  switch (d.tag) {
    case 'literal': return `lit(${esc(d.value)}${d.caseInsensitive ? ',i' : ''})`
    case 'regex': return `rx(${esc(d.source)},${esc(d.flags)})`
    case 'keywords': return `kw(${d.words.map(esc).join('|')};${d.caseInsensitive ? 'i' : ''};${d.boundary ?? ''})`
    case 'sequence': return `seq(${d.parsers.map(child => parserShape(child, new Set(seen))).join(',')})`
    case 'choice': return `choice(${d.parsers.map(child => parserShape(child, new Set(seen))).join('|')})`
    case 'dispatch': return `dispatch(${parserShape(d.selector, new Set(seen))};${d.cases.length};${d.matchers?.length ?? 0};${d.otherwise ? 1 : 0})`
    case 'lazy': return `ref(${String((parser as { _ruleName?: unknown })._ruleName ?? (d as { name?: unknown }).name ?? '?')})`
    case 'grammar': return `${d.clearTrivia ? 'noTrivia' : 'scope'}(${parserShape(d.parser, new Set(seen))})`
    case 'token': return `token(${parserShape(d.parser, new Set(seen))})`
    case 'optional': return `opt(${parserShape(d.parser, new Set(seen))})`
    case 'not': return `not(${parserShape(d.parser, new Set(seen))})`
    case 'peek': return `peek(${parserShape(d.parser, new Set(seen))})`
    case 'attempt': return `attempt(${parserShape(d.parser, new Set(seen))})`
    case 'transform': case 'node': case 'field': case 'label': case 'expect': case 'leaf': case 'trivia':
      return `${d.tag}(${parserShape(d.parser, new Set(seen))})`
    case 'routed': return d.fallback ? `routed(${parserShape(d.fallback, new Set(seen))})` : 'routed'
    default: return d.tag
  }
}

function transparentToken(parser: Combinator<unknown>): Combinator<unknown> | undefined {
  let current = parser
  for (let i = 0; i < 12; i++) {
    const d = current._def
    if (d.tag === 'token') return current
    if (d.tag === 'lazy') {
      current = d.thunk()
      continue
    }
    if (d.tag === 'grammar' || d.tag === 'transform' || d.tag === 'label' || d.tag === 'expect') {
      current = d.parser
      continue
    }
    return undefined
  }
  return undefined
}

function collect(rules: Record<string, Combinator<unknown>>): { tokens: Found[]; dispatches: Found[] } {
  const tokens = new Map<Combinator<unknown>, Found>()
  const dispatches = new Map<Combinator<unknown>, Found>()
  for (const [root, parser] of Object.entries(rules)) {
    const seen = new Set<Combinator<unknown>>()
    const walk = (entry: Combinator<unknown>): void => {
      if (seen.has(entry)) return
      seen.add(entry)
      const d = entry._def
      if (d.tag === 'token') {
        const found = tokens.get(entry) ?? { parser: entry, roots: new Set(), shape: parserShape(entry) }
        found.roots.add(root)
        tokens.set(entry, found)
      }
      if (d.tag === 'dispatch' && transparentToken(d.selector) !== undefined) {
        const found = dispatches.get(entry) ?? { parser: entry, roots: new Set(), shape: parserShape(d.selector) }
        found.roots.add(root)
        dispatches.set(entry, found)
      }
      for (const child of childrenOf(d)) walk(child)
    }
    // `rules()` returns the named placeholder for every forward-referenced rule.
    // Resolve the ROOT binding once, while still treating nested lazy refs as
    // leaves; otherwise either every site disappears or every root reaches the
    // entire grammar and the ownership labels become meaningless.
    const rootDef = parser._def
    const start = rootDef.tag === 'lazy' ? rootDef.thunk() : parser
    walk(start)
  }
  return { tokens: [...tokens.values()], dispatches: [...dispatches.values()] }
}

function routeSummary(entry: Found): string {
  const d = entry.parser._def
  if (d.tag !== 'dispatch') return ''
  const exact = d.cases.flatMap(c => c.keys).join('|') || '-'
  const match = (d.matchers ?? []).map(m => `${m.kind}:${m.value}/${m.flags ?? ''}${m.caseInsensitive ? 'i' : ''}`).join('|') || '-'
  return `exact=${exact} matcher=${match} fallback=${d.otherwise ? 'yes' : 'no'}`
}

const dialect = process.argv[2] as Dialect
if (dialect !== 'css' && dialect !== 'less') throw new Error('token-stream-contract: dialect must be css or less')
const parseman = await assertParseman()
const jessRoot = realpathSync(JESS_ROOT)
const jessSha = execFileSync('git', ['-C', jessRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (jessSha !== EXPECTED_JESS) throw new Error(`Jess SHA ${jessSha}, expected ${EXPECTED_JESS}`)
const loaded = await loadGrammar(dialect, 'ast')
const census = collect(loaded.rules)
const families = new Map<string, Found[]>()
for (const item of census.tokens) {
  const rows = families.get(item.shape) ?? []
  rows.push(item)
  families.set(item.shape, rows)
}

console.log(`node ${process.version} ${realpathSync(fileURLToPath(import.meta.url))}`)
console.log(`parseman ${parseman.version} ${parseman.root}`)
console.log(`jess ${jessSha} ${jessRoot}`)
console.log(`${dialect}: token producers=${census.tokens.length} token families=${families.size} token-dispatch sites=${census.dispatches.length}`)
for (const [index, [, items]] of [...families].entries()) {
  const roots = [...new Set(items.flatMap(item => [...item.roots]))].sort()
  console.log(`family ${index}: sites=${items.length} roots=${roots.join(',')}`)
  console.log(`  ${items[0]!.shape}`)
}
for (const [index, item] of census.dispatches.entries()) {
  console.log(`dispatch ${index}: roots=${[...item.roots].sort().join(',')} ${routeSummary(item)}`)
  console.log(`  family=${item.shape}`)
}

if (dialect === 'less') {
  const sharedValue = census.tokens.find(item => item.roots.has('Value') && item.roots.has('FunctionStatement'))
  const continuation = census.tokens.find(item => item.roots.has('CallArgumentFunction'))
  if (sharedValue === undefined || continuation === undefined) {
    throw new Error('Less same-position contract lost Value/FunctionStatement or CallArgumentFunction producer')
  }
  console.log('same-position: Value + FunctionStatement share the optional-open producer; '
    + 'CallArgumentFunction is the compatible required-open continuation')
  for (const name of ['Percentage', 'Dimension']) {
    if (!(name in loaded.rules)) throw new Error(`Less numeric contract lost rule ${name}`)
  }
} else {
  for (const name of ['Value', 'TypedValue', 'PseudoSelector', 'QueryTerm', 'Percentage', 'Dimension']) {
    if (!(name in loaded.rules)) throw new Error(`CSS token contract lost rule ${name}`)
  }
}

// The plant changes an actually checked fact rather than throwing directly.
// That proves the script's structural census is capable of going RED.
const expected = EXPECTED[dialect]
const observed = {
  producers: census.tokens.length,
  families: families.size,
  dispatches: census.dispatches.length + (process.argv.includes('--plant') ? 1 : 0),
}
if (JSON.stringify(observed) !== JSON.stringify(expected)) {
  throw new Error(`token topology mismatch: ${JSON.stringify(observed)}, expected ${JSON.stringify(expected)}`)
}
