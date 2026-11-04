/**
 * One side's counts, in a process of its own: `bench/call-count-guard.ts` runs this
 * once per side and engine. It loads an INSTRUMENTED bundle (see `instrument.ts`) and
 * reports, per case, the function calls and branch tests one parse executes.
 *
 * Every `new Function` body is instrumented before it is compiled, so the emitted
 * engine is counted too. `engine: 'closure'` makes the `Function` constructor throw
 * `EvalError`, the refusal a Content-Security-Policy gives, so the same grammar runs
 * on the closure assembler — the path a CSP user ships.
 *
 * Each case is parsed until two parses in a row count the same, so pieces built
 * lazily over the first parses are not charged to every parse. The parse must
 * succeed and consume its input: a count over a failed parse measures how early it
 * failed.
 */
import { readFileSync } from 'node:fs'
import { COUNTER, instrumentFunctionBody } from './instrument.ts'

export type WorkerArgs =
  | { kind: 'workloads'; module: string; engine: 'emitted' | 'closure' }
  | { kind: 'jess'; module: string; cases: Array<{ id: string; input: string; cst: boolean }> }

export type Counts = { calls: number; branches: number }

const args = JSON.parse(process.argv[2]!) as WorkerArgs
const k = { c: 0, b: 0 }
;(globalThis as Record<string, unknown>)[COUNTER] = k

const RealFunction = Function
const refuse = args.kind === 'workloads' && args.engine === 'closure'
const make = (fnArgs: unknown[]): unknown => {
  if (refuse) throw new EvalError('code generation from strings disallowed (call-count closure leg)')
  const body = fnArgs.length === 0 ? '' : String(fnArgs[fnArgs.length - 1])
  return Reflect.construct(RealFunction, [...fnArgs.slice(0, -1).map(String), instrumentFunctionBody(body)])
}
globalThis.Function = new Proxy(RealFunction, {
  construct: (_t, fnArgs: unknown[]) => make(fnArgs) as object,
  apply: (_t, _self, fnArgs: unknown[]) => make(fnArgs),
}) as FunctionConstructor

type Case = { id: string; parse: () => unknown }
const cases: Case[] = []
const mod = await import(args.module) as Record<string, unknown>

if (args.kind === 'workloads') {
  const buildWorkloads = mod['buildWorkloads'] as () => Array<{ id: string; make: () => { parse: () => unknown } }>
  for (const w of buildWorkloads()) {
    const built = w.make()
    cases.push({ id: w.id, parse: built.parse })
  }
} else {
  type Run = (entry: unknown, input: string, opts: object) => { ok: boolean; unconsumedFrom: number | null }
  const run = mod['run'] as Run
  const entry = (mod['grammar'] as Record<string, unknown>)['Stylesheet']
  for (const c of args.cases) {
    const input = readFileSync(c.input, 'utf8')
    const opts = c.cst ? { build: mod['cstBuildHost'] } : {}
    cases.push({ id: c.id, parse: () => run(entry, input, opts) })
  }
}

function accepted(id: string, result: unknown): void {
  if (result === null || typeof result !== 'object') return
  const r = result as { ok?: unknown; unconsumedFrom?: unknown }
  if (r.ok === false) throw new Error(`${id}: the parse failed, so its count would measure where it stopped`)
  if (typeof r.unconsumedFrom === 'number') throw new Error(`${id}: the parse stopped at byte ${r.unconsumedFrom}`)
}

const SETTLE_LIMIT = 20
const out: Record<string, Counts> = {}
for (const c of cases) {
  accepted(c.id, c.parse())
  const counted = (): Counts => {
    k.c = 0
    k.b = 0
    c.parse()
    return { calls: k.c, branches: k.b }
  }
  // Some pieces are built or specialised over the first few parses, not only the
  // first. Count until two parses in a row agree: that is the per-parse cost a
  // long-lived parser pays. A count that never settles is reported, not averaged.
  let prev = counted()
  let next = counted()
  for (let n = 2; prev.calls !== next.calls || prev.branches !== next.branches; n++) {
    if (n >= SETTLE_LIMIT) {
      throw new Error(`${c.id}: ${SETTLE_LIMIT} parses of the same input never counted the same twice in a row (last ${JSON.stringify(prev)}, ${JSON.stringify(next)})`)
    }
    prev = next
    next = counted()
  }
  out[c.id] = next
}
console.log(JSON.stringify(out))
