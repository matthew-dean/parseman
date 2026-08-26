import {
  OP_ATTEMPT, OP_FIELD, OP_GATE, OP_LABEL, OP_LEAF, OP_LIT, OP_NODE, OP_NOT,
  OP_RULE, OP_RX, OP_SCOPE, OP_SCOPE_CAP, OP_SCOPE_PLAIN, OP_SEQ, OP_SEQV,
  OP_SEQX, OP_TOKEN, OP_XFORM,
} from './ops.ts'

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

/** Direct untracked terminal whose recognition `not()` can inspect without materializing it. */
export function scalarTerminalNotChild(code: ArrayLike<number>, ip: number): number {
  if (code[ip] !== OP_NOT) return -1
  const child = code[ip + 1]!
  const op = code[child]
  return op === OP_RX || op === OP_LIT ? child : -1
}

/**
 * A direct scalar terminal that every successful execution of `ip` must match
 * first, through wrappers that cannot consume or select before their child.
 * Returns only after `minDepth` edges so a caller never duplicates recognition
 * merely to avoid one already-cheap terminal call.
 */
export function leadingScalarTerminal(
  code: ArrayLike<number>, ip: number, minDepth = 2, throughAttempt = true,
): number {
  const seen = new Set<number>()
  let at = ip
  let depth = 0
  while (!seen.has(at)) {
    seen.add(at)
    const op = code[at]
    if (op === OP_LIT || op === OP_RX) return depth >= minDepth ? at : -1
    if (op === OP_RULE || op === OP_LABEL || op === OP_TOKEN || (throughAttempt && op === OP_ATTEMPT)) {
      at = code[at + 1]!
      depth++
      continue
    }
    if (op === OP_GATE || op === OP_SCOPE || op === OP_SCOPE_CAP || op === OP_SCOPE_PLAIN
      || op === OP_XFORM || op === OP_NODE || op === OP_FIELD || op === OP_LEAF) {
      at = code[at + 2]!
      depth++
      continue
    }
    if (op === OP_SEQ || op === OP_SEQV) {
      if (code[at + 1]! < 1) return -1
      at = code[at + 2]!
      depth++
      continue
    }
    if (op === OP_SEQX) {
      if (code[at + 2]! < 1) return -1
      at = code[at + 3]!
      depth++
      continue
    }
    return -1
  }
  return -1
}
