# Releases and the release gate

Every merge to `main` publishes. `.github/workflows/publish.yml` runs on each push,
chooses the version, and skips the publish when nothing the package ships changed.
Pull requests file their CHANGELOG entry under `## Unreleased` and leave the version
alone, unless they want a minor or a major.

Two scripts carry it:

| script | where it runs | what it does |
| --- | --- | --- |
| `scripts/check-changelog.mjs` | CI job `release-gate` on every PR and push; `prepublishOnly` | requires the entry, keeps the three version sites in agreement |
| `scripts/release.mjs` | `publish.yml`, on every push to `main` | chooses the version, decides the skip, stamps the release |

## How a merge publishes

1. **Plan** (`node scripts/release.mjs plan`). Two kinds of commit publish nothing:
   the release commit the record step pushed to `main`, and a commit that some release
   tag already contains. The second is a re-run of a commit `main` has moved past;
   publishing it would ship older code under a newer number. Otherwise `V` is
   `package.json`'s version on `main` and `L` is the highest stable version on npm or
   among the `v*` tags.
   - If `V > L`, a pull request declared `V`: publish `V`.
   - Otherwise publish `L` with the patch plus one, unless the package is unchanged.

   Prereleases are not part of this flow: one on npm is never `L`, and a declared one
   is refused rather than published as `latest`.
2. **Skip.** The tree is stamped with `L`, built and packed exactly as `npm publish`
   would, and compared file by file with the tarball npm serves for `L`.
   `package.json` is compared on every field a consumer can see (see § B below), so a
   devDependency bump or a renamed bench script is not a change. If
   nothing differs, the run logs `Release skipped` and stops. Docs, tests, benches and
   CI changes never ship, so they never publish.

   This works because the build is reproducible: rebuilding the `v0.57.0` tag on
   another machine packs a tarball with the same sha1 as the one npm serves, and so
   does `main` after a docs-only merge against 0.58.0. The decision reads what would
   ship, not a list of paths that count.
3. **Stamp** (`node scripts/release.mjs stamp X.Y.Z`). Sets `package.json` and
   `src/version.ts`, renames `## Unreleased` to `## X.Y.Z — <date>`, and commits that
   in the runner as `release: X.Y.Z`. A section the pull request already named for
   `X.Y.Z` takes the date and any Unreleased entries.
4. **Guard and preflight.** `check-changelog.mjs --publish` and
   `check-main-release-state.mjs` pass on the stamped tree, `X.Y.Z` is not on npm,
   the tag `vX.Y.Z` does not exist, and the full preflight from `AGENTS.md` passes.
5. **Publish** with `npm publish --provenance`. With the `RELEASE_DEPLOY_KEY` secret,
   **record** the release on `main` (below). Then **tag** the stamped commit `vX.Y.Z`
   with a git push, and wait until npm serves the new version.

### Where the released version is recorded

Always on its tag. The `vX.Y.Z` tag points at the stamped release commit, whose first
parent is the merged commit. The tag's tree is exactly what was published,
`CHANGELOG.md` included. Tags are outside `main`'s branch rules, and `contents: write`
covers the push.

**On `main` too, when the `RELEASE_DEPLOY_KEY` secret is set.** `main` only takes pull
requests, and on a personal-account repository GitHub will not accept the Actions app as
a ruleset bypass actor, so `GITHUB_TOKEN` cannot write to it. A deploy key can be a
bypass actor. With the secret present, the job's record step
(`node scripts/release.mjs record`) pushes the release onto `main` over SSH before
tagging:

- if `main` has not moved since the run started, it fast-forwards `main` to the release
  commit;
- if another PR merged meanwhile, it rebuilds the stamp on the new tip, as `sync` would.
  The version files name the release, the release's CHANGELOG sections are copied in and
  their entries leave Unreleased, and whatever the later PR filed under Unreleased stays
  there;
- a push rejected because `main` moved again is rebuilt and retried, up to three times.
  It is never forced. If all three fail, the release is still published and tagged and
  the job fails with the recovery step: run `sync` in a PR.

That push runs the publish workflow again. The plan skips it when HEAD's subject is
`release: X.Y.Z` and its tree is `vX.Y.Z`'s, which is the fast-forward case. A record
rebuilt on a moved tip has a different tree; the next run publishes the later PR's change
from it, or finds nothing new against the tarball and skips.

