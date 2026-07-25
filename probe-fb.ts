import { transformMacro } from './src/plugin/index.ts'
const cases: Record<string,string> = {
  'plain node+build': `
import { node, regex, rules, compose } from 'parseman' with { type: 'macro' }
const factory = (g) => ({ Doc: node('Doc', regex(/a+/), (c) => ({ c })) })
export const cstG = rules({ hostMode: 'cst' }, factory)
export const composed = compose([cstG])
`,
  'withCtx': `
import { node, regex, rules, compose, withCtx } from 'parseman' with { type: 'macro' }
const factory = (g) => ({ Doc: node('Doc', withCtx(regex(/a+/), (ctx) => ({ ...ctx })), (c) => ({ c })) })
export const cstG = rules({ hostMode: 'cst' }, factory)
export const composed = compose([cstG])
`,
  'inferred node build (no explicit type)': `
import { node, regex, rules, compose } from 'parseman' with { type: 'macro' }
const factory = (g) => ({ Doc: node(regex(/a+/), (c) => ({ c })) })
export const cstG = rules({ hostMode: 'cst' }, factory)
export const composed = compose([cstG])
`,
}
for (const [name, src] of Object.entries(cases)) {
  try {
    const out = transformMacro(src.trim(), 'test.ts', new Set(['parseman']))
    const code = out?.code ?? ''
    const full = /ruleFns:\s*new Map/.test(code)
    console.log(`${full ? 'FULL-PIECES' : 'ir/other   '}  hostMode-in-literal=${/hostMode:\s*["']cst["']/.test(code)}  :: ${name}`)
  } catch (e) { console.log(`THREW  :: ${name} :: ${(e as Error).message.slice(0,80)}`) }
}
