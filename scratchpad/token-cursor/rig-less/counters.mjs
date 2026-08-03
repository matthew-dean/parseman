/**
 * Exact counters for the instrumented grammar artifact, plus a replayable trace.
 *
 * The trace exists so the character-level work can be re-executed on its own, in
 * the same process as the real parse, with the same access pattern and the same
 * regexes. That replay is the absorbable-share instrument: it is the work a token
 * cursor takes over, timed without the parser control flow around it.
 */
export const C = {
  cc: 0, cp: 0, sl: 0, slBytes: 0, ex: 0, exOk: 0, exFail: 0, exChars: 0, dk: 0,
  reAlloc: 0,
}

export let touched = null
export let traceOn = false

/** Char-read positions, in order. */
export let posTrace = null
/** Flat (regexId, startPos) pairs, in order. */
export let exTrace = null
/** Dedup of regex source+flags -> id. */
export const reIds = new Map()
export const reList = []

export function armTrace(len) {
  touched = new Uint8Array(len)
  posTrace = []
  exTrace = []
  slTrace = []
  traceOn = true
}
export function disarm() { traceOn = false }
export function resetCounts() { for (const k of Object.keys(C)) C[k] = 0 }
export function distinctTouched() {
  if (touched === null) return 0
  let n = 0
  for (let i = 0; i < touched.length; i++) if (touched[i] !== 0) n++
  return n
}

export function __CC(input, i) {
  C.cc++
  if (traceOn) { if (i >= 0 && i < touched.length) touched[i] = 1; posTrace.push(i) }
  return input.charCodeAt(i)
}

export function __CP(input, i) {
  C.cp++
  if (traceOn) { if (i >= 0 && i < touched.length) touched[i] = 1; posTrace.push(i) }
  return input.codePointAt(i)
}

/** Slice spans, in order, for the leaf-materialisation replay. */
export let slTrace = null

export function __SL(input, a, b) {
  C.sl++
  const end = b === undefined ? input.length : b
  C.slBytes += end - a
  if (traceOn) slTrace.push(a, end)
  return input.slice(a, b)
}

export function __RA(re) { C.reAlloc++; return re }

function reIdOf(re) {
  const key = `${re.source}\u0000${re.flags}`
  let id = reIds.get(key)
  if (id === undefined) { id = reList.length; reIds.set(key, id); reList.push({ source: re.source, flags: re.flags }) }
  return id
}

export function __EX(re, input) {
  // `lastIndex` is only meaningful for a regex carrying `g` or `y`. Without
  // either, `exec` neither reads nor advances it, so it stays 0 and this rig
  // would record start 0 for EVERY call -- silently corrupting touched[],
  // distinctPositionsTouched, redundancyFactor, and the replay-ex starts that
  // absorb.mjs consumes. A measurement rig that reports a confident wrong number
  // is worse than one that stops, so this refuses rather than guesses.
  if (!re.sticky && !re.global) {
    throw new Error(
      `__EX: ${re} carries neither the y nor the g flag, so re.lastIndex is always 0 ` +
        'and every recorded exec start would be wrong. Terminal regexes in this rig must be sticky.',
    )
  }
  const start = re.lastIndex
  C.ex++
  if (traceOn) exTrace.push(reIdOf(re), start)
  const m = re.exec(input)
  if (m !== null) {
    C.exOk++
    C.exChars += m[0].length
    if (traceOn) for (let i = start; i < start + m[0].length && i < touched.length; i++) touched[i] = 1
  } else {
    C.exFail++
    if (traceOn && start >= 0 && start < touched.length) touched[start] = 1
  }
  return m
}

export function __DK(key, i) {
  C.dk++
  return key.charCodeAt(i)
}
