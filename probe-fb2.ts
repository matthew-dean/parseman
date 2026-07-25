import { transformMacro } from './src/plugin/index.ts'
const src = `
import { node, regex, rules, compose, withCtx } from 'parseman' with { type: 'macro' }
const factory = (g) => ({ Doc: node('Doc', withCtx(regex(/a+/), (ctx) => ({ ...ctx })), (c) => ({ c })) })
export const cstG = rules({ hostMode: 'cst' }, factory)
export const composed = compose([cstG])
`.trim()
const out = transformMacro(src, 'test.ts', new Set(['parseman']))!
console.log('has ruleFns:', /ruleFns/.test(out.code))
console.log('has keys:',    /\bkeys:/.test(out.code))
console.log('has prelude:', /\bprelude:/.test(out.code))
for (const m of out.code.matchAll(/.{0,70}hostMode.{0,70}/g)) console.log('CTX>', m[0].replace(/\n/g,' '))
