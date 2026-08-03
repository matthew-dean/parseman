# The release gate

Every pull request lands **releasable**, or it does not land. `main` is never in a
state where the code is merged and the version that carries it does not exist.

One script, `scripts/check-changelog.mjs`, enforces that. It runs in three places:

| where | what it sees | what it asserts |
| --- | --- | --- |
| CI job `release-gate`, on a pull request | the diff against the PR base | release integrity **and** an open section |
| CI job `release-gate`, on a push to `main` | no base to diff | release integrity only |
| `prepublishOnly --publish`, at `npm publish` | the working tree only | release integrity **and** convergence |

Only the first row is the gate. `BASE_SHA` is populated for `pull_request` events
only, so a push to `main` — a direct push, or an admin merge that went around the
required check — is caught for an `Unreleased` changelog but **not** for a missing
bump. The last two rows are backstops. The third used to be the whole mechanism, and
that is the reason this document exists.

## What went wrong

The check ran only as `prepublishOnly`, and it asked one question: does
`CHANGELOG.md` contain a `##` heading matching `package.json`'s version, *anywhere*?

Both halves failed.

**Publish time is too late.** A gate that fires when someone tries to ship reports on
work that merged days earlier, authored by someone who has moved on. It cannot block
the PR that caused the problem, because that PR is already in. Every PR was free to
leave `main` merged-but-unshippable and none of them were told so.

**"Anywhere" is not a check.** A `## Unreleased` section sitting on top of the real
content still leaves the previous release's heading further down the file, so the
regex matched and the gate went green — while describing the newest change under a
heading that names no version at all.

