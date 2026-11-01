/**
 * Types for `scripts/release.mjs`, for the one consumer tsc sees:
 * `test/unit/release-version.test.ts`. The module is `.mjs` because the release gate
 * and the publish workflow run it under bare `node`, with no build step.
 */

export interface Version {
  major: number
  minor: number
  patch: number
  pre: string | null
  raw: string
}

export declare function parseVersion(raw: string): Version | null
export declare function compareVersions(a: Version, b: Version): -1 | 0 | 1

export interface NextVersion {
  version: string
  latest: string | null
  /** True when package.json's version is above the latest release and is published as is. */
  declared: boolean
}

export declare function nextVersion(input: { declared: string; published: readonly string[] }): NextVersion

export interface Decision extends NextVersion {
  release: boolean
  /** Why nothing is released, when `release` is false. */
  reason?: string
  /** The packed files that differ from the latest release, for an undeclared release. */
  differ?: string[]
}

export declare function decide(input: {
  declared: string
  npm: readonly string[]
  tags: readonly string[]
  own: string | null
  superseded: string | null
  differences: (latest: string) => string[]
  /** main's CHANGELOG.md. */
  changelog: string
  /** CHANGELOG.md at a release tag (`vX.Y.Z`). */
  released: (tag: string) => string
}): Decision

export declare function sectionEntries(changelog: string, version: string): string[] | null

export declare const NON_CONSUMER_FIELDS: readonly string[]
export declare const CONSUMER_LIFECYCLE_SCRIPTS: readonly string[]
export declare function consumerFieldChanges(a: unknown, b: unknown): string[]
export declare function packageDifferences(a: string, b: string): string[]
export declare function shippedPaths(pkg: Record<string, unknown>, paths: readonly string[]): string[]

export declare const UNRELEASED: 'Unreleased'
export declare function headingVersion(heading: string): string | null
export declare function entries(lines: readonly string[]): string[]
export declare function pendingEntries(changelog: string, published: string | null): string[]
export declare function stampChangelog(
  changelog: string,
  options: { version?: string; date?: string; released?: string },
): string
export declare function applyVersion(root: string, version: string): void
export declare function supersedingRelease(root?: string): string | null
export declare function releaseCommitOf(root?: string): string | null
export declare function recordCommit(
  root: string,
  version: string,
  tip: string,
): { action: 'none' | 'fast-forward' | 'rebuilt'; commit: string }
export declare function record(root: string, version: string, remote: string): string
