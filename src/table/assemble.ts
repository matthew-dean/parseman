/**
 * THE ASSEMBLER — the table, LINKED into closures instead of interpreted.
 *
 * This is ledger row G5 as stated: *"build the grammar reference at run start,
 * making the swaps on rules / sub-rules (leaves) at that point, then run with NO
 * logic branching for that option input"*. `exec.ts` builds the same table and
 * then interprets it: one `switch (code[ip])` over 29 opcodes, executed ONCE PER
 * ROW — 497,360 rows for `benchmark.less` (`bench/jess/g5-rows.ts`) — each
 * re-reading its opcode and re-decoding its operands from the `Int32Array`, and
 * re-testing the same per-parse options. That is the per-node branching the
 * design exists to remove.
 *
 * ## The shape
 *
 * Assembly walks the reachable table ONCE and lowers each site to a PIECE: a
 * closure with its operands already captured as `const`s and its children bound
 * as DIRECT references to their own pieces. At parse time there is no opcode
 * read, no operand decode and no switch — a piece is called, and it calls the
 * pieces it holds.
 *
 * The numbers that make this obviously the right trade, measured not assumed:
 *
 *   2,241  distinct reachable sites in the less table (`bench/jess/g5-sites.ts`)
 * 497,360  rows executed for one parse of `benchmark.less`
 *
 * Pieces are GRAMMAR-sized; rows are INPUT-sized. Assembly allocates ~2.2k
 * closures once per process and removes a dispatch plus an operand decode from
 * ~497k executions — a 222x ratio. Assembly cost is paid once and is not the
 * metric; it is measured anyway (`bench/jess/g5-ms.ts`, `bench/jess/g5-profile.ts`).
 *
 * ## Why this is not "just tuning the switch"
 *
 * A 29-case switch on an `Int32Array` load is a jump table whose successor V8
 * cannot know. The interpreter loop is ONE basic block with 29 merge edges, so
 * TurboFan cannot specialise any arm against its caller and every operand stays
 * an untyped load. Measured on this branch: `exec` reaches TURBOFAN and is
 * deoptimised back to MAGLEV repeatedly — 100 deopt events in a 20-parse run.
 * The design was not paying dispatch overhead, it was opting its whole hot path
 * out of the optimising compiler.
 *
 * A piece is created once and its call sites see one shape, so they stay
 * monomorphic and TurboFan can inline them. That is the structural win, and it is
 * why the target is codegen's number rather than a fraction of the gap.
 *
 * ## Why this keeps the artifact small
 *
 * The pieces ship ONCE, here, shared by every grammar and every variant. What a
 * bundle carries is still the table — DATA. Codegen's 2.10 MB is recognition
 * machinery inlined bespoke per rule; this stays at the table's 0.56 MB because
 * the machinery is one copy in the runtime and the variation lives in the
 * ASSEMBLY, not in duplicated piece bodies.
 *
 * ## Options are consumed by SELECTION, not by testing
 *
 * The piece set is a SUPERSET; an option set reaches a subset of it. Assembly
 * walks from the entry rule and instantiates only what it touches, so a piece an
 * option excludes is never allocated, never linked and costs zero at run — not a
 * cheap branch, zero. Where a decision is knowable from the option set
 * (`hostCst` below), assembly picks the piece rather than emitting one that
 * tests. `scripts/check-invariants.mjs` enforces that no piece body reads a
 * config field; see `CONFIG_FIELDS` there.
 *
 * Semantics are `exec.ts`'s, case for case. That file remains the reference and
 * the three-way identity sweep gates this against it.
 */
import type { Combinator, FieldMap, FirstSet, ParseContext, ParseResult, ParserDef } from '../types.ts'
import { balanced, scanTo } from '../combinators/scanTo.ts'
import { buildFieldMap } from '../compiler/fields.ts'
import { asciiFoldKey } from '../combinators/dispatch.ts'
import { projectChild, unwrapChild } from '../combinators/node.ts'
import { cstOutputHost } from '../compiler/build-arity.ts'
import { consumeTrivia } from '../combinators/trivia-skip.ts'
import {
  advanceTrivia, commitTriviaScan, needsDeferredTriviaCommit, rollbackScannedTriviaAt, rollbackTrivia, rollbackTriviaAt,
  saveTriviaMark, scanTrivia, scanTriviaCompact, skipTriviaScanned, type FastTriviaScanner,
} from '../combinators/trivia-skip.ts'
import {
  cstCaptureActive, cstLeavesLen, cstTlLen,
  demoteCapturedToRaw, pushCstChild, pushCstLeaf,
  type CstCaptureBuf,
} from '../cst/capture-buffer.ts'
import {
  OP_CHOICE, OP_EMPTY, OP_GATE, OP_LEAF, OP_LIT, OP_NODE, OP_NOT, OP_OPT,
  OP_PEEK, OP_REP, OP_REPV, OP_RULE, OP_RX, OP_SEQ, OP_SEQV, OP_XFORM,
  OP_LIT_TRACK, OP_RX_TRACK, OP_NODE_TRACK, OP_SCOPE, OP_SCOPE_CAP, OP_SCOPE_PLAIN, OP_EXPECT, OP_SEQX, OP_SCAN,
  OP_LIVE,
  OP_FIELD, OP_DISPATCH, OP_ROUTED, OP_LIT_CI, OP_LIT_CI_TRACK, OP_TOKEN, OP_WITHCTX, OP_GUARD, OP_ATTEMPT, OP_LABEL,
  OP_COV,
  OP_ADJ, OP_GREEDY, OP_REJECT, OP_ARMGATE,
  OP_LEX_BODY, OP_LEX_PROGRAM,
} from './ops.ts'
import { adjacencyHolds, adjacencyMisuse } from '../combinators/adjacency.ts'
import { failAt } from '../combinators/probe.ts'
/**
 * U4 — the emitted engine, and the three pure helpers both engines share.
 *
 * `spanLines`/`rawEntry`/`lead` moved out of this function's closure so the
 * emitted assembly can call the SAME definitions. A second copy of `rawEntry`
 * is exactly how a CST leaf's span drifts between two engines that exist to be
 * gated against each other.
 */
import {
  EMITTED_PARAMS, Unemittable, emitAssemblySource, rebuildPools,
  type EmittedAssembly, type EmittedFactory,
} from './emit-assembly.ts'
import { lead, rawEntry, spanLines } from './run-support.ts'
/**
 * THE COMPLETIONS PROBE, at the terminal fail sites and nowhere else.
 *
 * `failAt` (combinators/probe.ts) is called from exactly three places in the
 * interpreter — `literal.ts`, `regex.ts`, `keywords.ts` — and codegen emits its
 * mirror (`probeUpdate`) at the same leaf-fail sites. The table recorded
 * NOTHING, so `completionsAt` on a table artifact saw only the top-level
 * failure: a swallowed item failure inside a `sepBy` (`'{'` at offset 1 in a
 * `{ decl; }` grammar) never reached the probe and the item's opener vanished
 * from the completion set.
 *
 * Dormant unless `completionsAt` set `_probe`, so an ordinary parse pays one
 * property read per terminal miss — the same price codegen pays.
 */
import {
  classHas, decodeClassSpec, expandCompact, resolveTable,
  validateDispatchSpec,
  type CompactProgram, type ResolvedClass, type ResolvedTable,
  type SubtreeRef, type TableProgram, type TableRule,
} from './program.ts'
import { stampRuleMap } from './stamp.ts'
import { computeSiteLabels, reachableSites } from './site-labels.ts'
import { refuseUnclassifiedRootScope } from '../cst/root-trivia-scope.ts'
import { captureError, firstSetSentinel, matchesAt, orSentinel, recoverScan } from '../recovery/scan.ts'
import {
  leadingScalarTerminal, makeScalarRecognizer, scalarTerminalNodeChild,
  scalarTerminalNotChild, type ScalarRecognizer,
} from './scalar-terminal.ts'

/**
 * Is the EMITTED engine (`emit-assembly.ts`) enabled for this process?
 *
 * Read ONCE, here, at module load — never on a parse path and never per
 * assembly. It exists so the two engines can be A/B'd in ONE checkout: the
 * bench guidance is explicit that a cross-worktree comparison carries a bias
 * repetition does not remove.
 */
const EMIT_ENABLED = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.PM_TABLE_EMIT !== '0'

/** Failure sentinel — SHARED with the other two engines, see `cell.ts`. */
import { FAIL, newEndCell } from './cell.ts'

const EMPTY_TL: readonly number[] = Object.freeze([])
/** `finishCstBuf`'s two empty sentinels, held here so the node piece can inline it. */
const EMPTY_CH: unknown[] = []
const EMPTY_TLOG: number[] = []
const EMPTY_FX: string[] = []
const ROUTED_FX: string[] = ['routed()']
/** The sentinel pool a STRICT emitted assembly binds — it has no reader. */
const EMPTY_SENTS: readonly (Combinator<null> | undefined)[] = Object.freeze([])
/**
 * One encoded matcher arm, LINKED into a predicate at assembly.
 *
 * The previous form rebuilt a `DispatchMatcherCase` per arm PER PARSE and handed
 * it to `matchesDispatchMatcher` — an operand decode and an allocation in a piece
 * body, and it passed a hardcoded `caseInsensitive: false`, which silently
 * dropped `{ caseInsensitive: true }` on matcher arms and selected the wrong arm.
 * The encoder now folds the case-insensitivity into the operands (kinds 3/4 are
 * pre-folded startsWith/endsWith; a case-insensitive `matches` carries `i` in its
 * flags), so the whole decision is a `const` closure chosen once.
 */
function linkMatcher(m: readonly [number, string, string, number]): (key: string) => boolean {
  const value = m[1]
  switch (m[0]) {
    case 0: return key => key.startsWith(value)
    case 1: return key => key.endsWith(value)
    case 3: return key => asciiFoldKey(key).startsWith(value)
    case 4: return key => asciiFoldKey(key).endsWith(value)
    default: {
      const flags = m[2]
      // `matches()` refuses global/sticky patterns, so every compiler-owned
      // matcher has stable `lastIndex` and can be compiled once per assembly.
      // Preserve the old fresh-per-test behavior for hand-built low-level rows
      // that contain g/y or invalid flags rather than broadening the wire ABI.
      if (!flags.includes('g') && !flags.includes('y')) {
        try {
          const pattern = new RegExp(value, flags)
          return key => pattern.test(key)
        } catch {}
      }
      return key => new RegExp(value, flags).test(key)
    }
  }
}

type Leaf = { _tag: 'leaf'; value: string; span: { start: number; end: number } }

/**
 * The `COV` slot's value when a parse installs no collector. ONE shared function
 * across every assembly, so the slot's type never widens to `| undefined` and no
 * counter piece has to test it.
 */
const NO_COVERAGE = (_id: string): void => {}

/**
 * THE PIECE SIGNATURE — uniform, narrow, and the same for every one of the 29
 * lowerings.
 *
 * Three arguments and one return, so every call site in the assembled graph sees
 * one shape and stays monomorphic. A wider or varying signature (an out-param
 * object, a per-op return shape) reintroduces the polymorphism this design
 * exists to remove, and it would show up as exactly the megamorphic call sites
 * `exec`'s switch already was.
 *
 * The end position travels in the assembly-scope `EC.e` slot, as it does in
 * `exec.ts` and in codegen's `_pfEnd`, rather than in the return value — a
 * `{ value, end }` pair would be an allocation per row.
 */
type Piece = (input: string, pos: number, ctx: ParseContext) => unknown
type NodeBuilder = (
  children: readonly unknown[], fields: FieldMap | undefined, span: { start: number; end: number },
  rawChildren: readonly unknown[], triviaLog: readonly number[], state: unknown,
) => unknown
type ChoiceExpectedPrefix = (
  target: number, prev: number, acc: string[] | undefined,
) => string[] | undefined
type MaskedChoiceBlock = (
  input: string, pos: number, ctx: ParseContext, bits: number,
  need: boolean, mRaw: number, mTl: number, mLv: number, mFl: number,
  mEr: number, mLog: number, mRoot: number,
  acc: string[] | undefined, prev: number, best: number,
) => unknown
type GeneralChoiceBlock = (
  input: string, pos: number, ctx: ParseContext, c: number,
  need: boolean, mRaw: number, mTl: number, mLv: number, mFl: number,
  mEr: number, mLog: number, mRoot: number,
  acc: string[] | undefined, prev: number, best: number,
) => unknown
type ExclusiveChoiceBlock = (arm: number, input: string, pos: number, ctx: ParseContext) => unknown
type DispatchMatcher = (key: string) => boolean
type DispatchMatcherBlock = (key: string) => number | undefined
type DispatchBranch = (
  input: string, pos: number, selEnd: number, key: string,
  selectorMark: ReturnType<typeof saveTriviaMark>, ctx: ParseContext,
) => unknown
type DispatchArmBlock = (
  arm: number, input: string, pos: number, selEnd: number, key: string,
  selectorMark: ReturnType<typeof saveTriviaMark>, ctx: ParseContext,
) => unknown

/**
 * ONE NON-FIRST SEQUENCE TERM, in a sequence that carries an adjacency
 * assertion. Returns the new cursor or −1, with the value in `TERMV` —
 * `nextTerm`'s protocol, so a bound term and a bound assertion are
 * interchangeable in the loop and the loop tests neither.
 */
type TermRunner = (
  input: string, cur: number, ctx: ParseContext,
  inheritedSync?: Combinator<unknown>,
) => number
type SequenceTermBlock = (
  input: string, cur: number, ctx: ParseContext, values: unknown[] | undefined,
  inheritedSync?: Combinator<unknown>,
) => number

/**
 * The option set an assembly is specialised for.
 *
 * These are the facts `run()` fixes BEFORE the entry is called and that never
 * change during a parse, so they are resolved by choosing a piece rather than by
 * a test inside one. Anything that varies DURING a parse (position, the capture
 * sinks a `node()` opens and closes, the error sink's contents) is runtime and
 * stays where it is.
 */
export type RunCfg = {
  /** Is this parse's host a CST-output host? Fixes `OP_NODE`'s whole shape. */
  readonly hostCst: boolean
  /**
   * Does the structural host consume the semantic `children` array? `false`
   * selects raw-only node collectors. Collapse forces this back to true at the
   * run boundary because its predicate consumes both child views.
   */
  readonly hostReadsChildren?: boolean
  /**
   * Structural node types whose host consumes trivia. Evaluated while an
   * assembly is built, once per node site, never from the node execution path.
   * Absent means the backwards-compatible default: capture every structural
   * node's trivia.
   */
  readonly hostCaptureTrivia?: ((type: string) => boolean) | undefined
  /** `ctx.trackLines` — decides whether the trivia leaf swap is legal at all. */
  readonly trackLines: boolean
  /**
   * `ctx._tolerant` — is THIS parse allowed to recover?
   *
   * FIXED FOR THE LIFETIME OF A PARSE, which is what makes it legal here rather
   * than a per-piece test. Every writer of `ctx._tolerant` sets it BEFORE the
   * parse begins and never during — `compile.ts:119` (`parseWithErrors`),
   * `functional/run.ts:399`, `functional/doc.ts:29`, `combinators/completions.ts:40`.
   * The single mid-parse mutation is `recovery/scan.ts:36`, which CLEARS it for
   * the duration of a sentinel probe and restores it in `finally`; a sentinel is
   * a `firstSetSentinel` char-class combinator (or an `orSentinel` of two), never
   * an assembled rule, so no piece runs under the cleared value. Even if one did,
   * the selection would be the RIGHT one: a probe must not recover, and it would
   * get the strict assembly.
   *
   * Contrast `cstCaptureActive`, which a previous lane proposed for the same
   * treatment and which is per-NODE state — keying on that would have been
   * incorrect, not merely redundant.
   */
  readonly tolerant: boolean
  /**
   * `ctx._grammarCoverage` — is THIS parse counting grammar coverage?
   *
   * FIXED FOR THE LIFETIME OF A PARSE, checked the same way `tolerant` was. There
   * are exactly two writers — `createGrammarInstrumentationContext` (coverage.ts),
   * which builds the field into a FRESH context object before any parse, and
   * `functional/run.ts:403`, which installs it on the context it is about to run
   * — and no reader anywhere mutates or clears it, mid-parse or otherwise.
   * `createParseContext` initialises it to `undefined` once, at construction.
   *
   * So it is per-PARSE, unlike `ctx._cstBuf`, which a previous lane proposed
   * keying on and which `beginCstNodeCapture`/`endCstNodeCapture` replace per
   * NODE — that selection would have been incorrect, not merely redundant.
   *
   * An ordinary table has no `OP_COV` rows at all, so this bit selects a DIFFERENT
   * assembly only for a table encoded with a coverage plan. For every other table
   * the two assemblies are identical work and the extra bit costs one cache slot.
   */
  readonly coverage: boolean
  /**
   * `ctx._probe !== undefined` — is THIS parse feeding a completions probe?
   *
   * FIXED FOR THE LIFETIME OF A PARSE, on exactly the evidence `tolerant` is
   * held to. The two writers both install it BEFORE the parse begins and never
   * during — `combinators/grammar.ts:213` (built in `run()`'s prologue when
   * `recover` is set) and `combinators/completions.ts:38`. The single mid-parse
   * mutation is `recovery/scan.ts:29`, which CLEARS it for the duration of a
   * sentinel probe and restores it in `finally`; a sentinel is a
   * `firstSetSentinel` char-class combinator, never an assembled rule, so no
   * piece runs under the cleared value. Even if one did the selection would be
   * the RIGHT one — a sentinel probe must fail fast, and it would get the
   * strict assembly.
   *
   * It is here for `OP_GATE`, which is the only piece that reads it on a
   * SUCCESS path. The six leaf sites read it after their own `return`, on the
   * failure path only, and are deliberately left alone: selecting a second body
   * per literal length to remove a failure-path test would double the runtime's
   * literal bodies to buy nothing measurable.
   */
  readonly probe: boolean
}

/** THE bit packing for an assembly cache key. Six bits, so at most sixty-four
 * ordinary assemblies per table. Host trivia predicates use a host-identity
 * cache in addition to this key because their per-type answer is not one bit.
 *
 * Taken as six booleans rather than as a `RunCfg` because `AssemblyCache.forCtx`
 * runs once per entry invocation and must allocate nothing — it derives these bits
 * from the `ctx` and builds a `RunCfg` only on the miss. That constraint is why the
 * packing was written twice, 2500 lines apart in this file, and a bit added to one
 * copy but not the other is a cache COLLISION: a parse served the wrong assembly.
 * Splitting the packing from the object read satisfies both callers from one place. */
function cfgKeyOf(hostCst: boolean, trackLines: boolean, tolerant: boolean, coverage: boolean, probe: boolean, hostReadsChildren = true): number {
  return (hostCst ? 1 : 0) | (trackLines ? 2 : 0) | (tolerant ? 4 : 0)
    | (coverage ? 8 : 0) | (probe ? 16 : 0) | (hostReadsChildren ? 0 : 32)
}

/** The cfg key an assembly is cached under. */
export function cfgKey(c: RunCfg): number {
  return cfgKeyOf(c.hostCst, c.trackLines, c.tolerant, c.coverage, c.probe, c.hostReadsChildren)
}

export type Assembly = {
  /** One entry piece per rule name, already linked. */
  readonly pieces: Readonly<Record<string, Piece>>
  readonly end: () => number
  /**
   * Per-parse reset. What `exec.ts`'s `begin` DECIDED here (`trackLines`, the
   * host mode) is exactly what assembly resolved, so all that is left is
   * clearing the installed scanner and latching the host value.
   */
  readonly begin: (ctx: ParseContext) => void
  /** Close an invocation and restore a suspended re-entrant frame, if any. */
  readonly finish: () => void
  readonly scanSkip: readonly (readonly Combinator<unknown>[])[]
  /**
   * The sites this option set actually REACHED. A strict subset of the table's
   * reachable set whenever an option excludes anything, and the assertion
   * `test/unit/table-assemble.test.ts` makes on that.
   */
  readonly reached: ReadonlySet<number>
  /**
   * WHY THIS ASSEMBLY IS RUNNING CLOSURES, when it is.
   *
   * `undefined` means the emitted engine (`emit-assembly.ts`) built this
   * assembly. A string names the construct it refused. It is a field rather
   * than a log line because a grammar that quietly drops to the closure path
   * is a permanently slow path nobody would ever find — the same failure
   * `encode.ts:1208-1213` refuses to allow for `OP_LIVE`.
   */
  readonly emitRefusal: string | undefined
}

/**
 * Link one resolved table, for one option set, into a graph of closures.
 *
 * ONE walk. Each site is lowered at most once and memoised by its code offset,
 * so a subtree shared by two parents is one piece with two references to it.
 */
