/**
 * Rewrites a built jess grammar artifact so every character-level operation is
 * counted and its input position recorded.
 *
 * The rewrite is textual and total: every `input.charCodeAt(`, `input.codePointAt(`,
 * `input.slice(`, `_reN.exec(input)` and `_dkeyN.charCodeAt(` in the artifact goes
 * through a counter. Counts are exact, not sampled.
 *
 * Usage: node instrument.mjs <src grammar.js> <dest grammar.js>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [src, dest] = process.argv.slice(2)
let s = readFileSync(src, 'utf8')

const counts = {}
const sub = (name, re, to) => {
  let n = 0
  s = s.replace(re, (...a) => { n++; return typeof to === 'function' ? to(...a) : to })
  counts[name] = n
}

// `(?<![\w$])` is load-bearing: the artifact namespaces some identifiers with a
// hash prefix (`_8404fabf__re0`), so an unanchored `_re\d+` matches the TAIL of a
// longer name and the rewrite emits `_8404fabf___EX(...)`.
sub('charCodeAt', /(?<![\w$])input\.charCodeAt\(/g, '__CC(input,')
sub('codePointAt', /(?<![\w$])input\.codePointAt\(/g, '__CP(input,')
sub('slice', /(?<![\w$])input\.slice\(/g, '__SL(input,')
sub('exec', /(?<![\w$])([\w$]+)\.exec\(input\)/g, (_m, re) => `__EX(${re},input)`)
sub('dkey', /(?<![\w$])([\w$]*_dkey\d+)\.charCodeAt\(/g, (_m, k) => `__DK(${k},`)

// Regex TERMINALS are declared as function-scoped literals, so every call of the
// owning rule constructs fresh RegExp objects. A derived scanner replaces those
// terminals outright, so the allocation is work the cursor absorbs too — count it.
sub('reLiteral', /(?<![\w$])(const [\w$]*_re\d+ = )(\/(?:[^/\\\n\[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*)/g,
  (_m, decl, lit) => `${decl}__RA(${lit})`)

// Nothing char-level may survive un-instrumented, or the census undercounts.
for (const [what, re] of [
  ['charCodeAt', /\.charCodeAt\(/g],
  ['codePointAt', /\.codePointAt\(/g],
  ['exec', /\.exec\(/g],
  ['slice on input', /(?<![\w$])input\.slice\(/g],
]) {
  const left = s.match(re)
  if (left) console.log(`  RESIDUAL ${what}: ${left.length}`)
}

const preamble = `import { __CC, __CP, __SL, __EX, __DK, __RA } from './counters.mjs'\n`
s = preamble + s
writeFileSync(dest, s)
console.log(JSON.stringify(counts))
