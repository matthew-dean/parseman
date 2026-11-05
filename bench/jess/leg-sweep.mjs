/**
 * The same inputs through two built legs, compared whole: value, spans, errors and
 * expected sets, under strict and recovery parsing. A leg is a directory of runnable
 * artifacts from `bench/jess/build-leg.mts`; inputs come from `sweep-inputs.mjs`.
 *
 *   node bench/jess/leg-sweep.mjs <inputs.json> <dialect>-<variant> <legA> <legB> [--tolerant] [--examples=N] [--out=diffs.jsonl] [--leaves]
 *
 * `--leaves` compares a CST by its leaves and the trivia its kept nodes logged, rather than its
 * node shape, for two grammars that are meant to differ in which wrappers they keep. A CST from
 * `cstBuildHost` does not carry trivia, so this mode's host keeps each node's `triviaLog`. It
 * also counts node types.
 *
 * `--timeout=<ms>` stops one parse and records it as a throw. Less recovery on a CST takes
 * minutes on some inputs, on `main` too; a timeout on one side only is noise to recheck.
 *
 * Each leg's parses are tallied as full, partial (`ok` with bytes left over), failed or
 * threw. A partial parse compares where it stopped and what it built, never what the bytes
 * after that would have done, so `same` covers no more of an input than its parse reached.
 * Inputs where both legs throw have no parse to compare: they count as `bothThrow`, or as
 * `diff` if the messages differ, and never as `same`.
 */
import { appendFileSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runInThisContext } from 'node:vm'

const flags = process.argv.slice(2).filter(a => a.startsWith('--'))
const [file, art, a, b] = process.argv.slice(2).filter(a => !a.startsWith('--'))
if (!b) throw new Error('usage: leg-sweep.mjs <inputs.json> <dialect>-<variant> <legA> <legB> [--tolerant] [--examples=N] [--out=diffs.jsonl]')
const tolerant = flags.includes('--tolerant')
const flag = name => flags.find(f => f.startsWith(`--${name}=`))?.slice(name.length + 3)
const examples = +(flag('examples') ?? 8)
const timeout = +(flag('timeout') ?? 0)
const out = flag('out')
if (out) rmSync(out, { force: true })

const load = async leg => await import(realpathSync(join(resolve(leg), `${art}.mjs`)))
const A = await load(a)
const B = await load(b)
const inputs = JSON.parse(readFileSync(file, 'utf8'))
const cst = art.includes('cst')

const leavesOnly = flags.includes('--leaves')
const typeDelta = {}
const leaves = (n, out = []) => {
  if (n === null || typeof n !== 'object') return out
  if (Array.isArray(n)) { for (const c of n) leaves(c, out); return out }
  if (n._tag === 'leaf') { out.push([n.value, n.span?.start, n.span?.end]); return out }
  for (const c of n.children ?? []) leaves(c, out)
  return out
}
// The trivia every kept node logged, in source order. A wrapper a grammar drops takes its
// ownership with it, so this compares which runs were kept and never which node holds one.
const triviaLogs = (n, out = []) => {
  if (n === null || typeof n !== 'object') return out
  if (Array.isArray(n)) { for (const c of n) triviaLogs(c, out); return out }
  if (n._tag !== 'node') return out
  const log = n.triviaLog ?? []
  for (let i = 0; i + 3 < log.length; i += 4) out.push([log[i], log[i + 1], log[i + 3]])
  for (const c of n.children ?? []) triviaLogs(c, out)
  return out
}
const logging = m => Object.assign((type, children, fields, span, raw, log, state, tags) => {
  const nd = m.cstBuildHost(type, children, fields, span, raw, log, state, tags)
  if (log?.length > 0) nd.triviaLog = [...log]
  return nd
}, { _parsemanCstOutput: true })
const nodeTypes = (n, sign) => {
  if (n === null || typeof n !== 'object') return
  if (Array.isArray(n)) { for (const c of n) nodeTypes(c, sign); return }
  if (n._tag !== 'node') return
  typeDelta[n.type] = (typeDelta[n.type] ?? 0) + sign
  for (const c of n.children ?? []) nodeTypes(c, sign)
}