export function assemble(t: ResolvedTable, prog: TableProgram, cfg: RunCfg): Assembly {
  const { code, k, fns, cc, fx, disp, dsp, trivia, triviaLabelled } = t
  // The leaf swap is only legal when line tracking is off, and that is a property
  // of the OPTION SET — so it is decided HERE, once, and the scope pieces below
  // are chosen accordingly. `exec.ts` re-tested `FAST` at every scope entry.
  const triviaScan = t.triviaScan
  const swapLegal = !cfg.trackLines
  const hostCst = cfg.hostCst
  /**
   * DOES THIS ASSEMBLY LOWER RECOVERY? Two facts, both known here.
   *
   * `prog.rec === 1` is TABLE DATA — `encodeTable({ recovery })` lays down the
   * inferred sync operands, and their presence is what makes the recovery pieces
   * lowerable at all. It is now always 1, since recovery is always lowered.
   *
   * `cfg.tolerant` is the OPTION half. Recovery being lowered into the table must
   * not make a strict parse pay for it, and the way this design resolves an
   * option is by CHOOSING A PIECE, not by testing a flag inside one. So the
   * tolerant assembly holds the recovery pieces and the strict assembly holds the
   * arity-specialised ones it always held — `RunCfg.tolerant` documents why that
   * is sound. `parseWithErrors` and `completionsAt` set `_tolerant` before the
   * entry runs, so they land on the tolerant assembly; every other parse gets a
   * graph with no recovery in it anywhere.
   *
   * Dormancy is unchanged for the OTHER two engines: the source lowering
   * (`codegen.ts:3153`) and the interpreter (`repeat.ts:163`) still gate on
   * `ctx._tolerant` at runtime, and the recovery pieces below keep their own
   * `_tolerant === true` failure-path gates so `exec.ts` stays the identity
   * reference.
   */
  const REC = prog.rec === 1 && cfg.tolerant
  /**
   * The sync sentinel for a char-class index, built ONCE at assembly.
   *
   * `firstSetSentinel` is the interpreter's own constructor and codegen calls it
   * per publish through `_ctx._rec.sentinel(...)`; the ranges are recoverable from
   * the class spec, so the table builds the identical combinator here and the
   * publish is a slot read. −1 means "no usable sentinel", which is the same
   * answer `firstSetSentinel` gives for an `any`/`empty` first set.
   */
  const sentinels = new Map<number, Combinator<null> | undefined>()
  function sentinelFor(cls: number): Combinator<null> | undefined {
    if (cls < 0) return undefined
    const hit = sentinels.get(cls)
    if (hit !== undefined || sentinels.has(cls)) return hit
    const spec = prog.cc[cls]!
    const ranges = decodeClassSpec(spec)
    const made = firstSetSentinel({ kind: 'ranges', ranges }) ?? undefined
    sentinels.set(cls, made)
    return made
  }

  /**
   * THE ONE END-POSITION CELL FOR THIS ASSEMBLY (`_pfEnd` in emitted code).
   *
   * Whichever engines this assembly builds — the closure pieces below, the
   * emitted pieces from `emit-assembly.ts`, an `exec.ts` driver — all write
   * this slot, so a piece from one may be called by a piece from another. Per
   * ASSEMBLY rather than per module: two grammars live in one process must not
   * share it. See `cell.ts`.
   */
  const EC = newEndCell()

  // Indexed by the existing constant-pool operand: the same scalar recognizer
  // serves an ordinary terminal piece and a direct terminal-node materializer.
  // Value/CST/failure/cursor effects stay in those consumers.
  const scalarRecognizers: Array<ScalarRecognizer | undefined> = []
  const rawScalarSpecs = new Set<number>()
  function scalarFor(child: number): ScalarRecognizer | undefined {
    const spec = code[child + 1]!
    let recognize = scalarRecognizers[spec]
    if (recognize === undefined) {
      recognize = makeScalarRecognizer(code[child]!, k[spec])
      scalarRecognizers[spec] = recognize
    }
    return recognize
  }

  const labelExtraIps: number[] = []
  for (const s of prog.scans ?? []) {
    for (const r of s.skip) labelExtraIps.push(r[0])
    if (s.sentinel !== undefined) labelExtraIps.push(s.sentinel[0])
  }
  for (const set of prog.scanSkip ?? []) for (const r of set) labelExtraIps.push(r[0])
  const closureLabels = computeSiteLabels(
    code, [...Object.values(prog.rules), ...labelExtraIps], hostCst,
  )

  /**
   * The INSTALLED trivia scanner for the scope currently running.
   *
   * Still a slot rather than a capture because `OP_SCOPE` and `OP_TOKEN` change
   * it DURING a parse — it is runtime state, not configuration. What assembly
   * removed is the per-scope re-test of `FAST` and `triviaLabelled`: which
   * scanner a scope installs is now a `const` in that scope's piece.
   */
  let SCAN: FastTriviaScanner | null = null

  const memo = new Map<number, Piece>()
  const reached = new Set<number>()

  function pushLeaf(ctx: ParseContext, value: string, s: number, e: number): void {
    const lf: Leaf = { _tag: 'leaf', value, span: { start: s, end: e } }
    pushCstLeaf(ctx, lf)
  }

  /**
   * The three dominant AST node shapes, selected once while linking.
   *
   * The generic node body is necessarily broad: CST hosts, tracked spans,
   * fields, trivia/state reads, structural hosts, projections, collapse and
   * unwrap all share it. That made its one FunctionLiteral 1,100+ V8 bytecodes
   * even for the ordinary AST builder that needs none of those branches. Jess's
   * exact AST workloads execute the three shapes below 42k/66k/205k times per
   * CSS/Less/generated parse. Keep their bodies scalar and keep every other
   * shape on the generic oracle below.
   */
  function plainBuildNode(child: Piece, build: NodeBuilder): Piece {
    return (input, pos, ctx) => {
      const sCh = ctx._cstChildren
      const sLv = ctx._cstLeaves
      const sRaw = ctx._cstRawChildren
      const sTl = ctx._cstTriviaLog
      const sCap = ctx.captureTrivia
      const sBuf = ctx._cstBuf
      const savedFields = ctx._fields
      const buf: CstCaptureBuf = {}
      ctx._cstBuf = buf
      ctx._cstChildren = undefined
      ctx._cstLeaves = undefined
      ctx._cstRawChildren = undefined
      ctx._cstTriviaLog = undefined
      ctx.captureTrivia = false
      ctx._fields = undefined
      const value = child(input, pos, ctx)
      const kids = buf.ch ?? (buf.single !== undefined ? [buf.single] : EMPTY_CH)
      const rawKids = buf.raw ?? (buf.rawSingle !== undefined ? [buf.rawSingle] : EMPTY_CH)
      ctx._fields = savedFields
      ctx._cstBuf = sBuf
      ctx._cstChildren = sCh
      ctx._cstLeaves = sLv
      ctx._cstRawChildren = sRaw
      ctx._cstTriviaLog = sTl
      ctx.captureTrivia = sCap
      if (value === FAIL) return FAIL
      const end = EC.e
      const span = { start: pos, end }
      const node = build(kids, undefined, span, rawKids, EMPTY_TL, undefined)
      if (sBuf !== undefined || sCh !== undefined) {
        pushCstChild(ctx, node, rawEntry(node, input, pos, end))
      }
      EC.e = end
      return node
    }
  }

  /** The lazy capture buffer uses `single === undefined` as its empty sentinel:
   * leading undefined semantic children are therefore absent, while undefined
   * values after the first present child are retained in `ch`. A flat collector
   * normalizes only that cold prefix so the builder sees the identical list. */
  function capturedFlatChildren(children: unknown[]): readonly unknown[] {
    if (children.length === 0) return EMPTY_CH
    if (children[0] !== undefined) return children
    let first = 1
    while (first < children.length && children[first] === undefined) first++
    return first === children.length ? EMPTY_CH : children.slice(first)
  }

  /** Direct reducer whose declared arity proves `rawChildren` is unobservable.
   * Use the existing split children/leaves collector instead of opening a
   * duplicate raw capture buffer. The body shape is selected while linking. */
  function childrenOnlyBuildNode(child: Piece, build: NodeBuilder): Piece {
    return (input, pos, ctx) => {
      const sCh = ctx._cstChildren
      const sLv = ctx._cstLeaves
      const sRaw = ctx._cstRawChildren
      const sTl = ctx._cstTriviaLog
      const sCap = ctx.captureTrivia
      const sBuf = ctx._cstBuf
      const savedFields = ctx._fields
      const kids: unknown[] = []
      ctx._cstBuf = undefined
      ctx._cstChildren = kids
      ctx._cstLeaves = kids
      ctx._cstRawChildren = undefined
      ctx._cstTriviaLog = undefined
      ctx.captureTrivia = false
      ctx._fields = undefined
      const value = child(input, pos, ctx)
      const captured = capturedFlatChildren(kids)
      ctx._fields = savedFields
      ctx._cstBuf = sBuf
      ctx._cstChildren = sCh
      ctx._cstLeaves = sLv
      ctx._cstRawChildren = sRaw
      ctx._cstTriviaLog = sTl
      ctx.captureTrivia = sCap
      if (value === FAIL) return FAIL
      const end = EC.e
      const node = build(captured, undefined, { start: pos, end }, EMPTY_CH, EMPTY_TL, undefined)
      if (sBuf !== undefined || sCh !== undefined) {
        pushCstChild(ctx, node, sBuf !== undefined || sRaw !== undefined ? rawEntry(node, input, pos, end) : undefined)
      }
      EC.e = end
      return node
    }
  }

  function childrenOnlyFieldsBuildNode(child: Piece, build: NodeBuilder): Piece {
    return (input, pos, ctx) => {
      const sCh = ctx._cstChildren
      const sLv = ctx._cstLeaves
      const sRaw = ctx._cstRawChildren
      const sTl = ctx._cstTriviaLog
      const sCap = ctx.captureTrivia
      const sBuf = ctx._cstBuf
      const savedFields = ctx._fields
      const kids: unknown[] = []
      ctx._cstBuf = undefined
      ctx._cstChildren = kids
      ctx._cstLeaves = kids
      ctx._cstRawChildren = undefined
      ctx._cstTriviaLog = undefined
      ctx.captureTrivia = false
      ctx._fields = []
      const value = child(input, pos, ctx)
      const captured = capturedFlatChildren(kids)
      const fieldMap = buildFieldMap(ctx._fields)
      ctx._fields = savedFields
      ctx._cstBuf = sBuf
      ctx._cstChildren = sCh
      ctx._cstLeaves = sLv
      ctx._cstRawChildren = sRaw
      ctx._cstTriviaLog = sTl
      ctx.captureTrivia = sCap
      if (value === FAIL) return FAIL
      const end = EC.e
      const node = build(captured, fieldMap, { start: pos, end }, EMPTY_CH, EMPTY_TL, undefined)
      if (sBuf !== undefined || sCh !== undefined) {
        pushCstChild(ctx, node, sBuf !== undefined || sRaw !== undefined ? rawEntry(node, input, pos, end) : undefined)
      }
      EC.e = end
      return node
    }
  }

  function collapseBuildNode(child: Piece, build: NodeBuilder): Piece {
    return (input, pos, ctx) => {
      const sCh = ctx._cstChildren
      const sLv = ctx._cstLeaves
      const sRaw = ctx._cstRawChildren
      const sTl = ctx._cstTriviaLog
      const sCap = ctx.captureTrivia
      const sBuf = ctx._cstBuf
      const savedFields = ctx._fields
      const buf: CstCaptureBuf = {}
      ctx._cstBuf = buf
      ctx._cstChildren = undefined
      ctx._cstLeaves = undefined
      ctx._cstRawChildren = undefined
      ctx._cstTriviaLog = undefined
      ctx.captureTrivia = false
      ctx._fields = undefined
      const value = child(input, pos, ctx)
      const kids = buf.ch ?? (buf.single !== undefined ? [buf.single] : EMPTY_CH)
      const rawKids = buf.raw ?? (buf.rawSingle !== undefined ? [buf.rawSingle] : EMPTY_CH)
      ctx._fields = savedFields
      ctx._cstBuf = sBuf
      ctx._cstChildren = sCh
      ctx._cstLeaves = sLv
      ctx._cstRawChildren = sRaw
      ctx._cstTriviaLog = sTl
      ctx.captureTrivia = sCap
      if (value === FAIL) return FAIL
      const end = EC.e
      const span = { start: pos, end }
      const node = kids.length === 1
        ? kids[0]
        : build(kids, undefined, span, rawKids, EMPTY_TL, undefined)
      if (sBuf !== undefined || sCh !== undefined) {
        pushCstChild(ctx, node, rawEntry(node, input, pos, end))
      }
      EC.e = end
      return node
    }
  }

  function childrenOnlyCollapseBuildNode(child: Piece, build: NodeBuilder): Piece {
    return (input, pos, ctx) => {
      const sCh = ctx._cstChildren
      const sLv = ctx._cstLeaves
      const sRaw = ctx._cstRawChildren
      const sTl = ctx._cstTriviaLog
      const sCap = ctx.captureTrivia
      const sBuf = ctx._cstBuf
      const savedFields = ctx._fields
      const kids: unknown[] = []
      ctx._cstBuf = undefined
      ctx._cstChildren = kids
      ctx._cstLeaves = kids
      ctx._cstRawChildren = undefined
      ctx._cstTriviaLog = undefined
      ctx.captureTrivia = false
      ctx._fields = undefined
      const value = child(input, pos, ctx)
      const captured = capturedFlatChildren(kids)
      ctx._fields = savedFields
      ctx._cstBuf = sBuf
      ctx._cstChildren = sCh
      ctx._cstLeaves = sLv
      ctx._cstRawChildren = sRaw
      ctx._cstTriviaLog = sTl
      ctx.captureTrivia = sCap
      if (value === FAIL) return FAIL
      const end = EC.e
      const node = captured.length === 1
        ? captured[0]
        : build(captured, undefined, { start: pos, end }, EMPTY_CH, EMPTY_TL, undefined)
      if (sBuf !== undefined || sCh !== undefined) {
        pushCstChild(ctx, node, sBuf !== undefined || sRaw !== undefined ? rawEntry(node, input, pos, end) : undefined)
      }
      EC.e = end
      return node
    }
  }

  function plainProjectNode(child: Piece, projection: number, type: string): Piece {
    return (input, pos, ctx) => {
      const sCh = ctx._cstChildren
      const sLv = ctx._cstLeaves
      const sRaw = ctx._cstRawChildren
      const sTl = ctx._cstTriviaLog
      const sCap = ctx.captureTrivia
      const sBuf = ctx._cstBuf
      const savedFields = ctx._fields
      const buf: CstCaptureBuf = {}
      ctx._cstBuf = buf
      ctx._cstChildren = undefined
      ctx._cstLeaves = undefined
      ctx._cstRawChildren = undefined
      ctx._cstTriviaLog = undefined
      ctx.captureTrivia = false
      ctx._fields = undefined
      const value = child(input, pos, ctx)
      const kids = buf.ch ?? (buf.single !== undefined ? [buf.single] : EMPTY_CH)
      ctx._fields = savedFields
      ctx._cstBuf = sBuf
      ctx._cstChildren = sCh
      ctx._cstLeaves = sLv
      ctx._cstRawChildren = sRaw
      ctx._cstTriviaLog = sTl
      ctx.captureTrivia = sCap
      if (value === FAIL) return FAIL
      const end = EC.e
      const node = projectChild(kids, projection, type)
      if (sBuf !== undefined || sCh !== undefined) {
        pushCstChild(ctx, node, rawEntry(node, input, pos, end))
      }
      EC.e = end
      return node
    }
  }

  /** Mirrors `exec.ts`'s `rollbackNeeded` — a runtime question about live sinks. */
  function rollbackNeeded(ctx: ParseContext): boolean {
    return ctx._cstBuf !== undefined
      || ctx._cstLeaves !== undefined
      || ctx._cstRawChildren !== undefined
      || ctx._cstTriviaLog !== undefined
      || ctx._fields !== undefined
      || ctx._errors !== undefined
      || ctx._triviaLog !== undefined
      || ctx._rootTriviaLog !== undefined
  }

  /**
   * The three CST lengths of a rollback mark, as out-slots — see `markCst`.
   *
   * Slots for the same reason `EC.e` and `TERMV` are slots: a `{ raw, tl, lv }`
   * return would be an allocation per mark, and marks are the single most
   * executed thing in the driver.
   *
   * READ THEM IMMEDIATELY. They are only valid until the next `markCst`, which
   * in practice means the three lines under the call.
   */
  let MRAW = 0
  let MTL = 0
  let MLV = 0

  /**
   * Take a rollback mark's three CST lengths with ONE `ctx._cstBuf` load, and
   * answer `rollbackNeeded` on the way past.
   *
   * Every backtrackable construct marks before trying something it may roll
   * back, and `nextTerm` alone reaches here >200,000 times per parse of
   * `benchmark.less`. The previous shape called `rollbackNeeded` and then
   * `cstRawLen`/`cstTlLen`/`cstLeavesLen` — four calls, three of them
   * CROSS-MODULE into `../cst/capture-buffer.ts` and each independently
   * re-loading `ctx._cstBuf`. V8 inlined the local `rollbackNeeded` and did NOT
   * inline the other three: they cost 1.0% + 0.7% + 0.9% of the assembled
   * parse in SELF time. Source lowering emits the same mark as inline direct
   * loads, which is why it never paid this.
   *
   * The hoist is valid at EXACTLY this granularity and no wider. `_cstBuf` is
   * per-NODE state, not per-parse config: `beginCstNodeCapture` sets it and
   * `endCstNodeCapture` restores it, so it changes DURING a parse. The three
   * lengths are read here at one instant with nothing running between them, so
   * one load serves all three. It must NOT be cached in a piece or held across
   * the child call — between the mark and the rollback the child RUNS and may
   * replace or clear the buffer, so `rollbackCstCaptureAt` re-loads. A buffer
   * held across that would roll back against a stale object, which does not
   * throw: it silently keeps or drops CST children.
   *
   * `capture-buffer.ts`'s helpers stay exported and are still what `exec.ts`
   * calls. `exec.ts` is the identity reference a divergence is bisected
   * against; it is not inlined there.
   */
  function markCst(ctx: ParseContext): boolean {
    const b = ctx._cstBuf
    if (b !== undefined) {
      // `cstRawLen`/`cstLeavesLen` collapse the lazy single-entry form; `cstTlLen`
      // has no single form. `rollbackNeeded` short-circuits true on a live buffer,
      // so the other seven sinks are not consulted — as before.
      const raw = b.raw
      MRAW = b.noRaw === true
        ? b.rawLen ?? 0
        : raw !== undefined ? raw.length : b.rawSingle !== undefined ? 1 : 0
      const ch = b.ch
      MLV = ch !== undefined ? ch.length : b.single !== undefined ? 1 : 0
      const tl = b.tl
      MTL = tl !== undefined ? tl.length : 0
      return true
    }
    if (ctx._cstLeaves !== undefined
      || ctx._cstRawChildren !== undefined
      || ctx._cstTriviaLog !== undefined
      || ctx._fields !== undefined
      || ctx._errors !== undefined
      || ctx._triviaLog !== undefined
      || ctx._rootTriviaLog !== undefined) {
      MRAW = ctx._cstRawChildren?.length ?? 0
      MTL = ctx._cstTriviaLog?.length ?? 0
      MLV = ctx._cstLeaves?.length ?? 0
      return true
    }
    MRAW = 0
    MTL = 0
    MLV = 0
    return false
  }

  /**
   * Wrap a scope piece in its ROOT-CAPTURE POLICY, when it has one.
   *
   * Both bits are TABLE DATA, so the wrapping happens here and the common scope
   * — every scope in every grammar that never asked for either — gets the bare
   * piece back and pays nothing. `parser()` answers the same two questions in
   * `combinators/grammar.ts`; the table answered neither.
   */
  function scopeRootPolicy(piece: Piece, flags: number): Piece {
    let out = piece
    if ((flags & 1) !== 0) {
      // `grammar.ts:141` on a per-scope ctx COPY. One shared ctx here, so restore.
      const inner = out
      out = (input, pos, ctx) => {
        const saved = ctx._rootTriviaCapture
        ctx._rootTriviaCapture = false
        const v = inner(input, pos, ctx)
        ctx._rootTriviaCapture = saved
        return v
      }
    }
    if ((flags & 2) !== 0) {
      const inner = out
      out = (input, pos, ctx) => {
        refuseUnclassifiedRootScope(ctx._rootTriviaStrictScopes)
        return inner(input, pos, ctx)
      }
    }
    return out
  }

  function skipTrivia(input: string, cur: number, ctx: ParseContext): number {
    const s = SCAN
    if (s !== null
      && ctx._triviaLog === undefined
      && !(ctx.captureTrivia === true && (ctx._cstBuf !== undefined || ctx._cstTriviaLog !== undefined))) {
      return s(input, cur)
    }
    // CAPTURE IS NOT A REASON TO LEAVE THE SCANNER — see `skipTriviaScanned`.
    // Appended rather than folded into the test above so the non-capturing path
    // keeps the exact branch it had.
    if (s !== null) return skipTriviaScanned(s, input, cur, ctx)
    if (needsDeferredTriviaCommit(ctx)) {
      return commitTriviaScan(scanTriviaCompact(input, cur, ctx))
    }
    return advanceTrivia(input, cur, ctx)
  }

  /**
   * The value the last `nextTerm` produced.
   *
   * A second out-parameter slot beside `EC.e`, for the same reason `EC.e` is one:
   * a `{ value, end }` pair would be an allocation per sequence TERM, which is
   * the single most executed thing in any grammar here.
   */
  let TERMV: unknown

  /**
   * THE HOST, read ONCE PER PARSE.
   *
   * `ctx.build` is fixed by `run()` before the entry is called and cannot change
   * during a parse, so it is configuration — but unlike `hostCst` it is a VALUE
   * assembly cannot bake in, because two parses with the same option set can
   * carry two different host functions. So it is hoisted to the boundary instead:
   * `begin` reads it once, and the node piece reads this slot rather than going
   * back to `ctx` on each of the 145,512 nodes `benchmark.less` builds.
   *
   * INV-6 in `scripts/check-invariants.mjs` is what caught this: the first
   * version of the node piece opened with `const host = ctx.build`, which is a
   * per-parse config read on the hottest non-terminal in the grammar.
   */
  let HOST: ParseContext['build']

  /**
   * THE COLLECTOR THIS PARSE IS COUNTING INTO, latched at the boundary exactly as
   * `HOST` is and for the same reason: the assembly is SELECTED by whether one is
   * present (`RunCfg.coverage`), but WHICH one it is is a per-parse VALUE, and two
   * parses with the same option set can carry two different collectors.
   *
   * So no `OP_COV` piece reads `ctx` at all — it calls this slot. The initial
   * no-op exists because `begin` is what installs the real function; a counter
   * piece is only ever reachable from the coverage assembly, whose `begin` always
   * finds one on the context that selected it.
   */
  let COV: (id: string) => void = NO_COVERAGE

  /**
   * Assembly-local slots are scalar on the ordinary path. User host/reducer
   * code can synchronously invoke this same table map, though, so suspend them
   * only for that cold nested case rather than letting the inner parse poison
   * its caller's scanner, host, coverage sink, or end cell.
   */
  const frames: Array<{
    scan: FastTriviaScanner | null
    host: ParseContext['build']
    coverage: (id: string) => void
    end: number
  }> = []
  let depth = 0

  /**
   * A NON-FIRST sequence term: skip the installed trivia, run the child, and
   * unrecord that trivia if the child matched nothing.
   *
   * Returns the new cursor, or −1 on failure; the term's value lands in `TERMV`.
   * Split out of the loop because the FIRST term of a sequence never has trivia
   * before it — that is a property of the POSITION, known at assembly, so the
   * unrolled pieces call the first child directly and only reach here from term
   * two onward.
   *
   * Small and monomorphic on purpose: every unrolled sequence piece calls this
   * one function, so its call sites stay single-shape and TurboFan can inline it
   * into them.
   */
  function nextTerm(child: Piece, input: string, cur: number, ctx: ParseContext): number {
    if (ctx.trivia === undefined) {
      const v = child(input, cur, ctx)
      if (v === FAIL) return -1
      TERMV = v
      return EC.e
    }
    // The overwhelmingly common AST/value parse has no live rollback sink.  Do
    // not manufacture zero marks and then copy seven zero lengths for it: with
    // no buffer, leaves, fields, diagnostics, or trivia logs, `skipTrivia()`
    // cannot create anything that a failed following term would need to undo.
    // This is exactly `markCst(ctx) === false`, spelled here so that the hot
    // success path has neither its scalar writes nor its failure-only locals.
    if (ctx._cstBuf === undefined
      && ctx._cstLeaves === undefined
      && ctx._cstRawChildren === undefined
      && ctx._cstTriviaLog === undefined
      && ctx._fields === undefined
      && ctx._errors === undefined
      && ctx._triviaLog === undefined
      && ctx._rootTriviaLog === undefined) {
      const scanEnd = skipTrivia(input, cur, ctx)
      const v = child(input, scanEnd, ctx)
      if (v === FAIL) return -1
      TERMV = v
      return EC.e > scanEnd ? EC.e : cur
    }
    // SCALAR MARKS — only the three trivia sinks can receive ambient-scan rows.
    // Child-owned nodes, fields and errors are deliberately outside this range.
    const need = rollbackNeeded(ctx)
    const mTl = need ? cstTlLen(ctx) : 0
    const mLog = need ? ctx._triviaLog?.length ?? 0 : 0
    const mRoot = need ? ctx._rootTriviaLog?.length ?? 0 : 0
    const scanEnd = skipTrivia(input, cur, ctx)
    const scanTl = need ? cstTlLen(ctx) : 0
    const scanLog = need ? ctx._triviaLog?.length ?? 0 : 0
    const scanRoot = need ? ctx._rootTriviaLog?.length ?? 0 : 0
    const v = child(input, scanEnd, ctx)
    if (v === FAIL) return -1
    TERMV = v
    if (EC.e > scanEnd) return EC.e
    // The term matched nothing, so the trivia in front of it was never consumed
    // by anything — unrecord it and leave the cursor where it was.
    if (need) rollbackScannedTriviaAt(ctx, mTl, scanTl, mLog, scanLog, mRoot, scanRoot)
    return cur
  }

  /** A non-first term at a site proven to run under an open node capture buffer. */
  function nextTermBuffered(child: Piece, input: string, cur: number, ctx: ParseContext): number {
    if (ctx.trivia === undefined) {
      const v = child(input, cur, ctx)
      if (v === FAIL) return -1
      TERMV = v
      return EC.e
    }
    const before = ctx._cstBuf!
    const beforeTl = before.tl
    const mTl = beforeTl === undefined ? 0 : beforeTl.length
    const mLog = ctx._triviaLog?.length ?? 0
    const mRoot = ctx._rootTriviaLog?.length ?? 0
    const scanEnd = skipTrivia(input, cur, ctx)
    const scanned = ctx._cstBuf!
    const scannedTl = scanned.tl
    const scanTl = scannedTl === undefined ? 0 : scannedTl.length
    const scanLog = ctx._triviaLog?.length ?? 0
    const scanRoot = ctx._rootTriviaLog?.length ?? 0
    const v = child(input, scanEnd, ctx)
    if (v === FAIL) return -1
    TERMV = v
    if (EC.e > scanEnd) return EC.e
    rollbackScannedTriviaAt(ctx, mTl, scanTl, mLog, scanLog, mRoot, scanRoot)
    return cur
  }

  function committed(c: ParseContext): boolean {
    return c._fc === true
  }

  /** Append an exact-depth failed arm set in source order. Callers own depth ranking. */
  function accSet(ax: readonly string[] | undefined, acc: string[] | undefined): string[] | undefined {
    if (ax === undefined || ax.length === 0) return acc
    if (acc === undefined) return ax.slice()
    for (const s of ax) acc.push(s)
    return acc
  }

  /** No fixed child array is permitted to survive into a choice piece. */
  const NEVER_PIECE: Piece = () => FAIL
  const NEVER_CLASS: ResolvedClass = { ascii: new Uint8Array(128), hi: [] }
  const EMPTY_EXPECTED_PREFIX: ChoiceExpectedPrefix = (_target, _prev, acc) => acc

  /**
   * Four directly captured static expected sets. The chain keeps skipped-arm
   * diagnostics lazy across block boundaries: a later successful arm never
   * materialises expectations for earlier char-excluded arms.
   */
  function expectedBlock(
    start: number,
    e0: readonly string[], e1: readonly string[], e2: readonly string[], e3: readonly string[],
    prior: ChoiceExpectedPrefix,
  ): ChoiceExpectedPrefix {
    return (target, prev, acc) => {
      if (prev < start) { acc = prior(start, prev, acc); prev = start }
      if (target > start && prev < start + 1) acc = accSet(e0, acc)
      if (target > start + 1 && prev < start + 2) acc = accSet(e1, acc)
      if (target > start + 2 && prev < start + 3) acc = accSet(e2, acc)
      if (target > start + 3 && prev < start + 4) acc = accSet(e3, acc)
      return acc
    }
  }

  /** One four-arm ASCII-mask block, selected once when the arity is maskable. */
  function maskedChoiceBlock(
    start: number,
    a0: Piece, a1: Piece, a2: Piece, a3: Piece,
    through: ChoiceExpectedPrefix,
    next: MaskedChoiceBlock | undefined,
    total: number,
    choiceFx: string[],
  ): MaskedChoiceBlock {
    return (input, pos, ctx, bits, need, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot, acc, prev, best) => {
      if ((bits & (1 << start)) !== 0) {
        ctx._fc = false
        const v = a0(input, pos, ctx)
        if (v !== FAIL) return v
        if (best === pos) acc = through(start, prev, acc)
        prev = start + 1
        const at = ctx._fe ?? pos
        if (at > best) { best = at; acc = undefined }
        if (at === best) acc = accSet(ctx._fx, acc)
        if (committed(ctx)) { if (acc !== undefined) ctx._fx = acc; return FAIL }
        if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
      }
      if ((bits & (1 << (start + 1))) !== 0) {
        ctx._fc = false
        const v = a1(input, pos, ctx)
        if (v !== FAIL) return v
        if (best === pos) acc = through(start + 1, prev, acc)
        prev = start + 2
        const at = ctx._fe ?? pos
        if (at > best) { best = at; acc = undefined }
        if (at === best) acc = accSet(ctx._fx, acc)
        if (committed(ctx)) { if (acc !== undefined) ctx._fx = acc; return FAIL }
        if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
      }
      if ((bits & (1 << (start + 2))) !== 0) {
        ctx._fc = false
        const v = a2(input, pos, ctx)
        if (v !== FAIL) return v
        if (best === pos) acc = through(start + 2, prev, acc)
        prev = start + 3
        const at = ctx._fe ?? pos
        if (at > best) { best = at; acc = undefined }
        if (at === best) acc = accSet(ctx._fx, acc)
        if (committed(ctx)) { if (acc !== undefined) ctx._fx = acc; return FAIL }
        if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
      }
      if ((bits & (1 << (start + 3))) !== 0) {
        ctx._fc = false
        const v = a3(input, pos, ctx)
        if (v !== FAIL) return v
        if (best === pos) acc = through(start + 3, prev, acc)
        prev = start + 4
        const at = ctx._fe ?? pos
        if (at > best) { best = at; acc = undefined }
        if (at === best) acc = accSet(ctx._fx, acc)
        if (committed(ctx)) { if (acc !== undefined) ctx._fx = acc; return FAIL }
        if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
      }
      if (next !== undefined) {
        return next(input, pos, ctx, bits, need, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot, acc, prev, best)
      }
      if (best === pos) acc = through(total, prev, acc)
      ctx._fe = pos; ctx._fx = acc ?? choiceFx
      return FAIL
    }
  }

  /** One four-arm non-ASCII/general block. No mask state exists in this shape. */
  function generalChoiceBlock(
    start: number,
    a0: Piece, a1: Piece, a2: Piece, a3: Piece,
    g0: ResolvedClass | null, g1: ResolvedClass | null,
    g2: ResolvedClass | null, g3: ResolvedClass | null,
    through: ChoiceExpectedPrefix,
    next: GeneralChoiceBlock | undefined,
    total: number,
    choiceFx: string[],
  ): GeneralChoiceBlock {
    return (input, pos, ctx, c, need, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot, acc, prev, best) => {
      if (g0 === null || classHas(g0, c)) {
        ctx._fc = false
        const v = a0(input, pos, ctx)
        if (v !== FAIL) return v
        if (best === pos) acc = through(start, prev, acc)
        prev = start + 1
        const at = ctx._fe ?? pos
        if (at > best) { best = at; acc = undefined }
        if (at === best) acc = accSet(ctx._fx, acc)
        if (committed(ctx)) { if (acc !== undefined) ctx._fx = acc; return FAIL }
        if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
      }
      if (g1 === null || classHas(g1, c)) {
        ctx._fc = false
        const v = a1(input, pos, ctx)
        if (v !== FAIL) return v
        if (best === pos) acc = through(start + 1, prev, acc)
        prev = start + 2
        const at = ctx._fe ?? pos
        if (at > best) { best = at; acc = undefined }
        if (at === best) acc = accSet(ctx._fx, acc)
        if (committed(ctx)) { if (acc !== undefined) ctx._fx = acc; return FAIL }
        if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
      }
      if (g2 === null || classHas(g2, c)) {
        ctx._fc = false
        const v = a2(input, pos, ctx)
        if (v !== FAIL) return v
        if (best === pos) acc = through(start + 2, prev, acc)
        prev = start + 3
        const at = ctx._fe ?? pos
        if (at > best) { best = at; acc = undefined }
        if (at === best) acc = accSet(ctx._fx, acc)
        if (committed(ctx)) { if (acc !== undefined) ctx._fx = acc; return FAIL }
        if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
      }
      if (g3 === null || classHas(g3, c)) {
        ctx._fc = false
        const v = a3(input, pos, ctx)
        if (v !== FAIL) return v
        if (best === pos) acc = through(start + 3, prev, acc)
        prev = start + 4
        const at = ctx._fe ?? pos
        if (at > best) { best = at; acc = undefined }
        if (at === best) acc = accSet(ctx._fx, acc)
        if (committed(ctx)) { if (acc !== undefined) ctx._fx = acc; return FAIL }
        if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
      }
      if (next !== undefined) {
        return next(input, pos, ctx, c, need, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot, acc, prev, best)
      }
      if (best === pos) acc = through(total, prev, acc)
      ctx._fe = pos; ctx._fx = acc ?? choiceFx
      return FAIL
    }
  }

  /** Four direct exclusive arms, chained for every arity above three. */
  function exclusiveChoiceBlock(
    start: number, a0: Piece, a1: Piece, a2: Piece, a3: Piece,
    next: ExclusiveChoiceBlock | undefined,
  ): ExclusiveChoiceBlock {
    return (arm, input, pos, ctx) => {
      if (arm === start) return a0(input, pos, ctx)
      if (arm === start + 1) return a1(input, pos, ctx)
      if (arm === start + 2) return a2(input, pos, ctx)
      if (arm === start + 3) return a3(input, pos, ctx)
      return next === undefined ? FAIL : next(arm, input, pos, ctx)
    }
  }

  function dispatchMatcherBlock(
    m0: DispatchMatcher, a0: number, m1: DispatchMatcher, a1: number,
    m2: DispatchMatcher, a2: number, m3: DispatchMatcher, a3: number,
    next: DispatchMatcherBlock | undefined,
  ): DispatchMatcherBlock {
    return key => {
      if (m0(key)) return a0
      if (m1(key)) return a1
      if (m2(key)) return a2
      if (m3(key)) return a3
      return next?.(key)
    }
  }

  function dispatchBranch(child: Piece, usesRouted: boolean): DispatchBranch {
    if (!usesRouted) {
      return (input, _pos, selEnd, key, _selectorMark, ctx) => {
        const mark = saveTriviaMark(ctx)
        const v = child(input, selEnd, ctx)
        if (v === FAIL) {
          rollbackTrivia(ctx, mark)
          ctx._fc = true
          return FAIL
        }
        return [key, v]
      }
    }
    return (input, pos, selEnd, key, selectorMark, ctx) => {
      const savedRouted = ctx._routed
      rollbackTrivia(ctx, selectorMark)
      const mark = saveTriviaMark(ctx)
      ctx._routed = { value: key, span: { start: pos, end: selEnd } }
      let v: unknown
      try {
        v = child(input, pos, ctx)
      } finally {
        ctx._routed = savedRouted
      }
      if (v === FAIL) {
        rollbackTrivia(ctx, mark)
        ctx._fc = true
        return FAIL
      }
      return [key, v]
    }
  }

  function dispatchArmBlock(
    start: number,
    a0: DispatchBranch, a1: DispatchBranch, a2: DispatchBranch, a3: DispatchBranch,
    next: DispatchArmBlock | undefined,
  ): DispatchArmBlock {
    return (arm, input, pos, selEnd, key, selectorMark, ctx) => {
      if (arm === start) return a0(input, pos, selEnd, key, selectorMark, ctx)
      if (arm === start + 1) return a1(input, pos, selEnd, key, selectorMark, ctx)
      if (arm === start + 2) return a2(input, pos, selEnd, key, selectorMark, ctx)
      if (arm === start + 3) return a3(input, pos, selEnd, key, selectorMark, ctx)
      return next === undefined ? FAIL : next(arm, input, pos, selEnd, key, selectorMark, ctx)
    }
  }



  function trackLinesInto(ctx: ParseContext, input: string, end: number): void {
    const from = ctx._lineScannedTo ?? 0
    if (end <= from) return
    const starts = ctx._lineStarts
    if (starts === undefined) return
    for (let i = from; i < end; i++) if (input.charCodeAt(i) === 10) starts.push(i + 1)
    ctx._lineScannedTo = end
  }

  /* ── the link step ──────────────────────────────────────────────────────── */

  /**
   * Lower one site, memoised.
   *
   * CYCLES. The encoder emits children before parents, so the only back-edges are
   * the `OP_RULE` trampolines it patches for recursion (`encode.ts:228-241`). A
   * site already in flight gets a STUB that forwards through a slot patched when
   * the real piece exists, so recursive rules still hold direct references and
   * nothing falls back to an index lookup. The stub costs one call, only on a
   * genuine back-edge — 4 reachable `OP_RULE` sites in the less table.
   */
  const inFlight = new Map<number, { fwd: Piece; set: (p: Piece) => void }>()

  function link(ip: number): Piece {
    const done = memo.get(ip)
    if (done !== undefined) return done
    const flight = inFlight.get(ip)
    if (flight !== undefined) return flight.fwd

    let target: Piece | undefined
    const fwd: Piece = (input, pos, ctx) => target!(input, pos, ctx)
    const holder = { fwd, set: (p: Piece) => { target = p } }
    inFlight.set(ip, holder)

    const op = code[ip]
    // Match the emitted assembly's label-proven scope alias: rule entries in a
    // single ambient trivia scope otherwise reinstall and restore the exact
    // same trivia, labels and scanner on every call. Install the forwarding
    // holder first so a recursive child can still link back through this site.
    const piece = (op === OP_SCOPE_PLAIN || (op === OP_SCOPE && code[ip + 3]! === 0))
      && code[ip + 1]! >= 0
      && closureLabels.at(ip).tri === code[ip + 1]!
      ? link(code[ip + 2]!)
      : lower(ip)

    inFlight.delete(ip)
    holder.set(piece)
    memo.set(ip, piece)
    reached.add(ip)
    return piece
  }

  function lower(ip: number): Piece {
    const op = code[ip]
    switch (op) {
      /* ── terminals ───────────────────────────────────────────────────────── */

      case OP_LIT: {
        const s = k[code[ip + 1]!] as string
        const len = s.length
        const xf = fx[code[ip + 2]!] as string[]
        const shared = rawScalarSpecs.has(code[ip + 1]!) ? scalarFor(ip) : undefined
        if (shared !== undefined) {
          return (input, pos, ctx) => {
            const e = shared(input, pos)
            if (e >= 0) {
              if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
              EC.e = e
              return s
            }
            ctx._fe = pos; ctx._fx = xf
            if (ctx._probe !== undefined) failAt(ctx, xf, pos)
            return FAIL
          }
        }
        // LENGTH IS TABLE DATA, so the COMPARE is chosen here rather than
        // delegated to a builtin that has to rediscover it. See `litBodyNote`.
        if (len === 1) {
          const c0 = s.charCodeAt(0)
          return (input, pos, ctx) => {
            if (input.charCodeAt(pos) === c0) {
              const e = pos + 1
              if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
              EC.e = e
              return s
            }
            ctx._fe = pos; ctx._fx = xf
            if (ctx._probe !== undefined) failAt(ctx, xf, pos)
            return FAIL
          }
        }
        if (len === 2) {
          const c0 = s.charCodeAt(0), c1 = s.charCodeAt(1)
          return (input, pos, ctx) => {
            if (input.charCodeAt(pos) === c0 && input.charCodeAt(pos + 1) === c1) {
              const e = pos + 2
              if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
              EC.e = e
              return s
            }
            ctx._fe = pos; ctx._fx = xf
            if (ctx._probe !== undefined) failAt(ctx, xf, pos)
            return FAIL
          }
        }
        if (len === 3) {
          const c0 = s.charCodeAt(0), c1 = s.charCodeAt(1), c2 = s.charCodeAt(2)
          return (input, pos, ctx) => {
            if (input.charCodeAt(pos) === c0 && input.charCodeAt(pos + 1) === c1
              && input.charCodeAt(pos + 2) === c2) {
              const e = pos + 3
              if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
              EC.e = e
              return s
            }
            ctx._fe = pos; ctx._fx = xf
            if (ctx._probe !== undefined) failAt(ctx, xf, pos)
            return FAIL
          }
        }
        return (input, pos, ctx) => {
          if (input.startsWith(s, pos)) {
            const e = pos + len
            if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
            EC.e = e
            return s
          }
          ctx._fe = pos; ctx._fx = xf
            if (ctx._probe !== undefined) failAt(ctx, xf, pos)
          return FAIL
        }
      }

      case OP_LIT_TRACK: {
        const s = k[code[ip + 1]!] as string
        const len = s.length
        const xf = fx[code[ip + 2]!] as string[]
        if (len === 1) {
          const c0 = s.charCodeAt(0)
          return (input, pos, ctx) => {
            if (input.charCodeAt(pos) === c0) {
              const e = pos + 1
              if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
              trackLinesInto(ctx, input, e)
              EC.e = e
              return s
            }
            ctx._fe = pos; ctx._fx = xf
            if (ctx._probe !== undefined) failAt(ctx, xf, pos)
            return FAIL
          }
        }
        if (len === 2) {
          const c0 = s.charCodeAt(0), c1 = s.charCodeAt(1)
          return (input, pos, ctx) => {
            if (input.charCodeAt(pos) === c0 && input.charCodeAt(pos + 1) === c1) {
              const e = pos + 2
              if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
              trackLinesInto(ctx, input, e)
              EC.e = e
              return s
            }
            ctx._fe = pos; ctx._fx = xf
            if (ctx._probe !== undefined) failAt(ctx, xf, pos)
            return FAIL
          }
        }
        if (len === 3) {
          const c0 = s.charCodeAt(0), c1 = s.charCodeAt(1), c2 = s.charCodeAt(2)
          return (input, pos, ctx) => {
            if (input.charCodeAt(pos) === c0 && input.charCodeAt(pos + 1) === c1
              && input.charCodeAt(pos + 2) === c2) {
              const e = pos + 3
              if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
              trackLinesInto(ctx, input, e)
              EC.e = e
              return s
            }
            ctx._fe = pos; ctx._fx = xf
            if (ctx._probe !== undefined) failAt(ctx, xf, pos)
            return FAIL
          }
        }
        return (input, pos, ctx) => {
          if (input.startsWith(s, pos)) {
            const e = pos + len
            if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
            trackLinesInto(ctx, input, e)
            EC.e = e
            return s
          }
          ctx._fe = pos; ctx._fx = xf
            if (ctx._probe !== undefined) failAt(ctx, xf, pos)
          return FAIL
        }
      }

      case OP_RX: {
        const re = k[code[ip + 1]!] as RegExp
        const xf = fx[code[ip + 2]!] as string[]
        const shared = rawScalarSpecs.has(code[ip + 1]!) ? scalarFor(ip) : undefined
        if (shared !== undefined) {
          return (input, pos, ctx) => {
            const e = shared(input, pos)
            if (e >= 0) {
              const v = input.slice(pos, e)
              if (cstCaptureActive(ctx)) pushLeaf(ctx, v, pos, e)
              EC.e = e
              return v
            }
            ctx._fe = pos; ctx._fx = xf
            if (ctx._probe !== undefined) failAt(ctx, xf, pos)
            return FAIL
          }
        }
        return (input, pos, ctx) => {
          re.lastIndex = pos
          // `regex()` rows are sticky and expose only their whole match.  `exec()`
          // materialises a RegExpResult array just to read m[0]; `test()` performs
          // the identical sticky match and leaves its end in `lastIndex`.  This is
          // the exact primitive the emitted table body uses, so the compact closure
          // path must not retain an allocation on every regex token.
          if (re.test(input)) {
            const e = re.lastIndex
            const v = input.slice(pos, e)
            if (cstCaptureActive(ctx)) pushLeaf(ctx, v, pos, e)
            EC.e = e
            return v
          }
          ctx._fe = pos; ctx._fx = xf
            if (ctx._probe !== undefined) failAt(ctx, xf, pos)
          return FAIL
        }
      }

      case OP_RX_TRACK: {
        const re = k[code[ip + 1]!] as RegExp
        const xf = fx[code[ip + 2]!] as string[]
        return (input, pos, ctx) => {
          re.lastIndex = pos
          if (re.test(input)) {
            const e = re.lastIndex
            const v = input.slice(pos, e)
            if (cstCaptureActive(ctx)) pushLeaf(ctx, v, pos, e)
            trackLinesInto(ctx, input, e)
            EC.e = e
            return v
          }
          ctx._fe = pos; ctx._fx = xf
            if (ctx._probe !== undefined) failAt(ctx, xf, pos)
          return FAIL
        }
      }

      case OP_LIT_CI:
      case OP_LIT_CI_TRACK: {
        const s = k[code[ip + 1]!] as string
        const len = s.length
        const xf = fx[code[ip + 2]!] as string[]
        // The track/no-track choice was a per-row `code[ip] === OP_LIT_CI_TRACK`
        // re-read in `exec.ts`. It is a property of the ROW, so it is resolved here.
        // ASCII FOLD, one char at a time, WITHOUT the slice.
        //
        // `asciiFoldEq(input.slice(pos, e), s)` allocated a string on every
        // ATTEMPT — including the failures, which is where a case-insensitive
        // literal spends most of its executions (it is nearly always an arm of a
        // choice). The chain compares in place and allocates only the value it
        // is about to hand back, so the failure path allocates nothing at all.
        //
        // The semantics are `asciiFoldEq`'s, exactly: fold only A-Z (65-90) on
        // BOTH sides, compare code unit by code unit. Past end-of-input
        // `charCodeAt` is NaN, which folds to NaN and compares unequal — the
        // same answer `asciiFoldEq` gave via its short-slice length test.
        const fold = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c)
        const foldedLit: number[] = []
        for (let i = 0; i < len; i++) foldedLit.push(fold(s.charCodeAt(i)))
        const matchesFolded = (input: string, pos: number): boolean => {
          for (let i = 0; i < len; i++) {
            if (fold(input.charCodeAt(pos + i)) !== foldedLit[i]!) return false
          }
          return true
        }
        if (op === OP_LIT_CI_TRACK) {
          return (input, pos, ctx) => {
            const e = pos + len
            if (matchesFolded(input, pos)) {
              // Yields the INPUT's casing (`literal.ts:86`), not the literal's.
              const matched = input.slice(pos, e)
              if (cstCaptureActive(ctx)) pushLeaf(ctx, matched, pos, e)
              trackLinesInto(ctx, input, e)
              EC.e = e
              return matched
            }
            ctx._fe = pos; ctx._fx = xf
            if (ctx._probe !== undefined) failAt(ctx, xf, pos)
            return FAIL
          }
        }
        return (input, pos, ctx) => {
          const e = pos + len
          if (matchesFolded(input, pos)) {
            // Yields the INPUT's casing (`literal.ts:86`), not the literal's.
            const matched = input.slice(pos, e)
            if (cstCaptureActive(ctx)) pushLeaf(ctx, matched, pos, e)
            EC.e = e
            return matched
          }
          ctx._fe = pos; ctx._fx = xf
            if (ctx._probe !== undefined) failAt(ctx, xf, pos)
          return FAIL
        }
      }

      case OP_EMPTY:
        return (_input, pos) => { EC.e = pos; return '' }

      /* ── transparent / structural ────────────────────────────────────────── */

      case OP_GUARD: {
        const pred = fns[code[ip + 1]!] as (s: unknown) => boolean
        const xf = fx[code[ip + 2]!] as string[]
        return (_input, pos, ctx) => {
          if (pred(ctx.state)) { EC.e = pos; return null }
          ctx._fe = pos; ctx._fx = xf
          return FAIL
        }
      }

      case OP_ADJ: {
        // A row reached in its own right has NO boundary to test — the SEQ
        // pieces intercept the assertion wherever the question is answerable.
        // So this is the misuse the interpreter refuses (a bare choice arm, a
        // `node()` body, a repeat item), refused with the same sentence. Built
        // The POLARITY is bound here; the error itself is built where it is
        // thrown, so its stack points at the parse and not at assembly.
        const polarity = code[ip + 1] === 1 ? 'notAdjacent' : 'adjacent'
        return () => { throw adjacencyMisuse(polarity) }
      }

      case OP_GATE: {
        const cls = cc[code[ip + 1]!]!
        const xf = fx[code[ip + 3]!] as string[]
        const child = link(code[ip + 2]!)
        // SKIPPED ENTIRELY UNDER A PROBE / TOLERANT RECOVERY, exactly as the
        // interpreter skips it (`node.ts:239`, `attempt.ts:22`): the swallowed
        // inner failure is what feeds a completions probe, so a fail-fast that
        // never enters the body silently narrows `completionsAt` to the openers
        // it could see.
        //
        // Both halves of that condition are per-PARSE options, so the gate is
        // resolved HERE. Under either the gate is a no-op that forwards to the
        // child, and an assembly that forwards is better expressed as the child
        // itself: those assemblies drop the closure AND its call frame. The
        // strict assembly gets a body whose only test is the `classHas` the gate
        // exists for — the success path no longer reads `_probe` or `_tolerant`
        // at all, which is two context loads per gate execution removed (css has
        // 13 `GATE` rows, less 22, json none).
        if (cfg.tolerant || cfg.probe) return child
        return (input, pos, ctx) => {
          if (!classHas(cls, lead(input, pos))) {
            ctx._fe = pos; ctx._fx = xf
            return FAIL
          }
          return child(input, pos, ctx)
        }
      }

      case OP_LABEL: {
        const child = link(code[ip + 1]!)
        const xf = fx[code[ip + 2]!] as string[]
        return (input, pos, ctx) => {
          const v = child(input, pos, ctx)
          // `_fe` UNTOUCHED — `map.ts:84` keeps `result.span`.
          if (v === FAIL) ctx._fx = xf
          return v
        }
      }

      case OP_COV: {
        const child = link(code[ip + 1]!)
        // NOT AN OPTION TEST IN A PIECE BODY — the option is resolved HERE, by
        // choosing which of three pieces to return. `cfg.coverage` false hands
        // back the child itself, so a coverage-encoded table run without a
        // collector is the same graph, with the same call depth, as an ordinary
        // one: the counter rows vanish at link time rather than short-circuiting
        // at parse time.
        if (!cfg.coverage) return child
        const def = prog.cov?.[code[ip + 2]!]
        // An `OP_COV` row with no pool behind it is a table whose `cov` field was
        // dropped somewhere between encode and load — the emitter, the compact
        // wire form, or a fold. Say so, rather than counting `undefined` as an id
        // and reporting a full denominator with no hits in it.
        if (def === undefined) {
          throw new TypeError(
            `assemble: OP_COV at ${ip} indexes coverage definition ${code[ip + 2]}, but this program `
            + 'carries no `cov` pool. The counter rows and the definition pool are one artifact.',
          )
        }
        const id = def[0]
        // ENTRY vs SUCCESS, decided once. `EC.e` is deliberately untouched on both
        // paths: the counter runs before the child (entry) or after the child's
        // value is already in hand (success), so nothing observes a stale end.
        if (code[ip + 3] === 0) {
          return (input, pos, ctx) => {
            COV(id)
            return child(input, pos, ctx)
          }
        }
        return (input, pos, ctx) => {
          const v = child(input, pos, ctx)
          if (v !== FAIL) COV(id)
          return v
        }
      }

      case OP_RULE:
        // Pure indirection in the tape; in the assembled graph the parent simply
        // holds the target's piece. The trampoline row disappears entirely — this
        // is the only place a back-edge can occur, and `link` handles it.
        return link(code[ip + 1]!)

      case OP_LIVE: {
        // A HAND-WRITTEN COMBINATOR, run through its own `.parse` — mirrors
        // codegen's `emitRuntimeFallback`. Its result IS the interpreter's, so
        // `expected`/`span` propagate verbatim and `committed` is copied onto the
        // ctx bit both drivers use for the cut.
        const c = fns[code[ip + 1]!] as Combinator<unknown>
        return (input, pos, ctx) => {
          const r = c.parse(input, pos, ctx)
          if (!r.ok) {
            ctx._fe = r.span.start
            ctx._fx = r.expected
            ctx._fc = r.committed === true
            return FAIL
          }
          EC.e = r.span.end
          return r.value
        }
      }

      case OP_EXPECT: {
        const child = link(code[ip + 1]!)
        const xf = fx[code[ip + 2]!] as string[]
        // Line tracking is table data (`OP_EXPECT` has no tracked opcode variant).
        // Use the same helper as tracked node/root spans so an expect() recovery
        // diagnostic carries the interpreter's line/column contract in both
        // table engines. Do not use the incoming ctx bit: a grammar scope can
        // declare tracking even when the outer run context begins untracked.
        const expectSpan = (ctx: ParseContext, pos: number) =>
          prog.lines === 1 ? spanLines(ctx, pos, pos) : { start: pos, end: pos }
        // TOLERANT `expect()` EMBEDS ITS ERROR IN THE TREE, not only in the flat
        // `_errors` side-channel (`combinators/expect.ts:150`, and codegen's
        // `_ctx._rec.capture` at codegen.ts:4470) — so a tree walk finds every
        // diagnostic and the node survives incremental subtree reuse. The table
        // pushed to `_errors` and stopped, so a tolerant CST parse was missing the
        // `parseError` child the other two engines both produce.
        if (REC) {
          return (input, pos, ctx) => {
            const v = child(input, pos, ctx)
            if (v !== FAIL) return v
            const span = expectSpan(ctx, pos)
            const err = { _tag: 'parseError' as const, span, expected: xf }
            ctx._errors?.push(err)
            if (ctx._tolerant === true) captureError(ctx, err)
            // A RECOVERED FAILURE IS NO LONGER A FAILURE, so the commit bit the
            // child raised must not survive it. `_fc` is ctx-global for both table
            // drivers; the interpreter carries commitment on the RESULT object, so
            // returning a success drops it structurally and it has no bit to clear.
            // Leaving it set let a committed `dispatch`-tail failure that expect()
            // had already recovered CUT an enclosing choice, so the table rejected
            // input the interpreter accepts. Codegen has always cleared it
            // (`emitExpect`, `_ctx._fc = false`).
            ctx._fc = false
            EC.e = pos
            return err
          }
        }
        return (input, pos, ctx) => {
          const v = child(input, pos, ctx)
          if (v !== FAIL) return v
          const span = expectSpan(ctx, pos)
          const err = { _tag: 'parseError' as const, span, expected: xf }
          ctx._errors?.push(err)
          ctx._fc = false
          EC.e = pos
          return err
        }
      }

      case OP_FIELD: {
        const name = k[code[ip + 1]!] as string
        const child = link(code[ip + 2]!)
        return (input, pos, ctx) => {
          const v = child(input, pos, ctx)
          if (v === FAIL) return FAIL
          ctx._fields?.push({ name, value: v, span: { start: pos, end: EC.e } })
          return v
        }
      }

      case OP_XFORM: {
        const reducer = code[ip + 1]!
        const child = link(code[ip + 2]!)
        if (reducer < 0) {
          const projection = ~reducer
          return (input, pos, ctx) => {
            const v = child(input, pos, ctx)
            if (v === FAIL) return FAIL
            return (v as readonly unknown[])[projection]
          }
        }
        const fn = fns[reducer] as (value: unknown, span: { start: number; end: number }) => unknown
        return (input, pos, ctx) => {
          const v = child(input, pos, ctx)
          if (v === FAIL) return FAIL
          return fn(v, { start: pos, end: EC.e })
        }
      }

      case OP_SCAN: {
        // The scan POOL is built from subtrees, so it is linked after the graph
        // it references — a scan piece cannot capture its combinator at lowering
        // time without a cycle. It binds on first execution instead: one null
        // check, on 3 sites reached 6 times per parse of `benchmark.less`.
        const si = code[ip + 1]!
        let bound: Combinator<unknown> | undefined
        return (input, pos, ctx) => {
          const c = bound ?? (bound = scans[si]!)
          const r = c.parse(input, pos, ctx)
          if (!r.ok) {
            ctx._fe = r.span.start
            ctx._fx = (r.expected ?? EMPTY_FX) as string[]
            return FAIL
          }
          EC.e = r.span.end
          return r.value
        }
      }

      case OP_WITHCTX: {
        // `extra` and the child are both bound HERE; the piece only swaps a field.
        const extra = k[code[ip + 1]!]
        const child = link(code[ip + 2]!)
        return (input, pos, ctx) => {
          const saved = ctx.state
          ctx.state = extra
          try { return child(input, pos, ctx) }
          finally { ctx.state = saved }
        }
      }

      case OP_SCOPE:
      case OP_SCOPE_CAP:
      case OP_SCOPE_PLAIN: {
        const ki = code[ip + 1]!
        const scopeTrivia = ki < 0 ? undefined : (trivia[ki] as ParseContext['trivia'])
        const scopeLabels = scopeTrivia?._meta.triviaKindLabels
        // THE SWAP, RESOLVED AT ASSEMBLY. `exec.ts` computed
        // `FAST && ki >= 0 && !triviaLabelled[ki]` on every scope entry; `FAST` is
        // `!trackLines`, an option, and the other two are table data. All three are
        // known here, so the scope piece holds the scanner it installs as a `const`.
        const scanFor: FastTriviaScanner | null =
          swapLegal && ki >= 0 && !triviaLabelled[ki]! ? triviaScan[ki]! : null
        const child = link(code[ip + 2]!)
        // TWO PIECES, SELECTED HERE — not one piece that tests the opcode. Capture
        // is fixed for the whole parse, so `code[ip] === OP_SCOPE_CAP` is an
        // assembly-time fact and reading it per scope entry would be exactly the
        // config test INV-6 forbids.
        //
        // Both RESTORE rather than clear: capture is an OR with the enclosing
        // context (`grammar.ts:129`), so an inner scope must not switch an outer
        // capture off.
        const scopePiece: Piece = code[ip] === OP_SCOPE_CAP
          ? (input, pos, ctx) => {
              const saved = ctx.trivia
              const savedLabels = ctx.triviaKindLabels
              const savedScan = SCAN
              const savedCap = ctx.captureTrivia
              SCAN = scanFor
              ctx.trivia = scopeTrivia
              ctx.triviaKindLabels = scopeLabels
              ctx.captureTrivia = true
              const v = child(input, pos, ctx)
              ctx.captureTrivia = savedCap
              ctx.trivia = saved
              ctx.triviaKindLabels = savedLabels
              SCAN = savedScan
              return v
            }
          : (input, pos, ctx) => {
              const saved = ctx.trivia
              const savedLabels = ctx.triviaKindLabels
              const savedScan = SCAN
              SCAN = scanFor
              ctx.trivia = scopeTrivia
              ctx.triviaKindLabels = scopeLabels
              const v = child(input, pos, ctx)
              ctx.trivia = saved
              ctx.triviaKindLabels = savedLabels
              SCAN = savedScan
              return v
            }
        return scopeRootPolicy(scopePiece, code[ip] === OP_SCOPE_PLAIN ? 0 : code[ip + 3]!)
      }

      case OP_ROUTED: {
        const fb = code[ip + 1]!
        const fallback = fb >= 0 ? link(fb) : undefined
        return (input, pos, ctx) => {
          const item = ctx._routed
          if (item === undefined || pos !== item.span.start) {
            if (fallback !== undefined) return fallback(input, pos, ctx)
            ctx._fe = pos; ctx._fx = ROUTED_FX
            return FAIL
          }
          if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: item.value, span: item.span })
          EC.e = item.span.end
          return item.value
        }
      }

      /* ── transaction ─────────────────────────────────────────────────────── */

      case OP_ATTEMPT: {
        const child = link(code[ip + 1]!)
        return (input, pos, ctx) => {
          const need = markCst(ctx)
          const mRaw = MRAW
          const mTl = MTL
          const mLv = MLV
          const mFl = need ? ctx._fields?.length ?? 0 : 0
          const mEr = need ? ctx._errors?.length ?? 0 : 0
          const mLog = need ? ctx._triviaLog?.length ?? 0 : 0
          const mRoot = need ? ctx._rootTriviaLog?.length ?? 0 : 0
          const v = child(input, pos, ctx)
          if (v !== FAIL) return v
          if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
          // A committed failure propagates VERBATIM — rolled back, not re-anchored.
          if (committed(ctx)) return FAIL
          ctx._fe = pos
          return FAIL
        }
      }

      /* ── zero-width ──────────────────────────────────────────────────────── */

      case OP_NOT: {
        const scalarChild = scalarTerminalNotChild(code, ip)
        if (scalarChild >= 0) {
          const recognize = scalarFor(scalarChild)!
          const xf = fx[code[ip + 2]!] as string[]
          return (input, pos, ctx) => {
            if (recognize(input, pos) < 0) {
              EC.e = pos
              return null
            }
            ctx._fe = pos
            ctx._fx = xf
            EC.e = pos
            return FAIL
          }
        }
        const child = link(code[ip + 1]!)
        const xf = fx[code[ip + 2]!] as string[]
        return (input, pos, ctx) => {
          const need = markCst(ctx)
          const mRaw = MRAW
          const mTl = MTL
          const mLv = MLV
          const mFl = need ? ctx._fields?.length ?? 0 : 0
          const mEr = need ? ctx._errors?.length ?? 0 : 0
          const mLog = need ? ctx._triviaLog?.length ?? 0 : 0
          const mRoot = need ? ctx._rootTriviaLog?.length ?? 0 : 0
          const v = child(input, pos, ctx)
          if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
          if (v === FAIL) { EC.e = pos; return null }
          // `not.ts:50` — the ASSERTION's own set, at the assertion's position.
          ctx._fe = pos
          ctx._fx = xf
          return FAIL
        }
      }

      case OP_PEEK: {
        const child = link(code[ip + 1]!)
        const xf = fx[code[ip + 2]!] as string[]
        return (input, pos, ctx) => {
          const need = markCst(ctx)
          const mRaw = MRAW
          const mTl = MTL
          const mLv = MLV
          const mFl = need ? ctx._fields?.length ?? 0 : 0
          const mEr = need ? ctx._errors?.length ?? 0 : 0
          const mLog = need ? ctx._triviaLog?.length ?? 0 : 0
          const mRoot = need ? ctx._rootTriviaLog?.length ?? 0 : 0
          const v = child(input, pos, ctx)
          if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
          // `peek.ts:60` — the ASSERTION's own set, at the assertion's position.
          if (v === FAIL) { ctx._fe = pos; ctx._fx = xf; return FAIL }
          EC.e = pos
          return null
        }
      }

      case OP_OPT: {
        const child = link(code[ip + 1]!)
        return (input, pos, ctx) => {
          const need = markCst(ctx)
          const mRaw = MRAW
          const mTl = MTL
          const mLv = MLV
          const mFl = need ? ctx._fields?.length ?? 0 : 0
          const mEr = need ? ctx._errors?.length ?? 0 : 0
          const mLog = need ? ctx._triviaLog?.length ?? 0 : 0
          const mRoot = need ? ctx._rootTriviaLog?.length ?? 0 : 0
          ctx._fc = false
          const v = child(input, pos, ctx)
          if (v === FAIL) {
            if (committed(ctx)) return FAIL
            if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
            EC.e = pos
            // NULL, not undefined — `repeat.ts:269,277`, and grammars TEST for it.
            return null
          }
          return v
        }
      }

      /* ── boundaries ──────────────────────────────────────────────────────── */

      case OP_TOKEN: {
        const child = link(code[ip + 1]!)
        return (input, pos, ctx) => {
          const sTrivia = ctx.trivia, sKinds = ctx.triviaKindLabels
          const sBuf = ctx._cstBuf, sChildren = ctx._cstChildren, sLeaves = ctx._cstLeaves
          const sRaw = ctx._cstRawChildren, sTl = ctx._cstTriviaLog
          const sOuterTl = ctx._triviaLog, sRootTl = ctx._rootTriviaLog
          const wasCapturing = cstCaptureActive(ctx)

          const sScan = SCAN
          SCAN = null
          ctx.trivia = undefined
          ctx.triviaKindLabels = undefined
          ctx._cstBuf = undefined
          ctx._cstChildren = undefined
          ctx._cstLeaves = undefined
          ctx._cstRawChildren = undefined
          ctx._cstTriviaLog = undefined
          ctx._triviaLog = undefined
          ctx._rootTriviaLog = undefined

          let v: unknown
          try {
            v = child(input, pos, ctx)
          } finally {
            SCAN = sScan
            ctx.trivia = sTrivia
            ctx.triviaKindLabels = sKinds
            ctx._cstBuf = sBuf
            ctx._cstChildren = sChildren
            ctx._cstLeaves = sLeaves
            ctx._cstRawChildren = sRaw
            ctx._cstTriviaLog = sTl
            ctx._triviaLog = sOuterTl
            ctx._rootTriviaLog = sRootTl
          }
          if (v === FAIL) return FAIL
          const end = EC.e
          const value = input.slice(pos, end)
          if (wasCapturing) pushCstLeaf(ctx, { _tag: 'leaf', value, span: { start: pos, end } })
          EC.e = end
          return value
        }
      }

      case OP_LEX_BODY: {
        const recognize = t.lex[code[ip + 1]!]!
        const expected = fx[code[ip + 2]!] as string[]
        return (input, pos, ctx) => {
          const recognized = recognize(input, pos)
          if (recognized < 0) {
            ctx._fe = pos
            ctx._fx = expected as string[]
            if (ctx._probe !== undefined) failAt(ctx, expected, pos)
            return FAIL
          }
          const lineFlags = code[ip + 4]!
          const hasSuffix = (lineFlags & 4) !== 0
          const suffixMatched = hasSuffix && recognized % 2 === 1
          const end = (recognized - (suffixMatched ? 1 : 0)) / 2
          if ((lineFlags & 1) !== 0) {
            trackLinesInto(ctx, input, suffixMatched ? end - 1 : end)
          }
          if (hasSuffix) ctx._fc = false
          if (hasSuffix && suffixMatched && (lineFlags & 2) !== 0) {
            trackLinesInto(ctx, input, end)
          }
          if (hasSuffix && !suffixMatched) {
            const suffixExpected = fx[code[ip + 3]!] as string[]
            ctx._fe = end
            ctx._fx = suffixExpected
            if (ctx._probe !== undefined) failAt(ctx, suffixExpected, end)
          }
          const value = input.slice(pos, end)
          if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value, span: { start: pos, end } })
          EC.e = end
          return value
        }
      }

      case OP_LEX_PROGRAM: {
        const run = t.lexPrograms[code[ip + 1]!]!
        const scanId = run.scan
        if (scanId !== undefined) {
          return (input, pos, ctx) => {
            const sTrivia = ctx.trivia, sKinds = ctx.triviaKindLabels
            const sBuf = ctx._cstBuf, sChildren = ctx._cstChildren, sLeaves = ctx._cstLeaves
            const sRaw = ctx._cstRawChildren, sTl = ctx._cstTriviaLog
            const sOuterTl = ctx._triviaLog, sRootTl = ctx._rootTriviaLog
            const wasCapturing = cstCaptureActive(ctx)
            const sScan = SCAN
            SCAN = null
            ctx.trivia = undefined
            ctx.triviaKindLabels = undefined
            ctx._cstBuf = undefined
            ctx._cstChildren = undefined
            ctx._cstLeaves = undefined
            ctx._cstRawChildren = undefined
            ctx._cstTriviaLog = undefined
            ctx._triviaLog = undefined
            ctx._rootTriviaLog = undefined
            let end: number
            try { end = run(input, pos, ctx, scans[scanId]) }
            finally {
              SCAN = sScan
              ctx.trivia = sTrivia
              ctx.triviaKindLabels = sKinds
              ctx._cstBuf = sBuf
              ctx._cstChildren = sChildren
              ctx._cstLeaves = sLeaves
              ctx._cstRawChildren = sRaw
              ctx._cstTriviaLog = sTl
              ctx._triviaLog = sOuterTl
              ctx._rootTriviaLog = sRootTl
            }
            if (end < 0) return FAIL
            const value = input.slice(pos, end)
            if (wasCapturing) pushCstLeaf(ctx, { _tag: 'leaf', value, span: { start: pos, end } })
            EC.e = end
            return value
          }
        }
        return (input, pos, ctx) => {
          const end = run(input, pos, ctx)
          if (end < 0) return FAIL
          const value = input.slice(pos, end)
          if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value, span: { start: pos, end } })
          EC.e = end
          return value
        }
      }

      case OP_LEAF: {
        const fn = fns[code[ip + 1]!] as (value: unknown, span: { start: number; end: number }) => unknown
        const child = link(code[ip + 2]!)
        return (input, pos, ctx) => {
          const sBuf = ctx._cstBuf, sChildren = ctx._cstChildren, sLeaves = ctx._cstLeaves
          const sRaw = ctx._cstRawChildren, sTl = ctx._cstTriviaLog
          const sOuterTl = ctx._triviaLog
          const wasCapturing = cstCaptureActive(ctx)

          ctx._cstBuf = undefined
          ctx._cstChildren = undefined
          ctx._cstLeaves = undefined
          ctx._cstRawChildren = undefined
          ctx._cstTriviaLog = undefined
          ctx._triviaLog = undefined

          let v: unknown
          try {
            v = child(input, pos, ctx)
          } finally {
            ctx._cstBuf = sBuf
            ctx._cstChildren = sChildren
            ctx._cstLeaves = sLeaves
            ctx._cstRawChildren = sRaw
            ctx._cstTriviaLog = sTl
            ctx._triviaLog = sOuterTl
          }
          if (v === FAIL) return FAIL
          const end = EC.e
          const out = fn(v, { start: pos, end })
          if (wasCapturing) pushCstLeaf(ctx, { _tag: 'leaf', value: out, span: { start: pos, end } })
          EC.e = end
          return out
        }
      }

      /* ── sequences ───────────────────────────────────────────────────────── */

      case OP_SEQ:
      case OP_SEQV:
      case OP_SEQX: {
        const fused = op === OP_SEQX
        const base = fused ? ip + 3 : ip + 2
        const n = code[fused ? ip + 2 : ip + 1]!
        const wantValues = op !== OP_SEQV
        const reducer = fused ? code[ip + 1]! : -1
        const projection = reducer < 0 ? ~reducer : -1
        const fn = fused && projection < 0
          ? fns[reducer] as (value: unknown, span: { start: number; end: number }) => unknown
          : undefined
        const step = closureLabels.at(ip).buf ? nextTermBuffered : nextTerm

        const runnerBlock = (
          count: number,
          r0: TermRunner, r1: TermRunner, r2: TermRunner, r3: TermRunner,
          next: SequenceTermBlock | undefined,
        ): SequenceTermBlock => {
          if (count === 1) return (input, cur, ctx, values, inherited) => {
            cur = r0(input, cur, ctx, inherited)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            return next === undefined ? cur : next(input, cur, ctx, values, inherited)
          }
          if (count === 2) return (input, cur, ctx, values, inherited) => {
            cur = r0(input, cur, ctx, inherited)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            cur = r1(input, cur, ctx, inherited)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            return next === undefined ? cur : next(input, cur, ctx, values, inherited)
          }
          if (count === 3) return (input, cur, ctx, values, inherited) => {
            cur = r0(input, cur, ctx, inherited)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            cur = r1(input, cur, ctx, inherited)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            cur = r2(input, cur, ctx, inherited)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            return next === undefined ? cur : next(input, cur, ctx, values, inherited)
          }
          return (input, cur, ctx, values, inherited) => {
            cur = r0(input, cur, ctx, inherited)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            cur = r1(input, cur, ctx, inherited)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            cur = r2(input, cur, ctx, inherited)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            cur = r3(input, cur, ctx, inherited)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            return next === undefined ? cur : next(input, cur, ctx, values, inherited)
          }
        }

        /**
         * SEQUENCES CARRYING AN ADJACENCY ASSERTION — the assembly-time twin of
         * `sequence()`'s `parseAdjacent` fork (combinators/sequence.ts:118).
         *
         * `adjacent()` / `notAdjacent()` are BOUNDARY tests, not terms: each asks
         * whether trivia sat between the previous term and here, so it has to be
         * answered at the cursor, BEFORE the ambient scan `nextTerm` performs.
         * Handed the post-scan position it would find the gap already consumed
         * and answer "adjacent" every time — `adjacent()` a no-op,
         * `notAdjacent()` a guaranteed failure, both behind a parse that still
         * succeeds. Which term holds an assertion is TABLE DATA, so the decision
         * is made here and the parse path holds a bound runner per term rather
         * than an opcode test per term.
         *
         * A runner returns the new cursor or −1, with the value in `TERMV` —
         * `nextTerm`'s protocol, so the two kinds are interchangeable in the
         * loop. The assertion's runner returns `cur` UNMOVED: the following term
         * re-scans the same gap and keeps its own commit/rewind decision, which
         * is what makes the tree, the spans and the trivia log identical to the
         * same sequence written without the marker.
         *
         * Index 0 is never an assertion — `sequence()` rejects it at
         * construction, since the gap before the first term belongs to the
         * caller — so the first child is still called directly.
         */
        /**
         * RECOVERY SEQUENCES PUBLISH `ctx._sync`, and that is the whole of
         * "recovery config" — no grammar carries any.
         *
         * Before term `i`, the sentinel for the union of every LATER term's first
         * set becomes the sync point a list nested in that term resyncs to, so a
         * `sepBy` inside `sequence('{', list, '}')` finds `}` with nothing
         * annotated. Where there is no usable local follow (the last term, an
         * `any` first set) the INHERITED sync stays published, which is how the
         * enclosing delimiter reaches across a rule boundary.
         *
         * ONE generic loop rather than the arity-specialised pieces: this is only
         * reached in a recovery table, where the arity unroll buys a fraction of a
         * cold-path parse and costs four more copies of the publish protocol to
         * keep in step with the other two engines.
         *
         * The restore is `sequence()`'s `finally` (combinators/sequence.ts:105).
         * Codegen does not restore and compensates by having every list capture
         * `_sync` at ENTRY (codegen.ts:3032); the table captures at entry too, so
         * this is unobservable either way — it is here because leaving a stale
         * sentinel published is the kind of state a later reader will trust.
         */
        if (REC) {
          const first = link(code[base]!)
          const firstSync = sentinelFor(code[base + n]!)
          const runnerAt = (i: number): TermRunner => {
            const sync = sentinelFor(code[base + n + i]!)
            const kidIp = code[base + i]!
            if (code[kidIp] !== OP_ADJ) {
              const kid = link(kidIp)
              return (input, cur, ctx, inherited) => {
                ctx._sync = sync ?? inherited
                return step(kid, input, cur, ctx)
              }
            }
            const negated = code[kidIp + 1] === 1
            const ki = code[kidIp + 2]!
            const kinds = ki < 0 ? undefined : k[ki] as readonly string[]
            const xf = fx[code[kidIp + 3]!] as string[]
            return (input, cur, ctx, inherited) => {
              ctx._sync = sync ?? inherited
              if (!adjacencyHolds(input, cur, ctx, negated, kinds)) {
                ctx._fe = cur; ctx._fx = xf
                return -1
              }
              TERMV = null
              return cur
            }
          }
          const bindRunners = (start: number): SequenceTermBlock => {
            const count = Math.min(4, n - start)
            const at = (offset: number): TermRunner => runnerAt(start + offset)
            const never: TermRunner = () => -1
            return runnerBlock(
              count, at(0), count > 1 ? at(1) : never,
              count > 2 ? at(2) : never, count > 3 ? at(3) : never,
              start + count < n ? bindRunners(start + count) : undefined,
            )
          }
          const tail = n > 1 ? bindRunners(1) : undefined
          const runSyncTerms = (input: string, pos: number, ctx: ParseContext, values: unknown[] | undefined): number => {
            const inherited = ctx._sync
            ctx._sync = firstSync ?? inherited
            const v0 = first(input, pos, ctx)
            if (v0 === FAIL) { ctx._sync = inherited; return -1 }
            if (values !== undefined) values.push(v0)
            const cur = tail === undefined ? EC.e : tail(input, EC.e, ctx, values, inherited)
            if (cur < 0) { ctx._sync = inherited; return -1 }
            ctx._sync = inherited
            return cur
          }
          if (fused) {
            return (input, pos, ctx) => {
              const values: unknown[] = []
              const cur = runSyncTerms(input, pos, ctx, values)
              if (cur < 0) return FAIL
              EC.e = cur
              return projection >= 0 ? values[projection] : fn!(values, { start: pos, end: cur })
            }
          }
          if (wantValues) {
            return (input, pos, ctx) => {
              const values: unknown[] = []
              const cur = runSyncTerms(input, pos, ctx, values)
              if (cur < 0) return FAIL
              EC.e = cur
              return values
            }
          }
          return (input, pos, ctx) => {
            const cur = runSyncTerms(input, pos, ctx, undefined)
            if (cur < 0) return FAIL
            EC.e = cur
            return undefined
          }
        }

        let hasAdj = false
        for (let i = 1; i < n; i++) if (code[code[base + i]!] === OP_ADJ) { hasAdj = true; break }
        if (hasAdj) {
          const first = link(code[base]!)
          const runnerAt = (i: number): TermRunner => {
            const kidIp = code[base + i]!
            if (code[kidIp] !== OP_ADJ) {
              const kid = link(kidIp)
              return (input, cur, ctx) => step(kid, input, cur, ctx)
            }
            const negated = code[kidIp + 1] === 1
            const ki = code[kidIp + 2]!
            // The FILTER is bound; the MASK is not. A scope can swap the trivia
            // table, so which bit a category name means is a parse-time fact —
            // `adjacencyHolds` resolves it against the active table, exactly as
            // the interpreter does.
            const kinds = ki < 0 ? undefined : k[ki] as readonly string[]
            const xf = fx[code[kidIp + 3]!] as string[]
            return (input, cur, ctx) => {
              if (!adjacencyHolds(input, cur, ctx, negated, kinds)) {
                ctx._fe = cur; ctx._fx = xf
                return -1
              }
              TERMV = null
              return cur
            }
          }
          const bindRunners = (start: number): SequenceTermBlock => {
            const count = Math.min(4, n - start)
            const at = (offset: number): TermRunner => runnerAt(start + offset)
            const never: TermRunner = () => -1
            return runnerBlock(
              count, at(0), count > 1 ? at(1) : never,
              count > 2 ? at(2) : never, count > 3 ? at(3) : never,
              start + count < n ? bindRunners(start + count) : undefined,
            )
          }
          const tail = bindRunners(1)
          const runAdjTerms = (input: string, pos: number, ctx: ParseContext, values: unknown[] | undefined): number => {
            const v0 = first(input, pos, ctx)
            if (v0 === FAIL) return -1
            if (values !== undefined) values.push(v0)
            return tail(input, EC.e, ctx, values)
          }
          if (fused) {
            return (input, pos, ctx) => {
              const values: unknown[] = []
              const cur = runAdjTerms(input, pos, ctx, values)
              if (cur < 0) return FAIL
              EC.e = cur
              return projection >= 0 ? values[projection] : fn!(values, { start: pos, end: cur })
            }
          }
          if (wantValues) {
            return (input, pos, ctx) => {
              const values: unknown[] = []
              const cur = runAdjTerms(input, pos, ctx, values)
              if (cur < 0) return FAIL
              EC.e = cur
              return values
            }
          }
          return (input, pos, ctx) => {
            const cur = runAdjTerms(input, pos, ctx, undefined)
            if (cur < 0) return FAIL
            EC.e = cur
            return undefined
          }
        }

        /**
         * ARITY-SPECIALISED PIECES — the "pre-made, fully-formed" half of the
         * design, at the shape that dominates every grammar here.
         *
         * A sequence's ARITY is table data, so the loop over it is work assembly
         * can finish. Unrolling removes, per term: the counter, the bounds-checked
         * `kids[i]` load, and the `i > 0` test that decides whether trivia
         * precedes the term — the FIRST term never has trivia before it, and that
         * was being re-decided 166,842 times per parse for `SEQV` alone.
         *
         * The value array is built as a LITERAL of the right size rather than
         * grown by `push`, so a 2- or 3-term sequence allocates once at its final
         * capacity instead of reallocating as it fills.
         *
         * Arity 1-3 covers the overwhelming majority; above that the general loop
         * runs, so there is no arity this fails to lower.
         */
        if (n === 1) {
          const k0 = link(code[base]!)
          if (fused) {
            return (input, pos, ctx) => {
              const v = k0(input, pos, ctx)
              if (v === FAIL) return FAIL
              return projection === 0 ? v : fn!([v], { start: pos, end: EC.e })
            }
          }
          if (wantValues) {
            return (input, pos, ctx) => {
              const v = k0(input, pos, ctx)
              if (v === FAIL) return FAIL
              return [v]
            }
          }
          return (input, pos, ctx) => {
            const v = k0(input, pos, ctx)
            if (v === FAIL) return FAIL
            return undefined
          }
        }

        if (n === 2) {
          const k0 = link(code[base]!), k1 = link(code[base + 1]!)
          if (fused) {
            return (input, pos, ctx) => {
              const v0 = k0(input, pos, ctx)
              if (v0 === FAIL) return FAIL
              const cur = step(k1, input, EC.e, ctx)
              if (cur < 0) return FAIL
              EC.e = cur
              return projection === 0 ? v0
                : projection === 1 ? TERMV
                : fn!([v0, TERMV], { start: pos, end: cur })
            }
          }
          if (wantValues) {
            return (input, pos, ctx) => {
              const v0 = k0(input, pos, ctx)
              if (v0 === FAIL) return FAIL
              const cur = step(k1, input, EC.e, ctx)
              if (cur < 0) return FAIL
              EC.e = cur
              return [v0, TERMV]
            }
          }
          return (input, pos, ctx) => {
            const v0 = k0(input, pos, ctx)
            if (v0 === FAIL) return FAIL
            const cur = step(k1, input, EC.e, ctx)
            if (cur < 0) return FAIL
            EC.e = cur
            return undefined
          }
        }

        if (n === 3) {
          const k0 = link(code[base]!), k1 = link(code[base + 1]!), k2 = link(code[base + 2]!)
          if (fused) {
            return (input, pos, ctx) => {
              const v0 = k0(input, pos, ctx)
              if (v0 === FAIL) return FAIL
              let cur = step(k1, input, EC.e, ctx)
              if (cur < 0) return FAIL
              const v1 = TERMV
              cur = step(k2, input, cur, ctx)
              if (cur < 0) return FAIL
              EC.e = cur
              return projection === 0 ? v0
                : projection === 1 ? v1
                : projection === 2 ? TERMV
                : fn!([v0, v1, TERMV], { start: pos, end: cur })
            }
          }
          if (wantValues) {
            return (input, pos, ctx) => {
              const v0 = k0(input, pos, ctx)
              if (v0 === FAIL) return FAIL
              let cur = step(k1, input, EC.e, ctx)
              if (cur < 0) return FAIL
              const v1 = TERMV
              cur = step(k2, input, cur, ctx)
              if (cur < 0) return FAIL
              EC.e = cur
              return [v0, v1, TERMV]
            }
          }
          return (input, pos, ctx) => {
            const v0 = k0(input, pos, ctx)
            if (v0 === FAIL) return FAIL
            let cur = step(k1, input, EC.e, ctx)
            if (cur < 0) return FAIL
            cur = step(k2, input, cur, ctx)
            if (cur < 0) return FAIL
            EC.e = cur
            return undefined
          }
        }

        // Arbitrary strict arities use a bounded scalar block chain. Fixed
        // children are captured into prewritten four-term blocks at assembly;
        // the parse path has no `kids[i]`, fixed-child loop, or opcode lookup.
        const block = (
          count: number,
          k0: Piece, k1: Piece, k2: Piece, k3: Piece,
          next: SequenceTermBlock | undefined,
        ): SequenceTermBlock => {
          if (count === 1) return (input, cur, ctx, values) => {
            cur = step(k0, input, cur, ctx)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            return next === undefined ? cur : next(input, cur, ctx, values)
          }
          if (count === 2) return (input, cur, ctx, values) => {
            cur = step(k0, input, cur, ctx)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            cur = step(k1, input, cur, ctx)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            return next === undefined ? cur : next(input, cur, ctx, values)
          }
          if (count === 3) return (input, cur, ctx, values) => {
            cur = step(k0, input, cur, ctx)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            cur = step(k1, input, cur, ctx)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            cur = step(k2, input, cur, ctx)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            return next === undefined ? cur : next(input, cur, ctx, values)
          }
          return (input, cur, ctx, values) => {
            cur = step(k0, input, cur, ctx)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            cur = step(k1, input, cur, ctx)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            cur = step(k2, input, cur, ctx)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            cur = step(k3, input, cur, ctx)
            if (cur < 0) return -1
            if (values !== undefined) values.push(TERMV)
            return next === undefined ? cur : next(input, cur, ctx, values)
          }
        }
        const bind = (start: number): SequenceTermBlock => {
          const count = Math.min(4, n - start)
          const child = (offset: number): Piece => link(code[base + start + offset]!)
          return block(
            count, child(0), count > 1 ? child(1) : NEVER_PIECE,
            count > 2 ? child(2) : NEVER_PIECE, count > 3 ? child(3) : NEVER_PIECE,
            start + count < n ? bind(start + count) : undefined,
          )
        }
        const first = link(code[base]!)
        const tail = bind(1)
        const runDirectTerms = (
          input: string, pos: number, ctx: ParseContext, values: unknown[] | undefined,
        ): number => {
          const v0 = first(input, pos, ctx)
          if (v0 === FAIL) return -1
          if (values !== undefined) values.push(v0)
          return tail(input, EC.e, ctx, values)
        }

        if (fused) {
          return (input, pos, ctx) => {
            const values: unknown[] = []
            const cur = runDirectTerms(input, pos, ctx, values)
            if (cur < 0) return FAIL
            EC.e = cur
            return projection >= 0 ? values[projection] : fn!(values, { start: pos, end: cur })
          }
        }
        if (wantValues) {
          return (input, pos, ctx) => {
            const values: unknown[] = []
            const cur = runDirectTerms(input, pos, ctx, values)
            if (cur < 0) return FAIL
            EC.e = cur
            return values
          }
        }
        return (input, pos, ctx) => {
          const cur = runDirectTerms(input, pos, ctx, undefined)
          if (cur < 0) return FAIL
          EC.e = cur
          return undefined
        }
      }

      /* ── choice ──────────────────────────────────────────────────────────── */

      case OP_CHOICE: {
        const table = disp[code[ip + 1]!]!
        const n = code[ip + 2]!
        const choiceFx = fx[code[ip + 3]!] as string[]
        const base = ip + 4

        // THE TWO CHOICE SHAPES ARE TWO PIECES. `exec.ts` tested `table.exclusive`
        // on every choice execution; it is table data, so it selects here.
        if (table.exclusive) {
          const ascii = table.ascii
          const hi = table.hi
          // THE COMMON ARITIES OWN THEIR TOPOLOGY AS SCALARS. Do not build an
          // `arms[]` merely to rediscover the same two or three children at
          // every dispatch. The classifier remains table data; only its result
          // is turned into a direct captured call.
          if (n === 2) {
            const a0 = link(code[base]!), a1 = link(code[base + 1]!)
            return (input, pos, ctx) => {
              const c = lead(input, pos)
              let arm = -1
              if (c >= 0 && c < 128) {
                const a = ascii[c]!
                if (a !== 0) arm = a - 1
              } else if (c >= 128) {
                for (let i = 0; i < hi.length; i += 3) {
                  if (c >= hi[i]! && c <= hi[i + 1]!) { arm = hi[i + 2]!; break }
                }
              }
              if (arm >= 0) {
                ctx._fc = false
                const v = arm === 0 ? a0(input, pos, ctx) : a1(input, pos, ctx)
                if (v !== FAIL) return v
                if (committed(ctx)) return FAIL
                const failed = ctx._fx
                if (failed !== undefined && failed.length > 0) { ctx._fe = pos; return FAIL }
              }
              ctx._fe = pos; ctx._fx = choiceFx
              return FAIL
            }
          }
          if (n === 3) {
            const a0 = link(code[base]!), a1 = link(code[base + 1]!), a2 = link(code[base + 2]!)
            return (input, pos, ctx) => {
              const c = lead(input, pos)
              let arm = -1
              if (c >= 0 && c < 128) {
                const a = ascii[c]!
                if (a !== 0) arm = a - 1
              } else if (c >= 128) {
                for (let i = 0; i < hi.length; i += 3) {
                  if (c >= hi[i]! && c <= hi[i + 1]!) { arm = hi[i + 2]!; break }
                }
              }
              if (arm >= 0) {
                ctx._fc = false
                const v = arm === 0 ? a0(input, pos, ctx) : arm === 1 ? a1(input, pos, ctx) : a2(input, pos, ctx)
                if (v !== FAIL) return v
                if (committed(ctx)) return FAIL
                const failed = ctx._fx
                if (failed !== undefined && failed.length > 0) { ctx._fe = pos; return FAIL }
              }
              ctx._fe = pos; ctx._fx = choiceFx
              return FAIL
            }
          }
          const bindExclusive = (start: number): ExclusiveChoiceBlock => {
            const at = (i: number): Piece => i < n ? link(code[base + i]!) : NEVER_PIECE
            const next = start + 4 < n ? bindExclusive(start + 4) : undefined
            return exclusiveChoiceBlock(
              start, at(start), at(start + 1), at(start + 2), at(start + 3), next,
            )
          }
          const selected = bindExclusive(0)
          // THERE ARE NO OPEN ARMS HERE, and the piece is written to say so. An
          // ungated arm is one whose class is −1, and `resolveDispatch` clears
          // `exclusive` for exactly those arms (program.ts) — so `table.open` is
          // empty whenever `exclusive` holds, and the open-arm fallback loop this
          // piece used to carry was unreachable code plus a per-parse length test.
          return (input, pos, ctx) => {
            const c = lead(input, pos)
            let arm = -1
            if (c >= 0 && c < 128) {
              const a = ascii[c]!
              if (a !== 0) arm = a - 1
            } else if (c >= 128) {
              for (let i = 0; i < hi.length; i += 3) {
                if (c >= hi[i]! && c <= hi[i + 1]!) { arm = hi[i + 2]!; break }
              }
            }
            if (arm >= 0) {
              ctx._fc = false
              const v = selected(arm, input, pos, ctx)
              if (v !== FAIL) return v
              // THE CUT — a committed failure fails the whole choice.
              if (committed(ctx)) return FAIL
              // THE DISPATCHED ARM'S OWN SET IS THE ANSWER, at the choice's own
              // position. `_fx` already holds it; reporting the sole selected arm
              // is declining to overwrite it.
              const armFx = ctx._fx
              if (armFx !== undefined && armFx.length > 0) { ctx._fe = pos; return FAIL }
            }
            // THE UNION IS REPORTED ONLY ON A DISPATCH MISS, where the interpreter's
            // `parsers.flatMap` over non-nullable, char-excluded arms yields exactly
            // each arm's own opener — this set, without running the arms.
            ctx._fe = pos; ctx._fx = choiceFx
            return FAIL
          }
        }

        // THE PER-ARM GATE. Arms in source order, each skipped when its own class
        // excludes the char at `pos`. `null` means nullable or unmappable, and
        // those arms are always entered.
        const armCls = table.armCls
        if (n === 2 || n === 3) {
          const a0 = link(code[base]!), a1 = link(code[base + 1]!)
          const a2 = n === 3 ? link(code[base + 2]!) : undefined
          const predecide = !hostCst && !REC && !cfg.probe && !cfg.coverage && !cfg.trackLines
          const p0ip = predecide ? leadingScalarTerminal(code, code[base]!) : -1
          const p1ip = predecide ? leadingScalarTerminal(code, code[base + 1]!) : -1
          const p2ip = predecide && n === 3 ? leadingScalarTerminal(code, code[base + 2]!) : -1
          const p0 = p0ip < 0 ? undefined : scalarFor(p0ip)
          const p1 = p1ip < 0 ? undefined : scalarFor(p1ip)
          const p2 = p2ip < 0 ? undefined : scalarFor(p2ip)
          const e0 = fx[code[base + n]!] as string[]
          const e1 = fx[code[base + n + 1]!] as string[]
          const e2 = n === 3 ? fx[code[base + n + 2]!] as string[] : undefined
          const g0 = armCls[0] ?? null, g1 = armCls[1] ?? null
          const g2 = n === 3 ? armCls[2] ?? null : null
          const mask = new Uint32Array(129)
          const addGate = (cls: ResolvedClass | null, bit: number): void => {
            if (cls === null) {
              for (let c = 0; c < 129; c++) mask[c]! |= bit
              return
            }
            for (let c = 0; c < 128; c++) if (cls.ascii[c] === 1) mask[c]! |= bit
          }
          addGate(g0, 1); addGate(g1, 2)
          if (n === 3) addGate(g2, 4)

          return (input, pos, ctx) => {
            const c = lead(input, pos)
            const need = markCst(ctx)
            const mRaw = MRAW
            const mTl = MTL
            const mLv = MLV
            const mFl = need ? ctx._fields?.length ?? 0 : 0
            const mEr = need ? ctx._errors?.length ?? 0 : 0
            const mLog = need ? ctx._triviaLog?.length ?? 0 : 0
            const mRoot = need ? ctx._rootTriviaLog?.length ?? 0 : 0
            let acc: string[] | undefined
            let best = pos
            if (c < 128) {
              let bits = mask[c < 0 ? 128 : c]!
              if ((bits & 1) !== 0 && p0 !== undefined && p0(input, pos) < 0) bits &= ~1
              if ((bits & 2) !== 0 && p1 !== undefined && p1(input, pos) < 0) bits &= ~2
              if ((bits & 4) !== 0 && p2 !== undefined && p2(input, pos) < 0) bits &= ~4
              let prev = 0
              if ((bits & 1) !== 0) {
                ctx._fc = false
                const v = a0(input, pos, ctx)
                if (v !== FAIL) return v
                prev = 1
                const at = ctx._fe ?? pos
                if (at > best) { best = at; acc = undefined }
                if (at === best) acc = accSet(ctx._fx, acc)
                if (committed(ctx)) { if (acc !== undefined) ctx._fx = acc; return FAIL }
                if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
              }
              if ((bits & 2) !== 0) {
                ctx._fc = false
                const v = a1(input, pos, ctx)
                if (v !== FAIL) return v
                if (best === pos && prev < 1) acc = accSet(e0, acc)
                prev = 2
                const at = ctx._fe ?? pos
                if (at > best) { best = at; acc = undefined }
                if (at === best) acc = accSet(ctx._fx, acc)
                if (committed(ctx)) { if (acc !== undefined) ctx._fx = acc; return FAIL }
                if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
              }
              if (n === 3 && (bits & 4) !== 0) {
                ctx._fc = false
                const v = a2!(input, pos, ctx)
                if (v !== FAIL) return v
                if (best === pos && prev < 1) acc = accSet(e0, acc)
                if (best === pos && prev < 2) acc = accSet(e1, acc)
                prev = 3
                const at = ctx._fe ?? pos
                if (at > best) { best = at; acc = undefined }
                if (at === best) acc = accSet(ctx._fx, acc)
                if (committed(ctx)) { if (acc !== undefined) ctx._fx = acc; return FAIL }
                if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
              }
              if (best === pos && prev < 1) acc = accSet(e0, acc)
              if (best === pos && prev < 2) acc = accSet(e1, acc)
              if (best === pos && n === 3 && prev < 3) acc = accSet(e2, acc)
              ctx._fe = pos; ctx._fx = acc ?? choiceFx
              return FAIL
            }

            if ((g0 === null || classHas(g0, c)) && (p0 === undefined || p0(input, pos) >= 0)) {
              ctx._fc = false
              const v = a0(input, pos, ctx)
              if (v !== FAIL) return v
              const at = ctx._fe ?? pos
              if (at > best) { best = at; acc = undefined }
              if (at === best) acc = accSet(ctx._fx, acc)
              if (committed(ctx)) { if (acc !== undefined) ctx._fx = acc; return FAIL }
              if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
            } else if (best === pos) acc = accSet(e0, acc)
            if ((g1 === null || classHas(g1, c)) && (p1 === undefined || p1(input, pos) >= 0)) {
              ctx._fc = false
              const v = a1(input, pos, ctx)
              if (v !== FAIL) return v
              const at = ctx._fe ?? pos
              if (at > best) { best = at; acc = undefined }
              if (at === best) acc = accSet(ctx._fx, acc)
              if (committed(ctx)) { if (acc !== undefined) ctx._fx = acc; return FAIL }
              if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
            } else if (best === pos) acc = accSet(e1, acc)
            if (n === 3) {
              if ((g2 === null || classHas(g2, c)) && (p2 === undefined || p2(input, pos) >= 0)) {
                ctx._fc = false
                const v = a2!(input, pos, ctx)
                if (v !== FAIL) return v
                const at = ctx._fe ?? pos
                if (at > best) { best = at; acc = undefined }
                if (at === best) acc = accSet(ctx._fx, acc)
                if (committed(ctx)) { if (acc !== undefined) ctx._fx = acc; return FAIL }
                if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
              } else if (best === pos) acc = accSet(e2, acc)
            }
            ctx._fe = pos; ctx._fx = acc ?? choiceFx
            return FAIL
          }
        }

        const bindGeneral = (start: number, prior: ChoiceExpectedPrefix): GeneralChoiceBlock => {
          const arm = (i: number): Piece => i < n ? link(code[base + i]!) : NEVER_PIECE
          const expected = (i: number): readonly string[] => i < n
            ? fx[code[base + n + i]!] as string[]
            : EMPTY_FX
          const gate = (i: number): ResolvedClass | null => i < n ? armCls[i] ?? null : NEVER_CLASS
          const through = expectedBlock(
            start, expected(start), expected(start + 1), expected(start + 2), expected(start + 3), prior,
          )
          const next = start + 4 < n ? bindGeneral(start + 4, through) : undefined
          return generalChoiceBlock(
            start,
            arm(start), arm(start + 1), arm(start + 2), arm(start + 3),
            gate(start), gate(start + 1), gate(start + 2), gate(start + 3),
            through, next, n, choiceFx,
          )
        }
        const general = bindGeneral(0, EMPTY_EXPECTED_PREFIX)

        if (n <= 32) {
          const mask = new Uint32Array(129)
          for (let i = 0; i < n; i++) {
            const cls = armCls[i] ?? null
            const bit = 1 << i
            if (cls === null) {
              for (let c = 0; c < 129; c++) mask[c]! |= bit
              continue
            }
            for (let c = 0; c < 128; c++) if (cls.ascii[c] === 1) mask[c]! |= bit
          }

          const bindMasked = (start: number, prior: ChoiceExpectedPrefix): MaskedChoiceBlock => {
            const arm = (i: number): Piece => i < n ? link(code[base + i]!) : NEVER_PIECE
            const expected = (i: number): readonly string[] => i < n
              ? fx[code[base + n + i]!] as string[]
              : EMPTY_FX
            const through = expectedBlock(
              start, expected(start), expected(start + 1), expected(start + 2), expected(start + 3), prior,
            )
            const next = start + 4 < n ? bindMasked(start + 4, through) : undefined
            return maskedChoiceBlock(
              start, arm(start), arm(start + 1), arm(start + 2), arm(start + 3),
              through, next, n, choiceFx,
            )
          }
          const masked = bindMasked(0, EMPTY_EXPECTED_PREFIX)
          return (input, pos, ctx) => {
            const c = lead(input, pos)
            const need = markCst(ctx)
            const mRaw = MRAW
            const mTl = MTL
            const mLv = MLV
            const mFl = need ? ctx._fields?.length ?? 0 : 0
            const mEr = need ? ctx._errors?.length ?? 0 : 0
            const mLog = need ? ctx._triviaLog?.length ?? 0 : 0
            const mRoot = need ? ctx._rootTriviaLog?.length ?? 0 : 0
            if (c < 128) {
              return masked(
                input, pos, ctx, mask[c < 0 ? 128 : c]!,
                need, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot, undefined, 0, pos,
              )
            }
            return general(
              input, pos, ctx, c, need, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot, undefined, 0, pos,
            )
          }
        }

        return (input, pos, ctx) => {
          const c = lead(input, pos)
          const need = markCst(ctx)
          const mRaw = MRAW
          const mTl = MTL
          const mLv = MLV
          const mFl = need ? ctx._fields?.length ?? 0 : 0
          const mEr = need ? ctx._errors?.length ?? 0 : 0
          const mLog = need ? ctx._triviaLog?.length ?? 0 : 0
          const mRoot = need ? ctx._rootTriviaLog?.length ?? 0 : 0
          return general(
            input, pos, ctx, c, need, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot, undefined, 0, pos,
          )
        }
      }

      /* ── greedyClassify / autoNot ────────────────────────────────────────── */

      case OP_GREEDY: {
        const sup = link(code[ip + 1]!)
        const n = code[ip + 2]!
        // THE CLASSIFICATION MAP, BUILT ONCE. `choice()` builds the same map once
        // per construction (choice.ts:64-70); nothing about it is per-parse.
        const byWord = new Map<string, Piece>()
        for (let i = 0; i < n; i++) byWord.set(k[code[ip + 3 + 2 * i]!] as string, link(code[ip + 4 + 2 * i]!))
        return (input, pos, ctx) => {
          const need = markCst(ctx)
          const mRaw = MRAW
          const mTl = MTL
          const mLv = MLV
          const mFl = need ? ctx._fields?.length ?? 0 : 0
          const mEr = need ? ctx._errors?.length ?? 0 : 0
          const mLog = need ? ctx._triviaLog?.length ?? 0 : 0
          const mRoot = need ? ctx._rootTriviaLog?.length ?? 0 : 0
          const v = sup(input, pos, ctx)
          // The super arm's failure propagates verbatim — its `_fe`/`_fx`, not
          // the union of the arms (choice.ts:126).
          if (v === FAIL) return FAIL
          const end = EC.e
          const lit = byWord.get(input.slice(pos, end))
          if (lit === undefined) { EC.e = end; return v }
          // Unwind the regex's leaf so the credited arm's own leaf is the only
          // one. Re-running the arm cannot fail: the word IS its literal.
          if (need) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
          return lit(input, pos, ctx)
        }
      }

      case OP_ARMGATE: {
        // Predicate, arm and expected set all bound HERE — the body reads no
        // opcode, decodes no operand and tests no setting.
        const pred = fns[code[ip + 1]!] as (s: unknown) => boolean
        const child = link(code[ip + 2]!)
        const xf = fx[code[ip + 3]!] as string[]
        return (input, pos, ctx) => {
          if (!pred(ctx.state)) {
            // A `continue` in the interpreter (choice.ts:150), not a failure —
            // so no cut survives to the enclosing choice.
            ctx._fc = false
            ctx._fe = pos
            ctx._fx = xf
            return FAIL
          }
          return child(input, pos, ctx)
        }
      }

      case OP_REJECT: {
        const child = link(code[ip + 1]!)
        const n = code[ip + 2]!
        // The checks SPLIT BY KIND here, so neither loop below tests which kind
        // it is holding. `autoNotFires` is a pure OR over independent lookahead
        // predicates, so grouping them changes nothing but the branch.
        const strs: string[] = []
        const clss: ResolvedClass[] = []
        for (let i = 0; i < n; i++) {
          const o = code[ip + 4 + 2 * i]!
          if (code[ip + 3 + 2 * i]! === 0) strs.push(k[o] as string)
          else clss.push(cc[o]!)
        }
        const ns = strs.length
        const nc = clss.length
        return (input, pos, ctx) => {
          const v = child(input, pos, ctx)
          if (v === FAIL) return FAIL
          const end = EC.e
          for (let i = 0; i < ns; i++) {
            if (!input.startsWith(strs[i]!, end)) continue
            // A `continue` in the interpreter, not a failure — so no cut survives
            // AND no expectation is contributed: `choice.ts:174` rolls back and
            // moves on without touching `expected`. `_fx` still holds whatever the
            // arm's last inner failure left, so it is cleared rather than left to
            // be accumulated as if this arm had failed wanting something.
            ctx._fc = false
            ctx._fx = undefined
            return FAIL
          }
          if (nc !== 0) {
            const c = lead(input, end)
            for (let i = 0; i < nc; i++) {
              if (!classHas(clss[i]!, c)) continue
              ctx._fc = false
              ctx._fx = undefined
              return FAIL
            }
          }
          EC.e = end
          return v
        }
      }

      /* ── repetition ──────────────────────────────────────────────────────── */

      case OP_REP:
      case OP_REPV: {
        const child = link(code[ip + 1]!)
        const min = code[ip + 2]!
        const max = code[ip + 3]!
        const sepIp = code[ip + 4]!
        const sep = sepIp >= 0 ? link(sepIp) : undefined
        const flags = code[ip + 5]!
        const keepSeparators = (flags & 2) !== 0
        const trailingAllowed = (flags & 1) !== 0
        const reportItem = (flags & 4) !== 0
        const itemFx = reportItem ? fx[code[ip + 6]!] as string[] : EMPTY_FX
        const collect = op === OP_REP
        // The item's finite, non-nullable first set is table data. A strict
        // optional iteration whose lead is outside it cannot run or commit, so
        // stop before entering the child graph. Tolerant assemblies keep the
        // ordinary failure path because it may recover the rejected input.
        // A separator-less repeat has no separator sentinel, so ip+7 carries
        // the optional item's class at no extra table width. Separated lists
        // keep that slot for their recovery sentinel and use the ordinary path.
        const itemClassIndex = sepIp < 0 ? code[ip + 7]! : -1
        const itemClass = !REC && itemClassIndex >= 0 ? cc[itemClassIndex]! : undefined
        const itemMayStart = itemClass === undefined
          ? undefined
          : (input: string, pos: number): boolean => classHas(itemClass, lead(input, pos))
        // `many()` — the min-0, separator-less repeat — is the only shape that runs
        // its FIRST item through `repItem` and so skips leading trivia. The shape
        // identifies itself, and it is table data, so it is decided here.
        const skipBeforeFirst = sepIp < 0 && min === 0

        /**
         * TOLERANT RECOVERY — the third implementation of `recoverScan`'s
         * protocol, and it calls the SAME functions the other two do
         * (`recovery/scan.ts`), so an error's span, its expected set and its CST
         * embedding cannot drift between engines.
         *
         * Reached only in a recovery table, and inside it only on the FAILURE of
         * an element, so a matching item pays a `_sync` read at entry and nothing
         * else. The `ctx._tolerant` gate is the same dormancy the source lowering
         * and the interpreter have.
         *
         * WHAT RECOVERS, AND WHERE THE THREE ENGINES AGREE:
         *  - a MANDATORY item (`count < min`) of a separator-less repeat does NOT
         *    recover: `oneOrMore`'s first item propagates its failure
         *    (repeat.ts:221), and codegen inlines the `min` items ahead of the
         *    loop with an early return. A `sepBy`'s first element DOES recover,
         *    which is why the test is `sep !== undefined || count >= min`.
         *  - the check is `at(mySync, itemStart)`: sitting ON the sync token is a
         *    clean list end, not junk, and `itemStart` is past any leading trivia
         *    so that trivia is never swallowed into the error span
         *    (repeat.ts:167).
         *  - a separated list scans to its OWN separator or the enclosing
         *    delimiter (`orSentinel`, repeat.ts:454).
         *  - `mySync` is captured at ENTRY. An element's own sequence publishes
         *    over `_sync` while it runs; the interpreter restores in a `finally`
         *    and codegen saves at entry (codegen.ts:3032) — same value, both ways.
         *  - the separator-less path rolls the leading trivia back BEFORE
         *    recovering (repeat.ts's `repItem`), and the separated path does NOT:
         *    a consumed separator and the error after it both belong to the list
         *    (repeat.ts:533).
         */
        if (REC) {
          const itemFx = fx[code[ip + 6]!] as string[]
          const sepSent = sentinelFor(code[ip + 7]!)
          return (input, pos, ctx) => {
            const out: unknown[] | undefined = collect ? [] : undefined
            const hasTrivia = ctx.trivia !== undefined
            const needMark = rollbackNeeded(ctx)
            const mySync = ctx._sync
            let cur = pos
            let count = 0
            for (;;) {
              if (max >= 0 && count >= max) break
              if (sep !== undefined && count > 0 && count >= min && cur >= input.length) break
              if (needMark) markCst(ctx)
              const mRaw = needMark ? MRAW : 0
              const mTl = needMark ? MTL : 0
              const mLv = needMark ? MLV : 0
              const mFl = needMark ? ctx._fields?.length ?? 0 : 0
              const mEr = needMark ? ctx._errors?.length ?? 0 : 0
              const mLog = needMark ? ctx._triviaLog?.length ?? 0 : 0
              const mRoot = needMark ? ctx._rootTriviaLog?.length ?? 0 : 0
              let itemStart = cur
              let sepEnd = -1
              const viaRepItem = sep === undefined && count >= min && (count > 0 || skipBeforeFirst)
              if (sep !== undefined && count > 0) {
                const leavesBefore = cstLeavesLen(ctx)
                let sp = cur
                if (hasTrivia) sp = skipTrivia(input, sp, ctx)
                ctx._fc = false
                const sv = sep(input, sp, ctx)
                if (sv === FAIL) {
                  if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
                  if (committed(ctx)) return FAIL
                  break
                }
                if (!keepSeparators) demoteCapturedToRaw(ctx, leavesBefore)
                sepEnd = EC.e
                itemStart = hasTrivia ? skipTrivia(input, EC.e, ctx) : EC.e
              } else if (hasTrivia && (count > 0 || skipBeforeFirst)) {
                itemStart = skipTrivia(input, itemStart, ctx)
              }
              if (itemStart >= input.length && viaRepItem) {
                if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
                if (trailingAllowed && sepEnd >= 0) cur = sepEnd
                break
              }
              ctx._fc = false
              const v = child(input, itemStart, ctx)
              if (v === FAIL) {
                if (committed(ctx)) {
                  if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
                  return FAIL
                }
                if (ctx._tolerant === true
                  && mySync !== undefined
                  && (sep !== undefined || count >= min)
                  && !matchesAt(mySync, input, itemStart, ctx)) {
                  if (sep === undefined && needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
                  const rr = recoverScan(
                    input, itemStart, ctx,
                    sep === undefined ? mySync : orSentinel(sepSent ?? mySync, sepSent === undefined ? undefined : mySync),
                    itemFx,
                  )
                  if (out !== undefined) out.push(rr.error)
                  captureError(ctx, rr.error)
                  count++
                  cur = rr.end
                  continue
                }
                if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
                if (trailingAllowed && sepEnd >= 0) cur = sepEnd
                break
              }
              if (EC.e === itemStart && viaRepItem) {
                if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
                break
              }
              if (out !== undefined) out.push(v)
              cur = EC.e
              count++
            }
            if (count < min) {
              if (reportItem) { ctx._fe = cur; ctx._fx = itemFx }
              return FAIL
            }
            EC.e = cur
            return out
          }
        }

        return (input, pos, ctx) => {
          const out: unknown[] | undefined = collect ? [] : undefined
          const hasTrivia = ctx.trivia !== undefined
          const needMark = rollbackNeeded(ctx)
          // A completions probe deliberately observes swallowed item failures.
          // Keep the ordinary child path while one is active so this structural
          // fast stop cannot erase an item completion at the cursor.
          const gateItems = itemMayStart !== undefined && ctx._probe === undefined
          let cur = pos
          let count = 0
          for (;;) {
            if (max >= 0 && count >= max) break
            // A separated list is bounded by its SEPARATOR, so it stops at EOF at
            // the LOOP HEAD. Held to `count >= min` so an under-`min` list still
            // attempts the separator and reports its expected set.
            if (sep !== undefined && count > 0 && count >= min && cur >= input.length) break
            // With no trivia or separator to position, the item starts at `cur`.
            // This is the full 0.46 loop-head cut: no mark and no child setup.
            if (count >= min && sep === undefined && !hasTrivia
              && gateItems && !itemMayStart!(input, cur)) break
            // Per ITERATION, never hoisted: a preceding item's `node()` opened and
            // closed a capture buffer, so `ctx._cstBuf` is not the object it was
            // at the loop head. `needMark` is the pre-existing loop-invariant.
            if (needMark) markCst(ctx)
            const mRaw = needMark ? MRAW : 0
            const mTl = needMark ? MTL : 0
            const mLv = needMark ? MLV : 0
            const mFl = needMark ? ctx._fields?.length ?? 0 : 0
            const mEr = needMark ? ctx._errors?.length ?? 0 : 0
            const mLog = needMark ? ctx._triviaLog?.length ?? 0 : 0
            const mRoot = needMark ? ctx._rootTriviaLog?.length ?? 0 : 0
            let itemStart = cur
            let sepEnd = -1
            const viaRepItem = sep === undefined && count >= min && (count > 0 || skipBeforeFirst)
            if (sep !== undefined && count > 0) {
              const leavesBefore = cstLeavesLen(ctx)
              let sp = cur
              if (hasTrivia) sp = skipTrivia(input, sp, ctx)
              ctx._fc = false
              const sv = sep(input, sp, ctx)
              if (sv === FAIL) {
                if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
                if (committed(ctx)) return FAIL
                break
              }
              if (!keepSeparators) demoteCapturedToRaw(ctx, leavesBefore)
              sepEnd = EC.e
              itemStart = hasTrivia ? skipTrivia(input, EC.e, ctx) : EC.e
            } else if (hasTrivia && (count > 0 || skipBeforeFirst)) {
              itemStart = skipTrivia(input, itemStart, ctx)
            }
            if (itemStart >= input.length && viaRepItem) {
              if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
              if (trailingAllowed && sepEnd >= 0) cur = sepEnd
              break
            }
            if (count >= min && gateItems && !itemMayStart!(input, itemStart)) {
              if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
              if (trailingAllowed && sepEnd >= 0) cur = sepEnd
              break
            }
            ctx._fc = false
            const v = child(input, itemStart, ctx)
            if (v === FAIL) {
              if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
              if (committed(ctx)) return FAIL
              if (trailingAllowed && sepEnd >= 0) cur = sepEnd
              break
            }
            if (EC.e === itemStart && viaRepItem) {
              // Zero-width item: `repItem`'s TERMINATION device, not a semantic
              // filter — and it applies only where `repItem` runs.
              if (needMark) rollbackTriviaAt(ctx, mRaw, mTl, mLv, mFl, mEr, mLog, mRoot)
              break
            }
            if (out !== undefined) out.push(v)
            cur = EC.e
            count++
          }
          if (count < min) {
            if (reportItem) { ctx._fe = cur; ctx._fx = itemFx }
            return FAIL
          }
          EC.e = cur
          return out
        }
      }

      /* ── dispatch ────────────────────────────────────────────────────────── */

      case OP_DISPATCH: {
        const spec = dsp[code[ip + 2]!]!
        const selector = link(code[ip + 1]!)
        const otherIp = code[ip + 3]!
        const other = otherIp >= 0 ? link(otherIp) : undefined
        const otherRouted = code[ip + 4]! === 1
        const n = code[ip + 5]!
        const armBase = ip + 6
        const byKey = spec.byKey
        const byFold = spec.byFold
        const hasFold = spec.byFold.size > 0
        const match = spec.match
        const matchN = match.length
        const routed = spec.routed
        const expected = spec.expected as string[]

        const validArm = (arm: number): boolean => Number.isInteger(arm) && arm >= 0 && arm < n
        if (routed.length !== n) throw new TypeError('table assembler: malformed dispatch routed arity')
        for (const arm of byKey.values()) if (!validArm(arm)) throw new TypeError('table assembler: malformed dispatch exact arm')
        for (const arm of byFold.values()) if (!validArm(arm)) throw new TypeError('table assembler: malformed dispatch folded arm')
        for (const m of match) if (!validArm(m[3])) throw new TypeError('table assembler: malformed dispatch matcher arm')

        const neverMatch: DispatchMatcher = () => false
        const bindMatchers = (start: number): DispatchMatcherBlock => {
          const pred = (i: number): DispatchMatcher => i < matchN ? linkMatcher(match[i]!) : neverMatch
          const arm = (i: number): number => i < matchN ? match[i]![3] : -1
          const next = start + 4 < matchN ? bindMatchers(start + 4) : undefined
          return dispatchMatcherBlock(
            pred(start), arm(start), pred(start + 1), arm(start + 1),
            pred(start + 2), arm(start + 2), pred(start + 3), arm(start + 3), next,
          )
        }
        const matchBlock = matchN === 0 ? undefined : bindMatchers(0)
        const classify: (key: string) => number | undefined = hasFold
          ? matchBlock === undefined
            ? key => byKey.get(key) ?? byFold.get(asciiFoldKey(key))
            : key => byKey.get(key) ?? byFold.get(asciiFoldKey(key)) ?? matchBlock(key)
          : matchBlock === undefined
            ? key => byKey.get(key)
            : key => byKey.get(key) ?? matchBlock(key)

        const neverBranch: DispatchBranch = () => FAIL
        const bindArms = (start: number): DispatchArmBlock => {
          const branch = (i: number): DispatchBranch => i < n
            ? dispatchBranch(link(code[armBase + i]!), routed[i] === 1)
            : neverBranch
          const next = start + 4 < n ? bindArms(start + 4) : undefined
          return dispatchArmBlock(
            start, branch(start), branch(start + 1), branch(start + 2), branch(start + 3), next,
          )
        }
        const runArm = n === 0 ? undefined : bindArms(0)
        const runOther = other === undefined ? undefined : dispatchBranch(other, otherRouted)

        return (input, pos, ctx) => {
          const selectorMark = saveTriviaMark(ctx)
          const selVal = selector(input, pos, ctx)
          if (selVal === FAIL) return FAIL
          const selEnd = EC.e
          const key = selVal as string
          const arm = classify(key)
          if (arm === undefined) {
            if (runOther === undefined) {
              // No branch and no fallback: fail AT THE SELECTOR'S END.
              ctx._fe = selEnd
              ctx._fx = expected
              return FAIL
            }
            return runOther(input, pos, selEnd, key, selectorMark, ctx)
          }
          return runArm!(arm, input, pos, selEnd, key, selectorMark, ctx)
        }
      }

      /* ── node ────────────────────────────────────────────────────────────── */

      case OP_NODE:
      case OP_NODE_TRACK: {
        const flags = code[ip + 3]!
        const scalarChild = !hostCst && !cfg.tolerant && !cfg.probe && !cfg.coverage && !cfg.trackLines
          ? scalarTerminalNodeChild(code, ip)
          : -1
        if (scalarChild >= 0) {
          const recognize = scalarFor(scalarChild)!
          const spec = k[code[scalarChild + 1]!]
          const regexValue = code[scalarChild] === OP_RX
          const xf = fx[code[scalarChild + 2]!] as string[]
          const build = fns[code[ip + 1]!] as (
            children: readonly unknown[], fields: undefined, span: { start: number; end: number },
            rawChildren: readonly unknown[], triviaLog: readonly number[], state: undefined,
          ) => unknown
          return (input, pos, ctx) => {
            const end = recognize(input, pos)
            if (end < 0) {
              ctx._fe = pos; ctx._fx = xf
              if (ctx._probe !== undefined) failAt(ctx, xf, pos)
              return FAIL
            }
            const value = regexValue ? input.slice(pos, end) : spec as string
            const leaf = { _tag: 'leaf', value, span: { start: pos, end } }
            const kids = [leaf]
            const rawKids = [leaf]
            const span = { start: pos, end }
            EC.e = end
            const nd = build(kids, undefined, span, rawKids, EMPTY_TL, undefined)
            if (ctx._cstBuf !== undefined || ctx._cstChildren !== undefined) {
              pushCstChild(ctx, nd, ctx._cstRawChildren !== undefined || ctx._cstBuf !== undefined
                ? rawEntry(nd, input, pos, end)
                : undefined)
            }
            EC.e = end
            return nd
          }
        }
        const child = link(code[ip + 2]!)
        const proj = code[ip + 4]!
        const buildIdx = code[ip + 1]!
        const type = k[code[ip + 5]!] as string
        const tagIdx = code[ip + 6]!
        const tags = tagIdx < 0 ? undefined : k[tagIdx] as readonly string[]
        const tracked = op === OP_NODE_TRACK
        const readsTrivia = (flags & 4) !== 0
        const readsState = (flags & 8) !== 0
        const hasFields = (flags & 16) !== 0
        const collapse = (flags & 32) !== 0
        const unwrap = (flags & 64) !== 0
        const trailingTrivia = (flags & 128) !== 0
        // HOST MODE IS AN OPTION, and it decided five separate runtime ternaries
        // in `exec.ts`'s node case — the single most-executed non-terminal at
        // 145,512 executions per parse of `benchmark.less`. `cstOutputHost(ctx.build)`
        // is fixed by `run()` before the entry is called, so it selects the piece.
        const build = buildIdx >= 0
          ? fns[buildIdx] as NodeBuilder
          : undefined

        // The common AST-only bodies are separate FunctionLiterals, not a mode
        // branch in the generic node body. Their eligibility is entirely table
        // data plus this assembly's fixed option set; direct/custom contexts and
        // every richer node shape retain the generic implementation below.
        if (!hostCst && !tracked) {
          if (build !== undefined && proj < 0 && flags === 0) {
            return plainBuildNode(child, build)
          }
          if (build !== undefined && proj < 0 && flags === 2) {
            return childrenOnlyBuildNode(child, build)
          }
          if (build !== undefined && proj < 0 && flags === 18) {
            return childrenOnlyFieldsBuildNode(child, build)
          }
          if (build !== undefined && proj < 0 && flags === 32) {
            return collapseBuildNode(child, build)
          }
          if (build !== undefined && proj < 0 && flags === 34) {
            return childrenOnlyCollapseBuildNode(child, build)
          }
          if (build === undefined && proj >= 0 && flags === 0) {
            return plainProjectNode(child, proj, type)
          }
        }

        // A STRUCTURAL node — no builder, no projection — is the only shape that
        // takes a per-node-type trivia-kind mask off the host (`node.ts:260`).
        // Assembly-time, so a node with a reducer pays nothing for the question.
        const structural = build === undefined && proj < 0
        const grammarCapture = (flags & 1) !== 0 || trailingTrivia
        const hostCapturesThisType = structural && cfg.hostCaptureTrivia !== undefined
          ? cfg.hostCaptureTrivia(type)
          : undefined
        const wantFields = hasFields || hostCst
        const captureWide = readsTrivia || hostCst
          ? !structural || grammarCapture || hostCapturesThisType !== false
          : hostCapturesThisType === true
        // Only a plain structural host call can omit semantic children. Every
        // operation that consumes them keeps the lazy buffer, including either
        // grammar collapse form and the host collapse predicate.
        const keepChildren = !structural || cfg.hostReadsChildren !== false || collapse || unwrap
        const rawOnly = !keepChildren
        const omitsRaw = !hostCst && build !== undefined && proj < 0 && (flags & 2) !== 0
        return (input, pos, ctx) => {
          const host = HOST
          // `beginCstNodeCapture`/`endCstNodeCapture` INLINED, and the two objects
          // they exchange — the six-field `saved` and the three-field
          // `{children, rawChildren, triviaLog}` — held in locals instead.
          //
          // This is the same scalarisation `rollbackCstCaptureAt` already documents
          // for the five-field mark, applied to the node piece: `node()` runs
          // 145,512 times per parse of `benchmark.less`, so those were ~291k
          // allocations a parse that the compiled engine (which inlines its own
          // capture prologue and epilogue) never makes.
          const sCh = ctx._cstChildren
          const sCap = ctx.captureTrivia
          const sBuf = ctx._cstBuf
          const buf: CstCaptureBuf = rawOnly
            ? { rawOnly: true }
            : omitsRaw ? { noRaw: true, rawLen: 0 } : {}
          ctx._cstBuf = buf
          // `begin` sets this true and the caller immediately cleared it when the
          // node does not capture wide. Net: the flag IS `captureWide`, a const.
          ctx.captureTrivia = captureWide
          const savedFields = ctx._fields
          ctx._fields = wantFields ? [] : undefined
          // PER-NODE-TYPE TRIVIA-KIND MASK, scoped to the body and restored —
          // `node.ts:259-273`, and codegen's `_triviaCaptureMask` save/install/
          // restore around the same scope (`codegen.ts:4130-4136`). The table
          // installed nothing, so a host that asked `Outer` for comments only got
          // every kind the scanner saw.
          const savedMask = structural ? ctx._triviaCaptureMask : undefined
          if (structural && host?._parsemanTriviaKinds !== undefined) {
            ctx._triviaCaptureMask = host._parsemanTriviaKinds(type)
          }
          const v = child(input, pos, ctx)
          if (v !== FAIL && trailingTrivia && ctx.trivia !== undefined) EC.e = consumeTrivia(input, EC.e, ctx)
          const fieldMap: FieldMap | undefined = wantFields ? buildFieldMap(ctx._fields) : undefined
          ctx._fields = savedFields
          if (structural) ctx._triviaCaptureMask = savedMask
          const kids = rawOnly ? EMPTY_CH : buf.ch ?? (buf.single !== undefined ? [buf.single] : EMPTY_CH)
          const hostKids = kids
          const rawKids = omitsRaw
            ? EMPTY_CH
            : buf.raw ?? (buf.rawSingle !== undefined ? [buf.rawSingle] : EMPTY_CH)
          const tlog = buf.tl ?? EMPTY_TLOG
          ctx._cstBuf = sBuf
          ctx.captureTrivia = sCap
          if (v === FAIL) return FAIL
          const end = EC.e
          const span = tracked ? spanLines(ctx, pos, end) : { start: pos, end }
          const st = readsState && ctx.state !== undefined
            ? Object.assign({}, ctx.state as Record<string, unknown>)
            : undefined

          let nd: unknown
          if (unwrap && kids.length === 1) {
            nd = unwrapChild(kids[0])
          } else if (collapse && kids.length === 1) {
            nd = kids[0]
          } else if (
            // HOST COLLAPSE — applies wherever the node's VALUE comes from the
            // host, which is any node under a CST host, not only builder-less ones.
            (hostCst || (build === undefined && proj < 0))
            && keepChildren
            && host?._parsemanCstCollapse !== undefined
            && kids.length === 1
            && rawKids.length === 1
            && host._parsemanCstCollapse(type, kids[0], kids, rawKids)
          ) {
            nd = kids[0]
          } else if (proj >= 0) {
            nd = hostCst && host !== undefined
              ? host(type, kids, fieldMap, span, rawKids, tlog, readsState ? st : ctx.state !== undefined ? Object.assign({}, ctx.state as Record<string, unknown>) : undefined, tags)
              : projectChild(kids, proj, type)
          } else if (build !== undefined) {
            if (hostCst && host !== undefined) {
              // A direct builder is bypassed under a CST host.
              nd = host(type, kids, fieldMap, span, rawKids, tlog, readsState ? st : ctx.state !== undefined ? Object.assign({}, ctx.state as Record<string, unknown>) : undefined, tags)
            } else {
              nd = build(kids, fieldMap, span, rawKids, captureWide ? tlog : EMPTY_TL, st)
            }
          } else if (host !== undefined) {
            nd = host(type, hostKids, fieldMap, span, rawKids, tlog, st, tags)
          } else {
            nd = { _tag: 'node', type, span, state: st ?? null, children: kids }
          }
          // A ROOT NODE IS NOT A CHILD. `node()` pushes only when it was entered
          // from an enclosing collector — `saved.buf !== undefined || saved.ch !==
          // undefined` (node.ts:326). An outer `_cstLeaves` alone is a caller's
          // own sink, not a parent node, and pushing into it published the root
          // node as a leaf of itself.
          if (sBuf !== undefined || sCh !== undefined) {
            pushCstChild(ctx, nd, rawEntry(nd, input, pos, end))
          }
          EC.e = end
          return nd
        }
      }

      default:
        throw new Error(`table assembler: unknown opcode ${String(op)} at ${ip}`)
    }
  }

  /* ── scans, built once per assembly exactly as `exec.ts` builds them ─────── */

  function subtreeComb(r: SubtreeRef, def?: ParserDef): Combinator<unknown> {
    const piece = pieceAt(r[0])
    // THE END SLOT IS ONE CELL FOR THE WHOLE ASSEMBLY (`cell.ts`), so this
    // reads the end of whichever engine ran the piece without asking which.
    // It used to select `emitted.end` or this file's own slot, which was
    // correct only because exactly one engine was ever live: an emitted piece
    // writing its own private slot left this file's at zero, and a scan
    // sentinel read that as an empty span.
    return {
      _tag: 'tableSubtree',
      _meta: { firstSet: refFirstSet(r[1]), canMatchNewline: true, isTrivia: false },
      _def: def ?? { tag: 'unknown' } as unknown as ParserDef,
      parse(input: string, pos: number, ctx: ParseContext): ParseResult<unknown> {
        const v = piece(input, pos, ctx)
        if (v === FAIL) {
          const fe = ctx._fe
          const at = fe === undefined || fe < 0 ? pos : fe
          return { ok: false, expected: (ctx._fx ?? EMPTY_FX) as string[], span: { start: at, end: at } }
        }
        return { ok: true, value: v, span: { start: pos, end: EC.e } }
      },
    }
  }

  function refFirstSet(cls: number): FirstSet {
    if (cls === -2) return { kind: 'empty' }
    if (cls < 0) return { kind: 'any' }
    const spec = prog.cc[cls] ?? ''
    const ranges = decodeClassSpec(spec)
    return { kind: 'ranges', ranges }
  }

  /* ── U4: the EMITTED assembly, tried before the closure one ─────────────── */

  /**
   * Emitted source is attempted FIRST, and the closure walk above runs only for
   * what it refuses.
   *
   * Source emission names each fixed grammar edge directly and can be carried
   * as a build-time factory for CSP. The closure path may bind the same fixed
   * topology through scalar captures; this ordering selects the generated form
   * where it exists without making shared-literal IC behavior an architecture
   * premise.
   *
   * The refusal is RECORDED, not swallowed. A grammar that silently drops to
   * the closure path is a permanently slow path nobody would ever find, which
   * is the same failure `encode.ts:1208-1213` refuses for `OP_LIVE`.
   */
  const scansArr: Combinator<unknown>[] = []
  let emitted: EmittedAssembly | undefined
  /** "The build already did this" — not a refusal, and never a `emitRefusal`. */
  class ServedByBuild extends Error {}
  let emitRefusal: string | undefined
  let emitReached: ReadonlySet<number> | undefined
  {
    // The scan pool and the scan-skip sets are built FROM subtrees, so their
    // sites need emitted names too or `subtreeComb` would have to fall back to
    // a closure for them and the two engines would both be live in one parse.
    const extraIps: number[] = []
    for (const s of prog.scans ?? []) {
      for (const r of s.skip) extraIps.push(r[0])
      if (s.sentinel !== undefined) extraIps.push(s.sentinel[0])
    }
    for (const set of prog.scanSkip ?? []) for (const r of set) extraIps.push(r[0])
    const roots = [...Object.values(prog.rules), ...extraIps]
    for (const ip of reachableSites(code, roots)) {
      if (code[ip] === OP_DISPATCH) {
        const spec = dsp[code[ip + 2]!]
        validateDispatchSpec(spec, code[ip + 5]!, code[ip + 4]!)
      }
      if (!hostCst && !cfg.tolerant && !cfg.probe && !cfg.coverage && !cfg.trackLines) {
        if (code[ip] === OP_NODE) {
          const child = scalarTerminalNodeChild(code, ip)
          if (child >= 0) {
            rawScalarSpecs.add(code[child + 1]!)
            scalarFor(child)
          }
        } else if (code[ip] === OP_CHOICE && !disp[code[ip + 1]!]!.exclusive) {
          const n = code[ip + 2]!
          if (n === 2 || n === 3) {
            for (let i = 0; i < n; i++) {
              const child = leadingScalarTerminal(code, code[ip + 4 + i]!)
              if (child >= 0) scalarFor(child)
            }
          }
        }
      }
      const notChild = scalarTerminalNotChild(code, ip)
      if (notChild >= 0) scalarFor(notChild)
    }
    /**
     * THE BUILD'S OWN ANSWER, TRIED BEFORE THE CONSTRUCTOR.
     *
     * `prog.asm` carries assemblies a build-time emitter already compiled, one
     * per option set. When this parse's option set is among them there is
     * nothing to compile: the factory is an ordinary function literal in the
     * emitted module, and the only work left is rebuilding the three data pools
     * from `plan` (see `PoolPlan` — allocation, no source, no eval).
     *
     * This is what makes `docs/guide/modes.md` and `docs/reference/api.md` TRUE.
     * Both said a macro build is the answer for a CSP environment without
     * `unsafe-eval`; until this existed, the first `parse()` of a macro-built
     * table called `new Function` like every other path and the promise was
     * decided by nothing. `test/unit/no-function-constructor.test.ts` decides it
     * now, by counting constructor calls across a real parse.
     */
    // A build-time assembly cannot know a runtime host's per-type trivia
    // predicate. Never serve the scalar-keyed default factory for a
    // predicate-specialised parse; lower a fresh host-owned assembly instead.
    const pre = cfg.hostCaptureTrivia === undefined
      ? prog.asm?.find(a => a.key === cfgKey(cfg))
      : undefined
    if (pre !== undefined) {
      const pools = rebuildPools(t.cc, t.fx, t.disp, pre.plan)
      emitted = pre.factory(
        EC, FAIL, k, fx, fns, pools.masks, pools.classes, pools.armExpected, trivia,
        trivia.map(tv => tv?._meta.triviaKindLabels), triviaScan,
        scansArr, disp, dsp, EMPTY_FX, EMPTY_CH, EMPTY_TLOG, EMPTY_TL,
        cstCaptureActive, pushCstLeaf, pushCstChild, rollbackTriviaAt, rollbackScannedTriviaAt, failAt,
        classHas, consumeTrivia, buildFieldMap, projectChild, unwrapChild,
        demoteCapturedToRaw, cstLeavesLen, skipTriviaScanned, needsDeferredTriviaCommit,
        scanTrivia, advanceTrivia, refuseUnclassifiedRootScope, spanLines, rawEntry, lead,
        asciiFoldKey, ROUTED_FX,
        REC ? prog.cc.map((_, i) => sentinelFor(i)) : EMPTY_SENTS,
        matchesAt, recoverScan, orSentinel, captureError,
        scalarRecognizers, commitTriviaScan, scanTriviaCompact, t.lex, adjacencyHolds, t.lexPrograms,
      )
      emitReached = new Set(pre.reached)
    }
    /**
     * ONCE A PROGRAM CARRIES ASSEMBLIES, THE CONSTRUCTOR IS OFF FOR IT — for
     * EVERY option set, not just the ones that were pre-compiled.
     *
     * "Prefer the pre-compiled factory, fall back to `new Function`" is how this
     * defect survives forever: the fallback becomes load-bearing, production
     * takes it, and nobody can tell which path ran. So a macro-built artifact
     * whose option set was not pre-compiled runs the CLOSURE engine, and the
     * reason is on `Assembly.emitRefusal` where `test/unit/table-assemble.test.ts`
     * and anyone debugging can read it. Slower, correct, and observable — the
     * three properties a silent eval had none of.
     *
     * A program with NO `asm` at all is an explicit low-level hand-built
     * `tableRules(prog)` input. Compiler-created and macro-created artifacts
     * always carry the field, including the canonical empty inventory.
     */
    try {
      // Served above by a pre-compiled factory. Nothing to compile, nothing to
      // refuse — and in particular no constructor call.
      if (emitted !== undefined) throw new ServedByBuild()
      if (prog.asm !== undefined) {
        throw new Unemittable(
          `option set ${cfgKey(cfg)} (hostCst=${cfg.hostCst} trackLines=${cfg.trackLines} `
          + `tolerant=${cfg.tolerant} coverage=${cfg.coverage} probe=${cfg.probe}), which this build `
          + 'did not pre-compile. The Function constructor is NOT used for an artifact that carries '
          + 'assemblies — see `EmitOptions.assemblies` to add this option set to the build',
        )
      }
      // THE A/B TOGGLE, read ONCE at module load and never on a parse path.
      // Two engines that can only be compared across two checkouts cannot be
      // compared at all: the bench harness's own guidance is that a
      // cross-worktree measurement carries a bias no repetition removes. Same
      // spelling as `PM_TABLE_COUNT` (`bench/table-opcode-gaps.ts`).
      if (!EMIT_ENABLED) throw new Unemittable('PM_TABLE_EMIT=0 (measurement toggle)')
      const em = emitAssemblySource(t, prog, cfg, extraIps)
      /**
       * COMPILING THE TEXT — and the two ways it can fail are NOT the same.
       *
       * An `EvalError` is the ENVIRONMENT refusing: a Content-Security-Policy
       * without `unsafe-eval` forbids the `Function` constructor. That is a
       * legitimate refusal and the closure engine is the correct answer.
       *
       * A `SyntaxError` is THIS EMITTER having generated invalid JavaScript.
       * That is a bug in `emit-assembly.ts`, and catching it would ship a
       * permanently slow path that is also permanently undiagnosed — every
       * grammar would quietly run closures because of one bad template. It
       * propagates, with the offending source attached.
       */
      let factory: EmittedFactory
      try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        factory = new Function(...EMITTED_PARAMS, em.source) as EmittedFactory
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new Error(
            `table emitter: generated invalid JavaScript (${e.message}). This is a defect in `
            + 'emit-assembly.ts, not a property of the grammar.\n' + em.source,
          )
        }
        throw new Unemittable(`the Function constructor (${String(e)})`)
      }
      emitted = factory(
        EC, FAIL, k, fx, fns, em.masks, em.classes, em.armExpected, trivia,
        trivia.map(tv => tv?._meta.triviaKindLabels), triviaScan,
        scansArr, disp, dsp, EMPTY_FX, EMPTY_CH, EMPTY_TLOG, EMPTY_TL,
        cstCaptureActive, pushCstLeaf, pushCstChild, rollbackTriviaAt, rollbackScannedTriviaAt, failAt,
        classHas, consumeTrivia, buildFieldMap, projectChild, unwrapChild,
        demoteCapturedToRaw, cstLeavesLen, skipTriviaScanned, needsDeferredTriviaCommit,
        scanTrivia, advanceTrivia, refuseUnclassifiedRootScope, spanLines, rawEntry, lead,
        asciiFoldKey, ROUTED_FX,
        // THE SENTINEL POOL, dense over char-class indices so the emitted text can
        // index it the way it indexes `SCANS`. Built only for a recovery assembly
        // — a strict one emits no reader — and through the SAME `sentinelFor` memo
        // the closure pieces use, so both engines resync to the same combinator
        // object rather than to two separately constructed ones.
        REC ? prog.cc.map((_, i) => sentinelFor(i)) : EMPTY_SENTS,
        matchesAt, recoverScan, orSentinel, captureError,
        scalarRecognizers, commitTriviaScan, scanTriviaCompact, t.lex, adjacencyHolds, t.lexPrograms,
      )
      emitReached = em.reached
    } catch (e) {
      if (e instanceof ServedByBuild) { /* already emitted; no refusal to record */ }
      else if (e instanceof Unemittable) emitRefusal = e.construct
      else throw e
    }
  }

  /** One piece for a site, from whichever engine this assembly is running. */
  function pieceAt(ip: number): Piece {
    const em = emitted
    if (em !== undefined) {
      const p = em.byIp[ip]
      if (p === undefined) throw new Error(`table emitter: no emitted body for site ${ip}`)
      return p as Piece
    }
    return link(ip)
  }

  for (const s of prog.scans ?? []) {
    const skip = s.skip.map(r => subtreeComb(r))
    const raw = (s.flags & 1) !== 0
    if (s.kind === 1) {
      scansArr.push(balanced(s.open!, s.close!, { skip, raw, strict: (s.flags & 4) !== 0 }) as Combinator<unknown>)
      continue
    }
    const sentDef: ParserDef | undefined = typeof s.sent === 'string'
      ? { tag: 'literal', value: s.sent, caseInsensitive: false } as unknown as ParserDef
      : undefined
    scansArr.push(scanTo(subtreeComb(s.sentinel!, sentDef), { skip, raw, orEOF: (s.flags & 2) !== 0 }) as Combinator<unknown>)
  }
  const scans: readonly Combinator<unknown>[] = scansArr

  const scanSkip: readonly (readonly Combinator<unknown>[])[] =
    (prog.scanSkip ?? []).map(set => set.map(r => subtreeComb(r)))

  /* ── link the rules ──────────────────────────────────────────────────────── */

  if (emitted !== undefined) {
    const em = emitted
    return {
      pieces: em.pieces as Record<string, Piece>,
      end: em.end,
      begin: em.begin,
      finish: em.finish,
      scanSkip,
      reached: emitReached!,
      emitRefusal: undefined,
    }
  }

  const pieces: Record<string, Piece> = {}
  for (const [name, entryIp] of Object.entries(prog.rules)) pieces[name] = link(entryIp)

  /**
   * PER PARSE. `SCAN` starts null — a rule reached before any scope has no
   * installed trivia, and a stale one from a previous parse on a reused `ctx`
   * would skip trivia this grammar never declared.
   *
   * `FAST` and `HOSTCST` are gone: both were options, and both are now baked into
   * which pieces this assembly holds. What is left is the one piece of
   * configuration that is a per-parse VALUE rather than a per-parse FACT — the
   * host itself — and it is read here, once, instead of per node.
   */
  function begin(ctx: ParseContext): void {
    // Read user-owned values before touching the active frame. A getter that
    // throws must not leave an outer parse suspended.
    const nextHost = ctx.build
    const nextCoverage = ctx._grammarCoverage ?? NO_COVERAGE
    if (depth > 0) frames.push({ scan: SCAN, host: HOST, coverage: COV, end: EC.e })
    depth++
    SCAN = null
    HOST = nextHost
    COV = nextCoverage
  }

  function finish(): void {
    if (depth <= 0) throw new Error('parseman table assembly frame underflow')
    depth--
    if (depth === 0) return
    const prior = frames.pop()!
    SCAN = prior.scan
    HOST = prior.host
    COV = prior.coverage
    EC.e = prior.end
  }

  return { pieces, end: () => EC.e, begin, finish, scanSkip, reached, emitRefusal }
}

