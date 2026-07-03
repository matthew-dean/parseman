/**
 * Codegen A/B micro-benchmarks — isolate the two recent codegen optimizations so
 * their impact can be measured before/after in a single process (machine-
 * independent ratios; no dependency on old git state).
 *
 *   1. Regex lowering  — a scannable shape (`[0-9]+`, `[A-Za-z_]\w*`, `//…`,
 *      `/*…*​/`) compiles to a `charCodeAt` scan. The A/B "baseline" is the SAME
 *      pattern with `{1,}`/`{0,}` instead of `+`/`*`: identical matches, but the
 *      quantifier form is NOT recognized by parseScanShape, so it stays on
 *      `RegExp.exec`. scan-µs vs exec-µs isolates the lowering.
 *
 *   2. Choice dispatch — a disjoint choice of discrete first chars compiles to a
 *      `switch` jump table. Forcing `__setForceDisjointIf(true)` recompiles the
 *      SAME grammar as an `if/else if` chain. switch-µs vs if-µs isolates it.
 *
 * Run: node --import tsx/esm bench/codegen-ab.ts
 */
import { regex, literal, choice, many, sepBy } from '../src/index.ts'
import type { Combinator } from '../src/index.ts'
import { compile, __setForceDisjointIf } from '../src/compiler/codegen.ts'
import { measureMedianUs } from './parseman-perf.ts'

type CompiledFn = (input: string) => unknown

function comp<T>(c: Combinator<T>): CompiledFn {
  const k = compile(c)
  return (input: string) => k.parse(input, 0)
}

/** Compile a grammar with disjoint choices forced to the if/else if form. */
function compForceIf<T>(c: Combinator<T>): CompiledFn {
  __setForceDisjointIf(true)
  try {
    return comp(c)
  } finally {
    __setForceDisjointIf(false)
  }
}

// ---------------------------------------------------------------------------
// 1. Regex lowering: scan (`+`/`*`) vs exec (`{1,}`/`{0,}`, same semantics)
// ---------------------------------------------------------------------------

export type ScanAbCase = {
  name: string
  input: string
  scan: CompiledFn
  exec: CompiledFn
  /** True when scan compiled to charCodeAt and exec compiled to RegExp.exec. */
  valid: boolean
}

/**
 * Build a scan-vs-exec A/B from two grammars. `opt` uses a scannable regex
 * (`+`/`*`, lowered to charCodeAt); `base` is the SAME grammar with `{1,}`/`{0,}`
 * quantifiers — identical matches, but NOT recognized by parseScanShape, so it
 * stays on RegExp.exec. The only regex in each grammar is the one under test, so
 * "opt has no .exec" reliably means the terminal was lowered.
 */
function grammarScanAb(
  name: string,
  opt: Combinator<unknown>,
  base: Combinator<unknown>,
  input: string,
): ScanAbCase {
  const optSrc = compile(opt).source
  const baseSrc = compile(base).source
  const valid =
    optSrc.includes('charCodeAt') && !optSrc.includes('.exec(input)') &&
    baseSrc.includes('.exec(input)')
  return { name, input, scan: comp(opt), exec: comp(base), valid }
}

const sp = literal(' ')

/**
 * Realistic regime: MANY SHORT tokens, where a `regex.exec` call (lastIndex set,
 * native engine spin-up, match-array allocation) per token dominates. This is
 * what real grammars do (identifiers, numbers, punctuation), and where lowering
 * to an inline charCodeAt scan pays off. (Native regex still wins on a single
 * pathologically long run — see buildScanAbLongCases — but grammars rarely have
 * those.)
 */
export function buildScanAbCases(): ScanAbCase[] {
  const nums = Array.from({ length: 2000 }, (_, i) => String(i % 1000)).join(' ')
  const words = Array.from({ length: 2000 }, (_, i) => 'abcdef'.slice(0, (i % 5) + 1)).join(' ')
  const idents = Array.from({ length: 2000 }, (_, i) => 'v' + (i % 100)).join(' ')
  return [
    grammarScanAb('short digits ×2000',
      sepBy(regex(/[0-9]+/), sp), sepBy(regex(/[0-9]{1,}/), sp), nums),
    grammarScanAb('short chars  ×2000',
      sepBy(regex(/[a-z]+/), sp), sepBy(regex(/[a-z]{1,}/), sp), words),
    grammarScanAb('short ident  ×2000',
      sepBy(regex(/[a-z][a-z0-9]*/), sp), sepBy(regex(/[a-z][a-z0-9]{0,}/), sp), idents),
  ]
}

/**
 * Contrast regime: a SINGLE very long token. Native RegExp.exec is a tuned C++
 * scanner and beats an interpreted charCodeAt loop here, so scan is expected to
 * LOSE. Printed for context; not asserted (real grammars don't lean on this).
 */
