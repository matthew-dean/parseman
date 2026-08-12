#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let root = process.cwd()
let baseRef = process.env.BASE_REF ?? ''
let headRef = process.env.HEAD_REF ?? ''

for (const arg of process.argv.slice(2)) {
  if (arg === '--') continue
  if (arg.startsWith('--root=')) root = resolve(arg.slice('--root='.length))
  else if (arg.startsWith('--base-ref=')) baseRef = arg.slice('--base-ref='.length)
  else if (arg.startsWith('--head-ref=')) headRef = arg.slice('--head-ref='.length)
  else throw new Error(`unknown argument: ${arg}`)
}

if (baseRef !== 'main') {
  console.log(`main release-state gate: skipped (base is ${baseRef || '<unknown>'})`)
  process.exit(0)
}

const fail = (message) => {
  console.error(`main release-state gate: FAILED\n\n${message}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const version = pkg.version
if (typeof version !== 'string') fail('package.json has no string version.')

const versionSource = readFileSync(resolve(root, 'src/version.ts'), 'utf8')
const stamp = versionSource.match(/PARSEMAN_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
if (stamp === undefined) fail('src/version.ts has no PARSEMAN_VERSION stamp.')

const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')
const heading = changelog.match(/^##\s+(.+)$/m)?.[1]?.trim()
if (heading === undefined) fail('CHANGELOG.md has no release heading.')
const headingVersion = heading.replace(/^\[/, '').split(/[\s\]]/)[0]?.replace(/^v/, '')

const releaseBranch = headRef.match(/^release\/(\d+\.\d+\.\d+)$/)?.[1]
if (releaseBranch !== undefined && releaseBranch !== version) {
  fail(
    `head branch ${headRef} names ${releaseBranch}, but package.json says ${version}.\n` +
      'A release branch may target main only when it carries that exact release.',
  )
}

if (headingVersion !== version || stamp !== version) {
  fail(
    `main must remain the latest publishable release. Found:\n` +
      `  CHANGELOG.md: ${headingVersion ?? '<missing>'}\n` +
      `  package.json: ${version}\n` +
      `  src/version.ts: ${stamp}\n` +
      'Develop the next release on release/X.Y.Z; converge all three only in its release PR.',
  )
}

if (/\bunreleased\b/i.test(heading)) {
  fail(
    `CHANGELOG.md still says "${heading}".\n` +
      'An unreleased development line cannot merge to main. Date the release heading first.',
  )
}

console.log(`main release-state gate: ok — ${version} is converged and dated (${headRef || 'push'})`)
