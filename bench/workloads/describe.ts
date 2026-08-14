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

// Marks the file a module. Its only import is dynamic, so without this it has no
// static import or export and top-level `await` is not legal in it.
export {}

const { buildWorkloads } = await import('./index.ts')
const { assertWorkloadFullyConsumed } = await import('./consumption.ts')

type Consumed = { ok?: boolean; span?: { start: number; end: number } }

const workloads = buildWorkloads()
let invalid = false

console.log('workload                bytes    parsed        to EOF   nodes')
for (const w of workloads) {
  const built = w.make()
  const r = built.parse() as Consumed
  const end = r?.span?.end ?? 0
  const nodes = countNodes(r)
  let eof = 'yes'
  try {
    assertWorkloadFullyConsumed('describe', w.id, w.input, r)
  } catch {
    invalid = true
    eof = `NO (${end}/${w.input.length})`
  }
  console.log(
    `${w.id.padEnd(20)} ${String(w.bytes).padStart(8)}`
    + `   ${(r?.ok === true ? 'ok' : 'FAILED').padEnd(8)}`
    + `   ${eof.padEnd(18)} ${nodes}`,
  )
}

if (invalid) process.exitCode = 1

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
