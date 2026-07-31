/**
 * The AST path: what a COMPILER asks a parser for, as opposed to what an editor
 * asks for.
 *
 * ## Why this file exists
 *
 * The owner's ruling is that AST construction is parseman's canonical measure and
 * the CST is the nice-to-have — an IDE waits on a human, a build waits on nobody.
 * Every speed number this repo's broad gate produced was nonetheless a CST number,
 * because `bench/workloads/index.ts` had exactly one reducer and it was the
 * five-argument one.
 *
 * That is not a cosmetic gap. A design whose thesis is "don't build what nobody
 * reads" cannot win on a consumer that reads everything, and measuring it there is
 * measuring the one case that refutes it by construction. A deferred-leaf lane was
 * benchmarked exclusively on `bootstrap4` CST, read 0/4 and ~19% slower, and was
 * nearly closed on evidence that could not have come out any other way.
 *
 * ## What actually differs, mechanically
 *
 * Not vibes — three specific compiler switches, all of them already in parseman
 * and none of them previously benchmarked against each other on one grammar:
 *
 * 1. **`compile(g, { hostMode })`** — `src/compiler/codegen.ts:3608`. In `'cst'`
 *    every collector is captured unconditionally; in `'ast'` (the default) capture
 *    follows the builder's ARITY alone and the positioned-CST host branch is not
 *    emitted at all (`ctx.hostBranchElided`, codegen.ts:3615).
 * 2. **Reducer arity** — codegen.ts:3617-3622 gates `capturesTrivia`,
 *    `clonesState`, `capturesChildren`, `capturesRaw` and `capturesFields` on
 *    `Function.length`. The CST reducer declares five parameters, so all five
 *    tiers stay live. `astBuild` declares ONE.
 * 3. **`_triviaLog` on the parse context** — presence-activated
 *    (`src/cst/capture-buffer.ts:220`). The CST path passes `[]`; the AST path
 *    does not pass it.
 *
 * ## What the AST deliberately does NOT keep
 *
 * `STRUCTURAL` below is the delimiter set — `{ } ( ) [ ] ; : ,`. A compiler AST
 * stores the property name and the value tokens of `color: red;`; it does not
 * store the colon or the semicolon, because their information is the tree shape
 * itself. Operators and combinators are NOT in the set: `>` in a selector and `*`
 * in an expression are semantic and a real AST keeps them.
 *
 * This is the population line for any deferred-materialisation design, and
 * `leafCensus` measures it rather than asserting it: on the AST path every leaf is
 * still ALLOCATED as a `{_tag,value,span}` object before the reducer runs
 * (`emitLeafCapture`, codegen.ts:794-812) while only the non-structural ones are
 * ever READ. The gap between those two counts is the size of the prize, and it is
 * a number this repo did not previously have.
 */
import { node, type Combinator } from '../../src/index.ts'
import type { NodeFactory } from './less.ts'

/**
 * A compiler AST node: a kind, the token texts it keeps, and its child nodes.
 *
 * Plain data with no class and no shared identity, for the same reason
 * `WorkloadNode` is: the gate compares the two sides of an A/B with
 * `JSON.stringify` and they come from two separate module graphs.
 */
export type AstNode = {
  k: string
  t: string[]
  c: AstNode[]
}

/** The one leaf shape parseman hands a reducer — see `emitLeafCapture`. */
type Leaf = { _tag: 'leaf'; value: string; span: { start: number; end: number } }

const isLeaf = (v: unknown): v is Leaf =>
  typeof v === 'object' && v !== null && (v as { _tag?: unknown })._tag === 'leaf'

const isAstNode = (v: unknown): v is AstNode =>
  typeof v === 'object' && v !== null && typeof (v as { k?: unknown }).k === 'string'

/**
 * Delimiters a compiler AST discards. Deliberately NOT "all punctuation":
 * `>`, `+`, `~`, `*`, `/`, `-` and `!` carry meaning in this grammar and are kept.
 */
