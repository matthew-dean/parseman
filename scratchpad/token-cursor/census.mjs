// Static census of char-level operations in a built jess grammar artifact.
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const src = readFileSync(file, 'utf8')
const pats = {
  'charCodeAt(': /charCodeAt\(/g,
  'codePointAt(': /codePointAt\(/g,
  '.exec(': /\.exec\(/g,
  '.test(': /\.test\(/g,
  'lastIndex': /\.lastIndex/g,
  '.slice(': /\.slice\(/g,
  '.startsWith(': /\.startsWith\(/g,
  '.indexOf(': /\.indexOf\(/g,
  '.charAt(': /\.charAt\(/g,
  '.substring(': /\.substring\(/g,
  '_ctx.': /_ctx\./g,
  'input.charCodeAt(': /input\.charCodeAt\(/g,
  'regex literals /.../': /\/(?:[^/\\\n\[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuyd]*/g,
  'function decls': /\bfunction /g,
}
console.log(file, `${src.length} B`)
for (const [name, re] of Object.entries(pats)) {
  const m = src.match(re)
  console.log(`  ${name.padEnd(24)} ${m ? m.length : 0}`)
}