/**
 * Assemblies for one resolved table, one per option set, built on demand.
 *
 * The option set is not known when the rule map is created — `ctx.build`,
 * `ctx.trackLines` and `ctx._tolerant` arrive with the parse — so the entry
 * computes the scalar key and takes the assembly for it, building it the first
 * time that combination is seen. That is the "assembled at run start" half of G5:
 * only the option combinations a process actually uses, each holding the pieces
 * its options reach. A process that never parses tolerantly never builds, and
 * never runs, a single recovery piece.
 */
export class AssemblyCache {
  private readonly t: ResolvedTable
  private readonly prog: TableProgram
  private readonly byCfg: Array<Assembly | undefined> = Array.from({ length: 64 })
  /**
   * Monomorphic predicate inline cache. An assembly depends on the predicate
   * FUNCTION and the scalar cfg key, not on the host object that carries it, so
   * retaining the host would add neither correctness nor reuse. Stable parsing
   * is one identity comparison plus an array index; replacing the predicate
   * replaces this specialisation without retaining either host.
   */
  private hostPredicate: ((type: string) => boolean) | undefined
  private hostAssemblies: Array<Assembly | undefined> | undefined

  constructor(prog: TableProgram, resolved: ResolvedTable = resolveTable(prog)) {
    this.prog = prog
    this.t = resolved
  }