**Without the secret, the tag is the only record.** `main`'s `package.json` keeps the
last version a pull request declared, and its `## Unreleased` keeps entries an auto-patch
already shipped. Neither causes harm:

- the version rule reads npm and the tags, so a trailing `package.json` still yields
  the next patch;
- each stamp reads the previous tag's CHANGELOG, copies in the release sections `main`
  lacks, and removes their entries from the section being released. Every tag's
  CHANGELOG lists each change once, under the release that shipped it. An entry
  reworded on `main` after it shipped no longer matches and is listed again.

To catch `main` up by hand, run `node scripts/release.mjs sync` in a pull request: it
copies the released sections from the newest tag, drops their entries from Unreleased,
and sets `package.json` and `src/version.ts` to that release. Changing only the version
stamp needs no CHANGELOG entry.

#### One-time setup for recording on `main`

Run these as the repository owner, from any directory:

```sh
ssh-keygen -t ed25519 -N '' -C 'parseman publish.yml release recorder' -f parseman-release-key
gh repo deploy-key add parseman-release-key.pub -R matthew-dean/parseman --allow-write --title 'publish.yml release recorder'
gh secret set RELEASE_DEPLOY_KEY -R matthew-dean/parseman < parseman-release-key
rm parseman-release-key parseman-release-key.pub
```

Then let deploy keys through the rules on `main`. Under **Settings → Rules → Rulesets**,
add **Deploy keys** to the bypass list with "Always allow". Do this for both rulesets
that target `main`: `default` (which requires pull requests and the `test` and Greptile
checks) and `Human attribution` (which requires its own status check). Either one alone
still rejects a direct push. Through the API:

```sh
gh api repos/matthew-dean/parseman/rulesets/<id> --jq '{bypass_actors}'   # read first
# then PUT the ruleset with {"actor_type": "DeployKey", "bypass_mode": "always"} added
```

The record step pins GitHub's published ed25519 host key rather than trusting the first
key it sees. Until the secret exists, the step is skipped and nothing else changes.

### Two merges in a row

`concurrency: publish` with `cancel-in-progress: false`. A queued run waits for the one
ahead of it. It reads npm and the tags only once it starts, and the earlier run does
not release the group until npm serves its version. The second run then sees that
release as `L`. GitHub keeps one pending run per group, so a third quick merge replaces
the queued second. Its commit contains the second's, so nothing goes unreleased.

### Dry run

```sh
gh workflow run publish.yml --ref main -f dry_run=true
```

This runs the plan, stamp, guards and preflight against the real npm state, then stops
before publishing and tagging. Locally, `node scripts/release.mjs plan` prints the same
decision. It builds `dist/` and leaves tracked files as it found them.

### If a step fails

- **Before publish.** Nothing is out. Fix the cause; the next merge, or a re-run, plans
  again.
- **Publish succeeded, tag failed.** Do not re-run: the next plan would skip, because
  npm now has the version. Until the tag exists, every run stops in the plan with
  "parseman@X.Y.Z is on npm but has no vX.Y.Z tag". Releasing on top of it would read
  the CHANGELOG of the tag before it and file X.Y.Z's entries under the next version, and
  a re-run of a commit X.Y.Z contains would not be recognised as one. Recreate the
  stamped commit from the run's commit and push the tag by hand:

  ```sh
  sha=$(gh run view <run-id> --json headSha --jq .headSha)
  git checkout --detach "$sha" && RELEASE_DATE=<date the run used> node scripts/release.mjs stamp X.Y.Z
  git push origin HEAD:refs/tags/vX.Y.Z
  ```

- **A declared version shipped first by another merge.** The release gate checks a
  declared version against the tags when the pull request runs, not when it merges. If
  another merge ships that version in between, `main` ends up with the PR's entries
  under a heading for a release that never contained them. The plan stops when
  `package.json` names a tagged version and `CHANGELOG.md`'s section for it has an entry
  that none of the tag's release sections has. A re-dated heading, Unreleased entries the
  stamp folded in, or an entry it left under an earlier auto-patch don't count. Fix it in
  a pull request: move the entries under `## Unreleased`, delete the stale heading, and
  run `sync`, which files the release that shipped under that version from its tag. Or
  rename the section to a version above the latest release and declare it. `sync` on its
  own changes nothing here: `main` already has a section for that version, so it copies
  nothing in.
