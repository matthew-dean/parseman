#!/usr/bin/env node
/**
 * Refresh fixtures/jess-grammars/ — a snapshot of jess's four real grammar sources
 * (css, less, scss, jess) and the modules they compose over, taken from ONE jess
 * commit. `bench/jess-grammar-size-guard.ts` builds it the way jess's own build
 * does and enforces the 5x ceiling (docs/design/runtime-and-size-contract.md, rule 4).
 *
 * Vendored, not referenced: the gate must measure the same bytes on every machine
 * and in CI, and a parseman artifact carries no reference to a sibling checkout.
 * Package imports between the vendored packages become relative paths; imports of
 * `@jesscss/core` stay bare (reducers use it at run time only, and the gate never
 * runs them).
 *
 *   node scripts/vendor-jess-grammars.mjs --jess ~/git/oss/jess --ref origin/dev
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? undefined : process.argv[i + 1]
}
const JESS = resolve(arg('jess') ?? '../jess')
const REF = arg('ref') ?? 'HEAD'
const OUT = resolve(import.meta.dirname, '../fixtures/jess-grammars')

/** jess path -> snapshot path. */
const FILES = {
  'packages/parser-shared/src/recognition.ts': 'parser-shared/recognition.ts',
  'packages/parser-shared/src/pseudo-consts.ts': 'parser-shared/pseudo-consts.ts',
  'packages/parser-shared/src/unknown-at-rule.ts': 'parser-shared/unknown-at-rule.ts',
  'packages/syntax/css/css-parser/src/grammar.ts': 'css/grammar.ts',
  'packages/syntax/less/less-parser/src/grammar.ts': 'less/grammar.ts',
  'packages/syntax/less/less-parser/src/grammar-helpers.ts': 'less/grammar-helpers.ts',
  'packages/syntax/less/less-parser/src/parse-error.ts': 'less/parse-error.ts',
  'packages/syntax/less/less-parser/src/parse-state.ts': 'less/parse-state.ts',
  'packages/syntax/scss/scss-parser/src/grammar.ts': 'scss/grammar.ts',
  'packages/syntax/scss/scss-parser/src/grammar-helpers.ts': 'scss/grammar-helpers.ts',
  'packages/syntax/scss/scss-parser/src/parse-error.ts': 'scss/parse-error.ts',
  'packages/syntax/jess/jess-parser/src/grammar.ts': 'jess/grammar.ts',
  'packages/syntax/jess/jess-parser/src/grammar-helpers.ts': 'jess/grammar-helpers.ts',
}

/** Cross-package specifier -> snapshot module (the built `.js` the gate writes). */
const PACKAGES = {
  '@jesscss/parser-shared/recognition': 'parser-shared/recognition.js',
  '@jesscss/parser-shared/pseudo-consts': 'parser-shared/pseudo-consts.js',
  '@jesscss/parser-shared/unknown-at-rule': 'parser-shared/unknown-at-rule.js',
  '@jesscss/css-parser/grammar/base': 'css/grammar/base.js',
}

const commit = execFileSync('git', ['-C', JESS, 'rev-parse', `${REF}^{commit}`], { encoding: 'utf8' }).trim()
rmSync(OUT, { recursive: true, force: true })
for (const [from, to] of Object.entries(FILES)) {
  const target = join(OUT, to)
  const source = execFileSync('git', ['-C', JESS, 'show', `${commit}:${from}`], { encoding: 'utf8', maxBuffer: 1 << 26 })
    .replace(/(from ')(@jesscss\/[^']+)(')/g, (whole, open, spec, close) => {
      const module = PACKAGES[spec]
      if (module === undefined) return whole
      const rel = relative(dirname(target), join(OUT, module))
      return `${open}${rel.startsWith('.') ? rel : `./${rel}`}${close}`
    })
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, source)
}
writeFileSync(join(OUT, 'SOURCE.json'), `${JSON.stringify({
  repository: 'https://github.com/jesscss/jess',
  commit,
  files: FILES,
}, null, 2)}\n`)
console.log(`vendored ${Object.keys(FILES).length} files from jess ${commit} into ${relative(process.cwd(), OUT)}`)
