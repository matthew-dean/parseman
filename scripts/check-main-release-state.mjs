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
const headingDate = heading.match(/(?:\s+—\s+|\s+-\s+)(\d{4}-\d{2}-\d{2})$/)?.[1]

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

const validHeadingDate = (() => {
  if (headingDate === undefined) return false
  const [year, month, day] = headingDate.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
})()

if (!validHeadingDate) {
  fail(
    `CHANGELOG.md release heading is not dated: "${heading}".\n` +
      'A main release heading must end with a real YYYY-MM-DD calendar date.',
  )
}

console.log(`main release-state gate: ok — ${version} is converged and dated (${headRef || 'push'})`)
