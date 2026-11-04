# Node Projection Perf Evidence

Date: 2026-07-26

`node(..., { project: index })` is a compile/code-size and allocation cleanup for
grammar rules whose direct builder only returns one captured child. It is not claimed
as a measured parser speedup in 0.40.0.

## What changes

- No direct `build` callback is stored for the projected node.
- Macro/static lowering emits an array-index projection instead of a `_build[n](...)`
  call.
- Serializable IR carries `project: index` as data rather than callback source.
- AST mode still allocates the node child collector, because projection reads from
  captured children. CST mode keeps the existing full child/raw/trivia host frame.

## Focused evidence

The unit suite checks the mechanical claims directly:

- `test/unit/collapse-node.test.ts` asserts macro output contains no `node('Paren'...)`
  source call for a projected node and AST/CST output stays correct.
- `test/unit/ir-serialize.test.ts` asserts projection round-trips through static
  linkable IR as `project: 1`.
- `test/unit/plugin-coverage.test.ts` asserts the macro evaluator records projection
  as node definition data, not a build callback.

## Non-claims

No Jess or workload benchmark was run for a speed claim. A real speed claim would need
a grammar migration that replaces representative direct builders with `project`, then a
before/after workload run on the same inputs. Until then, the credible benefit is fewer
callback slots and less serialized callback source in the specific rules that adopt it.
