/**
 * SITE LABELS — the encoder's downward pass over an encoded program.
 *
 * ## The criterion
 *
 * *Any consulting of options at parse time, per rule or per combinator, is a
 * FAIL.* After U4 four consultations remained, and three of them are here:
 * `ctx.trivia` per sequence term, `cstCaptureActive` per leaf, and
 * `hasTrivia`/`needMark` per repetition. (`forCtx`, once per parse at the
 * boundary, is not one of these — it selects the assembly rather than running
 * inside one.)
 *
 * ## Why a label and not a `RunCfg` bit
 *
 * `assemble.ts:213-277` states the rule `RunCfg` is held to: a bit belongs there
 * only when it is FIXED FOR THE LIFETIME OF A PARSE. Neither of these facts is.
 *
 *   - `ctx.trivia` is per-SCOPE. `OP_SCOPE` swaps it mid-parse, so a `RunCfg`
 *     bit would be answering a question that has different answers at different
 *     sites in the same parse.
 *   - `ctx._cstBuf` is per-NODE — `assemble.ts:247-249` records that a previous
 *     lane proposed keying on it and that doing so would have been *incorrect,
 *     not merely redundant*.
 *
 * A site label is strictly stronger than either, and it is what makes both facts
 * legal to resolve: it is computed from the PROGRAM STRUCTURE at encode time,
 * before any option set exists, and it says what is true *at that site* rather
 * than what is true for the parse. `OP_NODE` sets `ctx._cstBuf` unconditionally
 * on entry and restores it on exit, so every site dynamically inside one has
 * `_cstBuf !== undefined` — not because of an option, but because of where it
 * sits in the program.
 *
 * ## The two axes, kept apart
 *
 * The capture label does not compress into one bit, and an earlier attempt to
 * make it one was wrong in both directions:
 *
 *   - `cap` is THREE-VALUED. `OP_NODE` writes `ctx.captureTrivia` a LITERAL —
 *     `readsTrivia || hostCst`, resolved at emit — so a site under a node has it
 *     definitely true OR definitely false. `OP_SCOPE_CAP` only ever sets it true.
 *     Collapsing "definitely off" into "unknown" loses the case that lets
 *     `_skipTrivia` drop its capture arm entirely.
 *   - `buf` is a separate FLAG, because `_cstBuf` and `captureTrivia` are set by
 *     different ops and neither implies the other: `OP_SCOPE_CAP` turns capture
 *     on without opening a buffer, and a builder-less `OP_NODE` opens a buffer
 *     with capture off.
 *
 * ## Asymmetry, deliberately
 *
 * `buf` is TRUE only for "guaranteed present". FALSE means UNKNOWN, never
 * "guaranteed absent" — no root can prove absence, because every entry point
 * (`prog.rules`, and the `extraIps` a scan pool reaches from outside the emitted
 * scope) is called with a context this pass cannot see. Nothing is elided on
 * `buf === false`; it only declines to elide. The same holds for `TRI_UNKNOWN`
 * and `CAP_UNKNOWN`, which are the lattice's top element, not a third fact.
 *
 * That asymmetry is what rules out the unsound version of this pass: eliding a
 * leaf's capture when `hostCst === false`. `OP_NODE` opens `_cstBuf` whatever the
 * host mode is, and those leaves feed `kids` → `build(...)`, so the ONLY thing a
 * label licenses at a leaf is dropping the TEST — never the capture.
 */
import {
  OP_ATTEMPT, OP_CHOICE, OP_GATE, OP_LABEL, OP_NODE, OP_NODE_TRACK, OP_NOT, OP_OPT,
  OP_PEEK, OP_REP, OP_REPV, OP_RULE, OP_SCOPE, OP_SCOPE_CAP, OP_SEQ, OP_SEQV, OP_SEQX,
  OP_XFORM,
} from './ops.ts'

/** No scope on this path installs a known trivia — the lattice's top element. */
export const TRI_UNKNOWN = -2
/** `ctx.trivia === undefined` is guaranteed here. */
export const TRI_NONE = -1
/** Any value `>= 0` is a trivia slot index, guaranteed installed here. */

/** `ctx.captureTrivia` is not known at this site. */
export const CAP_UNKNOWN = 0
/** `ctx.captureTrivia` is guaranteed NOT `true` here. */
export const CAP_OFF = 1
/** `ctx.captureTrivia === true` is guaranteed here. */
export const CAP_ON = 2

export type SiteLabel = {
  /** `TRI_UNKNOWN`, `TRI_NONE`, or the trivia slot the enclosing scope installed. */
  readonly tri: number
  /**
   * `ctx._cstBuf !== undefined` is GUARANTEED. False means unknown — see the
   * asymmetry note in this file's header. Never read as "guaranteed absent".
   */
  readonly buf: boolean
  /** `CAP_UNKNOWN` / `CAP_OFF` / `CAP_ON`. */
  readonly cap: number
}

/** The lattice's top: every entry point starts here. */
export const TOP: SiteLabel = { tri: TRI_UNKNOWN, buf: false, cap: CAP_UNKNOWN }

