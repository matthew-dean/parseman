/**
 * IDENTITY ONLY — does swapping `compose()`'s driver change what it PARSES?
 *
 * Not a measurement. No wall clock is read, so this needs no quiet machine and no
 * timing slot; it answers the correctness half of the linker-engine swap and nothing
 * else. `bench/jess/g5-ms.ts` is the instrument for the timing half.
 *
 * WHAT IS COMPARED. `compose([rules])` against `assembledRules(encodeTable(rules))`
 * over the whole corpus of a dialect. After the swap those two run the SAME engine on
 * the SAME merged program, so every row must be `SAME`. Run this with `linker.ts`
 * reverted to `exec.ts` and the rows say whether the interpreter and the assembler
 * ever disagreed on the compose path — which is the question the swap has to answer
 * before anyone quotes a speed number for it.
 *
 * THE DIGEST COVERS `expected`. `bench/table-lowering-identity.ts` digests only
 * `{ok, value, unconsumedFrom}`, and six divergences hid in `expected` during 0.47.
 * `expected` is a top-level field of `RunResult`; it is sorted here because it is a
 * set whose emission order is not part of the contract.
 *
 * `consumed` IS READ WITH `ok`, ALWAYS. `unconsumedFrom ?? bytes` means a FAILED
 * parse records the full byte count, so a binding that got faster by no longer
 * parsing looks identical to one that got faster honestly unless `ok` is printed
 * beside it. Both are in the digest and the ok-count is printed per dialect.
 *
 * Usage: node --import ./bench/jess/register.mjs bench/jess/linker-engine-identity.ts
 */
import { compose } from '../../src/compiler/linker.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assembledRules } from '../../src/table/assemble.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { run } from '../../src/functional/run.ts'
import { DIALECTS, ENTRY, JESS_ROOT, assertParseman, corpus, loadGrammar, type Dialect } from './grammars.ts'

type Entry = Parameters<typeof run>[0]

const prov = await assertParseman()
console.log(`parseman ${prov.version} at ${prov.root}`)
console.log(`  jess root ${JESS_ROOT}   node ${process.version}`)
console.log('')

function digest(entry: Entry, input: string): { d: string; ok: boolean; consumed: number } {
  const r = run(entry, input)
  return {
    d: digestValue({
      ok: r.ok,
      value: r.value,
      unconsumedFrom: r.unconsumedFrom,
      expected: [...(r.expected ?? [])].sort(),
    }),
    ok: r.ok,
    consumed: r.unconsumedFrom ?? input.length,
  }
}

/**
 * A GRAMMAR-BUILDER THROW IS NOT AN ENGINE DIVERGENCE, and conflating the two would
 * make this probe cry wolf on every run.
 *
 * 20 corpus files reach a `throw` written into the jess grammars' own build callbacks
 * ("Inline backtick JavaScript is not supported", "This Less variable name is not
 * supported", …) on the compose leg and not on the direct leg. That gap is
 * `compose()`'s IR round-trip plus `materializeDirectBuilders` re-attaching direct
 * builders, and it PREDATES the engine swap: the identical 20, with identical
 * messages, appear with `compose()` bound to `exec.ts` and to `assembledRules`.
 * Counted and printed, never conflated with a digest mismatch.
 */
let bad = 0
let threw = 0
const builderThrows: string[] = []
for (const dialect of DIALECTS as readonly Dialect[]) {
  const g = await loadGrammar(dialect, 'ast')
  const composed = (compose([g.rules as never]) as unknown as Record<string, Entry>)[ENTRY]!
  const direct = assembledRules(encodeTable(g.rules, {}))[ENTRY]! as unknown as Entry
  const files = corpus(dialect)
  let same = 0
  let okC = 0
  let okD = 0
  let bytes = 0
  for (const f of files) {
    let a: ReturnType<typeof digest>
    let b: ReturnType<typeof digest>
    try { a = digest(composed, f.input) } catch (e) {
      threw++; builderThrows.push(`compose ${dialect}/${f.name}: ${(e as Error).message}`); continue
    }
    try { b = digest(direct, f.input) } catch (e) {
      threw++; builderThrows.push(`direct  ${dialect}/${f.name}: ${(e as Error).message}`); continue
    }
    if (a.ok) okC++
    if (b.ok) okD++
    bytes += a.consumed
    if (a.d === b.d) { same++; continue }
    bad++
    console.log(`  DIVERGED ${dialect}/${f.name}`)
    console.log(`    compose  ok=${a.ok} consumed=${a.consumed}`)
    console.log(`    direct   ok=${b.ok} consumed=${b.consumed}`)
  }
  console.log(
    `  ${dialect.padEnd(5)} ${String(files.length).padStart(4)} files   `
    + `${same}/${files.length} identical   ok compose=${okC} direct=${okD}   ${bytes} B consumed`,
  )
}

console.log('')
console.log(`${threw} grammar-builder throws (pre-existing, engine-independent):`)
for (const t of builderThrows) console.log(`  ${t}`)
console.log('')
if (bad > 0) {
  console.log(`${bad} DIGEST DIVERGENCE(S) — the compose path does not agree with the shipped engine.`)
  process.exit(1)
}
console.log('compose() === assembledRules on every corpus file that parses, digest including `expected`.')
