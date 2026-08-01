# A/B harness trap: `pnpm pack` writes the same filename for both builds

Same failure family as a stale artifact read or a `link:` pointing at the wrong
checkout: **the instrument does not error, it measures the wrong object.** A green
result comes back, faster than usual, and nothing looks wrong.

## What happened

Setting up a two-sided oracle (`A` = clean `release/0.47.0`, `B` = the same plus a
branch), both sides were packed with:

    cd <worktree-A> && pnpm pack --pack-destination /tmp/pmpacks
    cd <worktree-B> && pnpm pack --pack-destination /tmp/pmpacks

Both worktrees carry the same `version` in `package.json`, so both wrote
`/tmp/pmpacks/parseman-0.47.0.tgz`. The second silently overwrote the first. Installing
"A" and "B" from that directory would have installed **B twice**, and the oracle would
have compared a build against itself — reporting 0 mismatches over thousands of pairs,
which reads as a strong pass.

Caught only because the next step was an md5 comparison; nothing in `pnpm pack`,
`pnpm install`, or the oracle would have complained.

## The fix, both halves

Pack into per-side directories:

    mkdir -p /tmp/pmpacks/A-clean /tmp/pmpacks/B-fix
    cd <worktree-A> && pnpm pack --pack-destination /tmp/pmpacks/A-clean
    cd <worktree-B> && pnpm pack --pack-destination /tmp/pmpacks/B-fix

and then **assert the two tarballs are distinct before using them**:

    md5 /tmp/pmpacks/A-clean/*.tgz /tmp/pmpacks/B-fix/*.tgz
    # MD5 (...A-clean/parseman-0.47.0.tgz) = dbb627e318ce2fca31aa215a1264c570
    # MD5 (...B-fix/parseman-0.47.0.tgz)   = af95e14cd22290eda130bac5e9d3609d

Distinct destinations alone are not enough — they only stop the overwrite. The md5
check is what proves the two sides are actually two things, and it is the step that
would have caught this if the destinations had been fumbled some other way.

## Then verify the installed side, not just the tarball

A distinct tarball can still be installed into the wrong place. After install, resolve
the real path and assert a marker that only ONE side has:

    P=$(node -e "console.log(require('node:fs').realpathSync('node_modules/parseman'))")
    # A: 0 files containing the new symbol   B: 21 files

Two canaries, doing two different jobs:

  - a marker present in BOTH (e.g. an API that exists only in the new major, such as
    `keepSeparator` = 14 hits on each side) proves neither side is a stale published
    version resolved from the registry;
  - a marker present in ONE (the branch's own new symbol, 0 vs 21) proves the two sides
    differ by exactly the change under test.

Without the second, a vacuous pass is indistinguishable from a real one.
