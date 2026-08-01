import type { Combinator, FirstSet, ParserDef } from '../types.ts'
import { firstSetOf, matchesEmpty } from '../combinators/first-set.ts'
import { deriveExpected } from '../combinators/expect.ts'
import { buildReadsState, buildReadsTrivia } from '../compiler/build-arity.ts'
import {
  OP_CHOICE, OP_EMPTY, OP_GATE, OP_LEAF, OP_LIT, OP_NODE, OP_NOT, OP_OPT,
  OP_PEEK, OP_REP, OP_REPV, OP_RULE, OP_RX, OP_SEQ, OP_SEQV, OP_XFORM,
  OP_LIT_TRACK, OP_RX_TRACK, OP_NODE_TRACK, OP_SCOPE, OP_EXPECT,
} from './ops.ts'
import type { TableProgram } from './program.ts'

/** Raised when a construct has no opcode yet. Prototype scope is explicit. */
class UnsupportedConstructBaseline extends Error {
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
  private memo = new Map<Combinator<unknown>, number>()
  private pending = new Map<Combinator<unknown>, number[]>()

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
    // REFUSE what this frozen copy cannot lower, rather than lowering it wrong.
    //
    // `scanTo` and `token` have no `case` below, so they reach `default:` and throw
    // — a refusal, which is safe. `balanced()` does NOT: it overrides `.parse` and
    // leaves `_def` as the EAGER INTERIOR with no distinguishing tag, so the switch
    // would encode the interior, report nothing, and produce a table that parses and
    // yields a different tree. An ablation measurement taken on a grammar using
    // `balanced()` would then be comparing against a parser that is not the one
    // under test. Refused explicitly, since this copy has no OP_CALL to fall back on.
    if ((p as { _balancedAmbient?: unknown })._balancedAmbient !== undefined) {
      throw new UnsupportedConstructBaseline('balanced() — the frozen ablation encoder cannot lower it')
    }
    switch (d.tag) {
      case 'literal': {
        if (d.caseInsensitive) throw new UnsupportedConstructBaseline('literal(caseInsensitive)')
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
        if (d.gates.some(g => g !== null)) throw new UnsupportedConstructBaseline('choice(gate:)')
        // Arm ORDER is semantics. `literalsLongestFirst` / `sharedPrefix` /
        // `greedyClassify` reorder or restructure the arms, so encoding them as
        // a plain ordered choice would pick a different arm and build a
        // different tree while still parsing. Refuse them rather than lower them
        // wrong.
        // `greedyClassify` runs ONE arm and then re-attributes the match to a
        // DIFFERENT arm by string equality, re-applying that arm's transforms.
        // That is a different execution, not a different order, so it is refused
        // rather than approximated.
        if (d.strategy.tag === 'greedyClassify') throw new UnsupportedConstructBaseline('choice(strategy=greedyClassify)')
        // `autoNot` rejects an arm that matched but is followed by a char in a
        // sibling's first set, so a later arm can win. Ignoring it would pick a
        // different arm and build a different tree behind a successful parse.
        if (d.autoNot.some(a => a !== null)) throw new UnsupportedConstructBaseline('choice(autoNot)')
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
        return this.emit(OP_REP, child, d.min, d.max ?? -1, sep, d.trailing === 'allow' ? 1 : 0)
      }
      case 'optional':
        return this.emit(OP_OPT, this.node(d.parser).ip)
      case 'transform': {
        const child = this.node(d.parser).ip
        return this.emit(OP_XFORM, this.fn(d.fn), child)
      }
      case 'leaf': {
        const child = this.node(d.parser).ip
        return this.emit(OP_LEAF, this.fn(d.fn), child)
      }
      case 'node': {
        if (d.unwrap || d.collapse || d.project !== undefined) throw new UnsupportedConstructBaseline('node(unwrap|collapse|project)')
        if (d.build === undefined) throw new UnsupportedConstructBaseline('node(no build)')
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
      case 'token':
      case 'attempt':
      case 'label':
      case 'trivia':
        return this.node(d.parser).ip
      case 'grammar': {
        // A trivia scope is a ROW, not a lowering decision: the scope's trivia
        // combinator goes in the const pool and the driver installs it.
        if (d.clearTrivia === true) return this.emit(OP_SCOPE, -1, this.node(d.parser).ip)
        if (d.triviaParser === undefined) return this.node(d.parser).ip
        return this.emit(OP_SCOPE, this.constant(d.triviaParser), this.node(d.parser).ip)
      }
      default:
        throw new UnsupportedConstructBaseline(d.tag)
    }
  }

  finish(): TableProgram {
    if (this.code.length === 0) this.emit(OP_EMPTY)
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
export function encodeTableBaseline(
  ruleMap: Record<string, Combinator<unknown>>,
  settings: TableSettings = {},
): TableProgram {
  const enc = new Encoder(settings)
  for (const name of Object.keys(ruleMap)) enc.encodeRule(name, ruleMap[name]!)
  return enc.finish()
}
