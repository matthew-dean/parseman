/** Rewrite the hand-typed ident class into explicit \u escapes, so the
 *  §7.2 dropped-low-bound bug cannot be reintroduced by retyping. */
import { readFileSync, writeFileSync } from 'node:fs'

const WANT = '[-_a-zA-Z0-9\\u0080-\\uFFFF\\\\]'
// any class that starts [-_a-zA-Z0-9 and ends with the backslash escape
const RE = /\[-_a-zA-Z0-9[^\]]*\\\\\]/g

for (const f of ['micro-tweaks.mjs', 'micro-charclass.mjs']) {
  const before = readFileSync(f, 'utf8')
  const after = before.replace(RE, WANT)
  writeFileSync(f, after)
  const codes = [...(before.match(RE) ?? [])].map(m => [...m].map(c => c.codePointAt(0)))
  console.log(f, 'replacements:', (before.match(RE) ?? []).length, 'changed:', before !== after)
  for (const c of codes) console.log('   old class code points:', c.join(' '))
}
