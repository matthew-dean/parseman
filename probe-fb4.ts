import { transformMacro } from './src/plugin/index.ts'
const cases: Record<string,string> = {
  'scanSkip = ref into ANOTHER grammar (targets ir-serialize.ts:242)': `
import { node, regex, rules, compose } from 'parseman' with { type: 'macro' }
const helper = rules((h) => ({ Skip: regex(/#[a-z]+/) }))
const factory = (g) => ({ Doc: node('Doc', regex(/a+/), (c)=>({c})) })
export const cstG = rules({ hostMode: 'cst', scanSkip: [helper.Skip] }, factory)
export const composed = compose([cstG])
`,
  'scanSkip = self-referential lazy via g': `
import { node, regex, rules, compose, lazy } from 'parseman' with { type: 'macro' }
const factory = (g) => ({ Doc: node('Doc', regex(/a+/), (c)=>({c})), Skip: regex(/#[a-z]+/) })
const g0 = rules(factory)
export const cstG = rules({ hostMode: 'cst', scanSkip: [g0.Skip] }, factory)
export const composed = compose([cstG])
`,
}
for (const [name, src] of Object.entries(cases)) {
  try {
    const out = transformMacro(src.trim(), 'test.ts', new Set(['parseman']))
    const c = out?.code ?? ''
    console.log(`  transformed=${!!out} FULL_PIECES=${/ruleFns:/.test(c)} hostModeInPieces=${/ruleFns:/.test(c) && /hostMode:\s*["']cst["']/.test(c)} :: ${name}`)
  } catch (e) { console.log(`  THREW :: ${name} :: ${(e as Error).message.slice(0,90)}`) }
}
