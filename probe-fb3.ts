import { transformMacro } from './src/plugin/index.ts'
const cases: Record<string,string> = {
  'build = imported fn ref': `
import { node, regex, rules, compose } from 'parseman' with { type: 'macro' }
import { mk } from './mk.js'
const factory = (g) => ({ Doc: node('Doc', regex(/a+/), mk) })
export const cstG = rules({ hostMode: 'cst' }, factory)
export const composed = compose([cstG])
`,
  'build = local named fn ref': `
import { node, regex, rules, compose } from 'parseman' with { type: 'macro' }
function mk(c){ return { c } }
const factory = (g) => ({ Doc: node('Doc', regex(/a+/), mk) })
export const cstG = rules({ hostMode: 'cst' }, factory)
export const composed = compose([cstG])
`,
  'scanSkip referencing a rule': `
import { node, regex, rules, compose, balanced } from 'parseman' with { type: 'macro' }
const factory = (g) => ({ Doc: node('Doc', regex(/a+/), (c)=>({c})), Skip: regex(/#[a-z]+/) })
export const cstG = rules({ hostMode: 'cst', scanSkip: [regex(/#[a-z]+/)] }, factory)
export const composed = compose([cstG])
`,
}
for (const [name, src] of Object.entries(cases)) {
  let full = false, transformed = false, hm = false
  try {
    const out = transformMacro(src.trim(), 'test.ts', new Set(['parseman']))
    if (out) { transformed = true; full = /ruleFns:/.test(out.code); hm = /hostMode:\s*["']cst["']/.test(out.code) && /ruleFns:/.test(out.code) }
  } catch (e) { console.log(`  THREW :: ${name} :: ${(e as Error).message.slice(0,70)}`); continue }
  console.log(`  transformed=${transformed} FULL_PIECES=${full} hostModeInPieces=${hm} :: ${name}`)
}
