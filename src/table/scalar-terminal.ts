import { OP_LIT, OP_RX } from './ops.ts'

/** Pure recognition only. Consumption owns value, CST, line, failure and cursor effects. */
export type ScalarRecognizer = (input: string, pos: number, seed?: number) => number

/**
 * One recognizer per existing terminal constant. This is the common raw/pending
 * seam: a later token cursor may provide a cached end for the same (pos, spec)
 * without changing either consumer's materialization protocol.
 */
export function makeScalarRecognizer(op: number, spec: unknown): ScalarRecognizer | undefined {
  if (op === OP_RX && spec instanceof RegExp) {
    return (input, pos) => {
      spec.lastIndex = pos
      return spec.test(input) ? spec.lastIndex : -1
    }
  }
  if (op !== OP_LIT || typeof spec !== 'string') return undefined
  const len = spec.length
  if (len === 1) {
    const c0 = spec.charCodeAt(0)
    return (input, pos) => input.charCodeAt(pos) === c0 ? pos + 1 : -1
  }
  if (len === 2) {
    const c0 = spec.charCodeAt(0), c1 = spec.charCodeAt(1)
    return (input, pos) => input.charCodeAt(pos) === c0 && input.charCodeAt(pos + 1) === c1 ? pos + 2 : -1
  }
  if (len === 3) {
    const c0 = spec.charCodeAt(0), c1 = spec.charCodeAt(1), c2 = spec.charCodeAt(2)
    return (input, pos) => input.charCodeAt(pos) === c0
      && input.charCodeAt(pos + 1) === c1
      && input.charCodeAt(pos + 2) === c2 ? pos + 3 : -1
  }
  return (input, pos) => input.startsWith(spec, pos) ? pos + len : -1
}

/** Exact bounded shape whose terminal value can be materialized without a node capture frame. */
export function scalarTerminalNodeChild(code: ArrayLike<number>, ip: number): number {
  if (code[ip + 1]! < 0 || code[ip + 3] !== 0 || code[ip + 4] !== -1) return -1
  const child = code[ip + 2]!
  const op = code[child]
  return op === OP_RX || op === OP_LIT ? child : -1
}
