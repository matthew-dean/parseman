/**
 * THE TRIVIA-SKIP ARMS THAT ARE ACTUALLY EMITTED, and how many sites call each.
 *
 * A site-label census counts LABELS. This counts the CODE the labels produced —
 * `skipFor()` pools one `_sk<N>` per distinct label, and the shape of that
 * function is the whole question: a bare `TRIVIASCAN[ki]` call, a
 * `skipTriviaScanned` capture call, or the labelled `scanTrivia` path that
 * `src/combinators/trivia-skip.ts` routes through `scanWithLabels`.
 */
import { emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { resolveTable } from '../../src/table/program.ts'
import { loadGrammar, VARIANT_SETTINGS, type Dialect, type Variant } from './grammars.ts'

const dialect = (process.argv[2] ?? 'css') as Dialect
const variant = (process.argv[3] ?? 'ast') as Variant

const g = await loadGrammar(dialect, variant)
const prog = encodeTable(g.rules, VARIANT_SETTINGS[variant])
const t = resolveTable(prog)

const extraIps: number[] = []
for (const s of prog.scans ?? []) {
  for (const r of s.skip) extraIps.push(r[0])
  if (s.sentinel !== undefined) extraIps.push(s.sentinel[0])
}
for (const set of prog.scanSkip ?? []) for (const r of set) extraIps.push(r[0])

const em = emitAssemblySource(t, prog, {
  hostCst: variant.startsWith('cst'), trackLines: variant.endsWith('lines'),
  tolerant: false, coverage: false, probe: false,
}, extraIps)

const src = em.source
// Each `_sk<N>` definition, and how many CALL SITES the emitted body has.
const defs = [...src.matchAll(/function (_sk\d+)\(input,cur,ctx\)\{([\s\S]*?)\n?\}\n/g)]
const rows = defs.map(m => {
  const name = m[1]!
  const body = m[2]!.replace(/\s+/g, ' ').trim()
  const calls = (src.match(new RegExp(`\\b${name}\\(`, 'g')) ?? []).length - 1
  return { name, calls, body }
})
rows.sort((a, b) => b.calls - a.calls)

console.log(JSON.stringify({
  dialect,
  variant,
  bytes: src.length,
  triviaLabelled: [...t.triviaLabelled],
  triviaScanLowered: t.triviaScan.map(s => s != null),
  skipDefs: rows,
  bareSkipTriviaCalls: (src.match(/\b_skipTrivia\(/g) ?? []).length,
  scanTriviaMentions: (src.match(/\bscanTrivia\(/g) ?? []).length,
  skipTriviaScannedMentions: (src.match(/\bskipTriviaScanned\(/g) ?? []).length,
  advanceTriviaMentions: (src.match(/\badvanceTrivia\(/g) ?? []).length,
  rbBufSites: (src.match(/\b_rbBuf\(/g) ?? []).length,
  pushLeafBufSites: (src.match(/\b_pushLeafBuf\(/g) ?? []).length,
  accSetSites: (src.match(/\b_accSet\(/g) ?? []).length,
}, null, 2))
