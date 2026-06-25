/**
 * Precompile vendored Jison grammars to bench/*-jison.js (CommonJS).
 */
import { createRequire } from 'node:module'
import { writeFileSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const { Generator } = require('jison')
const __dirname = dirname(fileURLToPath(import.meta.url))

function fixAcceptReturn(code) {
  return code
    .replace(
      /case 3:\s*\n\s*return true;/,
      'case 3:\n            return vstack[vstack.length - 1];',
    )
    .replace(
      /while \(true\) \{[\s\S]*?\n    return true;\n\}\};/,
      (block) => block.replace(/\n    return true;\n\}\};$/, '\n    return vstack[vstack.length - 1];\n}};'),
    )
}

function compileJison(grammarPath, outBase) {
  const { grammar } = require(grammarPath)
  const code = fixAcceptReturn(
    new Generator(grammar, {
      type: 'slr',
      moduleType: 'commonjs',
      moduleName: outBase,
    }).generate(),
  )
  const outJs = join(__dirname, `${outBase}.js`)
  const outCjs = join(__dirname, `${outBase}.cjs`)
  writeFileSync(outJs, code)
  copyFileSync(outJs, outCjs)
  console.log(`wrote bench/${outBase}.js (+ .cjs)`)
}

compileJison(join(__dirname, 'vendor/jison/json-grammar.cjs'), 'json-jison')
compileJison(join(__dirname, 'vendor/jison/graphql-grammar.cjs'), 'graphql-jison')
