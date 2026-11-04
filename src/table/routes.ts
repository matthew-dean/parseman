/**
 * LEFT-CORNER ROUTES — derived once per table, read by the engines.
 *
 * A construct nested under several levels (a value under its declaration, under
 * the declaration list, under the block) starts at every level at the same
 * position with the same piece: its LEFT CORNER. Without routes each level opens
 * its frame, scope and gates on the way down, and each level's continuation is
 * tried and fails on the way back up.
 *
 * A ROUTE is what one character at a node site decides, before anything runs:
 * which levels to enter, and the deepest piece to call. Every decision is the one
 * the level's own row makes on that character (a gate's class, a choice's arm, a
 * gated collapse's blockers, a sequence's leading terms and trivia), so a route
 * cannot disagree with the rows it stands in for. After the corner, each level
 * decides on the next token whether its continuation can start: where it cannot,
 * the level completes on its lone child; where it can, the engine opens only the
 * frame the route skipped and runs the continuation from the corner's end.
 *
 * The derivation reads the rows and the analyses the encoder already lays down
 * (classes, dispatch tables, site labels, nullability, failure cleanliness), and
 * nothing else. It is a pure function of the table, memoised per resolved table,
 * so every engine reads the same routes. Routes exist only for a strict parse —
 * no recovery, probe, coverage, line tracking or CST host — and the engines
 * decline them under any of those.
 *
 * Design and measurements: `docs/design/left-corner-routing.md`.
 */
import {
  OP_ADJ, OP_CHOICE, OP_DISPATCH, OP_GAPGATE, OP_GATE, OP_LIT, OP_NODE, OP_NOT, OP_OPT, OP_PEEK,
  OP_REP, OP_REPV, OP_ROUTED, OP_RULE, OP_RX, OP_SCOPE, OP_SCOPE_CAP, OP_SCOPE_PLAIN, OP_SEQ, OP_SEQV,
  OP_WITHCTX,
} from './ops.ts'
import {
  assemblyExtraIps, classHas, encodeClassSpec, resolveClass,
  type ResolvedClass, type ResolvedTable,
} from './program.ts'
import {
  gatedPassCollapse, passCollapse, reachableSites, scopeIsIdentity, triviaLeadRanges, type SiteLabels,
} from './site-labels.ts'
import { holdsGap, rowNullable } from './hold-gap.ts'
import type { FailClean } from './fail-clean.ts'
import { leadingTriviaFieldAt } from './field-spec.ts'
import { largeChoiceLiteralPretest, leadingScalarTerminal, scalarTerminalNodeChild } from './scalar-terminal.ts'
import { leadMasks, maskOfRanges, type LeadMask } from './lead-mask.ts'

export const K_WRAP = 0
export const K_SCOPE = 1
export const K_WITHCTX = 2
export const K_NODE = 3
export const K_SEQ = 4
export const K_REP = 5
export const K_CHOICE = 6

/** The completion a node level runs: the variant `lower(OP_NODE)` selects. */
export const V_PLAIN = 0
export const V_CHILDREN = 1
export const V_CHILDREN_FIELDS = 2
export const V_COLLAPSE = 3
export const V_CHILDREN_COLLAPSE = 4
export const V_GENERIC = 5
export const V_PASS = 6

/** How a continuation term decides at its start. */
export const T_OPT_GATE = 0
export const T_REP_CLASS = 1
export const T_REP_GAP = 2
export const T_REP_OPTGAP = 3

/**
 * One term after a left corner, as the piece that runs it decides at its start:
 * an `optional` behind a gate, a repeat behind its item class, a repeat whose item
 * opens with a gap (`OP_GAPGATE`: the gap's regex, the class after it, or the
 * class of an arm without it), or a repeat whose item opens with
 * `optional(<regex>)` and then a term with a finite lead. Any other term (a gate
 * that must match among them) leaves the level to resume and run it.
 */
export type RouteTail = {
  readonly kind: number
  /** The term's row. */
  readonly ip: number
  /** A repeat that collects its items (`OP_REP`, not `OP_REPV`). */
  readonly collect: boolean
  /** The class the term opens with (gate, repeat item, or the item's own class); −1 where none. */
  readonly cls: number
  /** The regex row of the gap the item opens with; −1 where none. */
  readonly gapRow: number
  /** `T_REP_GAP`: the class after the gap, and the class of an arm without it (−1 none). */
  readonly follow: number
  readonly other: number
  /** `T_REP_OPTGAP`: the lead of the term after the gap. */
  readonly followMask: LeadMask | undefined
  /** The expected set a term that cannot start reports (`fx` index); −1 where it reports none. */
  readonly xf: number
}