  for(cfg: RunCfg): Assembly {
    const key = cfgKey(cfg)
    // No host identity is available to own this predicate specialisation.
    if (cfg.hostCaptureTrivia !== undefined) return assemble(this.t, this.prog, cfg)
    const hit = this.byCfg[key]
    if (hit !== undefined) return hit
    const made = assemble(this.t, this.prog, cfg)
    this.byCfg[key] = made
    return made
  }

  /**
   * The assembly for the option set this `ctx` implies.
   *
   * ─── WHY THIS IS NOT A VIOLATION OF "NO OPTION READS AT PARSE TIME" ─────────
   *
   * The rule that shaped 0.47 is that consulting an option PER RULE or PER
   * COMBINATOR is a fail, and the reason it is a fail is that such a consult
   * scales with the input. This one does not, and the previous defence of it —
   * "cheap, allocation-free, only once" — was the wrong argument, because
   * cheapness is not the criterion. The right argument is that the consult is
   * IRREDUCIBLE, and it is worth stating precisely so nobody re-opens it:
   *
   *   A table entry has the artifact signature `(input, pos, ctx)`, shared with
   *   codegen. All scalar option bits live on that `ctx`, and every one of them is
   *   supplied PER CALL by the caller — `run()` takes `tolerant`, `build` and
   *   `instrumentation` as options on an artifact it was handed;
   *   `combinators/grammar.ts` sets `trackLines` on scope entry;
   *   `completionsAt` installs `_probe`. So the option set is not knowable
   *   before the call, and a selection that cannot happen before the call must
   *   happen at it.
   *
   * That is not a hole in G5, it is G5's own first clause: "quickly building the
   * grammar reference ON RUN START, making some swaps on rules or sub-rules, and
   * then the run actually runs with no logic branching for that option input"
   * (`notes/TABLE-DRIVER.md`). This IS the run-start step. What the criterion
   * forbids is the second sentence, and past this call there is no option read
   * anywhere — `scripts/check-invariants.mjs` INV-6 decides that mechanically.
   *
   * MEASURED, not asserted: exactly ONE call per entry invocation, including
   * `benchmark.less` at 106,802 bytes. Eliminating it would require binding the
   * option set to the ARTIFACT rather than to the CALL, which is a change to the
   * public run API (the map would have to hand back a cfg-keyed family and
   * `run()` index it), not a change to this file.
   *
   * It allocates nothing: the key is packed from the ctx's own bits by `cfgKeyOf`,
   * which takes them as arguments precisely so no `RunCfg` need exist here — that
   * object is built only on the miss that builds an assembly. A host trivia
   * predicate additionally selects its identity-specialised inline cache
   * because a function cannot be represented by a scalar bit.
   *
   * DO NOT CACHE THE RESULT ACROSS CALLS. Keying it on anything but the `ctx`'s
   * own option bits is how `tableRules` handed a strict parse the PREVIOUS
   * parse's tolerant assembly (`test/unit/table-assemble.test.ts`).
   */
  forCtx(ctx: ParseContext): Assembly {
    const host = ctx.build
    const hostCst = host !== undefined && cstOutputHost(host)
    const hostReadsChildren = host?._parsemanReadsChildren !== false
      || host?._parsemanCstCollapse !== undefined
    const hostCaptureTrivia = host?._parsemanCaptureTrivia
    const trackLines = ctx.trackLines === true
    const tolerant = ctx._tolerant === true
    const coverage = ctx._grammarCoverage !== undefined
    const probe = ctx._probe !== undefined
    const key = cfgKeyOf(hostCst, trackLines, tolerant, coverage, probe, hostReadsChildren)
    let cache = this.byCfg
    if (hostCaptureTrivia !== undefined) {
      // The predicate is host configuration, not parse state. Specialising each
      // node once keeps it out of the hot path, so its behaviour must stay stable
      // for this function identity. Replacing the function is supported: the
      // identity check below installs a fresh cache when it is replaced.
      if (this.hostPredicate === hostCaptureTrivia) {
        cache = this.hostAssemblies!
      }
      else {
        cache = Array.from({ length: 64 })
        this.hostPredicate = hostCaptureTrivia
        this.hostAssemblies = cache
      }
    }
    const hit = cache[key]
    if (hit !== undefined) return hit
    const made = assemble(this.t, this.prog, {
      hostCst, hostReadsChildren, hostCaptureTrivia,
      trackLines, tolerant, coverage, probe,
    })
    cache[key] = made
    return made
  }
}

