#!/usr/bin/env node
/**
 * Publish guard — refuses to publish a version that isn't documented.
 *
 * Reads the current version from package.json and checks that CHANGELOG.md has
 * a matching release heading (e.g. `## 0.14.0`). Runs automatically via the
 * `prepublishOnly` script, so `npm publish` (and `pnpm publish`) abort with a
 * clear message when the changelog is stale.
 *
 * Exit code 0 = version is documented, 1 = missing heading (or missing file).
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const PKG_PATH = resolve(__dir, '../package.json')
const CHANGELOG_PATH = resolve(__dir, '../CHANGELOG.md')

const { version } = JSON.parse(readFileSync(PKG_PATH, 'utf8'))

if (!existsSync(CHANGELOG_PATH)) {
  console.error(`✗ CHANGELOG.md not found — cannot publish ${version}.`)
  process.exit(1)
}

const changelog = readFileSync(CHANGELOG_PATH, 'utf8')

// Match a level-2 heading whose first token is the exact version, tolerating
// an optional `v` prefix and `[…]` brackets: `## 0.14.0`, `## [v0.14.0] - …`.
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\b`, 'm')

if (!heading.test(changelog)) {
  console.error(
    `✗ CHANGELOG.md has no entry for ${version}.\n` +
      `  Add a "## ${version}" section before publishing.`,
  )
  process.exit(1)
}

console.log(`✓ CHANGELOG.md documents ${version}.`)
