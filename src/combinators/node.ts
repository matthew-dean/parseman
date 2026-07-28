import type { Combinator, FieldMap, ParseContext, ParseResult, ParserMeta, ParserDef } from '../types.ts'
import { beginCstNodeCapture, endCstNodeCapture, pushCstChild } from '../cst/capture-buffer.ts'
import { buildReadsTrivia, buildReadsState, cstOutputHost } from '../compiler/build-arity.ts'
import { buildFieldMap, buildReadsFields, parserHasOwnFields } from '../compiler/fields.ts'
import { consumeTrivia } from './trivia-skip.ts'
import { matchesEmpty, startsFirstSet } from './first-set.ts'
import { deriveExpected } from './expect.ts'
import { annotateSpanFromLineContext } from '../line-index.ts'

/**
 * A CST/AST node rule. Runs `combinator` while collecting its terminals into
 * `children` / `rawChildren` arrays and trivia spans into `triviaLog`, then
 * calls `build(children, fields, span, rawChildren, triviaLog, state)` to produce the node.
 *
 *   - `children`    — structural items in source order: spanned CSTLeaf terminals
 *                     and sub-nodes (whatever `build` returned for inner nodes).
 *   - `rawChildren` — structural children only (same items as `children`).
 *   - `triviaLog`   — flat log of trivia entries: each entry is `[start, end, insertIdx]`
 *                     consumed between terms. `insertIdx` is the rawChildren index
 *                     before which the trivia was consumed. Use `buildTriviaIndex`
 *                     to turn this into a before/after lookup table.
 *
 * If `build` returns a non-node value (e.g. a bare string for an unwrapped rule),
 * the parent records it as a spanned leaf so its source span is still recoverable.
 */
export type BuildNode<N> = (
  children: ReadonlyArray<unknown>,
  fields: FieldMap | undefined,
  span: { start: number; end: number },
  rawChildren: ReadonlyArray<unknown>,
  triviaLog: readonly number[],
  state: unknown,
) => N

/**
 * Options for `node()`.
 * - `unwrap` — an AST/value wrapper rule that IS its single child when it
 *   captured exactly one. A leaf unwraps to its string value; a sub-node is
 *   returned as-is.
 * - `collapse` — a structural wrapper rule that returns its single child exactly
 *   as captured. A leaf stays a CSTLeaf; a node stays a node.
 * - `project` — return one captured semantic child by index while retaining the
 *   complete node frame for CST hosts. Leaves unwrap to their string value.
 * - `captureTrivia` — capture trivia consumed inside this node even when its
 *   enclosing `parser()` did not opt into document-wide trivia capture. This is
 *   scoped to the node; sibling and parent nodes retain their own setting.
 * - `trailingTrivia` — after a successful node body, consume the active grammar
 *   trivia once into THIS node's log. Intended for a document root whose body is
 *   a repetition; do not set it on a block that already has a closing delimiter.
 * Both skip `build` only for a one-child match; zero or two-plus children go
 * through `build` normally.
 */
type ParserValue<P> = P extends Combinator<infer T> ? T : never
type ProjectValue<P extends Combinator<unknown>, I extends number> =
  ParserValue<P> extends readonly unknown[]
    ? I extends keyof ParserValue<P> ? ParserValue<P>[I] : unknown
    : I extends 0 ? ParserValue<P> : unknown

export type NodeOptions = { unwrap?: boolean; collapse?: boolean; project?: number; captureTrivia?: boolean; trailingTrivia?: boolean }
export type NodeProjectOptions<I extends number = number> =
  Omit<NodeOptions, 'project' | 'unwrap' | 'collapse'> & { project: I; unwrap?: never; collapse?: never }

/** A captured child's value form: a leaf unwraps to its string value, else as-is. */
function unwrapChild(child: unknown): unknown {
  return child !== null && typeof child === 'object' && (child as { _tag?: string })._tag === 'leaf'
    ? (child as { value: unknown }).value
    : child
}

function isCstChild(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && ((value as { _tag?: string })._tag === 'node'
      || (value as { _tag?: string })._tag === 'leaf'
      || (value as { _tag?: string })._tag === 'parseError')
}

function missingInferredType(): never {
  throw new Error('node(): inferred node type requires a rules() key; pass node("Type", parser) outside rules()')
}

function normalizeProject(project: number | undefined): number | undefined {
  if (project === undefined) return undefined
  if (!Number.isInteger(project) || project < 0) {
    throw new Error('node() project child must be a non-negative integer')
  }
  return project
}

function projectChild(children: ReadonlyArray<unknown>, project: number, type: string): unknown {
  if (!(project in children)) {
    throw new Error(`node(${JSON.stringify(type)}) project child ${project} was not captured`)
  }
  return unwrapChild(children[project])
}

