import type { Combinator, FirstSet, ParserDef } from '../types.ts'
import { firstSetOf, matchesEmpty } from '../combinators/first-set.ts'
import { deriveExpected } from '../combinators/expect.ts'
import { buildReadsState, buildReadsTrivia } from '../compiler/build-arity.ts'
import {
  OP_CHOICE, OP_EMPTY, OP_GATE, OP_LEAF, OP_LIT, OP_NODE, OP_NOT, OP_OPT,
  OP_PEEK, OP_REP, OP_REPV, OP_RULE, OP_RX, OP_SEQ, OP_SEQV, OP_XFORM,
  OP_LIT_TRACK, OP_RX_TRACK, OP_NODE_TRACK, OP_SCOPE, OP_EXPECT, OP_SEQX, OP_CALL,
} from './ops.ts'
import type { TableProgram } from './program.ts'

/** Raised when a construct has no opcode yet. Prototype scope is explicit. */
export class UnsupportedConstruct extends Error {
  readonly tag: string
  constructor(tag: string) { super(`table lowering: no opcode for '${tag}'`); this.tag = tag }
}

/** Settings that select the TABLE'S CONTENTS. They never reach the driver. */
export type TableSettings = {
  readonly hostMode?: 'ast' | 'cst'
  readonly trackLines?: boolean
}

type Emitted = { readonly ip: number }

/**
 * Do these first sets share no character?
 *
 * `any` and `empty` are never disjoint from anything — an over-approximating arm
 * has to fall back to ordered first-match or the choice silently picks the wrong
 * one. See the `Keyword`-ahead-of-`Num` case in the choice encoder.
 */
function disjointSets(sets: readonly FirstSet[]): boolean {
  const seen: Array<{ lo: number; hi: number }> = []
  for (const fs of sets) {
    if (fs.kind !== 'ranges' || fs.ranges.length === 0) return false
    for (const r of fs.ranges) {
      for (const p of seen) if (r.lo <= p.hi && p.lo <= r.hi) return false
      seen.push(r)
    }
  }
  return true
}

class Encoder {
  code: number[] = []
  k: unknown[] = []
  fns: unknown[] = []
  cc: string[] = []
  fx: (readonly string[])[] = []
  disp: (readonly number[])[] = []
  rules: Record<string, number> = {}

  private kIndex = new Map<unknown, number>()
  private ccIndex = new Map<string, number>()
  private fxIndex = new Map<string, number>()
  /** Memoized by combinator identity: a shared sub-combinator is ONE row. */
  memo = new Map<Combinator<unknown>, number>()
  pending = new Map<Combinator<unknown>, number[]>()

  readonly settings: TableSettings
  /** Resolved once, HERE, at table-build time — never consulted at run time. */
  readonly track: boolean
  constructor(settings: TableSettings) {
    this.settings = settings
    this.track = settings.trackLines === true
  }

  private constant(v: unknown): number {
    const key = v instanceof RegExp ? `re:${JSON.stringify([v.source, v.flags])}` : v
    const hit = this.kIndex.get(key)
    if (hit !== undefined) return hit
    const i = this.k.length
    this.k.push(v)
    this.kIndex.set(key, i)
    return i
  }

  private fn(v: unknown): number {
    const i = this.fns.length
    this.fns.push(v)
    return i
  }

  private expected(list: readonly string[]): number {
    const key = JSON.stringify(list)
    const hit = this.fxIndex.get(key)
    if (hit !== undefined) return hit
    const i = this.fx.length
    this.fx.push(list)
    this.fxIndex.set(key, i)
    return i
  }

  /** A first set becomes a char class STRING of `[lo, hi]` pairs, or −1 for `any`. */
  private charClass(fs: FirstSet): number {
    if (fs.kind !== 'ranges' || fs.ranges.length === 0) return -1
    let spec = ''
    for (const r of fs.ranges) spec += String.fromCharCode(r.lo, r.hi)
    const hit = this.ccIndex.get(spec)
    if (hit !== undefined) return hit
    const i = this.cc.length
    this.cc.push(spec)
    this.ccIndex.set(spec, i)
    return i
  }

