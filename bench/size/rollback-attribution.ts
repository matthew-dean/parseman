/**
 * ROLLBACK / SAVE BYTE ATTRIBUTION
 * ================================
 *
 * Answers one question with numbers instead of intuition: of the bytes a
 * compiled grammar spends on capture save/restore, how many are the SEQUENCE
 * BOUNDARY trivia-commit decision (which a token cursor deletes outright,
 * because trivia is a scan-time property of a token and is never appended to a
 * capture buffer speculatively) and how many are the partial-capture rollback
 * that guards an already-committed object append (which a token cursor does NOT
 * delete, because an allocated node cannot be re-derived from an integer).
 *
 * Attribution is by MARK-VARIABLE PREFIX. `v(ctx, prefix)` in codegen.ts gives
 * every emission site its own prefix, so the prefix identifies the emitter
 * exactly — no heuristics, no guessing which `if (_ctx._cstLeaves …)` came from
 * where.
 *
 * Run: node --import tsx/esm bench/size/rollback-attribution.ts
 */
import { compile } from '../../src/index.ts'
import { Stylesheet as CssStylesheet } from '../../examples/css/parser.ts'
import { Stylesheet as LessStylesheet } from '../workloads/less.ts'
import { graphqlDoc } from '../../examples/graphql/parser.ts'

/**
 * Which emitter owns each mark-variable prefix (see codegen.ts `v(ctx, …)`).
 *
 * This table is only sound while each prefix has exactly ONE emitter, and it was
 * not: `emitMany`/`manySep` used `_mk`/`_mktl`/`_mklg`/`_mkrlg` too, so every
 * many-loop mark was billed to the sequence boundary — 86,574 B of the 375,527 B
 * this reported as boundary cost on css. The many family is now `_ml*`, which
 * makes the stated invariant true rather than assumed.
 */
const SEQ_BOUNDARY_PREFIXES = new Set([
  '_mk', '_mktl', '_mklg', '_mkrlg', // emitSeqValues capturing-trivia marks
  '_sne', '_sea', '_tlg',            // emitSeqValues scan-end / end-after / trivia-log hoist
])

/** `emitMany`/`manySep`: the per-iteration mark-item-rollback shape. */
const MANY_LOOP_PREFIXES = new Set([
  '_ml', '_mltl', '_mllg', '_mlrlg', '_mllv', '_mlf', '_mlrw',
])

type Bucket = { restoreBytes: number, saveBytes: number, sites: number }
const empty = (): Bucket => ({ restoreBytes: 0, saveBytes: 0, sites: 0 })

/** `_mktl12` -> `_mktl`. Prefixes are alphabetic; the counter is the digits. */
function prefixOf(name: string): string {
  return name.replace(/\d+$/, '')
}

/**
 * A guarded restore is exactly `if (X && X.length !== M) X.length = M` (or the
 * `X !== undefined` variant for the hoisted trivia log). Match the whole clause
 * so the measured bytes are the bytes actually in the artifact.
 */
const RESTORE_RE = /if \((_ctx\.\w+|_\w+) (?:&&|!== undefined &&) \1\.length !== (\w+)\) \1\.length = \2/g

/** A mark save: `const M = <sink>?.length ?? 0` or `<sink> ? <sink>.length : 0`. */
const SAVE_RE = /const (\w+) = (?:_ctx\.\w+|_\w+)(?:\?\.length \?\? 0|(?: !== undefined)? \? (?:_ctx\.\w+|_\w+)\.length : 0)/g

function attribute(source: string): { total: Bucket, seq: Bucket, many: Bucket, other: Bucket, byPrefix: Map<string, Bucket> } {
  const byPrefix = new Map<string, Bucket>()
  const bump = (p: string, key: 'restoreBytes' | 'saveBytes', n: number): void => {
    let b = byPrefix.get(p)
    if (!b) { b = empty(); byPrefix.set(p, b) }
    b[key] += n
    b.sites++
  }
  for (const m of source.matchAll(RESTORE_RE)) bump(prefixOf(m[2]!), 'restoreBytes', m[0]!.length)
  for (const m of source.matchAll(SAVE_RE)) bump(prefixOf(m[1]!), 'saveBytes', m[0]!.length)

  const total = empty(), seq = empty(), many = empty(), other = empty()
  for (const [p, b] of byPrefix) {
    const t = SEQ_BOUNDARY_PREFIXES.has(p) ? seq : MANY_LOOP_PREFIXES.has(p) ? many : other
    for (const k of ['restoreBytes', 'saveBytes', 'sites'] as const) { t[k] += b[k]; total[k] += b[k] }
  }
  return { total, seq, many, other, byPrefix }
}

const pct = (n: number, d: number): string => `${((n / d) * 100).toFixed(1)}%`

