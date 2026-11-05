/**
 * Inputs for `bench/jess/leg-sweep.mjs`, reproducible from a jess checkout: the corpus,
 * the small files cut at token boundaries and given comments and spacing, and a grid of
 * values and selectors in the positions a ladder is reached from. Seeded, so one checkout
 * gives one set. Writes `<outDir>/<dialect>.json` as `[kind, input][]`.
 *
 *   JESS_ROOT=<jess checkout> node bench/jess/sweep-inputs.mjs <outDir>
 */
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const JR = process.env.JESS_ROOT
if (!JR || !process.argv[2]) throw new Error('usage: JESS_ROOT=<jess checkout> node bench/jess/sweep-inputs.mjs <outDir>')
const OUT = process.argv[2]
const C = {
  css: { roots: ['packages/syntax/css/css-parser/test/css', 'packages/jess/benchmark/benchmark.css'], ext: '.css' },
  less: { roots: ['node_modules/@less/test-data', 'packages/jess/benchmark/benchmark.less', 'packages/jess/benchmark/gen-workload.less'], ext: '.less' },
  scss: { roots: ['packages/syntax/scss/scss-parser/.cache/sass-spec/inputs', 'packages/jess/benchmark/gen-workload.scss'], ext: '.scss' },
  jess: { roots: ['packages/syntax/jess/jess-parser/test', 'packages/jess/test/files', 'packages/jess/benchmark', 'packages/fns/test/files', 'packages/rollup-plugin-jess/test'], ext: '.jess' },
}
const walk = (p, ext, out) => { if (!existsSync(p)) return; const st = statSync(p); if (st.isDirectory()) { for (const e of readdirSync(p).sort()) { if (e === 'node_modules') continue; walk(join(p, e), ext, out) } } else if (p.endsWith(ext)) out.push(p) }
let seed = 42
const R = m => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % m }
const boundaries = s => { const o = []; for (let i = 1; i < s.length; i++) { if (/[\s,;:(){}\[\]+*\/=<>!-]/.test(s[i]) || /[\s,;:(){}\[\]+*\/=<>!-]/.test(s[i - 1])) o.push(i) } return o }
const VALS = {
  common: ['1', '1 2', '1,2', '1 , 2', '1, 2 3, 4', 'a b', 'a,b', 'a , b c', '1/2', '1 / 2', '1 /2', 'a / b', '1 + 2', '1 - 2', '1*2', '1 * 2 + 3', '(1 + 2) * 3', 'f(1)', 'f(1,2)', 'f(1 2, 3)', 'f(a / b)', 'f(1 + 2)', 'f()', 'calc(1 + 2)', 'calc(1 * (2 + 3))', 'var(--x)', 'var(--x, 1)', 'url(a.png)', '"s"', '"s" 1, 2', '#fff', '#fff 1', '1px', '-1px', '+1', '1 !important', '1,2 !important', 'a b !important', 'f(1) !important', '[a b]', '[a] 1', 'U+26', 'U+26 1', '1 -2', '1 - -2', 'a-b', '-a', '- a', 'a !', '!', ',', ', 1', '1,', '1 ,', '/', '1 /', '/ 1', '+', '1 +', '*', '{a}', '{a,b} 1', 'f({a,b})', '%', '5%', '1 % 2', '<', '=', 'a=b', 'alpha(opacity=50)', 'progid:x.y(a=1)', 'if(a: 1; else: 2)', 'attr(x)', 'min(1,2) max(3,4)'],
  less: ['@x', '-@x', '@x @y', '@x, @y', '@x/@y', '@x / @y', '@x + 1', '(@x + 1) * 2', '@{x}', '~"a"', '~`a`', 'e("a")', '@x[a]', '.m()', '.m()[x]', '#ns.m()', '#ns > .m()', '.m(1;2)', '.m(1,2) 3', '$p', '$p 1', '1px@v', 'calc(@w + 2vw)@suffix', '@@x', 'if((a), 1, 2)', '%(a)', '~(a=b)', 'f(~(a=b) c)', '@x !important', 'a when (b)', '@r: {a:1}', 'not(a)', 'not a', '1 and 2', '(a) and (b)', '@x<1'],
  scss: ['$x', '-$x', '$x $y', '$x, $y', '$x/$y', '$x / $y', '$x + 1', '($x + 1) * 2', '#{$x}', '#{$x}a', 'a#{$x}', '#{$x} 1', 'm.$x', 'm.f(1)', 'f($a: 1)', 'f($a...)', '(1, 2)', '(a: 1, b: 2)', '()', '$x !default', '$x !global', '1 == 2', '1 != 2', '1 < 2', 'not a', 'a and b', 'a or b', 'a + b', '"a" + b', '1 % 2', '&', '& + 1', 'if($a, 1, 2)', '$x % 2', '%foo', '[1, 2]', '[1 2]/3', '1 2/3', '1/2 3'],
  jess: ['$x', '$x $y', '$x, $y', '${x}', '$(x)', '$[x]', '$x + 1', '($x + 1) * 2', 'f($x)', 'a(1) b', '#{1}', '{a:1}', '~(1)', '@x', '$x.y', '$x[1]', '`a`'],
}
const SELS = { common: ['a', 'a b', 'a>b', 'a > b', 'a,b', 'a , b', 'a.b', 'a.b.c d', '.a', '#a', '*', 'a:hover', 'a::before', 'a:not(b)', 'a:is(b, c)', ':nth-child(2n+1)', ':nth-child(2n + 1 of a)', '[a]', '[a=b]', 'a[b="c"] d', 'a+b', 'a~b', 'a || b', '> a', '+ a', '~ a', '&', '&.a', '& a', 'a &', '&-x', '&:hover', '|a', 'n|a', '*|*', 'a,', ',a', 'a b,', 'a >', '@media', 'a/b'],
  less: ['.m', '.m()', '.m(@a)', '.a when (@b)', 'a:extend(b)', 'a:extend(b all)', '@{x}', '.@{x}', 'a@{x}', '@{x} b'],
  scss: ['%a', 'a%b', '#{$x}', '.#{$x}', 'a#{$x}', '#{$x} b', '&__x', '&#{$x}'],
  jess: ['${x}', '.${x}', '$(x)', '${x} b'] }