  private emit(...words: number[]): number {
    const ip = this.code.length
    for (const w of words) this.code.push(w)
    return ip
  }

  /** Reserve `n` operand slots to patch once children are laid out. */
  private emitHead(op: number, n: number): number {
    const ip = this.code.length
    this.code.push(op)
    for (let i = 0; i < n; i++) this.code.push(0)
    return ip
  }

  encodeRule(name: string, p: Combinator<unknown>): void {
    this.rules[name] = this.node(p).ip
  }

  node(p: Combinator<unknown>): Emitted {
    const hit = this.memo.get(p)
    if (hit !== undefined) return { ip: hit }
    // Recursion: reserve a trampoline row now, patch its target when the real
    // body lands. One extra indirection per recursive rule, zero per call site.
    const inFlight = this.pending.get(p)
    if (inFlight !== undefined) {
      const ip = this.emitHead(OP_RULE, 1)
      inFlight.push(ip + 1)
      return { ip }
    }
    const patches: number[] = []
    this.pending.set(p, patches)
    const ip = this.encodeDef(p)
    this.pending.delete(p)
    this.memo.set(p, ip)
    for (const slot of patches) this.code[slot] = ip
    return { ip }
  }

  private encodeDef(p: Combinator<unknown>): number {
    const d = p._def as ParserDef
    // Constructs whose behaviour is NOT recoverable from `_def`. Run the real
    // combinator rather than build a second implementation that drifts.
    // `balanced()` is the sharp one: it overrides `.parse` and leaves `_def` as
    // the eager interior, so encoding structurally builds the wrong parser and
    // reports nothing.
    if (d.tag === 'scanTo' || d.tag === 'token'
      || (p as { _balancedAmbient?: unknown })._balancedAmbient !== undefined) {
      return this.emit(OP_CALL, this.constant(p))
    }
    switch (d.tag) {
      case 'literal': {
        if (d.caseInsensitive) throw new UnsupportedConstruct('literal(caseInsensitive)')
        return this.emit(this.track ? OP_LIT_TRACK : OP_LIT, this.constant(d.value), this.expected(deriveExpected(p)))
      }
      case 'regex': {
        const flags = d.flags.includes('y') ? d.flags : `${d.flags}y`
        return this.emit(this.track ? OP_RX_TRACK : OP_RX, this.constant(new RegExp(d.source, flags)), this.expected(deriveExpected(p)))
      }
      case 'keywords': {
        // `keywords()` compiles to ONE sticky regex and pushes a leaf — which is
        // exactly what OP_RX does. Rebuilding the same regex here needs no new
        // opcode. Construction mirrors src/combinators/keywords.ts:87-106; the
        // words arrive already sorted longest-first on the def.
        const alt = d.words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
        const boundary = d.boundary ? `(?![${d.boundary}])` : ''
        const flags = d.caseInsensitive ? 'iy' : 'uy'
        return this.emit(
          this.track ? OP_RX_TRACK : OP_RX,
          this.constant(new RegExp(`(?:${alt})${boundary}`, flags)),
          this.expected(deriveExpected(p)),
        )
      }
      case 'expect': {
        // `expect()` NEVER fails: on a failed child it yields a ParseError value
        // at zero width. That is a distinct outcome, so it gets its own row.
        return this.emit(OP_EXPECT, this.node(d.parser).ip, this.expected([...d.expected]))
      }
      case 'sequence': {
        const kids = d.parsers.map(c => this.node(c).ip)
        const head = this.emitHead(d.valueUnused ? OP_SEQV : OP_SEQ, 1 + kids.length)
        this.code[head + 1] = kids.length
        for (let i = 0; i < kids.length; i++) this.code[head + 2 + i] = kids[i]!
        return head
      }
      case 'choice': {
        if (d.gates.some(g => g !== null)) throw new UnsupportedConstruct('choice(gate:)')
        // Arm ORDER is semantics. `literalsLongestFirst` / `sharedPrefix` /
        // `greedyClassify` reorder or restructure the arms, so encoding them as
        // a plain ordered choice would pick a different arm and build a
        // different tree while still parsing. Refuse them rather than lower them
        // wrong.
        // `greedyClassify` runs ONE arm and then re-attributes the match to a
        // DIFFERENT arm by string equality, re-applying that arm's transforms.
        // That is a different execution, not a different order, so it is refused
        // rather than approximated.
        if (d.strategy.tag === 'greedyClassify') throw new UnsupportedConstruct('choice(strategy=greedyClassify)')
        // `autoNot` rejects an arm that matched but is followed by a char in a
        // sibling's first set, so a later arm can win. Ignoring it would pick a
        // different arm and build a different tree behind a successful parse.
        if (d.autoNot.some(a => a !== null)) throw new UnsupportedConstruct('choice(autoNot)')
        // ORDER is the only thing the remaining strategies change, and order is
        // table data. `literalsLongestFirst` carries its order explicitly;
        // `sharedPrefix` is documented in choice.ts:52 as a firstMatch
        // specialization, so declared order is already correct for it.
        const order = d.strategy.tag === 'literalsLongestFirst'
          ? d.strategy.sortedIndices
          : d.parsers.map((_, i) => i)
        const arms = order.map(i => d.parsers[i]!)
        const kids = arms.map(c => this.node(c).ip)
        // O(1) first-char dispatch is only SOUND when the arms are disjoint.
        // With overlapping first sets, "the first arm whose class contains this
        // char" is not "the first arm that matches": a `Keyword` arm whose first
        // set over-approximates to include digits was selected ahead of `Num`
        // for the input `0` — the parse still succeeded, and only the TREE moved.
        // Disjointness is computed HERE, not read off `d.disjoint`. That flag is
        // set when `choice()` is CONSTRUCTED, at which point `g.X` arms are
        // unresolved refs whose first set is `any` — so every recursive grammar
        // reports non-disjoint and loses its dispatch. (Codegen has the same
        // problem and solves it the same way: a placeholder resolved at fuse.)
        let dispIdx = -1
        if (arms.every(a => !matchesEmpty(a))) {
          const sets = arms.map(a => firstSetOf(a))
          if (disjointSets(sets)) {
            const classes = sets.map(fs => this.charClass(fs))
            if (classes.every(c => c >= 0)) {
              dispIdx = this.disp.length
              this.disp.push(classes)
            }
          }
        }
        const head = this.emitHead(OP_CHOICE, 2 + kids.length)
        this.code[head + 1] = dispIdx
        this.code[head + 2] = kids.length
        for (let i = 0; i < kids.length; i++) this.code[head + 3 + i] = kids[i]!
        return head
      }
      case 'many':
      case 'oneOrMore': {
        const child = this.node(d.parser).ip
        return this.emit(
          d.valueUnused ? OP_REPV : OP_REP,
          child, d.tag === 'many' ? 0 : d.min, d.max ?? -1, -1, 0,
        )
      }
      case 'sepBy': {
        const child = this.node(d.parser).ip
        const sep = this.node(d.separator).ip
        // A list contributes its ITEMS and nothing else (release/0.47.0
        // `7cb528e feat(lists)!`). The separator is demoted out of `children`
        // after it matches unless the author opted in with `keepSeparator()`.
        const flags = (d.trailing === 'allow' ? 1 : 0) | (d.keepSeparators === true ? 2 : 0)
        return this.emit(OP_REP, child, d.min, d.max ?? -1, sep, flags)
      }
      case 'optional':
        return this.emit(OP_OPT, this.node(d.parser).ip)
      case 'transform': {
        // Declared on the def and not lowered here. Refuse rather than assume it is
        // inert: a recognition-only transform suppresses its value, and a table that
        // produced one anyway would differ from both other engines.
        if (d.recognitionOnly === true) throw new UnsupportedConstruct('transform(recognitionOnly)')
        // FUSE `transform(sequence(...))` — the dominant shape — into one row.
        // Emitted separately it costs two dispatches and two call frames per
        // rule invocation. The inner sequence must not be shared with anything
        // else, or fusing it here would steal it from the other reference.
        const inner = d.parser._def as ParserDef
        if (inner.tag === 'sequence' && !this.memo.has(d.parser) && !this.pending.has(d.parser)) {
          const kids = inner.parsers.map(c => this.node(c).ip)
          const head = this.emitHead(OP_SEQX, 2 + kids.length)
          this.code[head + 1] = this.fn(d.fn)
          this.code[head + 2] = kids.length
          for (let i = 0; i < kids.length; i++) this.code[head + 3 + i] = kids[i]!
          return head
        }
        const child = this.node(d.parser).ip
        return this.emit(OP_XFORM, this.fn(d.fn), child)
      }
      case 'leaf': {
        const child = this.node(d.parser).ip
        return this.emit(OP_LEAF, this.fn(d.fn), child)
      }
      case 'node': {
        if (d.unwrap || d.collapse || d.project !== undefined) throw new UnsupportedConstruct('node(unwrap|collapse|project)')
        if (d.build === undefined) throw new UnsupportedConstruct('node(no build)')
        // FAIL CLOSED on fields this encoder does not lower. The capture flags below
        // are derived from the reducer's ARITY, which cannot express an explicit
        // `captureTrivia: true` on a 3-argument reducer — the author asked for
        // capture and the arity analysis would say no. Silently ignoring the request
        // yields a table that parses and drops trivia, which is the exact
        // silent-failure class this lowering exists to avoid.
        if (d.captureTrivia !== undefined) throw new UnsupportedConstruct('node(captureTrivia)')
        if (d.trailingTrivia !== undefined) throw new UnsupportedConstruct('node(trailingTrivia)')
        if (d.tags !== undefined) throw new UnsupportedConstruct('node(tags)')
        const child = this.node(d.parser).ip
        // Capture flags, resolved HERE from the reducer's declared arity using the
        // same analysis codegen runs (`src/compiler/build-arity.ts`). `hostMode:
        // 'cst'` forces them on, exactly as the emitted `cstOut` path does. The
        // driver reads a bit; it re-derives nothing and sees no setting.
        const cstOut = this.settings.hostMode === 'cst'
        const flags = (cstOut || buildReadsTrivia(d) ? 4 : 0) | (cstOut || buildReadsState(d) ? 8 : 0)
        const body = this.emit(this.track ? OP_NODE_TRACK : OP_NODE, this.fn(d.build), child, flags)
        // The rule's own first-set gate — the emitted code's `_ngc` test, as data.
        // A NULLABLE rule has no gate: it succeeds on input its first set does
        // not contain (including EOF), so gating it would reject a legal empty
        // match. Caught by the ladder's `empty` and `garbage` cases.
        if (matchesEmpty(p)) return body
        const cls = this.charClass(firstSetOf(p))
        if (cls < 0) return body
        return this.emit(OP_GATE, cls, body, this.expected(deriveExpected(p)))
      }
      case 'lazy':
        // A named reference is not a hop: it resolves to the target's row.
        // Emitting a trampoline here cost one dispatch per reference for nothing.
        return this.node(d.thunk()).ip
      case 'not':
        return this.emit(OP_NOT, this.node(d.parser).ip)
      case 'peek':
        return this.emit(OP_PEEK, this.node(d.parser).ip)
      // Transparent wrappers: no row of their own, no dispatch at run time.
      case 'attempt':
      case 'label':
      case 'trivia':
        return this.node(d.parser).ip
      case 'grammar': {
        // Fail closed on the scope switches this encoder does not carry. `trackLines`
        // is the one field here that is RECONCILED rather than refused: the driver
        // takes it from TableSettings, so a scope asking for something different is a
        // silent disagreement between the grammar and the artifact.
        if (d.captureTrivia !== undefined) throw new UnsupportedConstruct('parser(captureTrivia)')
        if (d.rootCapture !== undefined) throw new UnsupportedConstruct('parser(rootCapture)')
        if (d.trackLines !== this.track) {
          throw new UnsupportedConstruct(
            `parser(trackLines: ${String(d.trackLines)}) disagrees with TableSettings.trackLines: ${String(this.track)}`,
          )
        }
        // A trivia scope is a ROW, not a lowering decision: the scope's trivia
        // combinator goes in the const pool and the driver installs it.
        if (d.clearTrivia === true) return this.emit(OP_SCOPE, -1, this.node(d.parser).ip)
        if (d.triviaParser === undefined) return this.node(d.parser).ip
        return this.emit(OP_SCOPE, this.constant(d.triviaParser), this.node(d.parser).ip)
      }
      default:
        throw new UnsupportedConstruct(d.tag)
    }
  }