/**
 * A SHIPPED artifact has been through the bundler, so its statements are split
 * across indented lines. `compile().source` is not. Collapse runs of whitespace
 * so one set of patterns reads both — the byte counts stay honest because the
 * collapsed form is what the minified/gzipped artifact actually carries.
 */
function normalize(src: string): string {
  return src.replace(/\s*\n\s*/g, ' ')
}

/** Attribute a file on disk (a built `ast.js`) rather than a freshly compiled grammar. */
const fileArgs = process.argv.slice(2).filter(a => !a.startsWith('-'))
if (fileArgs.length > 0) {
  const { readFileSync } = await import('node:fs')
  for (const f of fileArgs) {
    const raw = readFileSync(f, 'utf8')
    const { total, seq, many, other, byPrefix } = attribute(normalize(raw))
    const artifact = Buffer.byteLength(raw)
    const totalBytes = total.restoreBytes + total.saveBytes
    console.log(`\n=== ${f} — artifact ${artifact.toLocaleString()} B ===`)
    console.log(`save+restore total : ${totalBytes.toLocaleString()} B (${pct(totalBytes, artifact)} of artifact), ${total.sites} sites`)
    console.log(`  sequence boundary: ${(seq.restoreBytes + seq.saveBytes).toLocaleString()} B (${pct(seq.restoreBytes + seq.saveBytes, totalBytes)} of save+restore, ${pct(seq.restoreBytes + seq.saveBytes, artifact)} of artifact), ${seq.sites} sites`)
    console.log(`  many/repeat loop : ${(many.restoreBytes + many.saveBytes).toLocaleString()} B (${pct(many.restoreBytes + many.saveBytes, totalBytes)} of save+restore, ${pct(many.restoreBytes + many.saveBytes, artifact)} of artifact), ${many.sites} sites`)
    console.log(`  other (fallible) : ${(other.restoreBytes + other.saveBytes).toLocaleString()} B (${pct(other.restoreBytes + other.saveBytes, totalBytes)} of save+restore, ${pct(other.restoreBytes + other.saveBytes, artifact)} of artifact), ${other.sites} sites`)
    for (const [p, b] of [...byPrefix].sort((a, b) => (b[1].restoreBytes + b[1].saveBytes) - (a[1].restoreBytes + a[1].saveBytes))) {
      console.log(`    ${p.padEnd(8)} ${String(b.restoreBytes + b.saveBytes).padStart(8)} B  ${String(b.sites).padStart(5)} sites  ${SEQ_BOUNDARY_PREFIXES.has(p) ? 'SEQ' : MANY_LOOP_PREFIXES.has(p) ? 'MANY' : 'other'}`)
    }
  }
  process.exit(0)
}

for (const [name, g] of [
  ['css/stylesheet', CssStylesheet],
  ['less/stylesheet', LessStylesheet],
  ['graphql/document', graphqlDoc],
] as const) {
  const src = compile(g as never).source
  const { total, seq, many, other, byPrefix } = attribute(src)
  const artifact = Buffer.byteLength(src)
  const totalBytes = total.restoreBytes + total.saveBytes
  console.log(`\n=== ${name} — artifact ${artifact.toLocaleString()} B ===`)
  console.log(`save+restore total : ${totalBytes.toLocaleString()} B (${pct(totalBytes, artifact)} of artifact), ${total.sites} sites`)
  console.log(`  sequence boundary: ${(seq.restoreBytes + seq.saveBytes).toLocaleString()} B (${pct(seq.restoreBytes + seq.saveBytes, totalBytes)} of save+restore, ${pct(seq.restoreBytes + seq.saveBytes, artifact)} of artifact), ${seq.sites} sites`)
  console.log(`  many/repeat loop : ${(many.restoreBytes + many.saveBytes).toLocaleString()} B (${pct(many.restoreBytes + many.saveBytes, totalBytes)} of save+restore, ${pct(many.restoreBytes + many.saveBytes, artifact)} of artifact), ${many.sites} sites`)
  console.log(`  other (fallible) : ${(other.restoreBytes + other.saveBytes).toLocaleString()} B (${pct(other.restoreBytes + other.saveBytes, totalBytes)} of save+restore, ${pct(other.restoreBytes + other.saveBytes, artifact)} of artifact), ${other.sites} sites`)
  const rows = [...byPrefix].sort((a, b) => (b[1].restoreBytes + b[1].saveBytes) - (a[1].restoreBytes + a[1].saveBytes))
  console.log('  by prefix:')
  for (const [p, b] of rows) {
    const bytes = b.restoreBytes + b.saveBytes
    console.log(`    ${p.padEnd(8)} ${String(bytes).padStart(8)} B  ${String(b.sites).padStart(5)} sites  ${SEQ_BOUNDARY_PREFIXES.has(p) ? 'SEQ' : MANY_LOOP_PREFIXES.has(p) ? 'MANY' : 'other'}`)
  }
}
