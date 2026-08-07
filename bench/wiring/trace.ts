/**
 * V8 EVIDENCE for one (workload × wiring), deterministic and slot-free.
 *
 * Run it under the flags you want the answer from, e.g.
 *
 *   node --stack-size=4000 --trace-turbo-inlining --import tsx/esm \
 *     bench/wiring/trace.ts json w0-direct
 *
 * It builds the parser under the requested wiring through the shipped path and
 * parses until TurboFan has had every chance to act, then exits. Everything of
 * interest is on V8's own trace, not on this file's stdout — which is why the
 * only thing printed here is the provenance a reader needs to trust the trace.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { PARSEMAN_VERSION } from '../../src/version.ts'
import { lastEmittedBytes } from '../../src/table/assemble.ts'
import { subjects, defaultCfg } from './subjects.ts'
import { setWiring } from '../../src/table/assemble.ts'
import { rewire, WIRING_MODES, type WiringMode } from './rewire.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function main(): void {
  const [which = 'json', modeArg = 'w0-direct', repsArg = '400'] = process.argv.slice(2)
  const mode = modeArg as WiringMode
  if (!WIRING_MODES.includes(mode)) { console.error(`unknown wiring ${modeArg}`); process.exit(1) }
  const s = subjects().find(x => x.id.includes(which))
  if (s === undefined) { console.error(`unknown workload ${which}`); process.exit(1) }

  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  console.error(`### parseman ${PARSEMAN_VERSION} sha ${sha} node ${process.version}`)
  console.error(`### workload ${s.id} (${s.bytes} B)  wiring ${mode}  reps ${repsArg}`)

  setWiring(mode === 'w0-direct' ? undefined : rewire(mode))
  let parse: () => unknown
  try {
    parse = s.make(defaultCfg(s.id)).parse
    parse()
  } finally {
    setWiring(undefined)
  }
  console.error(`### emitted ${lastEmittedBytes()} B`)
  console.error('### ---- TRACE BEGINS ----')
  const reps = Number(repsArg)
  for (let i = 0; i < reps; i++) parse()
  console.error('### ---- TRACE ENDS ----')
}

main()