export type RouteLevel = {
  readonly kind: number
  readonly ip: number
  /** `K_CHOICE`: the arm the character takes. */
  readonly arm: number
  /** `K_NODE`: the completion variant. */
  readonly variant: number
  /**
   * `K_SEQ`/`K_REP`: whether the continuation is decided on the next token
   * (`false`: it always runs). `K_SEQ`: its leading zero-width terms, and
   * whether its trivia is only known at run time.
   */
  known: boolean
  readonly lc: number
  readonly trivRuntime: boolean
  readonly tails: readonly RouteTail[]
  /** `K_REP`: the separator is gated by the repeat's own class. */
  readonly sepGated: boolean
  /** `K_REP`/`K_CHOICE`: a failure that can leave diagnostics to roll back. */
  readonly dirty: boolean
  /**
   * `K_SEQ`/`K_REP`: the index, in the route's levels, of the framed node a
   * continuation resumes in; −1 before it is placed, −2 where there is none.
   */
  resumeTop: number
  /** Whether the walk may stop above this level (a node site that can stand as the atom). */
  readonly candidate: boolean
}

export type DispatchArmRoute = {
  /** The arm's own route below the dispatch, or `undefined` where the arm runs whole. */
  readonly route: Route | undefined
  readonly ip: number
  /** The arm re-reads the selector's token through `ctx._routed` (no routed atom below it). */
  readonly needsRouted: boolean
  readonly commits: boolean
}

export type RouteAtom =
  | { readonly kind: 'site'; readonly ip: number }
  | { readonly kind: 'routed' }
  | {
    readonly kind: 'dispatch'
    readonly ip: number
    readonly arms: readonly DispatchArmRoute[]
    readonly other: DispatchArmRoute | undefined
  }

export type Route = {
  /** Every level the walk entered; the route enters `levels[0 .. d)`. */
  readonly levels: readonly RouteLevel[]
  readonly d: number
  readonly atom: RouteAtom
  /**
   * A sequence with a leading lookahead whose trivia only the run time knows:
   * where that trivia may start at the character, the route is cut back to the
   * candidate `cut` (0: no route), reading the trivia installed by the scope
   * level `scope` (−1: the entry's).
   */
  readonly cuts: readonly { readonly at: number; readonly cut: number; readonly scope: number }[]
  /** A guarded choice: where any pretest terminal matches, the route is cut back to `cut`. */
  readonly guards: readonly { readonly terminals: readonly number[]; readonly cut: number }[]
}

export type RouteTable = {
  /**
   * The routes a node site tops, per character (0–127), `undefined` where it
   * tops none. Derived the first time a site asks, so an assembly pays only
   * for the node sites it links.
   */
  readonly routesAt: (top: number) => readonly (Route | undefined)[] | undefined
  /**
   * The regex rows an `optional` gap a route may read and hand over can sit at:
   * the `optional(<regex>)` that opens a repeat's item. Known before any route is
   * derived, because the row's piece is chosen when it is linked.
   */
  readonly gapRows: ReadonlySet<number>
}

/**
 * The table's routes, for one assembly. Only a strict assembly with no host CST
 * and no line tracking routes, so a table has one in practice. `labels`
 * (computed with `hostCst` false) and `clean` are the assembly's own analyses of
 * the same code, so the derivation does not compute them again.
 */
export function routeTable(t: ResolvedTable, labels: SiteLabels, clean: FailClean): RouteTable {
  let derive: ((top: number) => (Route | undefined)[] | undefined) | undefined
  const memo = new Map<number, (Route | undefined)[] | undefined>()
  return {
    routesAt: top => {
      if (memo.has(top)) return memo.get(top)
      derive ??= deriver(t, labels, clean)
      const routes = derive(top)
      memo.set(top, routes)
      return routes
    },
    gapRows: optionalGapRows(t.code, [...Object.values(t.prog.rules), ...assemblyExtraIps(t.prog)]),
  }
}

/** A node site some character may route below: the ones `lower(OP_NODE)` completes as a level. */
export function routeTopCandidate(code: Int32Array, ip: number): boolean {
  return nodeVariant(code, ip) !== -1
}

