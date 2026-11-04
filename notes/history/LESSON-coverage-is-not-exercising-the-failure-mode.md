# Coverage is not the same as exercising the failure mode

Companion to `HARNESS-pack-two-builds-same-filename.md`. Same lesson from the opposite
end: that one is about an instrument measuring the wrong object, this one is about an
instrument measuring the right object in the wrong *order*.

## The incident

`lane/disjoint-fix` shipped a refresh that MUTATED shared combinator state
(`_meta.firstSet`, `_def.disjoint`). It passed:

  - the full suite, 189 files / 3,619 tests;
  - a differential rejected-input probe, 110 real CSS files, 18,602 derived inputs,
    15,546 of them rejected, whole-result comparison including the `expected` payload,
    delta **0** against a clean-tip control;
  - a four-dialect byte-identity oracle, 7,743 pairs / 6,918 real trees, **0 mismatched**.

An adversarial review found three reproductions in under ten minutes. The worst:
`fuseInterpreted` is publicly exported, and a single `.parse()` before the fuse leaves a
stale dispatch table that returns a wrong **reject** and, because the refresh was
memoized once, never self-corrects.

None of those gates were weak. Every one of them exercised the change. **Not one of them
exercised the same object being compiled twice, or parsed and then composed** — and that
ordering is the only thing that makes the defect appear.

## The question that would have found it

The reviewer's route was not cleverness. It was reading the design choice and asking the
question the choice implies:

> This mutates shared state. What else holds a reference to that object, and what does it
> observe afterwards?

The author picked mutation and never asked it. That is the whole gap.

## The rule

**When a change's mechanism is mutation, caching, or memoization, coverage counts prove
nothing on their own.** Add at least one test that runs the operation TWICE, and at least
one that interleaves it with the other consumers of the same object. State the ordering
in the test name, so the next reader knows the ordering is the point.

Concretely, for anything that writes to a shared graph:

  - compile the same map twice;
  - compile it, then hand it to the other compiler entry;
  - parse it, then compose or fuse it;
  - read an analysis pass before and after a compile and require the same answer.

Those four take minutes to write and they are the entire failure surface of a mutating
design. A suite that does not contain them can be arbitrarily large and still blind.

## Related, and the reason this is filed rather than remembered

A guard is only worth what it ENFORCES, not what it describes. The withdrawn change
stated its soundness boundary as an object-graph property —

> a rule can be overridden at fuse time, so a dispatch table must not be baked over the
> arms visible at compile time

— but enforced it as a call-site convention: "we do not call the refresh in
`compileLinkable`". Object identity walks straight through that. **A guard that describes
one thing and enforces another is not a guard**, and it will pass every test that does not
happen to construct the aliasing path.