export function node<P extends Combinator<unknown>, const I extends number>(combinator: P, opts: NodeProjectOptions<I>): Combinator<ProjectValue<P, I>>
export function node<N>(combinator: Combinator<unknown>, build?: BuildNode<N>, opts?: NodeOptions): Combinator<N>
export function node<N>(combinator: Combinator<unknown>, opts?: NodeOptions): Combinator<N>
export function node<P extends Combinator<unknown>, const I extends number>(type: string, combinator: P, opts: NodeProjectOptions<I>): Combinator<ProjectValue<P, I>>
export function node<N>(type: string, combinator: Combinator<unknown>, build?: BuildNode<N>, opts?: NodeOptions): Combinator<N>
export function node<N>(type: string, combinator: Combinator<unknown>, opts?: NodeOptions): Combinator<N>
export function node<N>(
  typeOrCombinator: string | Combinator<unknown>,
  combinatorOrBuild?: Combinator<unknown> | BuildNode<N> | NodeOptions,
  buildOrOpts?: BuildNode<N> | NodeOptions,
  maybeOpts?: NodeOptions,
): Combinator<N> {
  const hasExplicitType = typeof typeOrCombinator === 'string'
  const type = hasExplicitType ? typeOrCombinator : undefined
  const combinator = (hasExplicitType ? combinatorOrBuild : typeOrCombinator) as Combinator<unknown>
  const buildArg = hasExplicitType ? buildOrOpts : combinatorOrBuild
  const build = typeof buildArg === 'function' ? buildArg as BuildNode<N> : undefined
  const opts = (typeof buildArg === 'function' ? maybeOpts : buildArg ?? maybeOpts) as NodeOptions | undefined
  const project = normalizeProject(opts?.project)
  if (project !== undefined && build !== undefined) {
    throw new Error('node() options cannot combine project with a build callback')
  }
  const baseDef = { tag: 'node' as const, parser: combinator, ...(type === undefined ? {} : { type }), ...(build === undefined ? {} : { build }) }
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline,
    isTrivia: false,
  }
  const unwrap = opts?.unwrap === true
  const collapse = opts?.collapse === true
  const captureTrivia = opts?.captureTrivia === true
  const trailingTrivia = opts?.trailingTrivia === true
  if (unwrap && collapse) {
    throw new Error('node() options cannot set both unwrap and collapse')
  }
  if (project !== undefined && (unwrap || collapse)) {
    throw new Error('node() options cannot combine project with unwrap or collapse')
  }
  const def: Extract<ParserDef, { tag: 'node' }> = unwrap || collapse || project !== undefined || captureTrivia || trailingTrivia
    ? { ...baseDef, ...(unwrap ? { unwrap: true } : {}), ...(collapse ? { collapse: true } : {}), ...(project !== undefined ? { project } : {}), ...(captureTrivia ? { captureTrivia: true } : {}), ...(trailingTrivia ? { trailingTrivia: true } : {}) }
    : baseDef
  // Arity-gated elision — decided once, identically to the compiler (build-arity.ts).
  // When the build never reads the trivia (4th) arg, disable per-node CST-trivia
  // capture for the inner scope; when it never reads state (5th), skip the state clone.
  // A STRUCTURAL node (no own build) defers to `ctx.build` / a default CST, which
  // may read either, so capture both.
  // These are the DIRECT builder's own needs, and they are not the whole story. A node
  // with its own build is re-routed through `ctx.build` when that host marks itself
  // `_parsemanCstOutput` (see the dispatch below) — and then the HOST, not the builder,
  // is the consumer. Nearly every AST builder is `children => …`, arity 1, so under a CST
  // host these nodes handed the host an EMPTY triviaLog and absent fields and state, and
  // an empty trivia log is indistinguishable from a node that genuinely had none.
  //
  // The COMPILED engine settles this at build time (`compile(g, { hostMode: 'cst' })`,
  // added in 0.37.0), where it costs nothing. The interpreter has no compile step and
  // stays dynamic, so it re-decides per parse — which is the same answer, reached the
  // only way this engine can reach it.
  const capturesTrivia = captureTrivia || trailingTrivia || (build ? buildReadsTrivia(def) : project === undefined)
  const clonesState = build ? buildReadsState(def) : project === undefined
  const hasOwnFields = parserHasOwnFields(combinator)
  const capturesFields = hasOwnFields && (build ? buildReadsFields(def) : project === undefined)
  // First-set fail-fast (mirrors emitNode's codegen guard): a node whose body can't
  // match empty and whose first set can't start here can only fail, so reject BEFORE
  // allocating the CST capture frame. Sound and output-neutral — the failing body
  // would capture nothing and beginCstNodeCapture saves/restores every buffer, so
  // skipping returns the same failure the body's start-fail produces. Skipped under a
  // completions probe / tolerant recovery, where the swallowed failure still feeds the
  // probe (matching the codegen guard's `!ctx.recovery` gate).
  const guardable = combinator._meta.firstSet.kind !== 'any' && !matchesEmpty(combinator)
  let failExpected: string[] | undefined
  return {
    _tag: 'node',
    _meta: meta,
    _def: def,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<N> {
      if (guardable && ctx._probe === undefined && !ctx._tolerant && !startsFirstSet(combinator, input, pos)) {
        if (failExpected === undefined) {
          const e = deriveExpected(combinator)
          failExpected = e.length > 0 ? e : [combinator._tag]
        }
        return { ok: false, expected: failExpected, span: { start: pos, end: pos } }
      }
      // Under a positioned-CST host a direct builder is bypassed, so capture must follow
      // what the HOST reads. Mirrors `hostMode: 'cst'` in the compiled engine, which
      // captures unconditionally there because it knows the mode at compile time.
      const hasDirectValue = build !== undefined || project !== undefined
      const hostCst = hasDirectValue && cstOutputHost(ctx.build)
      const effTrivia = capturesTrivia || hostCst
      const effFields = capturesFields || (hostCst && hasOwnFields)
      const saved = beginCstNodeCapture(ctx)
      const savedFields = ctx._fields
      ctx._fields = effFields ? [] : undefined
      // Per-node-type trivia-kind mask: a structural (host-built) node may want
      // only certain kinds captured (comments for Ruleset, whitespace for
      // CompoundSelector). Scoped here, restored below — matches the compiled path.
      const savedMask = ctx._triviaCaptureMask
      if (build === undefined && project === undefined && ctx.build?._parsemanTriviaKinds !== undefined && def.type !== undefined) {
        ctx._triviaCaptureMask = ctx.build._parsemanTriviaKinds(def.type)
      }
      // Short-circuit the per-node trivia push (scanTrivia gates on captureTrivia)
      // without touching the global _triviaLog, which is committed independently.
      if (!effTrivia) ctx.captureTrivia = false
      let r = combinator.parse(input, pos, ctx)
      if (r.ok && trailingTrivia && ctx.trivia) {
        const end = consumeTrivia(input, r.span.end, ctx)
        r = { ...r, span: { start: r.span.start, end } }
      }
      const fields = effFields ? buildFieldMap(ctx._fields) : undefined
      ctx._fields = savedFields
      ctx._triviaCaptureMask = savedMask
      const { children, rawChildren, triviaLog } = endCstNodeCapture(ctx, saved)

      if (!r.ok) return r

      // unwrap/collapse: a single captured child IS the value — skip build.
      const st = clonesState && ctx.state !== undefined ? Object.assign({}, ctx.state as Record<string, unknown>) : undefined
      const nodeType = def.type ?? missingInferredType()
      const cstOutput = cstOutputHost(ctx.build)
      const span = ctx.trackLines ? annotateSpanFromLineContext(r.span, ctx) : r.span
      // A direct builder that never declared `state` still owes the host its snapshot.
      // The clone happens AFTER the body, so unlike trivia it needs no gate up front —
      // build it here, on a branch the eval-AST path never takes. Matches what
      // `hostMode: 'cst'` does in the compiled engine.
      const hostState = clonesState
        ? st
        : ctx.state !== undefined ? Object.assign({}, ctx.state as Record<string, unknown>) : undefined
      const built: unknown = unwrap && children.length === 1
        ? unwrapChild(children[0])
        : collapse && children.length === 1
          ? children[0]
        : !build
          && project === undefined
          && ctx.build?._parsemanCstCollapse
          && children.length === 1
          && rawChildren.length === 1
          && ctx.build._parsemanCstCollapse(nodeType, children[0], children, rawChildren)
          ? children[0]
        : project !== undefined
          ? cstOutput && ctx.build
            ? ctx.build(nodeType, children, fields, span, rawChildren, triviaLog, hostState)
            : projectChild(children, project, nodeType)
        : build
          // A direct builder normally owns its result. The positioned-CST host is
          // the one exception: it must never receive an arbitrary AST object as a
          // child of a CST node, so build this grammar node through that host.
          ? cstOutput && ctx.build
            ? ctx.build(nodeType, children, fields, span, rawChildren, triviaLog, hostState)
            : build(children, fields, span, rawChildren, triviaLog, st)
          // Structural node: a `ctx.build` host if present, else a default CST.
          : ctx.build
              ? ctx.build(nodeType, children, fields, span, rawChildren, triviaLog, st)
              : { _tag: 'node', type: nodeType, span: ctx.trackLines ? { ...span } : { start: r.span.start, end: r.span.end }, state: st ?? null, children }
      const rawEntry = isCstChild(built)
        ? built
        // A direct semantic object is opaque to the raw CST, but its source is
        // not. Preserve the exact matched span so legacy/structural parents can
        // retain text and trivia without fabricating an empty token.
        : { _tag: 'leaf', value: typeof built === 'string' ? built : typeof built === 'object' && built !== null ? input.slice(r.span.start, r.span.end) : '', span }
      if (saved.buf !== undefined || saved.ch !== undefined) {
        pushCstChild(ctx, built, rawEntry)
      }
      return { ok: true, value: built as N, span }
    },
  }
}
