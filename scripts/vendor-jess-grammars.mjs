#!/usr/bin/env node
/**
 * Refresh fixtures/jess-grammars/ — a snapshot of jess's four real grammar sources
 * (css, less, scss, jess), the modules they import, and the parser-shared modules
 * they compose over, taken from ONE jess commit. `bench/jess-grammar-size-guard.ts`
 * builds it the way jess's own build does and enforces the 5x ceiling
 * (docs/design/runtime-and-size-contract.md, rule 4).
 *
 * Vendored, not referenced: the gate must measure the same bytes on every machine
 * and in CI, and a parseman artifact carries no reference to a sibling checkout.
 * Each grammar's relative imports are followed and copied. Imports between the
 * vendored packages become relative paths; `@jesscss/core` stays bare, and a bundle
 * of the two entries reducers import goes in `core/core.js`, so the gates that run
 * these grammars run their reducers too.
 *
 *   node scripts/vendor-jess-grammars.mjs --jess ~/git/oss/jess --ref origin/dev
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { build } from 'esbuild'

const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? undefined : process.argv[i + 1]
}
const JESS = resolve(arg('jess') ?? '../jess')
const REF = arg('ref') ?? 'HEAD'
const OUT = resolve(import.meta.dirname, '../fixtures/jess-grammars')

/** Snapshot directory -> the package `src/` it is copied from. */
const PACKAGES = {
  'parser-shared': 'packages/parser-shared/src',
  css: 'packages/syntax/css/css-parser/src',
  less: 'packages/syntax/less/less-parser/src',
  scss: 'packages/syntax/scss/scss-parser/src',
  jess: 'packages/syntax/jess/jess-parser/src',
}
const ROOTS = [
  'parser-shared/recognition.ts', 'parser-shared/pseudo-consts.ts', 'parser-shared/unknown-at-rule.ts',
  'css/grammar.ts', 'less/grammar.ts', 'scss/grammar.ts', 'jess/grammar.ts',
]

/** Cross-package specifier -> snapshot module (the built `.js` the gate writes). */
const SPECIFIERS = {
  '@jesscss/parser-shared/recognition': 'parser-shared/recognition.js',
  '@jesscss/parser-shared/pseudo-consts': 'parser-shared/pseudo-consts.js',
  '@jesscss/parser-shared/unknown-at-rule': 'parser-shared/unknown-at-rule.js',
  '@jesscss/css-parser/grammar/base': 'css/grammar/base.js',
}

const commit = execFileSync('git', ['-C', JESS, 'rev-parse', `${REF}^{commit}`], { encoding: 'utf8' }).trim()
const show = path => execFileSync('git', ['-C', JESS, 'show', `${commit}:${path}`], { encoding: 'utf8', maxBuffer: 1 << 26 })

rmSync(OUT, { recursive: true, force: true })
const files = {}
const pending = [...ROOTS]
while (pending.length > 0) {
  const to = pending.pop()
  if (to in files) continue
  const [pkg, ...rest] = to.split('/')
  const from = `${PACKAGES[pkg]}/${rest.join('/')}`
  files[to] = from
  const target = join(OUT, to)
  const source = show(from).replace(/(from\s+')([^']+)(')/g, (whole, open, spec, close) => {
    if (spec.startsWith('.')) {
      pending.push(posix.join(posix.dirname(to), spec.replace(/\.js$/, '.ts')))
      return whole
    }
    const module = SPECIFIERS[spec]
    if (module === undefined) return whole
    const rel = relative(dirname(target), join(OUT, module))
    return `${open}${rel.startsWith('.') ? rel : `./${rel}`}${close}`
  })
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, source)
}

// Built from the commit's sources, in a directory of their own so the path comments in
// the bundle do not name this machine. Third-party modules come from the jess checkout.
const coreTree = mkdtempSync(join(tmpdir(), 'jess-core-'))
try {
  execFileSync('tar', ['-x', '-C', coreTree], {
    input: execFileSync('git', ['-C', JESS, 'archive', '--format=tar', commit, 'packages/core/src'], { maxBuffer: 1 << 28 }),
  })
  await build({
    absWorkingDir: coreTree,
    stdin: { contents: "export * from './packages/core/src/ast.ts'\nexport * from './packages/core/src/diagnostics.ts'\n", resolveDir: coreTree, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], charset: 'utf8',
    nodePaths: [join(JESS, 'packages/core/node_modules'), join(JESS, 'node_modules')],
    outfile: join(OUT, 'core/core.js'),
  })
} finally {
  rmSync(coreTree, { recursive: true, force: true })
}
files['core/core.js'] = 'packages/core/src/ast.ts, packages/core/src/diagnostics.ts (bundled)'

writeFileSync(join(OUT, 'SOURCE.json'), `${JSON.stringify({
  repository: 'https://github.com/jesscss/jess',
  commit,
  files: Object.fromEntries(Object.entries(files).sort()),
}, null, 2)}\n`)
console.log(`vendored ${Object.keys(files).length} files from jess ${commit} into ${relative(process.cwd(), OUT)}`)
