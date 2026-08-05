import type { Combinator } from '../types.ts'
import type { HostMode } from '../cst/host-mode.ts'
import { childrenOf } from '../analysis/gating.ts'
import { collectGrammarReflection, type GrammarReflection } from '../cst/reflection.ts'
import { serializeRuleMap } from './ir-serialize.ts'
import { compileRuleMapTable, type TableRuleMapOptions } from '../table/compile-rule-map.ts'
import type { TableProgram, TableRule } from '../table/program.ts'
import { PARSEMAN_VERSION } from '../version.ts'

/**
 * `compileLinkable()` FOR THE TABLE LOWERING — `linkable()` produces TABLES too.
 *
 * ── WHAT `compileLinkable` ACTUALLY RETURNS, AND WHY NONE OF IT TRANSFERS ─────
 * `LinkablePieces` is `prelude` / `ruleFns` / `wrappers` / `firstSets` /
 * `firstSetRecipes` / `nullable` / `deps` / `needsEmptyTl` — every field of it is
 * SOURCE TEXT or an input to resolving source text. It exists because
 * source-lowering composition is a TEXTUAL splice: `fusedBody()` concatenates
 * namespaced preludes, picks a winning `_r_<Name>` per name, and substitutes
 * `@FS:` dispatch placeholders with the winner's first-set condition. A table has
 * no text to splice and no placeholders to resolve, so porting those fields would
 * be porting the mechanism rather than the capability.
 *
 * The capability is: a piece must be RUNNABLE on its own, and COMPOSABLE with
 * other pieces. This artifact carries exactly those two things.
 *
 *   `prog` / `rules`  — the piece AS A TABLE. Present whenever the piece is
 *                       self-contained. This is the ruling: a `linkable()`
 *                       artifact is a table, not a bag of compiled functions.
 *   `ir`              — the piece's combinator graph, serialized. This is the
 *                       composable half, and it is NOT new machinery: the plugin
 *                       already carries pieces as IR (`plugin/index.ts:1772`) and
 *                       the linker already re-lowers them (`linker.ts:640`,
 *                       `compileLinkable(evalRuleMapIR(p.ir), …)`).
 *
 * ── WHY THAT MAKES COMPOSITION THE EASY KIND ─────────────────────────────────
 * The open question was whether table-to-table composition has to merge two
 * ALREADY-ENCODED programs — relocating code offsets and merging const, fn,
 * class, expected and dispatch pools. It does not, as long as every piece
 * carries its IR: the composer evaluates each piece's IR back to a rule map,
 * merges the maps (later pieces overriding earlier names, which is what
 * `compose()` means), and calls `encodeTable` ONCE over the merged map. One
 * encode, no relocation, and the result is byte-for-byte the table the merged
 * grammar would have produced if it had been written as one `rules()` call.
 *
 * The relocation route is only forced for a piece with NO IR, which is why `ir`
 * being null is reported here as a first-class fact rather than folded into a
 * bare `null` return.
 *
 * ── THE HOLE CASE IS NOT REFUSED ─────────────────────────────────────────────
 * A piece that references a rule it does not define (`g.Value` with no
 * `.define()` — `hasExternalRuleRef`'s SHARED-SHAPE signature) cannot be encoded
 * standalone: `encodeTable` resolves a `lazy` by calling its thunk, and that
 * thunk throws. Such a piece gets `prog: null` and `rules: null` and keeps its
 * `ir`, which is the correct answer rather than a refusal: a shape with a hole
 * is not a parser in ANY lowering, and it composes through the merge above,
 * where the hole is filled by whichever piece supplies the name.
 */
export type LinkableTableOptions = Omit<TableRuleMapOptions, 'runtimeRef'>

export type LinkableTable = {
  /**
   * The parseman version that produced this artifact — the same ARTIFACT VERSION
   * LOCK `LinkablePieces.v` carries, for the same reason: artifacts are
   * version-locked and the format has no back-compat read path.
   */
  v: string
  ns: string
  /** Local rule names, external (undefined) entries already dropped. */
  keys: string[]
  /** Rule names this piece REFERENCES but does not define. */
  external: string[]
  /** The piece as a table — null when it has holes (see `external`). */
  prog: TableProgram | null
  /** The runnable form of `prog` — null for the same reason. */
  rules: Record<string, TableRule> | null
  /** The emitted expression for `prog`, or null when there is no `prog`. */
  replacement: string | null
  /**
   * The piece's combinator graph, serialized — the COMPOSABLE half. Null when
   * the map cannot be faithfully serialized (a callback with no captured
   * source); a null here is what would force composition to merge encoded
   * programs instead of merging rule maps.
   */
  ir: string | null
  hostMode: HostMode
  hostBranchElided: boolean
  reflection: GrammarReflection
}

/**
 * Local vs external, decided exactly as `compileLinkable` decides it: a
 * `rules(g => …)` cache also holds every `g.X` that was merely ACCESSED, so an
 * accessed-but-undefined rule leaks into `Object.entries` as an unresolvable
 * lazy. Those are not local rules.
 */
function isLocal(rule: Combinator<unknown>): boolean {
  const d = rule._def
  if (d.tag !== 'lazy') return true
  try { d.thunk(); return true } catch { return false }
}

/** Every named rule this map references but does not define, in first-seen order. */
function externalNames(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
): string[] {
  const out: string[] = []
  const seen = new Set<Combinator<unknown>>()
  const visit = (p: Combinator<unknown>): void => {
    if (seen.has(p)) return
    seen.add(p)
    const d = p._def
    if (d.tag === 'lazy') {
      let resolved: Combinator<unknown> | undefined
      try { resolved = d.thunk() } catch { resolved = undefined }
      if (resolved === undefined) {
        const name = (p as unknown as { _ruleName?: string })._ruleName
        if (name !== undefined && !out.includes(name)) out.push(name)
        return
      }
      visit(resolved)
      return
    }
    for (const child of childrenOf(d)) visit(child)
  }
  for (const [, rule] of ruleMap) visit(rule)
  return out
}

export function compileLinkableTable(
  ruleMapArg: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  ns: string,
  opts: LinkableTableOptions = {},
): LinkableTable | null {
  if (!ns) throw new Error('compileLinkableTable: ns must be a non-empty namespace')
  const ruleMap = ruleMapArg.filter(([, rule]) => isLocal(rule))
  if (ruleMap.length === 0) return null
  const external = externalNames(ruleMap)
  const compiled = external.length === 0 ? compileRuleMapTable(ruleMap, opts) : null
  // Serialized BEFORE anything else needs it and independently of whether the
  // piece encoded: a shape with a hole is precisely the case that has no table
  // and must still compose.
  const ir = serializeRuleMap(ruleMap, opts.scanSkip ?? null)
  if (compiled === null && ir === null) return null

  const hostMode = compiled?.hostMode
    ?? opts.hostMode
    ?? ruleMap.map(([, r]) => r._meta.grammarHostMode).find(Boolean)
    ?? 'ast'
  return {
    v: PARSEMAN_VERSION,
    ns,
    keys: ruleMap.map(([key]) => key),
    external,
    prog: compiled?.prog ?? null,
    rules: compiled?.rules ?? null,
    replacement: compiled?.replacement ?? null,
    ir,
    hostMode,
    hostBranchElided: hostMode === 'ast',
    reflection: compiled?.reflection ?? collectGrammarReflection(ruleMap),
  }
}
