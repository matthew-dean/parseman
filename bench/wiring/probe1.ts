import { emitFor } from './emit-probe.ts'
import { jsonValue, ws } from '../../examples/json/parser.ts'
import type { Combinator } from '../../src/types.ts'

const { source, ips } = emitFor({
  jsonValue: jsonValue as Combinator<unknown>,
  ws: ws as Combinator<unknown>,
})
console.log('bytes', source.length, 'sites', ips.length)
const i = source.indexOf('function _pf')
console.log(source.slice(i, i + 3000))
console.log('...TAIL...')
console.log(source.slice(-600))
