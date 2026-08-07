/** Render the shape census as a table. Deterministic; no timing. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lines = readFileSync(path.join(root, 'notes/results/mixture-shape.jsonl'), 'utf8').trim().split('\n')

const pad = (s, n) => String(s).padEnd(n)
const lpad = (s, n) => String(s).padStart(n)
console.log([pad('dialect', 8), pad('var', 5), lpad('emitKB', 8), lpad('sites', 7), lpad('words', 7), lpad('capON', 6), lpad('capOFF', 7), lpad('capDYN', 7), lpad('ON%', 6), lpad('!OFF%', 7)].join(' '))
for (const l of lines) {
  const o = JSON.parse(l)
  if (o.error) { console.log(pad(o.dialect, 8), pad(o.variant, 5), '  ERROR'); continue }
  const c = o.cap
  console.log([
    pad(o.dialect, 8), pad(o.variant, 5),
    lpad((o.emittedBytes / 1024).toFixed(0), 8),
    lpad(o.censusSites, 7), lpad(o.codeWords, 7),
    lpad(c.on, 6), lpad(c.off, 7), lpad(c.dynamic, 7),
    lpad(c.onPct.toFixed(1), 6),
    lpad((100 - (c.off / o.censusSites) * 100).toFixed(1), 7),
  ].join(' '))
}

// Opcode census, summed over the four AST grammars — the sweep's denominator.
const agg = new Map()
let totalSites = 0
for (const l of lines) {
  const o = JSON.parse(l)
  if (o.error || o.variant !== 'ast') continue
  totalSites += o.censusSites
  for (const [k, v] of Object.entries(o.opcodes)) agg.set(k, (agg.get(k) ?? 0) + v)
}
console.log('\nOPCODE CENSUS over the four AST grammars (' + totalSites + ' reachable sites)')
console.log([pad('opcode', 12), lpad('sites', 7), lpad('share%', 8), lpad('cum%', 7)].join(' '))
let cum = 0
for (const [k, v] of [...agg.entries()].sort((a, b) => b[1] - a[1])) {
  cum += v
  console.log([pad(k, 12), lpad(v, 7), lpad(((v / totalSites) * 100).toFixed(1), 8), lpad(((cum / totalSites) * 100).toFixed(1), 7)].join(' '))
}
