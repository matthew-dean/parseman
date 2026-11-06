#!/usr/bin/env node
/**
 * TWO OR MORE BUILT PARSERS ON ONE FILE: calls per parse, the tree, and marginal
 * instructions per parse.
 *
 *   node bench/jess/ab-built.mjs [--reps 5] [--n1 20] [--n2 120] [--out rows.jsonl] \
 *     <file> <name=module>...
 *
 * A module is anything built that exports `parse(text)`, and it throws if the file
 * doesn't parse in full. In a Jess checkout that's
 * `packages/syntax/less/less-parser/lib/index.js`. Each leg resolves its own
 * `parseman`, so the legs can be two checkouts, or one checkout built twice. The first
 * leg is the base. Name one build twice for an A/A. Each leg's module and the `parseman`
 * it resolves are printed first, by `realpath`, so a symlink can't mislabel a leg.
 *
 * `bench/jess/ab.ts` compares Parseman releases on one copy of the grammars. This
 * compares what a real bundler build shipped, which is what a macro option like
 * `assemblyProfile` changes.
 *
 * Instructions come from `/usr/bin/time -l` (macOS), with default Node settings: the
 * difference between `n1` and `n2` parses, so warm-up cancels, legs rotated, median of
 * `reps`. Calls come from precise coverage in a process of their own, so they never
 * slow a counted run, and only the last of three parses is counted. Exits 1 if a
 * parse throws or the legs build different trees.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { Session } from 'node:inspector'
import { createRequire } from 'node:module'
import { loadavg } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const MODE = process.env.AB_BUILT_MODE
if (MODE !== undefined) {
  const [module, count, file] = process.argv.slice(2)
  const text = readFileSync(file, 'utf8')
  if (MODE === 'calls') {
    const session = new Session()
    session.connect()
    const post = (method, params) => {
      let result
      session.post(method, params, (error, value) => { if (error) throw error; result = value })
      return result
    }
    post('Profiler.enable')
    post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
    const { parse } = await import(pathToFileURL(module).href)
    parse(text)
    parse(text)
    post('Profiler.takePreciseCoverage')
    parse(text)
    const scripts = post('Profiler.takePreciseCoverage').result.filter(script => !script.url.startsWith('node:'))
    console.log(scripts.flatMap(script => script.functions).reduce((sum, fn) => sum + fn.ranges[0].count, 0))
  } else {
    const { parse } = await import(pathToFileURL(module).href)
    const first = parse(text)
    if (MODE === 'digest') {
      const { digestValue } = await import(pathToFileURL(createRequire(module).resolve('parseman/oracle')).href)
      console.log(digestValue(first))
    }
    for (let i = 0; i < Number(count); i++) parse(text)
  }
  process.exit(0)
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { reps: { type: 'string', default: '5' }, n1: { type: 'string', default: '20' }, n2: { type: 'string', default: '120' }, out: { type: 'string' } },
})
const [file, ...legArgs] = positionals
const legs = legArgs.map(leg => { const at = leg.indexOf('='); return { name: leg.slice(0, at), module: resolve(leg.slice(at + 1)) } })
const reps = Number(values.reps)
const n1 = Number(values.n1)
const n2 = Number(values.n2)
const namesOk = legs.length >= 2 && legArgs.every(leg => leg.includes('=')) && new Set(legs.map(leg => leg.name)).size === legs.length
if (file === undefined || !namesOk || !Number.isInteger(reps) || reps < 0 || !Number.isInteger(n1) || !Number.isInteger(n2) || n1 < 0 || n2 <= n1) {
  console.error('usage: ab-built.mjs [--reps 5] [--n1 20] [--n2 120] [--out rows.jsonl] <file> <name=module>...\n  at least two legs with different names, reps a whole number, and n2 above n1')
  process.exit(2)
}

const script = import.meta.filename
const inChild = (mode, leg, count) => {
  const run = spawnSync(process.execPath, [script, leg.module, String(count), file], { encoding: 'utf8', env: { ...process.env, AB_BUILT_MODE: mode } })
  if (run.status !== 0) {
    console.error(`${leg.name} on ${file}: ${run.stderr.slice(-800)}`)
    process.exit(1)
  }
  // The last line, since a parser can print too.
  return run.stdout.trim().split('\n').at(-1)
}
const counted = (leg, count) => {
  const run = spawnSync('/usr/bin/time', ['-l', process.execPath, script, leg.module, String(count), file], { encoding: 'utf8', env: { ...process.env, AB_BUILT_MODE: 'run' } })
  const instructions = /(\d+)\s+instructions retired/.exec(run.stderr)
  const cycles = /(\d+)\s+cycles elapsed/.exec(run.stderr)
  if (run.status !== 0 || instructions === null || cycles === null) {
    console.error(`${leg.name} on ${file}: ${run.stderr.slice(-800)}`)
    process.exit(1)
  }
  return [Number(instructions[1]), Number(cycles[1])]
}
const median = list => {
  const sorted = [...list].sort((a, b) => a - b)
  return sorted.length % 2 === 1 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
}

for (const leg of legs) {
  let engine = 'none resolved'
  try {
    const parseman = realpathSync(createRequire(leg.module).resolve('parseman'))
    engine = parseman
  } catch { /* a leg that doesn't resolve it fails below */ }
  console.log(`${leg.name}: built parser ${realpathSync(leg.module)}  closure engine parseman at ${engine}`)
}
for (const leg of legs) {
  leg.calls = Number(inChild('calls', leg, 0))
  leg.digest = inChild('digest', leg, 0)
  leg.instructions = []
  leg.cycles = []
}
for (let rep = 0; rep < reps; rep++) {
  for (const leg of [...legs.slice(rep % legs.length), ...legs.slice(0, rep % legs.length)]) {
    const low = counted(leg, n1)
    const high = counted(leg, n2)
    leg.instructions.push((high[0] - low[0]) / (n2 - n1))
    leg.cycles.push((high[1] - low[1]) / (n2 - n1))
  }
}

const percent = (value, base) => `${value >= base ? '+' : ''}${(100 * (value - base) / base).toFixed(2)}%`
const [base] = legs
const sameTree = new Set(legs.map(leg => leg.digest)).size === 1
const load = loadavg()[0]
console.log(`${file}  tree ${sameTree ? 'same' : 'DIFFERS'}  load ${load.toFixed(0)}  reps ${reps}`)
for (const leg of legs) {
  const line = [`  ${leg.name.padEnd(12)}`, `calls ${leg.calls} ${percent(leg.calls, base.calls)}`]
  if (reps > 0) line.push(`instructions ${(median(leg.instructions) / 1e6).toFixed(1)}M ${percent(median(leg.instructions), median(base.instructions))}`, `cycles ${percent(median(leg.cycles), median(base.cycles))}`)
  console.log(line.join('  '))
}
if (values.out !== undefined) {
  const row = { file, reps, n1, n2, load, legs: Object.fromEntries(legs.map(leg => [leg.name, { calls: leg.calls, digest: leg.digest, instructions: reps > 0 ? median(leg.instructions) : null, cycles: reps > 0 ? median(leg.cycles) : null }])) }
  appendFileSync(values.out, `${JSON.stringify(row)}\n`)
}
process.exit(sameTree ? 0 : 1)