/** See `RouteTable.gapRows`: the rows, by structure alone. */
function optionalGapRows(code: Int32Array, roots: readonly number[]): Set<number> {
  const out = new Set<number>()
  for (const ip of reachableSites(code, roots)) {
    if ((code[ip] !== OP_REP && code[ip] !== OP_REPV) || code[ip + 4]! >= 0 || code[ip + 2]! !== 0) continue
    let at = code[ip + 1]!
    for (let guard = 0; guard < 8; guard++) {
      const op = code[at]
      if ((op === OP_SCOPE || op === OP_SCOPE_PLAIN) && code[at + 1]! < 0) { at = code[at + 2]!; continue }
      if (op !== OP_SEQ && op !== OP_SEQV) break
      const t0 = code[at + 2]!
      if (code[at + 1]! >= 2 && code[t0] === OP_OPT && code[code[t0 + 1]!] === OP_RX) { out.add(code[t0 + 1]!); break }
      at = t0
    }
  }
  return out
}

/** The variant `lower(OP_NODE)` selects, −1 where a route does not descend, −2 a gated collapse. */
export function nodeVariant(code: Int32Array, ip: number): number {
  if (code[ip] !== OP_NODE) return -1
  const flags = code[ip + 3]!
  if (scalarTerminalNodeChild(code, ip) >= 0) return -1
  if (code[ip + 1]! < 0 || code[ip + 4]! >= 0) return -1
  if ((flags & 128) !== 0 || (flags & 64) !== 0) return -1
  if (flags === 0) return V_PLAIN
  if (flags === 2) return V_CHILDREN
  if (flags === 18) return V_CHILDREN_FIELDS
  if (passCollapse(code, ip, false)) return V_PASS
  if (gatedPassCollapse(code, ip, false) !== undefined) return -2
  if (flags === 32) return V_COLLAPSE
  if (flags === 34) return V_CHILDREN_COLLAPSE
  return V_GENERIC
}

