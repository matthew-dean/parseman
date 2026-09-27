/**
 * The macro plugin's IR evaluator: turns a composed grammar's carried IR back
 * into combinators so the build can re-lower it. Build time only — see below.
 */
import type { Combinator } from '../types.ts'
import { rules } from '../combinators/parser.ts'
import { ref } from '../combinators/ref.ts'
import { regex } from '../combinators/regex.ts'
import { literal } from '../combinators/literal.ts'
import { keywords } from '../combinators/keywords.ts'
import { sequence } from '../combinators/sequence.ts'
import { choice } from '../combinators/choice.ts'
import { dispatch, endsWith, matches, otherwise, routed, startsWith, when } from '../combinators/dispatch.ts'
import { attempt } from '../combinators/attempt.ts'
import { many, oneOrMore, optional, sepBy, keepSeparator } from '../combinators/repeat.ts'
import { not } from '../combinators/not.ts'
import { peek } from '../combinators/peek.ts'
import { node } from '../combinators/node.ts'
import { parser } from '../combinators/grammar.ts'
import { scanTo, balanced } from '../combinators/scanTo.ts'
import { token, leaf } from '../combinators/token.ts'
import { classifiedTrivia, transform, trivia, label, field } from '../combinators/map.ts'
import { expect as expectC } from '../combinators/expect.ts'
import { withCtx } from '../combinators/withCtx.ts'
import { adjacent, notAdjacent } from '../combinators/adjacency.ts'

type Comb = Combinator<unknown>

/** Reconstruct a rule map from serialized IR (the inverse of `serializeRuleMap`) —
 * evaluate the combinator-construction expression with every constructor in scope.
 *
 * BUILD TIME ONLY. It evaluates source text, so it lives in the plugin, which runs
 * in the bundler; no runtime module imports it
 * (docs/design/runtime-and-size-contract.md, rule 1). */
