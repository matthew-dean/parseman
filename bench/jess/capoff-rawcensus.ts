/**
 * WHO READS `rawChildren` — the census behind the CST-capture cost.
 *
 * `encode.ts:1014-1019` derives six node flag bits: trivia (4), state (8),
 * fields (16), collapse (32), unwrap (64), trailingTrivia (128). There is NO bit
 * for `rawChildren`, and `buildReadsRaw` (`compiler/build-arity.ts:309`) is
 * exported and called from NOWHERE in `src/`.
 *
 * So every `OP_NODE` maintains `b.raw`/`b.rawSingle` beside `b.ch`/`b.single`
 * whatever the host mode: `_pushLeafBuf` writes both per leaf, `emitMark(buf)`
 * reads both lengths per mark, `_rbBuf` truncates both per rollback. `rawKids`
 * reaches only a CST host or a builder that declares a 4th formal parameter.
 *
 * This counts the node defs each way, so the size of that is a number rather
 * than an argument.
 */
import { buildReadsChildren, buildReadsRaw, buildReadsTrivia, confirmedArityForDef } from '../../src/compiler/build-arity.ts'
import type { Combinator } from '../../src/types.ts'
import { loadGrammar, type Dialect, type Variant } from './grammars.ts'

const dialect = (process.argv[2] ?? 'css') as Dialect
const variant = (process.argv[3] ?? 'ast') as Variant
const g = await loadGrammar(dialect, variant)

type Def = { tag: string } & Record<string, unknown>
const isComb = (v: unknown): v is Combinator<unknown> =>
  typeof v === 'object' && v !== null && '_def' in (v as Record<string, unknown>)

const seen = new Set<unknown>()
const nodes: Def[] = []
function walk(c: unknown): void {
  if (!isComb(c) || seen.has(c)) return
  seen.add(c)
  const d = c._def as Def
  if (d.tag === 'node') nodes.push(d)
  for (const v of Object.values(d)) {
    if (Array.isArray(v)) for (const x of v) walk(x)
    else walk(v)
  }
}
for (const r of Object.values(g.rules)) walk(r)

let readsRaw = 0
let readsKids = 0
let readsTrivia = 0
let structural = 0
let arityUnknown = 0
const arities = new Map<string, number>()
for (const d of nodes) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = d as Parameters<typeof buildReadsRaw>[0]
  if (d.build === undefined) structural++
  else if (confirmedArityForDef(def) === null) arityUnknown++
  if (buildReadsRaw(def)) readsRaw++
  if (buildReadsChildren(def)) readsKids++
  if (buildReadsTrivia(def)) readsTrivia++
  const a = d.build === undefined ? 'structural' : String(confirmedArityForDef(def))
  arities.set(a, (arities.get(a) ?? 0) + 1)
}

console.log(JSON.stringify({
  dialect,
  variant,
  nodeDefs: nodes.length,
  structural,
  arityUnconfirmed: arityUnknown,
  readsRawChildren: readsRaw,
  readsRawPct: +(100 * readsRaw / Math.max(1, nodes.length)).toFixed(1),
  rawCaptureDeadFor: nodes.length - readsRaw,
  readsChildren: readsKids,
  readsTrivia,
  byArity: Object.fromEntries([...arities].sort()),
}, null, 2))
