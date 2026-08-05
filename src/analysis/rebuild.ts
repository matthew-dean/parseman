/**
 * Rebuild a combinator graph THROUGH THE PUBLIC FACTORIES, substituting selected nodes.
 *
 * This exists so a proposed grammar fix can be APPLIED and then MEASURED, rather than
 * printed and hoped for. Everything downstream — `proposeFixes()` — depends on one
 * property: a rewritten grammar must be a real grammar, built the same way the author's
 * was, so that compiling it and parsing with it means the same thing.
 *
 * WHY THE FACTORIES AND NOT A `_def` DEEP-COPY
 * --------------------------------------------
 * A combinator is two things at once: a `_def` descriptor the COMPILER reads, and a
 * `parse` closure the INTERPRETER runs, which captured its children when the factory
 * ran. Patching `_def.parser` moves the compiled engine and leaves the interpreted one
 * on the old graph — the two engines would then disagree, and a verification that runs
 * either one would certify a rewrite that does not exist in the other. Re-running the
 * factory produces both halves from the same inputs, and also recomputes everything
 * DERIVED that the fix is trying to move in the first place: `_meta.firstSet`,
 * `choice._def.disjoint`, and the choice strategy.
 *
 * FROZEN SUBTREES, NOT A FAILED REBUILD
 * -------------------------------------
 * Some node kinds have no faithful public reconstruction — `dispatch` (its arms carry
 * matcher objects), `recover`, `scanTo`, `guard`, `withCtx`, `trivia` (classified
 * trivia carries labels derived at construction). Refusing to rebuild a whole grammar
 * because it contains one of them would make this useless on every real grammar. So
 * such a node is REUSED VERBATIM: nothing inside it changed, so reusing it is exact.
 * The cost is precise and reported — a rewrite target that sits inside a frozen subtree
 * cannot be applied, and comes back in `unapplied` so the caller can say WHY rather
 * than silently dropping it.
 *
 * THE HONESTY BACKSTOP
 * --------------------
 * This module does not claim to be faithful; it is CHECKED. `proposeFixes()` first
 * rebuilds with NO substitutions and requires that identity rebuild to produce
 * byte-identical parse output over the caller's corpus. If any option threading below
 * is wrong, that check fails and NO fix is offered for that grammar. A rebuilder that
 * is wrong makes the tool silent, never wrong.
 */
import type { Combinator, ParserDef } from '../types.ts'
import { literal } from '../combinators/literal.ts'
import { regex } from '../combinators/regex.ts'
import { keywords } from '../combinators/keywords.ts'
import { sequence } from '../combinators/sequence.ts'
import { choice } from '../combinators/choice.ts'
import { attempt } from '../combinators/attempt.ts'
import { many, oneOrMore, optional, sepBy } from '../combinators/repeat.ts'
import { ref } from '../combinators/ref.ts'
import { not } from '../combinators/not.ts'
import { peek } from '../combinators/peek.ts'
import { node } from '../combinators/node.ts'
import { transform, label, field } from '../combinators/map.ts'
import { token, leaf } from '../combinators/token.ts'
import { expect } from '../combinators/expect.ts'
import { adjacent, notAdjacent } from '../combinators/adjacency.ts'
import { parser } from '../combinators/grammar.ts'

/** A node kind reused verbatim: no public factory reconstructs it without loss. */
const FROZEN_TAGS: ReadonlySet<string> = new Set([
  'dispatch', 'recover', 'scanTo', 'guard', 'withCtx', 'routed', 'trivia', 'unknown',
])

/** A subtree that was reused verbatim instead of rebuilt. */
export type FrozenSubtree = {
  tag: string
  /** Nearest enclosing rule name, so the report can point at it. */
  rule: string
}

export type RebuildResult = {
  root: Combinator<unknown>
  /** Reused-verbatim subtrees, deduplicated by (rule, tag) and sorted. */
  frozen: FrozenSubtree[]
  /**
   * Substitutions that could NOT be applied because their target sits inside a frozen
   * subtree. Non-empty means the returned graph is NOT the graph the caller asked for.
   */
  unapplied: Combinator<unknown>[]
}

/** `_meta` fields stamped by `rules()` / `parser()` that a factory does not recompute. */
const CARRIED_META = [
  'grammarTrivia', 'grammarScanSkip', 'grammarHostMode', 'grammarTrackLines',
  'rootTriviaClassified',
] as const

function carryStamps(from: Combinator<unknown>, to: Combinator<unknown>): void {
  const fromRule = (from as { _ruleName?: string })._ruleName
  if (fromRule !== undefined) (to as { _ruleName?: string })._ruleName = fromRule
  const fm = from._meta as Record<string, unknown>
  const tm = to._meta as Record<string, unknown>
  for (const k of CARRIED_META) if (fm[k] !== undefined && tm[k] === undefined) tm[k] = fm[k]
}