function meet(a: SiteLabel, b: SiteLabel): SiteLabel {
  const tri = a.tri === b.tri ? a.tri : TRI_UNKNOWN
  const buf = a.buf && b.buf
  const cap = a.cap === b.cap ? a.cap : CAP_UNKNOWN
  if (tri === a.tri && buf === a.buf && cap === a.cap) return a
  return { tri, buf, cap }
}

/**
 * The child slots of a site, as code offsets.
 *
 * Restricted to what `emit-assembly.ts` lowers. Anything else contributes no
 * edges, which is safe in both directions: an unlowered op raises `Unemittable`
 * and the WHOLE assembly falls back to `assemble.ts`'s closures, so no emitted
 * body ever runs beside one — and any site this walk misses is looked up through
 * `labelAt`, which answers `TOP`.
 */
function childSlots(code: Int32Array, ip: number, out: number[]): void {
  switch (code[ip]) {
    case OP_GATE:
    case OP_SCOPE:
    case OP_SCOPE_CAP:
    case OP_XFORM:
    case OP_NODE:
    case OP_NODE_TRACK:
      out.push(code[ip + 2]!)
      return
    case OP_RULE:
    case OP_OPT:
    case OP_NOT:
    case OP_PEEK:
    case OP_ATTEMPT:
    case OP_LABEL:
      out.push(code[ip + 1]!)
      return
    case OP_SEQ:
    case OP_SEQV: {
      const n = code[ip + 1]!
      for (let i = 0; i < n; i++) out.push(code[ip + 2 + i]!)
      return
    }
    case OP_SEQX: {
      const n = code[ip + 2]!
      for (let i = 0; i < n; i++) out.push(code[ip + 3 + i]!)
      return
    }
    case OP_CHOICE: {
      const n = code[ip + 2]!
      for (let i = 0; i < n; i++) out.push(code[ip + 4 + i]!)
      return
    }
    case OP_REP:
    case OP_REPV:
      out.push(code[ip + 1]!)
      if (code[ip + 4]! >= 0) out.push(code[ip + 4]!)
      return
    default:
  }
}

/**
 * What a site hands DOWN to its children. Every op but the two that write the
 * context passes its own label through unchanged.
 */
function transfer(code: Int32Array, ip: number, at: SiteLabel, hostCst: boolean): SiteLabel {
  const op = code[ip]
  if (op === OP_SCOPE || op === OP_SCOPE_CAP) {
    const ki = code[ip + 1]!
    const tri = ki < 0 ? TRI_NONE : ki
    // `OP_SCOPE_CAP` is an OR with the inherited context, never a switch-off
    // (`encode.ts:1153-1158`), so it can only ever raise `cap` to `CAP_ON`.
    const cap = op === OP_SCOPE_CAP ? CAP_ON : at.cap
    if (tri === at.tri && cap === at.cap) return at
    return { tri, buf: at.buf, cap }
  }
  if (op === OP_NODE || op === OP_NODE_TRACK) {
    // `ctx._cstBuf = buf` and `ctx.captureTrivia = <literal>`, both unconditional
    // — `emit-assembly.ts`'s `OP_NODE` body opens the buffer before it descends
    // and closes it after, whatever the host mode is.
    const cap = ((code[ip + 3]! & 4) !== 0 || hostCst) ? CAP_ON : CAP_OFF
    if (at.buf && cap === at.cap) return at
    return { tri: at.tri, buf: true, cap }
  }
  return at
}

/** A site's label, or `TOP` for anything the walk did not reach. */
export type SiteLabels = { at: (ip: number) => SiteLabel }

/**
 * Compute a label for every site reachable from `roots`.
 *
 * A worklist to a fixpoint, because the program has cycles (a recursive rule is
 * a back-edge into a site already in flight) and because a site shared by two
 * parents must carry the MEET of what both hand it — a downward pass that simply
 * overwrote would give a shared site whichever parent it happened to visit last,
 * and the emitted body for that site is ONE body serving both.
 *
 * The meet only ever moves a label toward `TOP`, and `TOP` is absorbing, so the
 * lattice has height three and the walk terminates.
 */
export function computeSiteLabels(
  code: Int32Array,
  roots: Iterable<number>,
  hostCst: boolean,
): SiteLabels {
  const labels = new Map<number, SiteLabel>()
  const work: number[] = []

  const push = (ip: number, l: SiteLabel): void => {
    const cur = labels.get(ip)
    if (cur === undefined) {
      labels.set(ip, l)
      work.push(ip)
      return
    }
    const next = meet(cur, l)
    if (next === cur) return
    labels.set(ip, next)
    work.push(ip)
  }

  for (const r of roots) push(r, TOP)

  const kids: number[] = []
  while (work.length > 0) {
    const ip = work.pop()!
    const down = transfer(code, ip, labels.get(ip)!, hostCst)
    kids.length = 0
    childSlots(code, ip, kids)
    for (const c of kids) push(c, down)
  }

  return { at: (ip: number): SiteLabel => labels.get(ip) ?? TOP }
}