- **npm slow to serve the version.** The wait step times out after 10 minutes. The tag
  already exists, so the next run reads `L` from it. That run's skip comparison fails
  loudly until npm serves the tarball; re-run it then.

`check:differentials --strict` needs the jess sibling checkout, so it stays a by-hand
check before a release you want to vouch for (see
[differential-gates.md](./differential-gates.md)).

### One-time setup

npm accepts an OIDC publish only from a workflow the package owner has registered as a
trusted publisher. Register it once, either way:

- on npmjs.com: package `parseman` → **Settings** → **Trusted Publisher** → GitHub
  Actions, with user `matthew-dean`, repository `parseman`, workflow filename
  `publish.yml`, and no environment;
- or from a terminal, logged in as the package owner, with npm ≥ 11.15.0 (the first
  release with `--allow-publish`):

  ```sh
  npm trust github parseman --file publish.yml --repo matthew-dean/parseman --allow-publish
  ```

Until it is registered, the publish step fails with a 404 ("could not be found or you do
not have permission"). The registration names the workflow file, not the event, so
moving from dispatch to push needs no change.

## What the gate checks

`scripts/check-changelog.mjs`:

| where | what it sees | what it asserts |
| --- | --- | --- |
| CI job `release-gate`, on a pull request | the diff against the PR base | A, B, D, D′ |
| CI job `release-gate`, on a push to `main` | no base to diff | A only |
| `prepublishOnly --publish` | the stamped tree | A and A′ |

`scripts/check-main-release-state.mjs` runs beside it in the same job and on the
stamped tree: the newest release heading is dated, and `package.json`,
`src/version.ts` and that heading agree. A `release/X.Y.Z` head branch must carry
`X.Y.Z`.

### A. Release integrity — always

1. `CHANGELOG.md`'s first `##` heading is `## Unreleased` or a release heading. The
   newest release heading is the top one, or the one right under Unreleased, and it
   names a version.
2. That version equals `package.json`'s.
3. `src/version.ts`'s `PARSEMAN_VERSION` equals `package.json`'s.

(3) is not bookkeeping. `PARSEMAN_VERSION` is stamped into every generated-artifact
banner and read by the fuse-time version lock. See
[artifact-format.md](./artifact-format.md). A drift either mis-stamps artifacts or
makes the version assertion reject links that are in fact same-version.
`test/unit/version-sync.test.ts` also asserts it.

A has no exemption.

### A′. Publish integrity — at `npm publish`

No `## Unreleased` on top: the top heading names `package.json`'s version. A bare
`npm publish` from `main` therefore fails. Only a stamped tree publishes.

### B. The entry — on a PR, against its base

If the diff changes what the package ships, the PR adds a CHANGELOG entry: one that is
under `## Unreleased`, or under the version the PR declares, and was not there at the
base. An entry already on the base does not count, because `main`'s Unreleased can
still hold entries a release shipped.

What ships is decided by npm. `npm pack --dry-run` runs over a scratch directory with
the PR's `package.json` and a placeholder at every changed path, and every path it
would pack counts: `src/**` and `README.md` today, because of `files`. A deleted path
counts too. Added to that:

- the files that decide what `dist/` contains without being packed:
  `scripts/build.mjs`, `tsconfig.build.json`, and `tsconfig.json` (which reaches the
  emitted declarations through `tsconfig.build.json`'s `extends`);
- every `package.json` field except the few that reach nobody who installs parseman:
  `version`, `devDependencies`, `packageManager` and `scripts`. A field that list does
  not name (`sideEffects`, `os`, `imports`, a new one) counts, so nothing is ignored
  by omission;
- the lifecycle scripts a consumer executes: `preinstall`, `install`, `postinstall`,
  and `prepare` (run when installed from a git URL).

`src/version.ts` changing only its version literal does not count; the version is the
publish's decision. Everything else is exempt: `test/`, `bench/`, `examples/`,
`fixtures/`, the rest of `scripts/`, `docs/`, `notes/`, `.github/`, the lockfile,
`devDependencies`, `packageManager`, and every other `scripts` entry.

That exemption is what makes this gate requireable:

> A gate that fires spuriously gets bypassed, and then the gates that matter get
> bypassed with it.

The publish does not rely on this list. Its skip decision compares the built tarball,
so a lockfile bump that changes `dist/` still publishes. This is the cheap,
install-free approximation for pull requests.

B also refuses a `package.json` version that goes down against the base (the
`release-exempt` label waives this, for a revert). A version the PR raises is published
the moment it merges, as `latest`, and npm never takes a number back, so B also requires
it to be:

- stable, because the publish refuses a prerelease and would stop every release after it;
- the next patch, minor or major of the latest release, or that release itself (a
  `sync` PR), whose `## X.Y.Z` section must then hold every entry that release's own
  section shipped and nothing it did not (release integrity refuses an entry it did not
  ship, wherever `package.json` names a tagged version). A re-dated heading is fine. A
  section that lost an entry is not: the next stamp keeps `main`'s section for a version
  `main` has, so it would replace that release's own. The
  latest release is the newest stable `v*` tag, or the base's version when that is
  higher.

A version between the base and the latest tag is refused because the publish would
ignore it. It would ship the next patch, and leave the PR's entries under a heading that
names an older release. No label waives these checks.

### D. Peak record and D′. Peak-clause waiver — on every PR

Any edit to a perf gate's `peak` block is named in an entry the PR adds, with backward
moves and widened allowances called out by name. A `PERF-PEAK-WAIVER` line lands a
deliberate, measured drawdown without moving the peak. Both are specified in
[perf-gates.md](./perf-gates.md) § "The peak clause".

## Which bump

Pre-1.0, and the changelog's own preamble says so: minor versions may carry breaking
changes. So **anything a consumer can observe goes in the minor**, and a PR that makes
one declares it: set the heading to `## 0.N.0 — <date>` and `package.json` and
`src/version.ts` to `0.N.0`. The patch is for changes that cannot be observed at all.
It is what a merge gets by default.

0.36.0 is the worked example. `fix(expect)` adds no API. It does change output:
`expected` arrays no longer repeat a token, and consumers assert on those arrays. An
assertion inside this repo had to be updated for it. Observable, therefore minor.

## The escape hatches

### `release-exempt` — waives B only

The PR label. It exists for a **revert**, where the version may go down and the entry
may be a removal, and for a **chained PR** whose entry lives in the PR underneath it.
It is on the PR, visible next to the diff, which is the difference between a waiver
and a bypass. It never waives A, D or D′.

### `PERF-PEAK-WAIVER` — waives the peak clause's verdict only

See [perf-gates.md](./perf-gates.md) § D. It is deliberately not an extension of
`release-exempt`.

## History

**Publish time is too late for a gate.** The changelog check once ran only as
`prepublishOnly`, and it asked whether `package.json`'s version appeared anywhere in
`CHANGELOG.md`. `fix(expect)` (#68) merged with `## Unreleased` on top and the old
heading further down, the check passed, and three releases went out that way. That
is why the check runs on every PR.

**Releases were a separate step.** Until publish-on-merge, `main` carried an open
section naming the next version, PRs filed into it, a release PR converged the
version, and a person dispatched `publish.yml`. Requiring a bump per merge had burned
numbers that never shipped (0.37 through 0.41 went out as one 0.37.0), because merging
did not publish. Now merging does publish, so each merge that changes the package gets
its own number, and nobody has to pick it.

**Perf anchors were hand-kept.** The grammar and workload gates' `referenceSha` was
bumped by hand in each release PR and missed ten releases running, so §C of the gate
checked it. The gates now resolve the previous release from the tags at run time. See
[perf-gates.md](./perf-gates.md) § "Running them".

## Running it yourself

```sh
node scripts/check-changelog.mjs                    # release integrity (local preflight)
node scripts/check-changelog.mjs --base=origin/main # + the entry rule, as CI sees it
node scripts/check-changelog.mjs --publish          # + no Unreleased (what `npm publish` runs)
node scripts/release.mjs plan                       # what a merge of this tree would publish
```

`--root=<dir>` points `check-changelog.mjs` at another checkout, which is how
`test/unit/release-gate.test.ts` drives it over fixture repositories. The pure parts
of `release.mjs` are covered by `test/unit/release-version.test.ts`.