const tally = () => ({ full: 0, partial: 0, failed: 0, threw: 0, corpusFull: 0, corpusPartial: 0 })
const parses = { a: tally(), b: tally() }
const count = (t, kind, v) => {
  const end = v.threw !== undefined ? 'threw' : !v.ok ? 'failed' : v.unconsumedFrom === null ? 'full' : 'partial'
  t[end]++
  if (kind.startsWith('corpus:') && end === 'full') t.corpusFull++
  if (kind.startsWith('corpus:') && end === 'partial') t.corpusPartial++
}

const go = (m, input, sign) => {
  const opts = { ...(tolerant ? { tolerant: true } : {}), ...(cst ? { build: leavesOnly ? logging(m) : m.cstBuildHost } : {}) }
  try {
    const parse = () => m.run(m.grammar.Stylesheet, input, opts)
    globalThis.sweepParse = parse
    const r = timeout ? runInThisContext('sweepParse()', { timeout }) : parse()
    if (leavesOnly) nodeTypes(r.value, sign)
    return {
      ok: r.ok,
      digest: leavesOnly
        ? m.digestValue({ ok: r.ok, span: r.span, errors: r.errors, expected: r.expected, unconsumedFrom: r.unconsumedFrom, leaves: leaves(r.value), trivia: triviaLogs(r.value).sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]) })
        : m.digestValue(r),
      expected: r.expected,
      errors: r.errors?.length ?? 0,
      unconsumedFrom: r.unconsumedFrom ?? null,
    }
  } catch (e) {
    return { threw: String(e.message).split('\n')[0] }
  }
}

const counts = { inputs: inputs.length, same: 0, diff: 0, okFlip: 0, newThrow: 0, goneThrow: 0, bothThrow: 0, fewerExpected: 0, moreExpected: 0 }
const kinds = {}
const shown = []
for (const [kind, input] of inputs) {
  const x = go(A, input, -1)
  const y = go(B, input, 1)
  count(parses.a, kind, x)
  count(parses.b, kind, y)
  if (x.threw !== undefined && y.threw !== undefined) {
    counts.bothThrow++
    if (x.threw === y.threw) continue
  } else if (x.threw === y.threw && x.digest === y.digest) { counts.same++; continue }
  counts.diff++
  const k = kind.split(':')[0]
  kinds[k] = (kinds[k] ?? 0) + 1
  if (x.threw === undefined && y.threw !== undefined) counts.newThrow++
  else if (x.threw !== undefined && y.threw === undefined) counts.goneThrow++
  else if (x.ok !== y.ok) counts.okFlip++
  if (x.expected && y.expected) {
    const X = new Set(x.expected), Y = new Set(y.expected)
    if ([...X].some(e => !Y.has(e))) counts.fewerExpected++
    if ([...Y].some(e => !X.has(e))) counts.moreExpected++
  }
  const row = { kind, input: input.slice(0, 200), a: x, b: y }
  if (out) appendFileSync(out, JSON.stringify(row) + '\n')
  if (shown.length < examples) shown.push(row)
}
console.log(JSON.stringify({ art, tolerant, ...counts, kinds, parses }))
if (leavesOnly) console.log('  node types, B minus A:', JSON.stringify(Object.fromEntries(Object.entries(typeDelta).filter(([, v]) => v !== 0).sort((p, q) => p[1] - q[1]))))
for (const r of shown) {
  const fmt = v => v.threw !== undefined ? `THROW ${v.threw.slice(0, 60)}` : `${v.ok ? 'ok' : 'no'} err=${v.errors} un=${v.unconsumedFrom} exp=${v.expected.length}`
  console.log(`  ${JSON.stringify(r.input.slice(0, 70))} [${r.kind.slice(0, 30)}] ${fmt(r.a)} | ${fmt(r.b)}`)
}