/**
 * The ASSEMBLED rule map — the same artifact contract as `tableRules`, run
 * through linked closures instead of the bytecode interpreter.
 *
 * THE ONE config read is HERE, at the boundary, once per entry invocation:
 * `AssemblyCache.forCtx` turns the `ctx` into a scalar option set and takes the
 * assembly built for it. Everything past that point is pieces, and no piece body
 * reads an option — `scripts/check-invariants.mjs` INV-6 asserts it. `forCtx`
 * carries the argument for why that read is irreducible rather than merely cheap.
 */
export function tableRules(
  source: TableProgram | CompactProgram,
  artifactMetadata: Readonly<Record<symbol, unknown>> = {},
): Record<string, TableRule> {
  const prog = expandCompact(source)
  const resolved = resolveTable(prog)
  const cache = new AssemblyCache(prog, resolved)
  const names = Object.keys(prog.rules)
  const skipOf = prog.scanSkipOf
  let last: unknown
  /**
   * THE ASSEMBLY THIS ENTRY INVOCATION SELECTED — handed from `scanSkipFor` to
   * the `runRule` that `stamp.ts`'s entry runs immediately afterwards, on the
   * SAME `ctx`, so the pair costs one `forCtx` between them rather than two.
   *
   * It used to live ACROSS parses ("the lookup is memoised, so this is an array
   * index after the first parse"), and that was wrong: `scanSkipFor` runs before
   * `runRule` has re-selected, so a strict parse following a tolerant one was
   * installed with the TOLERANT assembly's `scanSkip` — verified by object
   * identity, since the two assemblies wrap their own pieces. Amortising a
   * per-parse selection over parses is not amortisation, it is a stale answer.
   *
   * `runRule` CONSUMES it, so it can never outlive the invocation that set it:
   * an entry reached without the preceding `scanSkipFor` re-selects, and a
   * nested entry invocation sets and consumes its own inside the outer
   * `runRule`, after the outer read.
   */
  let selected: Assembly | undefined
  return stampRuleMap(prog, {
    runRule: (ri, input, pos, ctx) => {
      const a = selected ?? cache.forCtx(ctx)
      selected = undefined
      a.begin(ctx)
      try {
        const v = a.pieces[names[ri]!]!(input, pos, ctx)
        if (v === FAIL) return -1
        last = v
        return a.end()
      } finally {
        // A host callback or direct reducer can run this same map before its
        // outer entry returns. Restore the assembly frame on every exit.
        a.finish()
      }
    },
    lastValue: () => last,
    scanSkipFor: (ri, ctx) => {
      const a = cache.forCtx(ctx)
      selected = a
      return a.scanSkip[skipOf?.[ri] ?? -1]
    },
  }, artifactMetadata, resolved)
}
