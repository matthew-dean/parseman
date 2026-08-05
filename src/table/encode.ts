import type { Combinator, FirstSet, ParserDef } from '../types.ts'
import { firstSetOf, matchesEmpty } from '../combinators/first-set.ts'
import { deriveExpected } from '../combinators/expect.ts'
import { buildReadsState, buildReadsTrivia } from '../compiler/build-arity.ts'
import { buildReadsFields, parserHasOwnFields } from '../compiler/fields.ts'
import { asciiFoldKey, branchUsesRouted, parserUsesRouted } from '../combinators/dispatch.ts'
import {
  OP_CHOICE, OP_EMPTY, OP_GATE, OP_LEAF, OP_LIT, OP_NODE, OP_NOT, OP_OPT,
  OP_PEEK, OP_REP, OP_REPV, OP_RULE, OP_RX, OP_SEQ, OP_SEQV, OP_XFORM,
  OP_LIT_TRACK, OP_RX_TRACK, OP_NODE_TRACK, OP_SCOPE, OP_EXPECT, OP_SEQX, OP_SCAN,
  OP_FIELD, OP_DISPATCH, OP_ROUTED, OP_LIT_CI, OP_LIT_CI_TRACK, OP_TOKEN,
} from './ops.ts'
import type { BalancedSpec } from '../combinators/scanTo.ts'
import type { DispatchSpec, ScanSpec, SubtreeRef, TableProgram, TriviaSpec } from './program.ts'

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


class Encoder {
  code: number[] = []
  k: unknown[] = []
  fns: unknown[] = []
  cc: string[] = []
  fx: (readonly string[])[] = []
  disp: (readonly number[])[] = []
  dsp: DispatchSpec[] = []
  labels: readonly string[] | undefined = undefined
  classified = false
  scans: ScanSpec[] = []
  /** Ambient `scanSkip` sets, pooled by the ARRAY's identity (stable per grammar). */
  scanSkipSets: (readonly SubtreeRef[])[] = []
  private scanSkipIndex = new Map<readonly Combinator<unknown>[], number>()
  /** Per rule, in `rules` order: which pooled set its entry installs, or −1. */
  scanSkipOf: number[] = []
  /** Reasons this program can RUN but not be EMITTED. */
  runtimeOnly = new Set<string>()
  triviaSpecs: TriviaSpec[] = []
  private triviaIndex = new Map<Combinator<unknown>, number>()

  /**
   * A trivia combinator as DATA where its shape allows.
   *
   * `classifiedTrivia()` builds exactly `trivia(oneOrMore(choice(label(name,
   * arm)…)))` (src/combinators/map.ts) and the four shipping grammars give it
   * regex arms, so the whole thing round-trips through `[label, source, flags]`
   * triples. Anything else is kept LIVE and recorded, so the program runs and
   * emit refuses by name.
   */
  private triviaSlot(t: Combinator<unknown>): number {
    const hit = this.triviaIndex.get(t)
    if (hit !== undefined) return hit
    const idx = this.triviaSpecs.length
    this.triviaIndex.set(t, idx)
    this.triviaSpecs.push(this.triviaSpecOf(t))
    return idx
  }

  private triviaSpecOf(t: Combinator<unknown>): TriviaSpec {
    const unlowered = (why: string): TriviaSpec => {
      this.runtimeOnly.add(`rules({ trivia }) — ${why}`)
      return { arms: [], live: t }
    }
    const d = t._def
    if (d.tag !== 'trivia') return unlowered(`expected a trivia() wrapper, got '${d.tag}'`)
    const inner = d.parser._def
    if (inner.tag === 'regex') return { arms: [], plain: [inner.source, inner.flags] }
    // classifiedTrivia's exact shape.
    const rep = inner.tag === 'oneOrMore' || (inner.tag === 'many' && inner.min >= 1) ? inner.parser._def : null
    if (rep === null || rep.tag !== 'choice') return unlowered(`unrecognised trivia body '${inner.tag}'`)
    const arms: Array<readonly [string, string, string]> = []
    for (const arm of rep.parsers) {
      const a = arm._def
      if (a.tag !== 'label') return unlowered(`trivia arm is '${a.tag}', not a labelled arm`)
      const body = a.parser._def
      if (body.tag !== 'regex') return unlowered(`trivia arm ${JSON.stringify(a.label)} is '${body.tag}', not a regex`)
      arms.push([a.label, body.source, body.flags])
    }
    return { arms }
  }
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

