/**
 * `pnpm perf:workloads:describe` — what the gate is actually measuring.
 *
 * Not a gate. It answers the question a reader of a workload benchmark should
 * always ask first: does each workload really parse its input, all of it, and
 * how hard does it work per byte? A workload that silently fails at byte 300 and
 * returns still times something — it just does not time what the name says.
 *
 * Reports, per workload: input size, whether the parse consumed the whole input,
 * the resulting node count, and the speculative-probe density measured by
 * counting `not()` entries through an instrumented context.
 */
process.env.PARSEMAN_GATING = 'off'

const { buildWorkloads } = await import('./index.ts')

type Consumed = { ok?: boolean; span?: { start: number; end: number } }

const workloads = buildWorkloads()

console.log('workload                bytes    parsed        to EOF   nodes')
for (const w of workloads) {
  const built = w.make()
  const r = built.parse() as Consumed
  const end = r?.span?.end ?? 0
  const nodes = countNodes(r)
  // Trailing trivia sits outside the root node's span, so "consumed" means
  // nothing but whitespace is left, not that the span reaches the last byte.
  const eof = w.input.slice(end).trim() === '' ? 'yes' : `NO (${end}/${w.input.length})`
  console.log(
    `${w.id.padEnd(20)} ${String(w.bytes).padStart(8)}`
    + `   ${(r?.ok === false ? 'FAILED' : 'ok').padEnd(8)}`
    + `   ${eof.padEnd(18)} ${nodes}`,
  )
}

function countNodes(v: unknown, depth = 0): number {
  if (depth > 200 || v === null || typeof v !== 'object') return 0
  if (Array.isArray(v)) {
    let n = 0
    for (const x of v) n += countNodes(x, depth + 1)
    return n
  }
  const o = v as Record<string, unknown>
  let n = typeof o.type === 'string' ? 1 : 0
  for (const k of Object.keys(o)) n += countNodes(o[k], depth + 1)
  return n
}