const gridValue = d => [...VALS.common, ...(VALS[d] ?? [])]
const wrap = { v: v => `a{b:${v};}`, v2: v => `a{b:${v}}`, top: v => `b:${v};`, sub: v => `a{b:${v};c:d}` }
const extra = d => d === 'less' ? [v => `@x:${v};`, v => `.m(${v});`, v => `.m(@a:${v}){}`, v => `@media (a:${v}){}`, v => `a when (${v}){}`, v => `a{.m(${v});}`] : d === 'scss' ? [v => `$x:${v};`, v => `@include m(${v});`, v => `@if ${v} {}`, v => `@return ${v};`, v => `@function f($a:${v}){}`, v => `@each $a in ${v} {}`, v => `a{--x:${v};}`] : d === 'jess' ? [v => `$x:${v};`, v => `$x = ${v};`, v => `@mixin m($a:${v}){}`] : [v => `@media (a:${v}){}`, v => `@supports (a:${v}){}`, v => `a{--x:${v};}`, v => `@page{b:${v}}`]
mkdirSync(OUT, { recursive: true })
for (const d of Object.keys(C)) {
  const files = []; for (const r of C[d].roots) walk(join(JR, r), C[d].ext, files)
  const out = new Map()
  const add = (n, s) => { if (!out.has(s)) out.set(s, n) }
  for (const f of files) add('corpus:' + f.slice(JR.length + 1), readFileSync(f, 'utf8'))
  const corpusN = out.size
  const small = files.filter(f => statSync(f).size < 3000)
  const step = d === 'scss' ? 3 : 1
  small.forEach((f, idx) => {
    if (idx % step) return
    const s = readFileSync(f, 'utf8'); if (s.length < 2) return
    const n = f.slice(JR.length + 1); const b = boundaries(s); if (!b.length) return
    for (let i = 0; i < 3; i++) add(`trunc:${n}`, s.slice(0, b[R(b.length)]))
    for (let i = 0; i < 3; i++) { const p = b[R(b.length)]; add(`cmt:${n}`, s.slice(0, p) + '/*c*/' + s.slice(p)) }
    add(`cmtall:${n}`, s.replace(/[ \t]+/g, ' /*c*/ '))
    add(`tight:${n}`, s.replace(/[ \t]*([,+*\/>])[ \t]*/g, '$1'))
    add(`spaced:${n}`, s.replace(/([,+*\/>:;])/g, ' $1 '))
  })
  const grid = [...gridValue(d)]
  const forms = [...Object.values(wrap), ...extra(d)]
  for (const v of grid) for (const w of forms) {
    const t = w(v); add('grid', t)
    add('gridtrunc', t.slice(0, -1))
    for (const p of boundaries(v)) { add('gridcmt', w(v.slice(0, p) + '/*c*/' + v.slice(p))); add('gridsp', w(v.slice(0, p) + ' ' + v.slice(p))) }
    add('gridlead', w('/*c*/' + v)); add('gridtrail', w(v + '/*c*/')); add('gridboth', w(' /*c*/ ' + v + ' /*d*/ '))
  }
  for (const v of [...SELS.common, ...(SELS[d] ?? [])]) {
    for (const w of [x => `${x}{a:b}`, x => `${x} {}`, x => `${x}`, x => `q{${x}{a:b}}`, x => `@media x{${x}{}}`]) {
      const t = w(v); add('sel', t)
      for (const p of boundaries(v)) { add('selcmt', w(v.slice(0, p) + '/*c*/' + v.slice(p))); add('selsp', w(v.slice(0, p) + ' ' + v.slice(p))) }
      add('sellead', w('/*c*/' + v)); add('seltrail', w(v + '/*c*/'))
    }
  }
  const arr = [...out].map(([s, n]) => [n, s])
  writeFileSync(`${OUT}/${d}.json`, JSON.stringify(arr))
  console.log(d, 'corpus files', files.length, 'distinct corpus', corpusN, 'total inputs', arr.length)
}