/** Every combinator reachable from `p`, without resolving refs (used to test containment). */
function subtreeContains(p: Combinator<unknown>, targets: ReadonlySet<Combinator<unknown>>): Combinator<unknown>[] {
  const hit: Combinator<unknown>[] = []
  const seen = new Set<Combinator<unknown>>()
  const walk = (c: Combinator<unknown>): void => {
    if (seen.has(c)) return
    seen.add(c)
    if (targets.has(c)) hit.push(c)
    const d = (c as { _def?: unknown })._def as ParserDef | undefined
    if (d === undefined || typeof d !== 'object') return
    const rec = d as unknown as Record<string, unknown>
    const kids: Combinator<unknown>[] = []
    if (Array.isArray(rec.parsers)) kids.push(...(rec.parsers as Combinator<unknown>[]))
    if (Array.isArray(rec.skip)) kids.push(...(rec.skip as Combinator<unknown>[]))
    for (const k of ['parser', 'main', 'skipped', 'separator', 'sentinel', 'selector', 'otherwise', 'fallback', 'triviaParser'])
      if (rec[k]) kids.push(rec[k] as Combinator<unknown>)
    if (d.tag === 'dispatch') {
      for (const c2 of d.cases) kids.push(c2.parser)
      if (d.matchers) for (const c2 of d.matchers) kids.push(c2.parser)
    }
    for (const k of kids) walk(k)
  }
  walk(p)
  return hit
}

/**
 * Rebuild `root`, replacing every combinator that is a key of `replacements` with its
 * value. The replacement is spliced WITHOUT descending into the original target.
 */
