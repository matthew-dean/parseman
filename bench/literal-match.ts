/**
 * Literal matching A/B for interpreter `literal()`.
 *
 * Compares the obvious match probes before changing production code:
 *   - slice(pos, end) === value
 *   - startsWith(value, pos)
 *   - charCodeAt chain
 *
 * Run: pnpm bench:literal
 */
import { measureMedianUs } from './parseman-perf.ts'

type Case = {
  name: string
  value: string
  hits: string[]
  misses: string[]
  pos: number
  iterations: number
}

const cases: Case[] = [
  { name: '1-char', value: '{', hits: ['xx{yyyy', 'aa{bbbb', 'zz{qqqq'], misses: ['xx[yyyy', 'aa]bbbb', 'zz-qqqq'], pos: 2, iterations: 2_000_000 },
  { name: '2-char', value: '=>', hits: ['xx=>yyyy', 'aa=>bbbb', 'zz=>qqqq'], misses: ['xx=<yyyy', 'aa=<bbbb', 'zz=<qqqq'], pos: 2, iterations: 2_000_000 },
  { name: '5-char', value: 'hello', hits: ['xxhelloyyyy', 'aahellobbbb', 'zzhelloqqqq'], misses: ['xxhulloyyyy', 'aahellXbbbb', 'zzxelloqqqq'], pos: 2, iterations: 1_000_000 },
  { name: '9-char', value: 'important', hits: ['xximportantyyyy', 'aaimportantbbbb', 'zzimportantqqqq'], misses: ['xximporxantyyyy', 'aaimportantXbbb', 'zzxmportantqqqq'], pos: 2, iterations: 500_000 },
  { name: '17-char', value: 'abcdefghijklmnopq', hits: ['xxabcdefghijklmnopqyy', 'aaabcdefghijklmnopqbb', 'zzabcdefghijklmnopqqq'], misses: ['xxabcdefghXjklmnopqyy', 'aaabcdefghijklmnopXbb', 'zzXbcdefghijklmnopqqq'], pos: 2, iterations: 300_000 },
]

function sliceEq(input: string, pos: number, value: string): boolean {
  return input.slice(pos, pos + value.length) === value
}

function startsWithAt(input: string, pos: number, value: string): boolean {
  return input.startsWith(value, pos)
}

function charCodeEq(input: string, pos: number, value: string): boolean {
  if (pos + value.length > input.length) return false
  for (let i = 0; i < value.length; i++) {
    if (input.charCodeAt(pos + i) !== value.charCodeAt(i)) return false
  }
  return true
}

function measure(label: string, inputs: string[], pos: number, value: string, fn: (input: string, pos: number, value: string) => boolean, iterations: number): string {
  let i = 0
  let keep = false
  const us = measureMedianUs(() => {
    const input = inputs[i++ % inputs.length]!
    keep = fn(input, pos, value)
  }, iterations, { samples: 11 })
  if (keep) process.stdout.write('')
  return `${label} ${us.toFixed(4).padStart(8)}µs`
}

console.log('\n=== Literal match A/B — hit ===')
for (const c of cases) {
  console.log(
    `  ${c.name.padEnd(8)} ` +
    `${measure('slice', c.hits, c.pos, c.value, sliceEq, c.iterations)}  ` +
    `${measure('startsWith', c.hits, c.pos, c.value, startsWithAt, c.iterations)}  ` +
    `${measure('charCode', c.hits, c.pos, c.value, charCodeEq, c.iterations)}`,
  )
}

console.log('\n=== Literal match A/B — miss ===')
for (const c of cases) {
  console.log(
    `  ${c.name.padEnd(8)} ` +
    `${measure('slice', c.misses, c.pos, c.value, sliceEq, c.iterations)}  ` +
    `${measure('startsWith', c.misses, c.pos, c.value, startsWithAt, c.iterations)}  ` +
    `${measure('charCode', c.misses, c.pos, c.value, charCodeEq, c.iterations)}`,
  )
}
