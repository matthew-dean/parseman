import {
  OP_ATTEMPT, OP_CHOICE, OP_FIELD, OP_GATE, OP_LABEL, OP_LEAF, OP_LIT, OP_NODE, OP_NOT,
  OP_PEEK, OP_RULE, OP_RX, OP_SCOPE, OP_SCOPE_CAP, OP_SCOPE_PLAIN, OP_SEQ, OP_SEQV,
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
  code: ArrayLike<number>, ip: number, minDepth = 2, throughAttempt = true, throughPeek = false,
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
    // A positive lookahead has exactly its child's success language and no
    // effects on success. Choice predecisions may therefore execute a scalar
    // child to reject the enclosing arm early. This is opt-in because callers
    // that require a CONSUMING opener (notably exact start-failure diagnostics)
    // must continue to treat peek() as zero-width.
    if (throughPeek && op === OP_PEEK) {
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

/**
 * A bounded union of literal prefixes that every successful execution of `ip`
 * must enter through. Unlike `leadingScalarTerminal`, this may cross nested
 * choices, but only when EVERY arm yields literal authority. Longer literals
 * covered by a shorter prefix are removed (`@{-}` is already covered by `@{`).
 */
export function leadingLiteralFamily(
  code: ArrayLike<number>, constants: readonly unknown[], ip: number,
  minDepth = 2, limit = 4,
): readonly number[] | undefined {
  const active = new Set<number>()

  const walk = (at: number, depth: number): number[] | undefined => {
    if (active.has(at)) return undefined
    active.add(at)
    try {
      const op = code[at]
      if (op === OP_LIT) {
        const value = constants[code[at + 1]!]
        return depth >= minDepth && typeof value === 'string' && value.length > 0 ? [at] : undefined
      }
      if (op === OP_RULE || op === OP_LABEL || op === OP_TOKEN || op === OP_ATTEMPT || op === OP_PEEK) {
        return walk(code[at + 1]!, depth + 1)
      }
      if (op === OP_GATE || op === OP_SCOPE || op === OP_SCOPE_CAP || op === OP_SCOPE_PLAIN
        || op === OP_XFORM || op === OP_NODE || op === OP_FIELD || op === OP_LEAF) {
        return walk(code[at + 2]!, depth + 1)
      }
      if (op === OP_SEQ || op === OP_SEQV) {
        return code[at + 1]! < 1 ? undefined : walk(code[at + 2]!, depth + 1)
      }
      if (op === OP_SEQX) {
        return code[at + 2]! < 1 ? undefined : walk(code[at + 3]!, depth + 1)
      }
      if (op !== OP_CHOICE) return undefined

      const n = code[at + 2]!
      if (n < 1) return undefined
      const out: number[] = []
      for (let i = 0; i < n; i++) {
        const branch = walk(code[at + 4 + i]!, depth + 1)
        if (branch === undefined) return undefined
        for (const terminal of branch) {
          const value = constants[code[terminal + 1]!] as string
          let covered = false
          for (let j = 0; j < out.length; j++) {
            const prior = constants[code[out[j]! + 1]!] as string
            if (value.startsWith(prior)) { covered = true; break }
          }
          if (covered) continue
          for (let j = out.length - 1; j >= 0; j--) {
            const prior = constants[code[out[j]! + 1]!] as string
            if (prior.startsWith(value)) out.splice(j, 1)
          }
          out.push(terminal)
          if (out.length > limit) return undefined
        }
      }
      return out
    } finally {
      active.delete(at)
    }
  }

  return walk(ip, 0)
}