export function rebuildCombinator(
  root: Combinator<unknown>,
  replacements: ReadonlyMap<Combinator<unknown>, Combinator<unknown>>,
): RebuildResult {
  const memo = new Map<Combinator<unknown>, Combinator<unknown>>()
  const frozenKeys = new Set<string>()
  const frozen: FrozenSubtree[] = []
  const unapplied: Combinator<unknown>[] = []
  const targets = new Set(replacements.keys())

  const go = (p: Combinator<unknown>, rule: string): Combinator<unknown> => {
    const already = memo.get(p)
    if (already !== undefined) return already
    const sub = replacements.get(p)
    if (sub !== undefined) { memo.set(p, sub); return sub }

    const d = (p as { _def?: unknown })._def as ParserDef | undefined
    if (d === undefined || typeof d !== 'object') { memo.set(p, p); return p }
    const here = (p as { _ruleName?: string })._ruleName ?? rule

    if (FROZEN_TAGS.has(d.tag)) {
      const key = JSON.stringify([here, d.tag])
      if (!frozenKeys.has(key)) { frozenKeys.add(key); frozen.push({ tag: d.tag, rule: here }) }
      for (const t of subtreeContains(p, targets)) if (!unapplied.includes(t)) unapplied.push(t)
      memo.set(p, p)
      return p
    }

    // A ref/lazy is the only place a cycle can close. Publish an EMPTY slot into the
    // memo before descending, so a body that refers back to this rule binds to the
    // new slot rather than re-entering (which would not terminate).
    if (d.tag === 'lazy') {
      let target: Combinator<unknown>
      try { target = (d as { thunk(): Combinator<unknown> }).thunk() }
      catch {
        // An undefined ref: nothing to rebuild through, and nothing inside it to miss.
        memo.set(p, p)
        return p
      }
      const slot = ref<unknown>()
      memo.set(p, slot)
      slot.define(go(target, here))
      carryStamps(p, slot)
      return slot
    }

    const one = (c: Combinator<unknown>): Combinator<unknown> => go(c, here)
    let out: Combinator<unknown>
    switch (d.tag) {
      case 'literal':
        out = literal(d.value, d.caseInsensitive ? { caseInsensitive: true } : {}); break
      case 'regex':
        out = regex(d.source, d.flags); break
      case 'keywords':
        out = keywords(d.words, {
          ...(d.caseInsensitive ? { caseInsensitive: true } : {}),
          ...(d.boundary === undefined ? {} : { boundary: d.boundary }),
        }); break
      case 'sequence': {
        const kids = d.parsers.map(one) as [Combinator<unknown>, ...Combinator<unknown>[]]
        out = sequence(...kids); break
      }
      case 'choice': {
        // A per-arm gate predicate cannot be re-wrapped through the public `choice()`
        // arity (it takes GatedArm objects the grammar built), and the whole point of
        // rebuilding a choice is that its strategy is recomputed — which the gated path
        // suppresses anyway. Freeze it rather than rebuild it wrong.
        if (d.gates.some(g => g !== null)) {
          const key = JSON.stringify([here, "choice(gated)"])
          if (!frozenKeys.has(key)) { frozenKeys.add(key); frozen.push({ tag: 'choice(gated)', rule: here }) }
          for (const t of subtreeContains(p, targets)) if (!unapplied.includes(t)) unapplied.push(t)
          memo.set(p, p)
          return p
        }
        const kids = d.parsers.map(one) as [Combinator<unknown>, ...Combinator<unknown>[]]
        out = choice(...kids); break
      }
      // Reconstructible from public factories with no loss, so NOT frozen.
      case 'adjacency':
        out = d.polarity === 'adjacent'
          ? adjacent()
          : d.kinds === undefined ? notAdjacent() : notAdjacent({ kinds: d.kinds })
        break
      case 'attempt': out = attempt(one(d.parser)); break
      case 'not': out = not(one(d.parser)); break
      case 'peek': out = peek(one(d.parser)); break
      case 'optional': out = optional(one(d.parser)); break
      case 'many':
        out = many(one(d.parser), d.max === undefined ? {} : { max: d.max }); break
      case 'oneOrMore':
        out = oneOrMore(one(d.parser), { min: d.min, ...(d.max === undefined ? {} : { max: d.max }) }); break
      case 'sepBy':
        out = sepBy(one(d.parser), one(d.separator), {
          min: d.min,
          ...(d.max === undefined ? {} : { max: d.max }),
          ...(d.trailing === undefined ? {} : { trailing: d.trailing }),
        }); break
      case 'transform': out = transform(one(d.parser), d.fn); break
      case 'label': out = label(d.label, one(d.parser)); break
      case 'field': out = field(d.name, one(d.parser)); break
      case 'token': out = token(one(d.parser)); break
      case 'leaf': out = leaf(one(d.parser), d.fn); break
      // A LABELLED expect reproduces `d.expected` exactly (`expect` sets it to `[label]`).
      // An unlabelled one RE-DERIVES it from the rebuilt inner parser, so it can differ
      // from `d.expected` when derivation hit an undefined `lazy` thunk in a different
      // order than the original construction did. That is diagnostic text, not parse
      // output: `fix.ts` — the only consumer of this rebuild — compares failures by
      // POSITION and excludes `expected` labels by design (see its module header).
      // Preserving `d.expected` verbatim would need an expected-set override on the
      // public `expect()` signature, which is not worth widening for a label.
      case 'expect': out = expect(one(d.parser), d.label) as Combinator<unknown>; break
      case 'node': {
        const opts = {
          ...(d.unwrap ? { unwrap: true } : {}),
          ...(d.collapse ? { collapse: true } : {}),
          ...(d.project === undefined ? {} : { project: d.project }),
          ...(d.captureTrivia ? { captureTrivia: true } : {}),
          ...(d.trailingTrivia ? { trailingTrivia: true } : {}),
          ...(d.buildArity === undefined ? {} : { buildArity: d.buildArity }),
          ...(d.tags === undefined ? {} : { tags: d.tags }),
        }
        // `node(combinator, build, opts)` — the UNTYPED-with-build arity — drops `opts`
        // (src/combinators/node.ts:159-160 reads the 4th positional argument, which that
        // arity never receives). Reconstructing through it would silently lose
        // unwrap/collapse/project/tags, so freeze that one shape instead.
        if (d.type === undefined && d.build !== undefined && Object.keys(opts).length > 0) {
          const key = `${here} node(untyped+build+opts)`
          if (!frozenKeys.has(key)) { frozenKeys.add(key); frozen.push({ tag: 'node(untyped+build+opts)', rule: here }) }
          for (const t of subtreeContains(p, targets)) if (!unapplied.includes(t)) unapplied.push(t)
          memo.set(p, p)
          return p
        }
        out = d.type === undefined
          ? (d.build === undefined ? node(one(d.parser), opts) : node(one(d.parser), d.build))
          : node(d.type, one(d.parser), d.build, opts)
        break
      }
      case 'grammar': {
        const inner = one(d.parser)
        out = parser({
          ...(d.clearTrivia ? { trivia: null } : d.triviaParser === undefined ? {} : { trivia: d.triviaParser }),
          ...(d.rootCapture === undefined ? {} : { rootCapture: d.rootCapture }),
          ...(d.captureTrivia ? { captureTrivia: true } : {}),
          trackLines: d.trackLines,
        }, inner) as unknown as Combinator<unknown>
        break
      }
      default: {
        const key = JSON.stringify([here, (d as { tag: string }).tag])
        if (!frozenKeys.has(key)) { frozenKeys.add(key); frozen.push({ tag: (d as { tag: string }).tag, rule: here }) }
        for (const t of subtreeContains(p, targets)) if (!unapplied.includes(t)) unapplied.push(t)
        memo.set(p, p)
        return p
      }
    }
    carryStamps(p, out)
    memo.set(p, out)
    return out
  }

  const rebuilt = go(root, (root as { _ruleName?: string })._ruleName ?? '<entry>')
  frozen.sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
  return { root: rebuilt, frozen, unapplied }
}
