/**
 * The pre-compiled assembly must be BYTE-IDENTICAL in outcome to the one the
 * runtime constructor built. Digests {ok, value, unconsumedFrom, expected} —
 * `expected` included, because six divergences hid outside it during 0.47.
 */
import { digestValue } from '../src/oracle/index.ts'
import { run } from '../src/functional/run.ts'
import { encodeTable } from '../src/table/encode.ts'
import { assembledRules, AssemblyCache } from '../src/table/assemble.ts'
import { defaultAssemblyCfgs } from '../src/table/emit.ts'
import { emitAssemblySource } from '../src/table/emit-assembly.ts'
import { resolveTable, type TableProgram, type PrecompiledAssembly } from '../src/table/program.ts'
import { EMITTED_PARAMS } from '../src/table/emit-assembly.ts'
import { jsonRules, jsonWs, baseNodes, fieldNodes, dispatchNodes, selectNodes, hostNodes, trailingTriviaNodes } from './table-grammars.ts'
import { cssRules } from '../examples/css/parser.ts'
import type { Combinator } from '../src/types.ts'

type Map_ = Record<string, Combinator<unknown>>

/** Build the `asm` array the EMITTER would print, using the same emitter. */
function precompile(prog: TableProgram): PrecompiledAssembly[] {
  const t = resolveTable(prog)
  const extraIps: number[] = []
  for (const s of prog.scans ?? []) {
    for (const r of s.skip) extraIps.push(r[0])
    if (s.sentinel !== undefined) extraIps.push(s.sentinel[0])
  }
  for (const set of prog.scanSkip ?? []) for (const r of set) extraIps.push(r[0])
  const out: PrecompiledAssembly[] = []
  for (const cfg of defaultAssemblyCfgs(prog)) {
    const em = emitAssemblySource(t, prog, cfg, extraIps)
    const key = (cfg.hostCst ? 1 : 0) | (cfg.trackLines ? 2 : 0) | (cfg.tolerant ? 4 : 0)
    // The harness compiles the SAME text the emitter prints. This stands in for
    // the module loader; the property under test is the plan/pool rebuild, not
    // how the function literal got made.
    const factory = new Function(...EMITTED_PARAMS, em.source) as PrecompiledAssembly['factory']
    out.push({ key, factory, plan: em.plan, reached: [...em.reached] })
  }
  return out
}

const CASES: Array<[string, Map_, string, string, Combinator<unknown> | undefined]> = [
  ['json', jsonRules as unknown as Map_, 'Value', '{"a":{"b":[1,-2.5,1e10,true,false,null,"x"]},"c":[],"d":"\\u00e9"}', jsonWs as Combinator<unknown>],
  ['json-bad', jsonRules as unknown as Map_, 'Value', '[1,2,]', jsonWs as Combinator<unknown>],
  ['json-bare', jsonRules as unknown as Map_, 'Value', 'nope', jsonWs as Combinator<unknown>],
  ['json-garbage', jsonRules as unknown as Map_, 'Value', '@@@', jsonWs as Combinator<unknown>],
  ['css', cssRules as unknown as Map_, 'Stylesheet', 'a,b .c>d{color:red;margin:0 auto}@media screen{x{y:z}}', undefined],
  ['css-bad', cssRules as unknown as Map_, 'Stylesheet', 'a { color: }} @@', undefined],
  ['baseNodes', baseNodes as unknown as Map_, 'Doc', 'aaa', undefined],
  ['fieldNodes', fieldNodes as unknown as Map_, 'Doc', 'aaa', undefined],
  ['dispatch', dispatchNodes as unknown as Map_, 'Doc', '@media', undefined],
  ['dispatch-o', dispatchNodes as unknown as Map_, 'Doc', '@-webkit', undefined],
  ['select', selectNodes as unknown as Map_, 'Doc', 'abc12x!y', undefined],
  ['host', hostNodes as unknown as Map_, 'Doc', 'aaa', undefined],
  ['trailing', trailingTriviaNodes as unknown as Map_, 'Root', 'aaa ', undefined],
]

let total = 0, matched = 0
const bad: string[] = []
for (const [name, map, entryRule, input, trivia] of CASES) {
  for (const tolerant of [false, true]) {
    const prog = encodeTable(map, {})
    const runtimeEntry = assembledRules(prog)[entryRule]!
    const pre: TableProgram = { ...prog, asm: precompile(prog) }
    const preEntry = assembledRules(pre)[entryRule]!

    // Prove WHICH engine each leg ran, before any number.
    const cfg = { hostCst: false, trackLines: false, tolerant, coverage: false, probe: false }
    const rtRefusal = new AssemblyCache(prog).for(cfg).emitRefusal
    const preRefusal = new AssemblyCache(pre).for(cfg).emitRefusal
    if (rtRefusal !== undefined || preRefusal !== undefined) {
      bad.push(`${name} tolerant=${tolerant}: ENGINE runtime=${rtRefusal ?? 'emitted'} pre=${preRefusal ?? 'emitted'}`)
    }

    const d = (e: unknown): string => {
      const r = run(e as never, input, { ...(trivia ? { trivia: trivia as never } : {}), tolerant })
      return digestValue({
        ok: r.ok, value: r.value, unconsumedFrom: r.unconsumedFrom,
        expected: r.ok ? undefined : [...(r.expected ?? [])].sort(),
        errors: r.ok ? (r.errors ?? []).length : undefined,
      })
    }
    total++
    const a = d(runtimeEntry), b = d(preEntry)
    if (a === b) matched++
    else bad.push(`${name} tolerant=${tolerant}: runtime ${a} != pre-compiled ${b}`)
  }
}
console.log(`pre-compiled vs runtime-constructed: ${matched}/${total} identical`)
for (const b of bad) console.log('  ' + b)
process.exit(bad.length === 0 ? 0 : 1)
