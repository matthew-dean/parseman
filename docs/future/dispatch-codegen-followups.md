# Dispatch Codegen Follow-Ups

These are worthwhile but intentionally outside the current focused dispatch/routed
optimization slice.

## Non-Immediate Pair Elision

The compiler now elides the public dispatch tuple for the common immediate
`transform(dispatch(...), ([, tail]) => tail)` shape. A broader analysis could
propagate "tail-only" value usage through simple wrappers or named helpers, but
that needs a real value-flow proof so public `dispatch()` still returns
`[selector, tail]` whenever user code can observe it.

## Exact-Key Switch Lowering

Case-sensitive exact string `when(...)` arms could sometimes lower to a
`switch (_dkey)` or generated lookup table. That should be benchmarked against
the current `if`/`else if` chain first: short exact key lists are already cheap,
and matcher arms, grouped keys, case-insensitive keys, coverage events, and
committed branch failures still need the current ordered-control semantics.
