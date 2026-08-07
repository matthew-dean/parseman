/**
 * IS THE CAP TERNARY REACHABLE? — checking `lane/capoff`'s claim, not assuming it.
 *
 * `skipFor()` consults `l.cap` only when `hasScan` is true, and `hasScan` is
 * `swapLegal && !triviaLabelled[ki] && triviaScan[ki] != null`. If every slot is
 * labelled or has no fast scanner, the `capturing` ternary is dead and the cap
 * label cannot affect a byte of emitted source — which would make a cap-axis
 * measurement noise.
 *
 * Checked against the EMITTED TEXT rather than the labeller, because the text is
 * what runs: a mention of `TRIVIASCAN` / `skipTriviaScanned` / `ctx.captureTrivia`
 * in a `_sk*` body is the observable consequence of the branch being live.
 *
 *   node --import ./bench/jess/register.mjs bench/jess/mixture-skip-probe.ts <dialect> [variant]
 */
import { encodeTable } from '../../src/table/encode.ts'
import { resolveTable } from '../../src/table/program.ts'
import { emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { DIALECTS, VARIANTS, VARIANT_SETTINGS, loadGrammar, type Dialect, type Variant } from './grammars.ts'

const dialect = process.argv[2] as Dialect
if (!DIALECTS.includes(dialect)) throw new Error(`unknown dialect '${String(process.argv[2])}'`)
const variant = (process.argv[3] ?? 'ast') as Variant
if (!VARIANTS.includes(variant)) throw new Error(`unknown variant '${String(process.argv[3])}'`)

const { rules } = await loadGrammar(dialect, variant)
const settings = VARIANT_SETTINGS[variant]
const prog = encodeTable(rules, settings)
const t = resolveTable(prog)
const cfg = {
  hostCst: settings.hostMode === 'cst',
  trackLines: settings.trackLines === true,
  tolerant: false, coverage: false, probe: false, mix: undefined,
}

const extraIps: number[] = []
for (const s of prog.scans ?? []) {
  for (const r of s.skip) extraIps.push(r[0])
  if (s.sentinel !== undefined) extraIps.push(s.sentinel[0])
}
for (const set of prog.scanSkip ?? []) for (const r of set) extraIps.push(r[0])

const src = emitAssemblySource(t, prog, cfg, extraIps).source

// The three tokens that can only appear in a `_sk*` body if `hasScan` was true.
const skBodies = [...src.matchAll(/function (_sk\d+)\(input,cur,ctx\)\{([\s\S]*?)\n\}/g)]
const live = skBodies.filter(m =>
  m[2]!.includes('TRIVIASCAN') || m[2]!.includes('skipTriviaScanned') || m[2]!.includes('captureTrivia'))

console.log(JSON.stringify({
  dialect,
  variant,
  triviaLabelled: [...t.triviaLabelled],
  triviaScanNonNull: t.triviaScan.map(s => s != null),
  swapLegal: !cfg.trackLines,
  skipFns: skBodies.map(m => m[1]),
  skipFnsConsultingScanner: live.map(m => m[1]),
  capTernaryReachable: live.length > 0,
}))