const STRUCTURAL: ReadonlySet<string> = new Set(['{', '}', '(', ')', '[', ']', ';', ':', ','])

/**
 * The AST factory. Arity ONE — it reads `children` and nothing else, so codegen
 * elides the rawChildren, trivia and state tiers.
 */
export const astNodeFactory: NodeFactory = (type, body) =>
  node(type, body, (children: ReadonlyArray<unknown>): AstNode => {
    const t: string[] = []
    const c: AstNode[] = []
    for (let n = 0; n < children.length; n++) {
      const ch = children[n]
      if (isLeaf(ch)) {
        if (!STRUCTURAL.has(ch.value)) t.push(ch.value)
      } else if (isAstNode(ch)) {
        c.push(ch)
      }
    }
    return { k: type, t, c }
  })

export type LeafCensus = {
  /** Leaf objects parseman allocated and handed to a reducer. */
  allocated: number
  /** Leaves the AST actually read the text of. */
  read: number
  /** Leaves discarded as pure delimiters — the deferred-materialisation population. */
  structural: number
  nodes: number
}

/**
 * Count leaves allocated vs leaves read, on the AST path.
 *
 * A SEPARATE factory rather than a counter inside `astNodeFactory`, because a
 * tally in the reducer would be inside the timed path and every number this
 * harness prints would then include the cost of measuring itself.
 */
export function censusNodeFactory(census: LeafCensus): NodeFactory {
  return (type, body) =>
    node(type, body, (children: ReadonlyArray<unknown>): AstNode => {
      const t: string[] = []
      const c: AstNode[] = []
      census.nodes++
      for (let n = 0; n < children.length; n++) {
        const ch = children[n]
        if (isLeaf(ch)) {
          census.allocated++
          if (STRUCTURAL.has(ch.value)) census.structural++
          else { census.read++; t.push(ch.value) }
        } else if (isAstNode(ch)) {
          c.push(ch)
        }
      }
      return { k: type, t, c }
    })
}

export const emptyCensus = (): LeafCensus => ({ allocated: 0, read: 0, structural: 0, nodes: 0 })

/**
 * A deliberate, KNOWN-SIZE slowdown injected into the AST reducer.
 *
 * This exists so the harness can be shown detecting something rather than
 * asserted to. `pnpm perf:ast --prove` compiles one side with this factory and
 * requires the gate to go red; a gate that cannot be watched failing is not known
 * to work, and thirteen gates in this project have been found green while
 * checking nothing.
 *
 * The work is proportional to leaves read, so the cost lands on exactly the path
 * under test, and it is real work V8 cannot fold away — the result is stored on
 * the node so nothing is dead.
 */
export function slowedNodeFactory(spins: number): NodeFactory {
  return (type, body) =>
    node(type, body, (children: ReadonlyArray<unknown>): AstNode => {
      const t: string[] = []
      const c: AstNode[] = []
      for (let n = 0; n < children.length; n++) {
        const ch = children[n]
        if (isLeaf(ch)) {
          if (!STRUCTURAL.has(ch.value)) {
            let h = 0
            for (let s = 0; s < spins; s++) h = (h * 31 + ch.value.length + s) | 0
            t.push(h === 0x7fffffff ? '' : ch.value)
          }
        } else if (isAstNode(ch)) {
          c.push(ch)
        }
      }
      return { k: type, t, c }
    })
}

/** Total nodes and kept tokens in a built AST — the size of what a compiler holds. */
export function astSize(root: unknown): { nodes: number; tokens: number } {
  let nodes = 0
  let tokens = 0
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const v = stack.pop()
    if (!isAstNode(v)) continue
    nodes++
    tokens += v.t.length
    for (let n = 0; n < v.c.length; n++) stack.push(v.c[n])
  }
  return { nodes, tokens }
}

export type { Combinator }