  /**
   * A combinator carried as a table SUBTREE plus its first set.
   *
   * The first set is not decoration: `buildBalancedInterior` reads each skipper's
   * to decide whether the interior content run can be one bounded regex
   * (scanTo.ts:280). A reference that reported `any` would rebuild a different —
   * one-character-at-a-time — interior than the grammar's own.
   */
  private subtree(c: Combinator<unknown>): SubtreeRef {
    const ip = this.node(c).ip
    const fs = firstSetOf(c)
    return [ip, fs.kind === 'empty' ? -2 : this.charClass(fs)]
  }

  /** Pool one scan spec. One per combinator: `node()` memoizes by identity. */
  private scanSlot(spec: ScanSpec): number {
    const i = this.scans.length
    this.scans.push(spec)
    return i
  }

  private scanSkipSlot(set: readonly Combinator<unknown>[]): number {
    const hit = this.scanSkipIndex.get(set)
    if (hit !== undefined) return hit
    const i = this.scanSkipSets.length
    // Reserve the slot BEFORE encoding: an ambient skipper can be a `balanced()`
    // whose own encoding reaches back here through the same array.
    this.scanSkipIndex.set(set, i)
    this.scanSkipSets.push([])
    this.scanSkipSets[i] = set.map(c => this.subtree(c))
    return i
  }