/** The derivation, over the analyses it shares between every site it is asked about. */
function deriver(t: ResolvedTable, labels: SiteLabels, CLEAN: FailClean): (top: number) => (Route | undefined)[] | undefined {
  const { code, k, cc, disp, dsp, trivia } = t
  const NULLABLE = new Map<number, boolean>()
  const leadOf = leadMasks(code, k, cc)

  const triviaMaskAt = (ip: number): LeadMask | null => {
    const r = triviaLeadRanges(labels.at(ip).tri, trivia)
    return r === undefined ? null : maskOfRanges(r)
  }
  /** The class a strict parse gates `optional(child)` with: the child's own gate. */
  const gateClass = (child: number): number => code[child] === OP_GATE ? code[child + 1]! : -1

  /**
   * A repeat item that opens, through a sequence's first term and trivia-free
   * scopes, with `optional(<regex>)` and then a term `F` with a finite lead: the
   * gap an `OP_GAPGATE` row would name, written as an optional.
   */
  function optGapOf(item: number): { row: number; follow: LeadMask; xf: number } | undefined {
    let at = item
    for (let guard = 0; guard < 8; guard++) {
      const op = code[at]
      if ((op === OP_SCOPE || op === OP_SCOPE_PLAIN) && code[at + 1]! < 0) { at = code[at + 2]!; continue }
      if (op !== OP_SEQ && op !== OP_SEQV) return undefined
      const t0 = code[at + 2]!
      if (code[at + 1]! >= 2 && code[t0] === OP_OPT && code[code[t0 + 1]!] === OP_RX) {
        const tm = triviaMaskAt(at)
        if (tm === null || tm.some(x => x === 1)) return undefined
        const F = code[at + 3]!
        const fop = code[F]
        if (fop !== OP_LIT && fop !== OP_RX && fop !== OP_GATE) return undefined
        if (rowNullable(code, k, F, NULLABLE)) return undefined
        const follow = leadOf(F)
        if (follow === null) return undefined
        return { row: code[t0 + 1]!, follow, xf: code[F + (fop === OP_GATE ? 3 : 2)]! }
      }
      at = t0
    }
    return undefined
  }

  const tail = (kind: number, ip: number, o: Partial<RouteTail> = {}): RouteTail => ({
    kind, ip, collect: false, cls: -1, gapRow: -1, follow: -1, other: -1, followMask: undefined, xf: -1, ...o,
  })

  /** The tail term at `ip`, or `undefined` where its start cannot be decided here. */
  function classifyTail(ip: number): RouteTail | undefined {
    const op = code[ip]
    if (op === OP_OPT && gateClass(code[ip + 1]!) >= 0) return tail(T_OPT_GATE, ip, { cls: gateClass(code[ip + 1]!) })
    if ((op === OP_REP || op === OP_REPV) && code[ip + 4]! < 0 && code[ip + 2]! === 0) {
      const item = code[ip + 1]!
      const itemCls = code[ip + 7]!
      const collect = op === OP_REP
      if (code[item] === OP_GAPGATE) {
        return tail(T_REP_GAP, ip, { collect, cls: itemCls, gapRow: code[item + 2]!, follow: code[item + 3]!, other: code[item + 4]! })
      }
      const og = optGapOf(item)
      if (og !== undefined) {
        return tail(T_REP_OPTGAP, ip, { collect, cls: itemCls, gapRow: og.row, followMask: og.follow, xf: og.xf })
      }
      if (itemCls < 0) return undefined
      return tail(T_REP_CLASS, ip, { collect, cls: itemCls })
    }
    return undefined
  }

  const level = (kind: number, ip: number, o: Partial<RouteLevel> = {}): RouteLevel => ({
    kind, ip, arm: -1, variant: -1, known: true, lc: 0, trivRuntime: false, tails: [],
    sepGated: false, dirty: false, resumeTop: -1, candidate: false, ...o,
  })

  function seqLevel(ip: number, lc: number, trivRuntime: boolean): RouteLevel {
    const n = code[ip + 1]!
    const tails: RouteTail[] = []
    let known = true
    for (let i = lc + 1; i < n; i++) {
      const T = classifyTail(code[ip + 2 + i]!)
      if (T === undefined) { known = false; break }
      tails.push(T)
    }
    return level(K_SEQ, ip, { lc, trivRuntime, tails, known })
  }

  function repLevel(ip: number): RouteLevel {
    const sepIp = code[ip + 4]!
    let known = true
    let sepGated = false
    if (sepIp >= 0) {
      // A separator the repeat does not gate is entered, and its failure is
      // reported by the separator itself: the level always resumes there.
      const sepClass = leadingTriviaFieldAt(code, k, sepIp) ? -1 : code[ip + 7]!
      sepGated = sepClass >= 0 && !rowNullable(code, k, sepIp, NULLABLE)
      if (!sepGated) known = false
    } else if (code[ip + 7]! < 0) known = false
    return level(K_REP, ip, { known, sepGated, dirty: !CLEAN(code[ip + 1]!) })
  }

  /** A piece whose value is the one node it publishes (a node behind wrappers or arms). */
  function nodeValued(ip: number, depth = 0): boolean {
    if (depth > 12) return false
    const op = code[ip]
    if (op === OP_NODE) return true
    if (op === OP_GATE || op === OP_SCOPE || op === OP_SCOPE_PLAIN || op === OP_SCOPE_CAP || op === OP_WITHCTX) return nodeValued(code[ip + 2]!, depth + 1)
    if (op === OP_RULE) return nodeValued(code[ip + 1]!, depth + 1)
    if (op === OP_CHOICE) {
      const n = code[ip + 2]!
      for (let i = 0; i < n; i++) if (!nodeValued(code[ip + 4 + i]!, depth + 1)) return false
      return n > 0
    }
    return false
  }

  const routeMemo = new Map<string, Route>()
  const routeKeys = new Map<Route, string>()
  const levelIds = new Map<RouteLevel, number>()
  const levelId = (L: RouteLevel): number => {
    let id = levelIds.get(L)
    if (id === undefined) { id = levelIds.size; levelIds.set(L, id) }
    return id
  }
  const armKey = (a: DispatchArmRoute | undefined): string =>
    a === undefined ? '-' : `${a.ip}.${a.route === undefined ? '' : routeKeys.get(a.route)!}.${a.commits ? 1 : 0}`
  const atomKey = (a: RouteAtom): string =>
    a.kind === 'site' ? `s${a.ip}` : a.kind === 'routed' ? 'r' : `d${a.ip}(${a.arms.map(armKey).join(';')}/${armKey(a.other)})`
  type Group = number[]
  const split = (chars: Group, keyOf: (c: number) => number): Map<number, Group> => {
    const out = new Map<number, Group>()
    for (const c of chars) {
      const x = keyOf(c)
      const g = out.get(x)
      if (g === undefined) out.set(x, [c])
      else g.push(c)
    }
    return out
  }

  /** Per node site: the characters a gated collapse keeps its frame for; `null` where unknown (all). */
  const blockersMemo = new Map<number, Uint8Array | null>()
  function gatedBlockers(ip: number): Uint8Array | null {
    if (blockersMemo.has(ip)) return blockersMemo.get(ip)!
    const gated = gatedPassCollapse(code, ip, false)!
    const triviaLead = triviaLeadRanges(labels.at(code[ip + 2]!).tri, trivia)
    let m: Uint8Array | null = null
    if (triviaLead !== undefined) {
      const blockers: ResolvedClass[] = [
        ...gated.leads.map(g => cc[code[g + 1]!]!),
        resolveClass(encodeClassSpec([
          ...triviaLead,
          ...gated.lits.map(i => { const x = (k[i] as string).codePointAt(0)!; return { lo: x, hi: x } }),
        ])),
      ]
      m = new Uint8Array(128)
      for (let c = 0; c < 128; c++) if (blockers.some(b => classHas(b, c))) m[c] = 1
    }
    blockersMemo.set(ip, m)
    return m
  }

  /**
   * Per non-exclusive choice, per character: the one arm the route takes (−1:
   * none), and the pretest terminals of the other arms that claim it.
   */
  const choiceMemo = new Map<number, { arm: Int16Array; guards: (readonly number[] | undefined)[] }>()
  function choiceArms(ip: number): { arm: Int16Array; guards: (readonly number[] | undefined)[] } {
    const done = choiceMemo.get(ip)
    if (done !== undefined) return done
    const table = disp[code[ip + 1]!]!
    const n = code[ip + 2]!
    const arm = new Int16Array(128).fill(-1)
    const guards: (readonly number[] | undefined)[] = Array.from({ length: 128 })
    if (n <= 32) {
      // The terminals the choice pretests an arm with before it enters it.
      const pre: (readonly number[])[] = []
      for (let a = 0; a < n; a++) {
        const aIp = code[ip + 4 + a]!
        if (n === 2 || n === 3) {
          const tm = leadingScalarTerminal(code, aIp, 2, true, true)
          pre.push(tm >= 0 ? [tm] : [])
        } else pre.push(largeChoiceLiteralPretest(code, k, aIp) ?? [])
      }
      for (let c = 0; c < 128; c++) {
        let count = 0
        let only = -1
        for (let i = 0; i < n; i++) {
          const cls = table.armCls[i] ?? null
          if (cls === null || cls.ascii[c] === 1) { count++; only = i }
        }
        if (count === 1) { if (pre[only]!.length === 0) arm[c] = only; continue }
        // Several arms claim `c`: the route still passes when every arm but one is
        // pretested, and only while none of those pretests matches.
        let open = -1
        const terminals: number[] = []
        let ok = true
        for (let i = 0; i < n && ok; i++) {
          const cls = table.armCls[i] ?? null
          if (!(cls === null || cls.ascii[c] === 1)) continue
          if (pre[i]!.length === 0) { if (open >= 0) ok = false; else open = i }
          else terminals.push(...pre[i]!)
        }
        if (ok && open >= 0) { arm[c] = open; guards[c] = terminals }
      }
    }
    const out = { arm, guards }
    choiceMemo.set(ip, out)
    return out
  }

  /** Per sequence: where it can be a level, its leading-term count and the characters that block it. */
  type SeqFacts = { lc: number; blocked: Uint8Array | null; trivRuntime: boolean } | null
  const seqMemo = new Map<string, SeqFacts>()
  function seqFacts(ip: number, armMode: boolean): SeqFacts {
    const mk = `${ip}.${armMode ? 1 : 0}`
    if (seqMemo.has(mk)) return seqMemo.get(mk)!
    let out: SeqFacts = null
    const op = code[ip]
    const n = code[ip + 1]!
    const base = ip + 2
    let adj = false
    for (let i = 1; i < n; i++) {
      const kid = code[base + i]!
      if (code[kid] === OP_ADJ || leadingTriviaFieldAt(code, k, kid) || holdsGap(code, k, base, n, i, NULLABLE)) { adj = true; break }
    }
    if (!adj) {
      let lc = 0
      while (lc < n) {
        const tm = code[base + lc]!
        if (code[tm] === OP_NOT || code[tm] === OP_PEEK || (rowNullable(code, k, tm, NULLABLE) && code[tm] === OP_OPT)) lc++
        else break
      }
      if (!(lc >= n || (lc > 0 && (op === OP_SEQ || armMode)))) {
        let blocked: Uint8Array | null = new Uint8Array(128)
        for (let i = 0; i < lc && blocked !== null; i++) {
          const tm = code[base + i]!
          if (code[tm] !== OP_OPT) continue
          const m = leadOf(tm)
          if (m === null) blocked = null
          else for (let c = 0; c < 128; c++) if (m[c] === 1) blocked[c] = 1
        }
        const trivAt = triviaMaskAt(ip)
        if (blocked !== null && lc > 0 && trivAt !== null) for (let c = 0; c < 128; c++) if (trivAt[c] === 1) blocked[c] = 1
        out = { lc, blocked, trivRuntime: trivAt === null }
      }
    }
    seqMemo.set(mk, out)
    return out
  }

  /**
   * The atom a `dispatch()` is at the bottom of a route, per character: its
   * selector is the left corner, read once; its key picks the arm as the
   * dispatch does; the arm then runs as a route of its own down to the routed
   * token. Only where every arm re-reads the selector's token (`routed()`), so
   * the selector's match is the arm's start.
   */
  const dispatchMemo = new Map<number, readonly (RouteAtom | undefined)[]>()
  const NO_ATOMS: readonly (RouteAtom | undefined)[] = Array.from({ length: 128 })
  function dispatchAtoms(ip: number): readonly (RouteAtom | undefined)[] {
    const done = dispatchMemo.get(ip)
    if (done !== undefined) return done
    dispatchMemo.set(ip, NO_ATOMS)
    const spec = dsp[code[ip + 2]!]!
    const otherIp = code[ip + 3]!
    const otherRouted = (code[ip + 4]! & 1) === 1
    const otherCommits = (code[ip + 4]! & 2) === 0
    const n = code[ip + 5]!
    if (spec.routed.some(r => r !== 1) || (otherIp >= 0 && !otherRouted)) return NO_ATOMS
    const memoL = new Map<string, RouteLevel>()
    const armsOf = (aIp: number, commits: boolean): (DispatchArmRoute | undefined)[] => {
      const rs = routesFrom(aIp, memoL, true)
      const whole = nodeValued(aIp) ? { route: undefined, ip: aIp, needsRouted: true, commits } : undefined
      const byRoute = new Map<Route, DispatchArmRoute>()
      return rs.map(r => {
        if (r === undefined) return whole
        let a = byRoute.get(r)
        if (a === undefined) { a = { route: r, ip: aIp, needsRouted: r.atom.kind !== 'routed', commits }; byRoute.set(r, a) }
        return a
      })
    }
    const arms: (DispatchArmRoute | undefined)[][] = []
    for (let i = 0; i < n; i++) arms.push(armsOf(code[ip + 6 + i]!, true))
    const other = otherIp >= 0 ? armsOf(otherIp, otherCommits) : undefined
    const atoms = new Map<string, RouteAtom>()
    const out: (RouteAtom | undefined)[] = []
    for (let c = 0; c < 128; c++) {
      const cArms = arms.map(a => a[c])
      const cOther = other?.[c]
      if (cArms.some(a => a === undefined) || (other !== undefined && cOther === undefined)) { out.push(undefined); continue }
      const atom: RouteAtom = { kind: 'dispatch', ip, arms: cArms as DispatchArmRoute[], other: cOther }
      const ak = atomKey(atom)
      let shared = atoms.get(ak)
      if (shared === undefined) { shared = atom; atoms.set(ak, atom) }
      out.push(shared)
    }
    dispatchMemo.set(ip, out)
    return out
  }

  /**
   * The routes from `top`, per character (0–127): the levels each enters and the
   * deepest piece it calls. The walk carries a GROUP of characters and splits it
   * where a level decides differently for them, so each path is walked once.
   * `memoL` shares a level between every character that walks the same path to
   * it, so a level's resume placement is decided once.
   */
  function routesFrom(top: number, memoL: Map<string, RouteLevel>, armMode: boolean): (Route | undefined)[] {
    const out: (Route | undefined)[] = Array.from({ length: 128 })
    type Path = { levels: RouteLevel[]; key: string; best: number; guardAt: { at: number; terminals: readonly number[] }[] }
    const enter = (P: Path, make: () => RouteLevel, at: number): Path => {
      const key = P.key + '>' + String(at)
      let L = memoL.get(key)
      if (L === undefined) { L = make(); memoL.set(key, L) }
      return { levels: [...P.levels, L], key, best: P.best, guardAt: P.guardAt }
    }
    const finish = (chars: Group, P: Path, ip: number, terminal0: number, atom: RouteAtom | undefined): void => {
      const r = complete(P, ip, terminal0, atom)
      if (r !== undefined) for (const c of chars) out[c] = r
    }
    const go = (chars: Group, ip: number, P: Path, depth: number): void => {
      if (chars.length === 0) return
      if (depth >= 96) { finish(chars, P, ip, -1, undefined); return }
      const op = code[ip]
      if (op === OP_NODE) {
        const variant = nodeVariant(code, ip)
        if (variant === -1) { finish(chars, P, ip, ip, undefined); return }
        if (variant === -2) {
          const blocked = gatedBlockers(ip)
          if (blocked === null) { finish(chars, P, ip, ip, undefined); return }
          const at = ip
          const parts = split(chars, c => blocked[c]!)
          if (parts.has(1)) finish(parts.get(1)!, P, ip, ip, undefined)
          if (parts.has(0)) {
            const Q = enter(P, () => level(K_NODE, at, { variant: V_PASS, candidate: true }), ip)
            Q.best = Q.levels.length - 1
            go(parts.get(0)!, gatedPassCollapse(code, ip, false)!.last, Q, depth + 1)
          }
          return
        }
        const at = ip
        const Q = enter(P, () => level(K_NODE, at, { variant, candidate: true }), ip)
        Q.best = Q.levels.length - 1
        go(chars, code[ip + 2]!, Q, depth + 1)
        return
      }
      if (op === OP_GATE) {
        const cls = cc[code[ip + 1]!]!
        const parts = split(chars, c => cls.ascii[c]!)
        if (parts.has(0)) finish(parts.get(0)!, P, ip, -1, undefined)
        const at = ip
        if (parts.has(1)) go(parts.get(1)!, code[ip + 2]!, enter(P, () => level(K_WRAP, at), ip), depth + 1)
        return
      }
      if (op === OP_RULE) {
        const at = ip
        go(chars, code[ip + 1]!, enter(P, () => level(K_WRAP, at), ip), depth + 1)
        return
      }
      if (op === OP_SCOPE || op === OP_SCOPE_CAP || op === OP_SCOPE_PLAIN) {
        const at = ip
        go(chars, code[ip + 2]!, enter(P, () => level(scopeIsIdentity(code, at, labels.at(at)) ? K_WRAP : K_SCOPE, at), ip), depth + 1)
        return
      }
      if (op === OP_WITHCTX) {
        const at = ip
        go(chars, code[ip + 2]!, enter(P, () => level(K_WITHCTX, at), ip), depth + 1)
        return
      }
      if (op === OP_CHOICE) {
        const table = disp[code[ip + 1]!]!
        const facts = table.exclusive ? undefined : choiceArms(ip)
        const armOf = (c: number): number => facts === undefined ? table.ascii[c]! - 1 : facts.arm[c]!
        const byArm = split(chars, armOf)
        for (const [arm, group] of byArm) {
          if (arm < 0) { finish(group, P, ip, -1, undefined); continue }
          const at = ip
          const Q0 = enter(P, () => level(K_CHOICE, at, { arm, dirty: !CLEAN(at) }), ip * 64 + arm)
          // Characters a guard covers carry its pretests; group them by guard.
          const byGuard = new Map<string, { chars: Group; terminals: readonly number[] | undefined }>()
          for (const c of group) {
            const t = facts?.guards[c]
            const gk = t === undefined ? '' : t.join('.')
            const g = byGuard.get(gk)
            if (g === undefined) byGuard.set(gk, { chars: [c], terminals: t })
            else g.chars.push(c)
          }
          for (const { chars: gc, terminals } of byGuard.values()) {
            const Q = terminals === undefined ? Q0 : { ...Q0, guardAt: [...Q0.guardAt, { at: P.levels.length, terminals }] }
            go(gc, code[ip + 4 + arm]!, Q, depth + 1)
          }
        }
        return
      }
      if (op === OP_ROUTED && armMode) { finish(chars, P, ip, -1, { kind: 'routed' }); return }
      if (op === OP_DISPATCH && !armMode) {
        const atoms = dispatchAtoms(ip)
        const byAtom = new Map<RouteAtom | undefined, Group>()
        for (const c of chars) {
          const a = atoms[c]
          const g = byAtom.get(a)
          if (g === undefined) byAtom.set(a, [c])
          else g.push(c)
        }
        for (const [a, g] of byAtom) finish(g, P, ip, -1, a)
        return
      }
      if (op === OP_SEQ || op === OP_SEQV) {
        const f = seqFacts(ip, armMode)
        if (f === null || f.blocked === null) { finish(chars, P, ip, -1, undefined); return }
        const blocked = f.blocked
        const parts = split(chars, c => blocked[c]!)
        if (parts.has(1)) finish(parts.get(1)!, P, ip, -1, undefined)
        const at = ip
        if (parts.has(0)) go(parts.get(0)!, code[ip + 2 + f.lc]!, enter(P, () => seqLevel(at, f.lc, f.trivRuntime), ip), depth + 1)
        return
      }
      if (op === OP_REP || op === OP_REPV) {
        if (code[ip + 2]! !== 1) { finish(chars, P, ip, -1, undefined); return }
        const at = ip
        go(chars, code[ip + 1]!, enter(P, () => repLevel(at), ip), depth + 1)
        return
      }
      finish(chars, P, ip, -1, undefined)
    }
    const all: Group = []
    for (let c = 0; c < 128; c++) all.push(c)
    go(all, top, { levels: [], key: '', best: 0, guardAt: [] }, 0)
    return out
  }

  /** The route a walk that stopped at `ip` takes, or `undefined` where it enters no level. */
  function complete(P: Path0, ip: number, terminal0: number, atom: RouteAtom | undefined): Route | undefined {
    const levels = P.levels
    let best = P.best
    let terminal = terminal0
    if (terminal < 0 && atom === undefined && code[ip] === OP_NODE) terminal = ip
    if (terminal >= 0 || atom !== undefined) best = levels.length
    // A continuation that can start resumes at the nearest framed node above it.
    for (let i = 0; i < best; i++) {
      const L = levels[i]!
      if ((L.kind !== K_SEQ && L.kind !== K_REP) || L.resumeTop !== -1) continue
      let h = i - 1
      while (h >= 0 && !(levels[h]!.kind === K_NODE && levels[h]!.variant !== V_PASS)) h--
      if (h < 0) { L.known = false; L.resumeTop = -2; continue }
      L.resumeTop = h
    }
    // A level that always resumes at the top makes the whole route the plain path
    // plus the walk: the top keeps its own piece for that character.
    for (let i = 0; i < best; i++) {
      const L = levels[i]!
      if ((L.kind === K_SEQ || L.kind === K_REP) && !L.known && L.resumeTop <= 0) best = 0
    }
    const d = best
    if (d === 0) return undefined
    // A sequence with a leading lookahead runs its left corner after the trivia
    // installed at run time; where the labels cannot name that trivia it is read
    // at entry: the entry's, unless a scope above installs its own.
    const cuts: { at: number; cut: number; scope: number }[] = []
    for (let i = 0; i < d; i++) {
      const L = levels[i]!
      if (L.kind !== K_SEQ || !L.trivRuntime || L.lc === 0) continue
      let cut = 0
      let scope = -1
      for (let j = i - 1; j >= 0; j--) {
        if (levels[j]!.candidate && cut === 0) cut = j
        if (levels[j]!.kind === K_SCOPE && scope < 0) scope = j
      }
      cuts.push({ at: i, cut, scope })
    }
    const guards: { terminals: readonly number[]; cut: number }[] = []
    for (const g of P.guardAt) {
      if (g.at >= d) continue
      let cut = 0
      for (let j = g.at - 1; j >= 0; j--) if (levels[j]!.candidate) { cut = j; break }
      guards.push({ terminals: g.terminals, cut })
    }
    const atomHere = d === levels.length && atom !== undefined
    const atomOut: RouteAtom = atomHere ? atom! : { kind: 'site', ip: d === levels.length ? terminal : levels[d]!.ip }
    // Characters that take the same path share one route.
    const rkey = levels.slice(0, d).map(levelId).join(',') + '|' + atomKey(atomOut)
      + '|' + cuts.map(x => `${x.at}.${x.cut}.${x.scope}`).join(',')
      + '|' + guards.map(g => `${g.cut}.${g.terminals.join('.')}`).join(',')
    const shared = routeMemo.get(rkey)
    if (shared !== undefined) return shared
    const route: Route = { levels: levels.slice(0, d), d, atom: atomOut, cuts, guards }
    routeMemo.set(rkey, route)
    routeKeys.set(route, rkey)
    return route
  }
  type Path0 = { levels: RouteLevel[]; best: number; guardAt: { at: number; terminals: readonly number[] }[] }

  return top => {
    if (code[top] !== OP_NODE) return undefined
    const routes = routesFrom(top, new Map(), false)
    return routes.some(r => r !== undefined) ? routes : undefined
  }
}
