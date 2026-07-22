/**
 * sharedPrefix A/B micro-benchmark — head-to-head proof artifact.
 *
 * The `sharedPrefix` choice strategy recognizes a common leading literal/regex ONCE
 * and replays it per arm, instead of every arm re-scanning it (ordered `firstMatch`).
 * It shares ONLY the scan — each arm still enters its own node() frame — so the win is
 * exactly the redundant prefix-scan cost, and is real only when (a) the shared prefix
 * does meaningful scanning work and (b) several arms re-scan it before one wins.
 *
 * This bench compiles the SAME grammar two ways in one process — grouped (sharedPrefix)
 * vs `__setForceNoSharedPrefix` (ordered firstMatch, re-scan per arm) — and times a
 * worst-case parse (winning arm LAST, so every earlier arm scans the full prefix then
 * fails on its residual). Two workloads:
 *   - adversarial:  maximally favors sharedPrefix (long shared prefix, many arms).
 *   - realistic:    a plausible pseudo-like grammar (moderate prefix, few arms).
 *
 * Run: node --import tsx/esm bench/shared-prefix-ab.ts
 */
import { choice, sequence, regex, literal, node, type Combinator } from '../src/index.ts'
import { compile, __setForceNoSharedPrefix } from '../src/compiler/codegen.ts'
import { measureMedianUs } from './parseman-perf.ts'

type CompiledFn = (input: string) => { ok: boolean; value?: unknown }

function comp<T>(c: Combinator<T>): CompiledFn {
  const k = compile(c)
  return (input: string) => k.parse(input, 0) as { ok: boolean; value?: unknown }
}

/** Compile the SAME grammar with sharedPrefix disabled (ordered firstMatch). */
function compForceFirstMatch<T>(c: Combinator<T>): CompiledFn {
  __setForceNoSharedPrefix(true)
  try {
    return comp(c)
  } finally {
    __setForceNoSharedPrefix(false)
  }
}

const cst = (type: string) =>
  (children: readonly unknown[], _f: unknown, span: { start: number; end: number }) =>
    ({ type, span, children: [...children] })

export type SpAbCase = {
  name: string
  input: string
  grammar: Combinator<unknown>
  /** True when grouped compiled to sharedPrefix and forced compiled to firstMatch. */
  valid: boolean
}

/**
 * N arms all leading with the SAME `prefix`, then a distinct 3-char discriminator.
 * The winning arm is LAST → every earlier arm scans `prefix` in full then fails.
 * Wrapped in node() so it's a realistic capturing production, single-function scope.
 */
function buildCase(name: string, prefix: Combinator<unknown>, nArms: number, input: string): SpAbCase {
  const arms = Array.from({ length: nArms }, (_, i) =>
    node(`P${i}`, sequence(prefix, literal(`!${String(i).padStart(2, '0')}`)), cst(`P${i}`)),
  )
  const grammar = choice(...(arms as [Combinator<unknown>, ...Combinator<unknown>[]]))
  const strat = (grammar._def as { strategy?: { tag: string } }).strategy?.tag
  // Validity: the strategy detected sharedPrefix, and the two compiles differ.
  const src = compile(grammar).source
  __setForceNoSharedPrefix(true)
  let srcFm: string
  try {
    srcFm = compile(grammar).source
  } finally {
    __setForceNoSharedPrefix(false)   // never leave the flag set (would corrupt later cases)
  }
  const valid = strat === 'sharedPrefix' && src !== srcFm
  return { name, input, grammar, valid }
}

function buildCases(): SpAbCase[] {
  // Adversarial: a long shared name (regex scanning a ~40-char run) + 8 arms, winner last.
  const longName = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn'   // 40 chars
  const adversarial = buildCase(
    'adversarial (40-char regex prefix, 8 arms)',
    regex(/[a-z]+/),
    8,
    `${longName}!07`,
  )
  // Adversarial-literal: a fixed long shared literal (24 chars) + 8 arms, winner last.
  const sharedLit = 'https://example.com/api/'   // 24 chars
  const adversarialLit = buildCase(
    'adversarial (24-char literal prefix, 8 arms)',
    literal(sharedLit),
    8,
    `${sharedLit}!07`,
  )
  // Realistic-favorable: a moderate shared token (regex ~8 chars) + 4 arms, winner last.
  const realistic = buildCase(
    'realistic (8-char regex prefix, 4 arms)',
    regex(/[a-z]+/),
    4,
    `abcdefgh!03`,
  )
  return [adversarial, adversarialLit, realistic]
}

export { buildCases }

export type SpAbPair = { name: string; input: string; shared: CompiledFn; firstMatch: CompiledFn; valid: boolean }

/** Compile each case both ways (sharedPrefix vs forced firstMatch) for A/B use. */
export function buildAbPairs(): SpAbPair[] {
  return buildCases().map(c => ({
    name: c.name,
    input: c.input,
    shared: comp(c.grammar),
    firstMatch: compForceFirstMatch(c.grammar),
    valid: c.valid,
  }))
}

export type SpAbResult = { name: string; sharedUs: number; firstMatchUs: number; speedup: number; valid: boolean; ok: boolean }

export function runSharedPrefixAb(iterations = 200_000): SpAbResult[] {
  return buildAbPairs().map(p => {
    // Correctness: both must produce the same result on the input.
    const rs = p.shared(p.input), rf = p.firstMatch(p.input)
    const ok = rs.ok === rf.ok && JSON.stringify(rs.value) === JSON.stringify(rf.value) && rs.ok
    const sharedUs = measureMedianUs(() => { p.shared(p.input) }, iterations)
    const firstMatchUs = measureMedianUs(() => { p.firstMatch(p.input) }, iterations)
    return { name: p.name, sharedUs, firstMatchUs, speedup: firstMatchUs / sharedUs, valid: p.valid, ok }
  })
}

export function printSharedPrefixAb(): void {
  console.log('\n=== sharedPrefix A/B — worst case (winning arm last; per-parse median) ===')
  console.log('    firstMatch = re-scan prefix per arm; shared = scan once + replay\n')
  for (const r of runSharedPrefixAb()) {
    const flags = `${r.valid ? '' : '  ⚠ A/B invalid'}${r.ok ? '' : '  ⚠ outputs differ'}`
    console.log(
      `  ${r.name.padEnd(44)} firstMatch ${r.firstMatchUs.toFixed(3).padStart(8)}µs   shared ${r.sharedUs.toFixed(3).padStart(8)}µs   ${r.speedup.toFixed(3)}×${flags}`,
    )
  }
  console.log()
}

// Direct-run entry (tsx): `node --import tsx/esm bench/shared-prefix-ab.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  printSharedPrefixAb()
}