  encodeRule(name: string, p: Combinator<unknown>): void {
    const body = this.node(p).ip
    // GRAMMAR-LEVEL AMBIENT TRIVIA (`rules({ trivia }, …)`).
    //
    // `run()` installs this from `entry._meta.grammarTrivia`, but ONLY for a
    // combinator entry — a compiled entry is a FUNCTION and is expected to have
    // baked it in (src/functional/run.ts:269). A table entry is also a function,
    // so without this the whole grammar parses with NO ambient trivia and every
    // whitespace-bearing input silently fails to match the same way in every
    // path — which makes a three-way identity check AGREE while proving nothing.
    // Bake it, exactly as the compiled path does.
    // AMBIENT `scanSkip`, PER RULE — the granularity `run()` uses, because it
    // reads the ENTRY rule's own `_meta.grammarScanSkip` (grammar.ts:203). It is
    // stamped by `rules({ scanSkip }, …)` on that map's rules only
    // (parser.ts:210); a `parser()` scope has no `scanSkip` at all, so a rule is
    // the finest scope that can carry one. In a `composeLeaf` grammar the pieces
    // disagree — 67 of jess's 195 css rules carry no set — and taking the first
    // one for the whole program handed those entries a skip list the interpreter
    // does not give them.
    const gss = p._meta.grammarScanSkip
    this.scanSkipOf.push(gss === undefined ? -1 : this.scanSkipSlot(gss))
    const amb = p._meta.grammarTrivia
    if (amb !== undefined) {
      // Carried so `tableRules` can stamp the entry — see TableProgram.labels.
      this.labels ??= amb._meta.triviaKindLabels
      if (amb._meta.rootTriviaClassified === true) this.classified = true
    }
    this.rules[name] = amb === undefined ? body : this.emit(OP_SCOPE, this.triviaSlot(amb), body)
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
    // THE SCANNING CONSTRUCTS, as their constructor arguments.
    //
    // Neither is recoverable from `_def` alone — `balanced()` overrides `.parse`
    // and leaves `_def` as its EAGER interior, so a structural encoding builds a
    // parser that skips the wrong things and reports nothing. Both are fully
    // described by what they were CONSTRUCTED with, which is what `ScanSpec`
    // carries; `resolveTable` hands that back to `scanTo()`/`balanced()`.
    //
    // The `balanced()` test reads `_balancedSpec` on the object `balanced()`
    // RETURNS. That object is a `token()` and the ambient marker lives on the
    // combinator INSIDE it, so testing `_balancedAmbient` here would either miss
    // the construct or reach past the `token()` that gives it its one leaf.
    const bal = (p as BalancedSpec)._balancedSpec
    if (bal !== undefined) return this.emit(OP_SCAN, this.scanSlot({
      kind: 1,
      flags: (bal.raw ? 1 : 0) | (bal.strict ? 4 : 0),
      skip: bal.ownSkip.map(c => this.subtree(c)),
      open: bal.open,
      close: bal.close,
    }))
    if (d.tag === 'scanTo') {
      const sentDef = d.sentinel._def
      return this.emit(OP_SCAN, this.scanSlot({
        kind: 0,
        flags: (d.raw ? 1 : 0) | (d.orEOF ? 2 : 0),
        skip: d.skip.map(c => this.subtree(c)),
        sentinel: this.subtree(d.sentinel),
        sent: sentDef.tag === 'literal' ? sentDef.value : null,
      }))
    }
    switch (d.tag) {
      case 'literal': {
        if (d.caseInsensitive) {
          return this.emit(this.track ? OP_LIT_CI_TRACK : OP_LIT_CI, this.constant(d.value), this.expected(deriveExpected(p)))
        }
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
        // EVERY choice now carries its arms' classes. The old code recorded them
        // only when the whole site qualified for O(1) selection — all arms
        // non-nullable, pairwise disjoint and mappable — and a single failure
        // left the site with no gate of any kind, so all its arms were entered
        // at every position it was reached.
        //
        // An arm's class is its OWN gate and is sound on its own: a
        // non-nullable arm whose first set excludes the char at `pos` cannot
        // match there, whatever the other arms do. `firstSetOf` already skips a
        // leading zero-width assertion so `not(X) Y` reports firstSet(Y) rather
        // than `any` (`first-set.ts` `isZeroWidthAssertion`), and `charClass`
        // returns −1 for anything it cannot represent — both directions are the
        // safe one. A NULLABLE arm is never gated: it can match at a position
        // its first set does not contain, by consuming nothing.
        //
        // `resolveDispatch` decides from these classes whether the site keeps
        // the O(1) table (`exclusive`) or falls to the ordered per-arm path.
        // Arm ORDER is preserved on both, which is what makes this a PEG-safe
        // change rather than a reordering.
        const classes = arms.map(a => matchesEmpty(a) ? -1 : this.charClass(firstSetOf(a)))
        const dispIdx = this.disp.length
        this.disp.push(classes)
        const head = this.emitHead(OP_CHOICE, 3 + kids.length)
        this.code[head + 1] = dispIdx
        this.code[head + 2] = kids.length
        // The choice's OWN expected set — the union both engines report.
        this.code[head + 3] = this.expected(deriveExpected(p))
        for (let i = 0; i < kids.length; i++) this.code[head + 4 + i] = kids[i]!
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
        // Bit 2: an ITEM-expected fx index follows at `ip + 6`. A list that ends
        // under `min` reports what would have let it CONTINUE — the ITEM, which
        // is what `failAt` (repeat.ts) and `deriveExpectedArr([def.parser])`
        // (codegen emitSepBy) both use; the driver otherwise reports whatever
        // sub-parse failed last, which is the SEPARATOR. Only `min >= 2` can
        // reach that end under `min` with items already taken — at `min === 1`
        // it means the FIRST item failed, and that failure already set the
        // item's own set. So no committed grammar grows by a word.
        const flags = (d.trailing === 'allow' ? 1 : 0) | (d.keepSeparators === true ? 2 : 0) | (d.min >= 2 ? 4 : 0)
        return d.min >= 2
          ? this.emit(OP_REP, child, d.min, d.max ?? -1, sep, flags, this.expected(deriveExpected(d.parser)))
          : this.emit(OP_REP, child, d.min, d.max ?? -1, sep, flags)
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
        // A node legally has NO builder when its value comes from a selection:
        // `project` replaces the builder outright, and `collapse`/`unwrap` make
        // the single captured child the value. A node with none of those and no
        // builder is STRUCTURAL — its value comes from a `ctx.build` host, which
        // this driver does not have (see the guard in exec.ts).
        if (d.build === undefined && d.project === undefined && d.collapse !== true && d.unwrap !== true) {
          throw new UnsupportedConstruct('node(structural — needs a ctx.build host)')
        }
        if (d.type === undefined) throw new UnsupportedConstruct('node(inferred type)')
        // FAIL CLOSED on fields this encoder does not lower. The capture flags below
        // are derived from the reducer's ARITY, which cannot express an explicit
        // `captureTrivia: true` on a 3-argument reducer — the author asked for
        // capture and the arity analysis would say no. Silently ignoring the request
        // yields a table that parses and drops trivia, which is the exact
        // silent-failure class this lowering exists to avoid.
        if (d.captureTrivia !== undefined) throw new UnsupportedConstruct('node(captureTrivia)')
        const child = this.node(d.parser).ip
        // Capture flags, resolved HERE from the reducer's declared arity using the
        // same analysis codegen runs (`src/compiler/build-arity.ts`). `hostMode:
        // 'cst'` forces them on, exactly as the emitted `cstOut` path does. The
        // driver reads a bit; it re-derives nothing and sees no setting.
        const cstOut = this.settings.hostMode === 'cst'
        // Field capture mirrors the interpreter's `effFields`
        // (src/combinators/node.ts): the body must actually contain `field()`
        // captures AND the reducer must read them. A node that reads fields but
        // has none, or has them and never reads them, allocates nothing.
        const wantsFields = parserHasOwnFields(d.parser) && (cstOut || buildReadsFields(d))
        // `trailingTrivia` consumes trivia INSIDE the node's capture scope, so it
        // lands in THIS node's log — the interpreter does it before
        // `endCstNodeCapture`, and doing it after would put the run in the parent.
        const flags = (cstOut || buildReadsTrivia(d) ? 4 : 0)
          | (cstOut || buildReadsState(d) ? 8 : 0)
          | (wantsFields ? 16 : 0)
          | (d.collapse === true ? 32 : 0)
          | (d.unwrap === true ? 64 : 0)
          | (d.trailingTrivia === true ? 128 : 0)
        const body = this.emit(
          this.track ? OP_NODE_TRACK : OP_NODE,
          d.build === undefined ? -1 : this.fn(d.build),
          child, flags,
          d.project ?? -1,
          this.constant(d.type),
          // `tags` reaches a `ctx.build` host as its 8th argument. jess's
          // `cssCstBuildHost` is built with `{ tags: true }` and puts them on
          // every CST node, so this is load-bearing, not reflection trivia.
          d.tags === undefined ? -1 : this.constant(d.tags),
        )
        // The rule's own first-set gate — the emitted code's `_ngc` test, as data.
        // A NULLABLE rule has no gate: it succeeds on input its first set does
        // not contain (including EOF), so gating it would reject a legal empty
        // match. Caught by the ladder's `empty` and `garbage` cases.
        if (matchesEmpty(p)) return body
        const cls = this.charClass(firstSetOf(p))
        if (cls < 0) return body
        return this.emit(OP_GATE, cls, body, this.expected(deriveExpected(p)))
      }
      case 'token':
        return this.emit(OP_TOKEN, this.node(d.parser).ip)
      case 'routed':
        return this.emit(OP_ROUTED, d.fallback === undefined ? -1 : this.node(d.fallback).ip)
      case 'dispatch': {
        // A `routed()` in the SELECTOR is a hard error in the interpreter
        // (dispatch.ts:318) — it would ask for a token that has not been read yet.
        if (parserUsesRouted(d.selector as Combinator<unknown>)) {
          throw new UnsupportedConstruct('dispatch(routed() in selector)')
        }
        const sel = this.node(d.selector as Combinator<unknown>).ip
        const arms: number[] = []
        const routed: number[] = []
        const key: string[] = [], keyArm: number[] = []
        const fold: string[] = [], foldArm: number[] = []
        const match: Array<readonly [number, string, string, number]> = []
        const expected: string[] = []
        // ARM ORDER IS RESOLUTION ORDER: exact key, then ASCII-folded key, then
        // matchers in declaration order, then otherwise. Mirrors dispatch.ts:325.
        for (const c of d.cases) {
          const arm = arms.length
          arms.push(this.node(c.parser).ip)
          routed.push(branchUsesRouted(c) ? 1 : 0)
          for (const kk of c.keys) {
            expected.push(JSON.stringify(kk))
            if (c.caseInsensitive) { fold.push(asciiFoldKey(kk)); foldArm.push(arm) }
            else { key.push(kk); keyArm.push(arm) }
          }
        }
        const KIND = { startsWith: 0, endsWith: 1, matches: 2 } as const
        for (const m of d.matchers ?? []) {
          const arm = arms.length
          arms.push(this.node(m.parser).ip)
          routed.push(branchUsesRouted(m) ? 1 : 0)
          match.push([KIND[m.kind], m.value, m.flags ?? '', arm])
        }
        const other = d.otherwise === undefined ? -1 : this.node(d.otherwise).ip
        const dspIdx = this.dsp.length
        this.dsp.push({ key, keyArm, fold, foldArm, match, routed, expected })
        const head = this.emitHead(OP_DISPATCH, 5 + arms.length)
        this.code[head + 1] = sel
        this.code[head + 2] = dspIdx
        this.code[head + 3] = other
        // THE FALLBACK'S ROUTED BIT IS WALKED, NOT READ OFF THE DEF.
        //
        // `d.otherwiseUsesRouted` is computed when `otherwise()` is CONSTRUCTED
        // (dispatch.ts:189), and at that moment a `g.X` inside the arm is an
        // unresolved ref whose thunk throws — `parserUsesRouted` catches and
        // answers `false`. The interpreter never reads the stored flag alone: it
        // calls `branchUsesRouted` at PARSE time (dispatch.ts:335), which ORs the
        // flag with a live walk of the now-resolved graph.
        //
        // Reading only the flag here is why `@charset "UTF-8";` — one line of
        // plain CSS — failed under the table with `expected: ["routed()"]`: the
        // fallback ran at the selector's END with no routed token, so the
        // `routed()` inside it had nothing to yield. Every case arm was already
        // walked (`branchUsesRouted(c)` above); the fallback was the one branch
        // that was not.
        const otherRouted = d.otherwise === undefined
          ? false
          : branchUsesRouted({ parser: d.otherwise as Combinator<unknown>, usesRouted: d.otherwiseUsesRouted === true })
        this.code[head + 4] = otherRouted ? 1 : 0
        this.code[head + 5] = arms.length
        for (let i = 0; i < arms.length; i++) this.code[head + 6 + i] = arms[i]!
        return head
      }
      case 'field':
        return this.emit(OP_FIELD, this.constant(d.name), this.node(d.parser).ip)
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
        // `rootCapture: 'opaque'` is INERT for parsing. grammar.ts reads it only
        // inside a `_rootTriviaStrictScopes` validation throw; it declares that
        // this scope's trivia is opaque to root capture, which `run()` consumes.
        // Nothing in the parse changes, so there is nothing for the table to
        // lower — accepting it is not a gap, it is the correct lowering.
        // ONLY `true` IS MEANINGFUL HERE. `grammar.ts:94` stores
        // `opts.trackLines ?? false`, so an UNSET scope and an explicitly-false
        // one are the same value on the def — the distinction is lost. At parse
        // time `:103` reads `opts.trackLines ?? _ctx?.trackLines ?? false`, i.e.
        // unset INHERITS. So stored-false cannot be read as "force off", and
        // comparing it against the setting refused every inner scope of a
        // trackLines:true grammar — all four `*PositionsGrammar`s.
        //
        // A scope that asks to force tracking ON inside a table built without it
        // is still a real disagreement, and still refuses.
        if (d.trackLines === true && !this.track) {
          throw new UnsupportedConstruct(
            `parser(trackLines: true) inside a table built with TableSettings.trackLines: ${String(this.track)}`,
          )
        }
        // A trivia scope is a ROW, not a lowering decision: the scope's trivia
        // combinator goes in the const pool and the driver installs it.
        if (d.clearTrivia === true) return this.emit(OP_SCOPE, -1, this.node(d.parser).ip)
        if (d.triviaParser === undefined) return this.node(d.parser).ip
        return this.emit(OP_SCOPE, this.triviaSlot(d.triviaParser), this.node(d.parser).ip)
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
        // ARMS START AT ip+4. `ip+3` is the choice's own EXPECTED-SET index, and
        // rewriting it here treated an `fx` index as a code offset: when the row
        // at that offset happened to be `OP_RULE` the index was replaced by that
        // row's target, so a failing choice reported a different expected set —
        // and the bogus "target" was then pushed onto the walk and its operands
        // rewritten as if they were child slots. It also left the LAST arm
        // uncollapsed, which is the only part of this that was merely slow.
        case OP_CHOICE: return Array.from({ length: this.code[ip + 2]! }, (_, i) => ip + 4 + i)
        case OP_REP: case OP_REPV: return this.code[ip + 4]! >= 0 ? [ip + 1, ip + 4] : [ip + 1]
        default: return []
      }
    }
    const seen = new Set<number>()
    // Scan subtrees are ROOTS too: a sentinel or skipper is reached through
    // `prog.scans`, not through any code slot, so leaving them out left their
    // interiors uncollapsed and — worse — left the spec's own offset pointing at
    // a trampoline whose target had been rewritten around it.
    const refs: SubtreeRef[] = []
    for (const s of this.scans) {
      if (s.sentinel !== undefined) refs.push(s.sentinel)
      refs.push(...s.skip)
    }
    for (const set of this.scanSkipSets) refs.push(...set)
    const stack = [...Object.values(this.rules), ...refs.map(r => r[0])]
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
    const res = (r: SubtreeRef): SubtreeRef => [resolve(r[0]), r[1]]
    this.scans = this.scans.map(s => ({
      ...s,
      skip: s.skip.map(res),
      ...(s.sentinel === undefined ? {} : { sentinel: res(s.sentinel) }),
    }))
    this.scanSkipSets = this.scanSkipSets.map(set => set.map(res))
  }

  finish(): TableProgram {
    if (this.code.length === 0) this.emit(OP_EMPTY)
    this.collapseIndirection()
    return {
      code: this.code, k: this.k, fns: this.fns, cc: this.cc,
      fx: this.fx, disp: this.disp, dsp: this.dsp, rules: this.rules,
      ...(this.labels === undefined ? {} : { labels: this.labels }),
      ...(this.classified ? { classified: 1 as const } : {}),
      ...(this.scanSkipSets.length === 0
        ? {}
        : { scanSkip: this.scanSkipSets, scanSkipOf: this.scanSkipOf }),
      ...(this.scans.length === 0 ? {} : { scans: this.scans }),
      ...(this.settings.hostMode === undefined ? {} : { hostMode: this.settings.hostMode }),
      ...(this.runtimeOnly.size === 0 ? {} : { runtimeOnly: [...this.runtimeOnly].sort() }),
      ...(this.triviaSpecs.length === 0 ? {} : { triviaSpecs: this.triviaSpecs }),
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
