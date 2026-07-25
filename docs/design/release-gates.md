# The release gate

Every pull request lands **releasable**, or it does not land. `main` is never in a
state where the code is merged and the version that carries it does not exist.

One script, `scripts/check-changelog.mjs`, enforces that. It runs in two places:

| where | what it sees | what it asserts |
| --- | --- | --- |
| CI job `release-gate`, every PR and every push to `main` | the diff against the PR base | release integrity **and** the bump |
| `prepublishOnly`, at `npm publish` | the working tree only | release integrity |

The second is a backstop, not the gate. It used to be the gate, and that is the
whole reason this document exists.

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
   not `TBD`, not `Next`.
2. That version equals `package.json`'s `version`.
3. `src/version.ts`'s `PARSEMAN_VERSION` equals it too.

(3) is not bookkeeping. `PARSEMAN_VERSION` is stamped into every generated-artifact
banner and read by the fuse-time version lock — see
[artifact-format.md](./artifact-format.md). A drift either mis-stamps artifacts or
makes the version assertion reject links that are in fact same-version.
`test/unit/version-sync.test.ts` also asserts it; the gate repeats it so that a
release problem produces a *release* error message rather than a unit-test failure.

**A has no exemption.** Not for a docs-only PR, not for a hotfix, not with a label.
`Unreleased` is not a state this repo ships from, so it is not a state `main` is
allowed to sit in.

### B. The bump — on a PR, against its base

If the diff touches the **published surface**, `package.json`'s version must be
strictly greater than the base's.

The published surface is:

- anything under `src/**` — it compiles into `dist/`, which is what `files` ships
- the `package.json` fields a consumer receives: `name`, `type`, `main`, `module`,
  `types`, `exports`, `files`, `bin`, `dependencies`, `peerDependencies`,
  `optionalDependencies`, `engines`, `license`

Everything else is exempt: `test/`, `bench/`, `examples/`, `fixtures/`, `scripts/`,
`docs/`, `notes/`, `.github/`, the lockfile, the tsconfigs, and `devDependencies`.
None of them can change what `npm install parseman` produces.

That exemption is not a concession — it is what makes this gate *requireable*.

> A gate that fires spuriously gets bypassed, and then the gates that matter get
> bypassed with it.

A version bump demanded for fixing a typo in a comment teaches everyone to reach for
the override, and the override is not per-gate. The same reasoning is why
`perf:guard:grammars` is fast (see [perf-gates.md](./perf-gates.md)): a gate's
tolerability is a correctness property.

Note that a docs-only PR skips the Node matrix and the perf gate but **not** this
job. A is cheap and unconditional; B simply reports that nothing publishable moved.

## Which bump

Pre-1.0, and the changelog's own preamble says so: minor versions may carry breaking
changes. So **anything a consumer can observe goes in the minor**, and the patch
digit is for changes that cannot be observed at all.

0.36.0 is the worked example. `fix(expect)` adds no API. It does change output —
`expected` arrays no longer repeat a token — and consumers assert on those arrays; an
assertion inside this repo had to be updated for it. Observable, therefore minor.

## The escape hatch

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

## Running it yourself

```sh
node scripts/check-changelog.mjs                    # release integrity (what publish runs)
node scripts/check-changelog.mjs --base=origin/main # + the bump rule, as CI sees it
```

`--root=<dir>` points it at another checkout, which is how
`test/unit/release-gate.test.ts` drives it over fixture repositories.