export function buildScanAbLongCases(): ScanAbCase[] {
  const digits = '9'.repeat(4000)
  const line = '//' + 'x'.repeat(4000)
  const block = '/*' + 'x'.repeat(4000) + '*/'
  return [
    grammarScanAb('long digits (1 tok)', regex(/[0-9]+/), regex(/[0-9]{1,}/), digits),
    grammarScanAb('long line   (1 tok)', regex(/\/\/[^\n\r]*/), regex(/\/\/[^\n\r]{0,}/), line),
    grammarScanAb('long block  (1 tok)',
      regex(/\/\*(?:[^*]|\*(?!\/))*\*\//), regex(/\/\*(?:[^*]|\*(?!\/)){0,}\*\//), block),
  ]
}

// ---------------------------------------------------------------------------
// 2. Choice dispatch: switch (default) vs if/else if (forced)
// ---------------------------------------------------------------------------

export type DispatchAbCase = {
  name: string
  input: string
  sw: CompiledFn
  iff: CompiledFn
  /** True when sw compiled to a switch and iff did not. */
  valid: boolean
}

function dispatchAb(name: string, arms: Combinator<unknown>, input: string): DispatchAbCase {
  const swSrc = compile(arms).source
  __setForceDisjointIf(true)
  const ifSrc = compile(arms).source
  __setForceDisjointIf(false)
  const valid = swSrc.includes('switch (') && !ifSrc.includes('switch (')
  return { name, input, sw: comp(arms), iff: compForceIf(arms), valid }
}

export function buildDispatchAbCases(): DispatchAbCase[] {
  type Arms = [Combinator<unknown>, ...Combinator<unknown>[]]

  // 10 single-char operators → 10-case switch. Input cycles all arms 4000×.
  const opChars = ['+', '-', '*', '/', '%', '<', '>', '=', '&', '|']
  const ops = many(choice(...(opChars.map(s => literal(s)) as Arms)))
  const opInput = Array.from({ length: 4000 }, (_, i) => opChars[i % opChars.length]).join('')

  // Keyword dispatch: 8 words with DISTINCT first chars (disjoint → switch).
  const kws = ['apple', 'banana', 'cherry', 'date', 'fig', 'grape', 'kiwi', 'lemon']
  const methodTok = choice(...([literal(' '), ...kws.map(s => literal(s))] as Arms))
  const methods = many(methodTok)
  const kwInput = Array.from({ length: 2000 }, (_, i) => kws[i % kws.length]).join(' ') + ' '

  return [
    { ...dispatchAb('ops  choice(10× 1-char)', ops, opInput) },
    { ...dispatchAb('kw   choice(8 methods)', methods, kwInput) },
  ]
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type AbResult = { name: string; aUs: number; bUs: number; speedup: number; valid: boolean }

function measure(fn: CompiledFn, input: string, iterations: number): number {
  return measureMedianUs(() => fn(input), iterations, { samples: 9 })
}

function runScanCases(cases: ScanAbCase[], iterations: number): AbResult[] {
  return cases.map(c => {
    const bUs = measure(c.exec, c.input, iterations)
    const aUs = measure(c.scan, c.input, iterations)
    return { name: c.name, aUs, bUs, speedup: bUs / aUs, valid: c.valid }
  })
}

export function runScanAb(iterations = 20_000): AbResult[] {
  return runScanCases(buildScanAbCases(), iterations)
}

export function runScanAbLong(iterations = 4_000): AbResult[] {
  return runScanCases(buildScanAbLongCases(), iterations)
}

export function runDispatchAb(iterations = 20_000): AbResult[] {
  return buildDispatchAbCases().map(c => {
    const bUs = measure(c.iff, c.input, iterations)
    const aUs = measure(c.sw, c.input, iterations)
    return { name: c.name, aUs, bUs, speedup: bUs / aUs, valid: c.valid }
  })
}

function printScan(title: string, results: AbResult[]): void {
  console.log(`\n=== Codegen A/B — ${title} ===`)
  for (const r of results) {
    const flag = r.valid ? '' : '  ⚠ A/B invalid (paths not as expected)'
    console.log(
      `  ${r.name.padEnd(24)} exec ${r.bUs.toFixed(2).padStart(8)}µs  scan ${r.aUs.toFixed(2).padStart(8)}µs  ${r.speedup.toFixed(2)}×${flag}`,
    )
  }
}

export function printCodegenAb(): void {
  printScan('regex lowering — realistic (many short tokens)', runScanAb())
  printScan('regex lowering — contrast (1 long token; native exec wins)', runScanAbLong())
  console.log('\n=== Codegen A/B — disjoint dispatch (switch vs if/else) ===')
  for (const r of runDispatchAb()) {
    const flag = r.valid ? '' : '  ⚠ A/B invalid (paths not as expected)'
    console.log(
      `  ${r.name.padEnd(24)} if ${r.bUs.toFixed(2).padStart(8)}µs  switch ${r.aUs.toFixed(2).padStart(8)}µs  ${r.speedup.toFixed(2)}×${flag}`,
    )
  }
  console.log()
}

// Direct-run entry (tsx): `node --import tsx/esm bench/codegen-ab.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  printCodegenAb()
}