That is not hypothetical. `fix(expect)` (#68) merged, `package.json` read `0.35.0`,
`src/version.ts` read `0.35.0`, and the changelog's top section read `## Unreleased`
with the entire 0.36.0 release under it. The old gate passed on that tree. Three
consecutive releases went out through the same gap.

## What it checks now

### A. Release integrity — always, no history needed

1. `CHANGELOG.md`'s **first** `##` heading names a real version. Not `Unreleased`,
   not `TBD`, not `Next`. That version is the **release under construction**.
2. It is greater than or equal to `package.json`'s `version` — equal when nothing
   unreleased is pending, greater when a section is open. Never lower: behind means
   history is being rewritten, or a published version lost its section.
3. `src/version.ts`'s `PARSEMAN_VERSION` equals `package.json`'s. These two move
   together, and they move at **publish**.

(3) is not bookkeeping. `PARSEMAN_VERSION` is stamped into every generated-artifact
banner and read by the fuse-time version lock — see
[artifact-format.md](./artifact-format.md). A drift either mis-stamps artifacts or
makes the version assertion reject links that are in fact same-version.
`test/unit/version-sync.test.ts` also asserts it; the gate repeats it so that a
release problem produces a *release* error message rather than a unit-test failure.

**A has no exemption.** Not for a docs-only PR, not for a hotfix, not with a label.
`Unreleased` is not a state this repo ships from, so it is not a state `main` is
allowed to sit in.

### A'. Publish integrity — at `npm publish`

`--publish` additionally requires the heading, `package.json` and `src/version.ts` to
be **equal**. This is the moment the number is spent, so it is the moment they all
have to agree.

### B. An open section — on a PR, against its base

If the diff touches the **published surface**, the release under construction must be
a version that has **not been published yet** — the top changelog heading strictly
above the version in **the base's** `package.json`.

Against the *base*, not against HEAD. Two shapes satisfy that, and both are legal:

| shape | base `package.json` | heading | HEAD `package.json` |
|---|---|---|---|
| **deferred** — a mid-cycle PR | `0.44.0` | `0.45.0 — unreleased` | `0.44.0` |
| **release PR** — this PR *is* the release | `0.44.0` | `0.45.0 — <date>` | `0.45.0` |

The deferred shape is why this gate is changelog-relative: no PR is *forced* to bump,
so any number of PRs land into one open section and the number is spent once (see
"Merging is not publishing" below).

The release shape is the other half, and reading HEAD instead of the base used to
reject it. A release PR bumps `package.json` ahead of npm *in that very PR*, so HEAD's
version is not the "last published" marker — asking whether the heading is above it
asks whether the heading is above the version being published, which is `0` by
construction. A correctly prepped release — heading, `package.json` and
`src/version.ts` all agreeing, exactly the state A′ demands — failed check B, and
failed it with the sentence *"0.45.0, which is already published"* about a version
that was not published anywhere.

Both shapes are the same claim once the comparison is against the base: **the release
under construction is not yet on npm.** What stays rejected is filing into a heading
that names a version already published as of the base.

The published surface is:

- anything under `src/**` — it compiles into `dist/`, which is what `files` ships
- the files that decide what `dist/` *contains* rather than living in it:
  `scripts/build.mjs`, `tsconfig.build.json`, `tsconfig.json`. A build-script change
  can move every shipped byte with `src/` sitting still, and the root tsconfig reaches
  the emitted declarations through `tsconfig.build.json`'s `extends`. Named individually,
  not by exempting `scripts/` wholesale — the rest of that directory is CI machinery
- the `package.json` fields a consumer receives: `name`, `type`, `main`, `module`,
  `types`, `exports`, `files`, `bin`, `dependencies`, `peerDependencies`,
  `optionalDependencies`, `engines`, `license`
- the `package.json` lifecycle scripts a consumer **executes**: `preinstall`,
  `install`, `postinstall` (run when parseman is installed as a dependency) and
  `prepare` (run when it is installed from a git URL)

Everything else is exempt: `test/`, `bench/`, `examples/`, `fixtures/`, `scripts/`,
`docs/`, `notes/`, `.github/`, the lockfile, `devDependencies`, and
every other `scripts` entry. None of them can change what `npm install parseman`
produces or runs.

Note that `scripts` is compared by projection rather than wholesale, for the same
reason the file list is narrow: `test`, `lint` and the `bench:*` entries churn
constantly and reach nobody. A gate that demanded a release for renaming a bench
script is the noise this design exists to avoid.

That exemption is not a concession — it is what makes this gate *requireable*.

> A gate that fires spuriously gets bypassed, and then the gates that matter get
> bypassed with it.

A version bump demanded for fixing a typo in a comment teaches everyone to reach for
the override, and the override is not per-gate. The same reasoning is why
`perf:guard:grammars` is fast (see [perf-gates.md](./perf-gates.md)): a gate's
tolerability is a correctness property.

Note that a docs-only PR skips the Node matrix and the perf gate but **not** this
job. A is cheap and unconditional; B simply reports that nothing publishable moved.

## Merging is not publishing

B used to compare the head version against **the base branch's**: any PR touching
`src/**` had to bump `package.json`. That was wrong in two ways at once, and the
second one was worse.

**It made a version number the price of merging.** This project spends numbers at
publish. When several PRs land between two releases, a bump-per-merge burns one number
per PR and only the last ever ships — every earlier number collapses into it. That is
not hypothetical: 0.37 through 0.41 were bumped and never published, and all of that
work went out as one 0.37.0. The gate was manufacturing exactly the waste it looked
like discipline against.

**And it contradicted A.** A must hold on `main` at all times, so a PR that did not
bump was forced to file its entry under a heading naming an *already published*
version — documenting changes into a release that demonstrably does not contain them.
The only way out was the `release-exempt` label on a PR that is neither a revert nor
chained, which puts a false statement exactly where reviewers read.

So the invariant is **changelog-relative, not branch-relative**. `main` carries an open
section naming the next unpublished version; every PR files into it; the number is spent
once per release cycle, by whoever publishes, however many PRs land into that cycle.

```md
## 0.45.0 — unreleased      ← the release under construction; PRs file here
## 0.44.0 — 2026-07-30      ← published; package.json and src/version.ts say 0.44.0
```

At publish: rename the heading with a date, bump `package.json` and `src/version.ts`
to match, and `--publish` passes. Nothing else in the flow changes.

## Which bump

Pre-1.0, and the changelog's own preamble says so: minor versions may carry breaking
changes. So **anything a consumer can observe goes in the minor**, and the patch
digit is for changes that cannot be observed at all.

0.36.0 is the worked example. `fix(expect)` adds no API. It does change output —
`expected` arrays no longer repeat a token — and consumers assert on those arrays; an
assertion inside this repo had to be updated for it. Observable, therefore minor.

### C. Bench anchors — on a RELEASE PR, against its base

The two perf gates (`docs/design/perf-gates.md`) measure this build against a
`referenceSha` pinned in `bench/grammar-density/config.json` and
`bench/workloads/config.json`. Both files have said "bump this to the released sha at
every release, in the release PR" in a comment since they were written. Both were
missed for **ten consecutive releases** — v0.33.0 and v0.35.0 were still the anchors
when 0.45.0 was prepped.

Nothing complained, because a stale anchor reads `ok`. It compares against a baseline
that already absorbed every regression since, so the headroom becomes the error bar:
`rollback/dense` sat at -62%, meaning that path could have got 2.6x slower and still
passed.

So on a release PR — the shape `--publish` demands, all three version sites naming the
same not-yet-published version — every anchor must equal **the commit that released the
base's version**. That is found by walking first-parent from the base and taking the
oldest commit in the contiguous run carrying that version, not the base tip: ordinary
PRs merge after a release and carry the number forward. The rule reproduces both
hand-set anchors (0.33.0 → `7f1ddcd`, 0.35.0 → `3562f78`).

Mid-cycle PRs never see it — the bump is due at release, like the version. And it has
**no hatch**: `release-exempt` waives B only. Re-anchoring makes the gates stricter and
may expose a regression the stale anchor was hiding; that is the gate working, and the
answer is to report the number, not to move the anchor.

A checkout carrying neither config is not asked to re-anchor anything.

## The escape hatches

There are two, and they are disjoint on purpose.

### `release-exempt` — waives B only

Add the **`release-exempt` label** to the PR. It waives **B only**.

It exists for exactly two situations where "the version must go up" is wrong:

- **a revert of a release** — the version legitimately goes down
- **a chained PR** whose bump lives in the PR underneath it

The label is the hatch on purpose, rather than a commit trailer or an env var. It is
attached to the PR, visible in the timeline, and a reviewer sees it next to the
diff — which is the difference between a waiver and a bypass. Nobody should be
reaching for `--no-verify` to get past this, and if they are, that is a bug in this
document.

Whoever merges an exempt PR owns the next release carrying the bump.

### `PERF-PEAK-WAIVER` — waives the peak clause's verdict only

A `PERF-PEAK-WAIVER` line in the CHANGELOG's open section lets a **deliberate,
measured, explained** drawdown past `pnpm perf:workloads:peak` **without moving the
peak record**. Section D' of `check-changelog.mjs` validates it on every PR; the full
rules, and when it is legitimate, are in `docs/design/perf-gates.md` §D.

It waives that verdict and nothing else — not C, not D's requirement to document a
peak edit, not A or B. It is deliberately **not** an extension of `release-exempt`:
that label's scope is B, and widening one hatch to cover an unrelated gate is exactly
how a gate stops being one. It is also per-PR — it does not carry to the next PR, and
it does not raise the baseline.

## Running it yourself

```sh
node scripts/check-changelog.mjs                    # release integrity (local preflight)
node scripts/check-changelog.mjs --base=origin/main # + the open-section rule, as CI sees it
node scripts/check-changelog.mjs --publish          # + convergence (what `npm publish` runs)
```

`--root=<dir>` points it at another checkout, which is how
`test/unit/release-gate.test.ts` drives it over fixture repositories.