export function evalRuleMapIR(ir: string): Array<[string, Comb]> {
  // `_tf`/`_nd` reconstruct a transform/node AND restore its captured callback
  // source (`_def.fnSrc`/`buildSrc`) so re-lowering inlines it statically. The live
  // fn is only needed for interpreted mode; a self-contained transform source is
  // eval'd, a node build (which may reference imported AST classes) is left to its
  // source only. Macro-only validation metadata is carried as plain data: this
  // runtime module never parses callback source or imports a compiler frontend.
  const _tf = (child: Comb, src: string, recognitionOnly = false): Comb => {
    let fn: (...a: unknown[]) => unknown
    // eslint-disable-next-line no-eval
    try { fn = (0, eval)(`(${src})`) } catch { fn = () => { throw new Error('IR transform fn not materialized') } }
    const t = transform(child as never, fn as never)
    ;(t._def as { fnSrc?: string }).fnSrc = src
    if (recognitionOnly) (t._def as { recognitionOnly?: boolean }).recognitionOnly = true
    return t as Comb
  }
  const _lf = (child: Comb, src: string): Comb => {
    let fn: (...a: unknown[]) => unknown
    // eslint-disable-next-line no-eval
    try { fn = (0, eval)(`(${src})`) } catch { fn = () => { throw new Error('IR leaf fn not materialized') } }
    const l = leaf(child as never, fn as never)
    ;(l._def as { fnSrc?: string }).fnSrc = src
    return l as Comb
  }
  const _nd = (type: string, child: Comb, src: string, opts?: unknown, staticError?: readonly string[], sigSrc?: string, buildImports?: ReadonlyArray<{ local: string; source: string; imported: string }>, rawUnused?: true): Comb => {
    if (staticError !== undefined && staticError.length > 0) {
      // Fail closed: a builder with an un-rescuable binding is NOT fused. The
      // plugin catches this and leaves the runtime compose() in place rather than
      // shipping a fused table that would ReferenceError on import. Import-rescued
      // free names never reach here — they ride in `buildImports`, not `staticError`.
      throw new Error(`IR direct node builder for ${type} must be macro-static and self-contained; unsupported binding(s): ${staticError.join(', ')}`)
    }
    // A serialized direct builder needs an inert sentinel as well as buildSrc.
    // `node(..., undefined)` is structural, so re-lowering a composed artifact
    // silently routes it through ctx.build/default CST even though the IR still
    // carries the callback source. The compiler is the only consumer that may
    // materialize `buildSrc`; raw IR interpretation deliberately rejects direct
    // builders rather than evaluating arbitrary captured source at runtime.
    const n = node(type, child as never, (() => { throw new Error('IR node build requires static re-lowering') }) as never, opts as never)
    ;(n._def as { buildSrc?: string; buildStaticError?: readonly string[] }).buildSrc = src
    if (staticError !== undefined) (n._def as { buildStaticError?: readonly string[] }).buildStaticError = staticError
    // Analysis-only resolved reducer signature (see `buildAnalysisSrc`). Without it a
    // re-lowered composed artifact silently re-acquires the fail-open capture cost the
    // authoring module had already resolved away.
    if (sigSrc !== undefined) (n._def as { buildSigSrc?: string }).buildSigSrc = sigSrc
    if (rawUnused === true) (n._def as { buildRawUnused?: true }).buildRawUnused = true
    // Re-attach the direct-builder import provenance so the plugin's re-lower pass
    // can re-emit the imports into the consuming module. Plain data — this runtime
    // module never resolves or emits imports itself.
    if (buildImports !== undefined) (n._def as { buildImports?: ReadonlyArray<{ local: string; source: string; imported: string }> }).buildImports = buildImports
    return n as Comb
  }
  // `_gch` rebuilds a GATED choice AND restores its `_def.gateSrcs` (parallel to the
  // arms) — the gate mirror of `_tf`/`_nd`. Each item is either a plain arm or a
  // `[gateSource, arm]` tuple: the source is eval'd to the live predicate (interpreted
  // mode) and recorded as the arm's gateSrcs entry so re-lowering INLINES the gate
  // statically (keeping the artifact fusible via `emitFusedSource`). A missing/failed
  // source falls back to a throwing predicate — the same contract as `_tf`.
  const _gch = (items: Array<Comb | [string, Comb]>): Comb => {
    const gateSrcs: (string | null)[] = []
    const arms = items.map(it => {
      if (Array.isArray(it)) {
        const [src, comb] = it
        gateSrcs.push(src)
        let gate: (s: unknown) => boolean
        // eslint-disable-next-line no-eval
        try { gate = (0, eval)(`(${src})`) } catch { gate = () => { throw new Error('IR gate fn not materialized') } }
        return { gate, combinator: comb }
      }
      gateSrcs.push(null)
      return it
    })
    const c = (choice as (...a: unknown[]) => Comb)(...arms)
    // `choice` is the authority on gate alignment; `gateSrcs` must line up 1:1 with
    // the constructed `_def.gates`. They always do on the normal path (both from the
    // same `items.map`), but assert it so a future change in `choice` that coalesces
    // or drops arms can't silently ship a mis-aligned gate-source array.
    const gates = (c._def as { gates?: unknown[] }).gates
    if (gates && gates.length !== gateSrcs.length) {
      throw new Error(`_gch: gateSrcs length ${gateSrcs.length} != choice gates length ${gates.length}`)
    }
    ;(c._def as { gateSrcs?: (string | null)[] }).gateSrcs = gateSrcs
    return c
  }
  // `_wc` rebuilds a `withCtx` AND restores its `_def.extraSrc` (the source of the
  // `extra`/state value) — the withCtx mirror of `_tf`/`_nd`/`_gch`. The source is
  // eval'd to the live `extra` value (interpreted mode) and recorded on the def so
  // re-lowering INLINES the state getter statically (`() => (extraSrc)`), keeping the
  // artifact fusible via `emitFusedSource`. A plain `withCtx(value, inner)` would
  // leave `extraSrc` unset → codegen emits a source-less runtime closure (a non-static
  // callback) → `emitFusedSource` fails and a downstream `compose()` silently falls
  // back to a runtime fuse. A missing/failed source falls back to `undefined` state —
  // the same best-effort contract as `_tf`.
  const _wc = (src: string, inner: Comb): Comb => {
    let extra: unknown
    // eslint-disable-next-line no-eval
    try { extra = (0, eval)(`(${src})`) } catch { extra = undefined }
    const w = (withCtx as (e: unknown, c: Comb) => Comb)(extra, inner)
    ;(w._def as { extraSrc?: string }).extraSrc = src
    return w
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'rules', 'ref', 'regex', 'literal', 'keywords', 'sequence', 'choice', 'dispatch', 'when', 'startsWith', 'endsWith', 'matches', 'otherwise', 'routed', 'attempt',
    'many', 'oneOrMore', 'optional', 'sepBy', 'keepSeparator', 'not', 'peek', 'node', 'parser',
    'scanTo', 'balanced', 'token', 'leaf', 'transform', 'trivia', 'classifiedTrivia', 'label', 'field', 'expect', 'adjacent', 'notAdjacent', '_tf', '_lf', '_nd', '_gch', '_wc',
    `return (${ir})`,
  )
  const map = fn(
    rules, ref, regex, literal, keywords, sequence, choice, dispatch, when, startsWith, endsWith, matches, otherwise, routed, attempt,
    many, oneOrMore, optional, sepBy, keepSeparator, not, peek, node, parser,
    scanTo, balanced, token, leaf, transform, trivia, classifiedTrivia, label, field, expectC, adjacent, notAdjacent, _tf, _lf, _nd, _gch, _wc,
  ) as Record<string, Comb>
  return Object.entries(map)
}