  /**
   * Peephole: an `OP_RULE` row is pure indirection — a switch dispatch and a
   * call frame to do nothing but jump. Rewrite every child slot that points at
   * one to point at its target instead. Transitive, and cycle-safe by bounding
   * the walk at the number of rows.
   */
  private collapseIndirection(): void {
    const resolve = (ip: number): number => {
      let t = ip
      for (let n = 0; n < this.code.length && this.code[t] === OP_RULE; n++) t = this.code[t + 1]!
      return t
    }
    const slots = (ip: number): number[] => {
      switch (this.code[ip]) {
        case OP_GATE: return [ip + 2]
        case OP_RULE: case OP_OPT: case OP_NOT: case OP_PEEK: case OP_EXPECT: return [ip + 1]
        case OP_SCOPE: case OP_XFORM: case OP_LEAF: case OP_NODE: case OP_NODE_TRACK: return [ip + 2]
        case OP_SEQ: case OP_SEQV: return Array.from({ length: this.code[ip + 1]! }, (_, i) => ip + 2 + i)
        case OP_SEQX: return Array.from({ length: this.code[ip + 2]! }, (_, i) => ip + 3 + i)
        case OP_CHOICE: return Array.from({ length: this.code[ip + 2]! }, (_, i) => ip + 3 + i)
        case OP_REP: case OP_REPV: return this.code[ip + 4]! >= 0 ? [ip + 1, ip + 4] : [ip + 1]
        default: return []
      }
    }
    const seen = new Set<number>()
    const stack = Object.values(this.rules)
    while (stack.length > 0) {
      const ip = stack.pop()!
      if (seen.has(ip)) continue
      seen.add(ip)
      for (const slot of slots(ip)) {
        const target = resolve(this.code[slot]!)
        this.code[slot] = target
        stack.push(target)
      }
    }
    for (const name of Object.keys(this.rules)) this.rules[name] = resolve(this.rules[name]!)
  }

  finish(): TableProgram {
    if (this.code.length === 0) this.emit(OP_EMPTY)
    this.collapseIndirection()
    return {
      code: this.code, k: this.k, fns: this.fns, cc: this.cc,
      fx: this.fx, disp: this.disp, rules: this.rules,
      lines: this.track ? 1 : 0,
    }
  }
}

/**
 * Encode a rule map into ONE table for ONE settings pair.
 *
 * Two settings pairs give two programs and therefore two cached reference
 * tables; the driver that reads them is the same function in both cases and
 * never sees `settings`.
 */
export function encodeTable(
  ruleMap: Record<string, Combinator<unknown>>,
  settings: TableSettings = {},
): TableProgram {
  const enc = new Encoder(settings)
  for (const name of Object.keys(ruleMap)) enc.encodeRule(name, ruleMap[name]!)
  return enc.finish()
}
