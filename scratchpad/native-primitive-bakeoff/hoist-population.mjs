/**
 * Is hoisting even AVAILABLE? The 2.1-2.4x micro assumed a field read several
 * times with nothing invalidating the local in between.
 *
 * In the real artifact those fields are also WRITTEN (306 sites), and rule
 * functions call other rule functions that mutate the SAME context object. A
 * hoisted local goes stale across any such call, so hoisting is only sound in a
 * straight-line region containing no call and no write to that field.
 *
 * This measures that population directly: split each emitted function body at
 * every call site, and inside each resulting call-free region count how often a
 * single `_ctx.<field>` is read more than once.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'artifact-base-css-stylesheet.js'), 'utf8')

// Anything that can run user/emitted code and thus mutate _ctx.
const CALL = /\b(_r_[A-Za-z0-9_]+|_pf[A-Za-z0-9_]*|_build\[[0-9]+\]|_map\.[A-Za-z0-9_]+)\s*\(/

const lines = src.split('\n')
let region = []
const regions = []
for (const ln of lines) {
  region.push(ln)
  if (CALL.test(ln) || /^\s*(function|\})/.test(ln)) { regions.push(region); region = [] }
}
if (region.length) regions.push(region)

let totalReads = 0
let redundant = 0 // reads beyond the first of the same field in a call-free region
const perField = new Map()
for (const r of regions) {
  const text = r.join('\n')
  const counts = new Map()
  for (const m of text.matchAll(/_ctx\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
  }
  for (const [f, n] of counts) {
    totalReads += n
    if (n > 1) {
      redundant += n - 1
      perField.set(f, (perField.get(f) ?? 0) + (n - 1))
    }
  }
}

console.log(`emitted call-free regions:            ${regions.length}`)
console.log(`total _ctx reads:                     ${totalReads}`)
console.log(`REDUNDANT reads hoisting could remove: ${redundant}  (${(100 * redundant / totalReads).toFixed(1)}% of reads)`)
console.log(`\nby field:`)
for (const [f, n] of [...perField].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  _ctx.${f.padEnd(20)} ${n}`)
}
