/**
 * LEFT-CORNER ROUTES, LOWERED INTO THE EMITTED ENGINE.
 *
 * `routes.ts` says what one character at a node site decides. The closure engine
 * reads that as data and runs a chain of pieces over it; here a route is one
 * generated function, straight-line code for exactly the levels that route
 * enters, so none of the things `assemble.ts` captures per level is a test at
 * parse time: whether a repeat collects, whether a sequence keeps values, which
 * level is innermost and whether a choice can leave diagnostics are all settled
 * as this text is printed.
 *
 * The function descends through the levels' entry work, calls the atom, and then
 * completes upward. Where a continuation can start on the next character, it runs
 * from the corner: a repeat's own loop entered with one item counted, or a
 * sequence's own term blocks from the term after the corner. Neither is a copy:
 * the row's only lowering is the one the route calls.
 *
 * Design and measurements: `docs/design/left-corner-routing.md`.
 */
import {
  E_LIST, E_NULL, K_CHOICE, K_NODE, K_REP, K_SCOPE, K_SEQ, K_WITHCTX, V_CHILDREN, V_CHILDREN_COLLAPSE,
  V_CHILDREN_FIELDS, V_COLLAPSE, V_GENERIC, V_PASS, V_PLAIN, type Route, type RouteLevel,
} from './routes.ts'
import { OP_REP, OP_SCOPE_CAP, OP_SCOPE_PLAIN, OP_SEQ } from './ops.ts'
import { TRI_UNKNOWN } from './site-labels.ts'
import type { LeadMask } from './lead-mask.ts'

/** The emitter's own lowering helpers a route is printed with. */
export type RouteEmitter = {
  readonly code: Int32Array
  readonly exclusive: (choice: number) => boolean
  /** The site's function name. */
  readonly link: (ip: number) => string
  readonly hoist: (kind: string, expr: string) => string
  readonly fnRef: (i: number) => string
  readonly kRef: (i: number) => string
  /** The trivia slot a label names at `ip`: `TRI_NONE`, a slot, or `TRI_UNKNOWN`. */
  readonly triAt: (ip: number) => number
  /** A slot's installed scanner, as `OP_SCOPE` holds it; `null` where it has none. */
  readonly scannerOf: (ki: number) => string | null
  /** The test that a character cannot start the slot's trivia. */
  readonly triviaMiss: (ki: number) => ((c: string) => string) | undefined
  /** The site can be called: a selective assembly emits it. */
  readonly emitted: (ip: number) => boolean
}

const deferredScope = (code: Int32Array, ip: number): boolean => code[ip] === OP_SCOPE_PLAIN || code[ip + 3]! === 0

/** Whether a sequence level enters no term of its own after the corner. */
const seqLast = (code: Int32Array, L: RouteLevel): boolean => L.lc + 1 === code[L.ip + 1]!
const repMaxOne = (code: Int32Array, L: RouteLevel): boolean => { const m = code[L.ip + 3]!; return m >= 0 && m <= 1 }

/** The level's continuation can run: what the route calls for it must exist. */
function resumes(code: Int32Array, L: RouteLevel): boolean {
  return (L.kind === K_SEQ && !seqLast(code, L)) || (L.kind === K_REP && !repMaxOne(code, L))
}

/** Whether a route can be lowered, and the sequences and repeats it continues in. */
export function routeLowerable(route: Route, E: Pick<RouteEmitter, 'code' | 'triAt' | 'emitted'>): boolean {
  const { code } = E
  if (route.guards.length > 0 || route.atom.kind !== 'site') return false
  for (let i = 0; i < route.d; i++) {
    const L = route.levels[i]!
    if (L.kind === K_SCOPE && !deferredScope(code, L.ip)) return false
    if (L.kind === K_NODE && L.variant !== V_PASS && !nodeVariantLowered(L.variant)) return false
    if (L.kind === K_SEQ || L.kind === K_REP) {
      if (resumes(code, L)) {
        if (!E.emitted(L.ip)) return false
      }
    }
  }
  return true
}
const nodeVariantLowered = (v: number): boolean =>
  v === V_PLAIN || v === V_CHILDREN || v === V_CHILDREN_FIELDS || v === V_COLLAPSE || v === V_CHILDREN_COLLAPSE || v === V_GENERIC

/** The sites a route enters its continuation of, so their rows can be entered there. */
export function routeContinuations(route: Route, code: Int32Array, seqs: Set<number>, reps: Set<number>): void {
  for (let i = 0; i < route.d; i++) {
    const L = route.levels[i]!
    if (!resumes(code, L)) continue
    if (L.kind === K_SEQ) seqs.add(L.ip)
    else reps.add(L.ip)
  }
}

function maskRuns(m: LeadMask): string {
  const runs: number[] = []
  for (let c = 0; c < 129; c++) {
    if (m[c] !== 1) continue
    const lo = c
    while (m[c + 1] === 1 && c + 1 < 129) c++
    runs.push(lo, c)
  }
  return runs.join(',')
}

/** The function text of `route`, named `name`. */
export function lowerRoute(route: Route, name: string, E: RouteEmitter, publish: (nd: string) => string): string {
  const { code, link, hoist, fnRef, kRef } = E
  const levels = route.levels
  const d = route.d
  if (route.atom.kind !== 'site') throw new Error('lowerRoute: a dispatch atom is not lowered')
  const atomIp = route.atom.ip
  const down: string[] = []
  const up: string[] = []
  const rows: string[] = []
  let anyDirty = false
  let anyWithCtx = false

  // The deferred scope over each level.
  const scopeOver: (number | undefined)[] = []
  {
    let S: number | undefined
    for (let i = 0; i < d; i++) {
      scopeOver.push(S)
      if (levels[i]!.kind === K_SCOPE) S = levels[i]!.ip
    }
    scopeOver.push(S)
  }
  const installed = (S: number | undefined, call: string, t: string): string => {
    if (S === undefined) return call
    const ki = code[S + 1]!
    const scan = ki < 0 ? 'null' : E.scannerOf(ki) ?? 'null'
    const tri = ki < 0 ? 'undefined' : hoist('tv', `TRIVIA[${ki}]`)
    const lab = ki < 0 ? 'undefined' : hoist('tl', `TRIVIA[${ki}]._meta.triviaKindLabels`)
    return `const ${t}T=ctx.trivia,${t}L=ctx.triviaKindLabels,${t}S=_pfScan
_pfScan=${scan}
ctx.trivia=${tri}
ctx.triviaKindLabels=${lab}
${call}
ctx.trivia=${t}T
ctx.triviaKindLabels=${t}L
_pfScan=${t}S`
  }

  // Which node a continuation frames, and whether any level below can open it.
  const framed = new Set<number>()
  for (let i = 0; i < d; i++) if (resumes(code, levels[i]!) && levels[i]!.resumeTop >= 0) framed.add(levels[i]!.resumeTop)
  const seenResumer = new Set<number>()

  // The slot of the gap the ascent has read, and the next level that needs one.
  const gapOf = (i: number): number => {
    const S = scopeOver[i]
    const ki = S !== undefined ? code[S + 1]! : E.triAt(levels[i]!.ip)
    return ki === TRI_UNKNOWN ? TRI_UNKNOWN : Math.max(ki, -1)
  }
  const nextGap = (below: number): number | undefined => {
    for (let j = below - 1; j >= 0; j--) {
      const L = levels[j]!
      if ((L.kind === K_SEQ && !seqLast(code, L) && L.go !== undefined) || (L.kind === K_REP && !repMaxOne(code, L) && L.go !== undefined)) return gapOf(j)
    }
    return undefined
  }
  const readGap = (ki: number): string => {
    if (ki === TRI_UNKNOWN) return 'gl=_rgap(input,e,ctx)'
    if (ki < 0) return 'gc=input.charCodeAt(e)\ngl=gc<128?gc:gc>=128?128:129'
    const scan = E.scannerOf(ki)
    const miss = E.triviaMiss(ki)
    if (scan === null) {
      // No pure read of this trivia: where a character could start it, the continuation decides.
      return miss === undefined ? 'gl=130' : `gc=input.charCodeAt(e)\ngl=${miss('gc')}||gc!==gc?(gc<128?gc:gc>=128?128:129):130`
    }
    const read = `gc=input.charCodeAt(${scan}(input,e))`
    return `${miss === undefined ? read : `gc=input.charCodeAt(e)\nif(!(${miss('gc')}))${read}`}\ngl=gc<128?gc:gc>=128?128:129`
  }
  let gapHeld: number | undefined
  const gapHere = (i: number): void => {
    const ki = gapOf(i)
    if (gapHeld !== ki) up.push(readGap(ki))
    gapHeld = ki
  }

  const resumeCapture = (i: number): boolean => {
    const H = levels[i]!.resumeTop
    if (H < 0) return false
    let cap = H >= 0 && levels[H]!.variant === V_GENERIC && (code[levels[H]!.ip + 3]! & 4) !== 0
    for (let j = H + 1; j < i; j++) if (levels[j]!.kind === K_SCOPE && code[levels[j]!.ip] === OP_SCOPE_CAP) cap = true
    return cap
  }

  /** Open the frame `levels[i]` continues in, once, holding what the route already parsed. */
  const openFrame = (i: number): string => {
    const H = levels[i]!.resumeTop
    if (H < 0) return ''
    const v = levels[H]!.variant
    const flags = code[levels[H]!.ip + 3]!
    const open = v === V_CHILDREN || v === V_CHILDREN_FIELDS || v === V_CHILDREN_COLLAPSE
      ? 'const fk=[]\nctx._cstChildren=fk\nctx._cstLeaves=fk'
      : `ctx._cstBuf=new _BUF(undefined,${v === V_GENERIC && (flags & 2) !== 0 ? 'true' : 'undefined'},0)`
    const body = `${open}\npushCstChild(ctx,pv,rawEntry(pv,input,pos,e))\nfo=true`
    const first = !seenResumer.has(H)
    seenResumer.add(H)
    return first ? `${body}\n` : `if(!fo){\n${body}\n}\n`
  }

  const tailCall = (i: number, seedValue: string): string => {
    const L = levels[i]!
    const t = `c${i}`
    const callee = L.kind === K_SEQ
      ? `${link(L.ip)}t(input,e,ctx${code[L.ip] === OP_SEQ ? `,${seedValue}` : ''})`
      : `${link(L.ip)}(input,e,ctx,1)`
    const cap = resumeCapture(i)
    return `const ${t}C=ctx.captureTrivia
ctx.captureTrivia=${cap ? 'true' : 'false'}
${installed(scopeOver[i], `const ${t}=${callee}`, `${t}s`)}
ctx.captureTrivia=${t}C
if(${t}===FAIL){d=${i};break X}
e=EC.e`
  }

  /** After a continuation moved the end: the gap the next deciding level needs. */
  const gapAfterResume = (i: number): string => {
    const next = nextGap(i)
    if (next === undefined || next !== gapHeld) return ''
    return `\n${readGap(next)}`
  }

  // Descent and ascent, in level order.
  let fcPending = false
  for (let i = 0; i < d; i++) {
    const L = levels[i]!
    const ip = L.ip
    switch (L.kind) {
      case K_WITHCTX: {
        anyWithCtx = true
        const ki = code[ip + 1]!
        down.push(`const st${i}=ctx.state\nctx.state=${ki < 0 ? `${fnRef(~ki)}(st${i})` : kRef(ki)}`)
        break
      }
      case K_CHOICE: {
        fcPending = true
        if (L.dirty) anyDirty = true
        const n = code[ip + 2]!
        const fxOf = (a: number): number => code[ip + 4 + n + a]!
        if (E.exclusive(ip)) rows.push(`[${i},1,${L.dirty ? 1 : 0},${code[ip + 3]!}]`)
        else {
          const pre: number[] = []
          const suf: number[] = []
          for (let a = 0; a < n; a++) { if (a < L.arm) pre.push(fxOf(a)); else if (a > L.arm) suf.push(fxOf(a)) }
          rows.push(`[${i},2,${L.dirty ? 1 : 0},${code[ip + 3]!},${hoist('rp', `[${pre.join(',')}]`)},${hoist('rp', `[${suf.join(',')}]`)}]`)
        }
        break
      }
      case K_REP: {
        fcPending = true
        if (L.dirty) anyDirty = true
        const report = (code[ip + 5]! & 4) !== 0
        if (L.dirty || report) rows.push(`[${i},0,${L.dirty ? 1 : 0},${report ? code[ip + 6]! : -1}]`)
        break
      }
      case K_SEQ: {
        if (L.lc > 0 && fcPending) { down.push('ctx._fc=false'); fcPending = false }
        for (let t = 0; t < L.lc; t++) down.push(`if(${link(code[ip + 2 + t]!)}(input,pos,ctx)===FAIL){d=${i};break X}`)
        break
      }
      case K_NODE: {
        if (L.variant === V_PASS) break
        const flags = code[ip + 3]!
        const own = (flags & 16) !== 0 || L.variant === V_CHILDREN_FIELDS
        let fieldsAbove = false
        for (let j = 0; j < i; j++) {
          const A = levels[j]!
          if (A.kind === K_NODE && A.variant !== V_PASS && ((code[A.ip + 3]! & 16) !== 0 || A.variant === V_CHILDREN_FIELDS)) fieldsAbove = true
        }
        if (own || fieldsAbove) down.push(`const f${i}=ctx._fields\nctx._fields=${own ? '[]' : 'undefined'}`)
        break
      }
    }
  }
  if (fcPending) down.push('ctx._fc=false')

  const atomScope = scopeOver[d]
  const atomName = link(atomIp)
  for (let i = d - 1; i >= 0; i--) {
    const L = levels[i]!
    const ip = L.ip
    const flags = code[ip + 3]!
    switch (L.kind) {
      case K_WITHCTX:
        up.push(`ctx.state=st${i}`)
        break
      case K_REP: {
        const collect = code[ip] === OP_REP
        const lone = collect ? 'r=[r]' : 'r=undefined'
        if (repMaxOne(code, L)) { up.push(lone); break }
        const resume = `${openFrame(i)}${tailCall(i, 'r')}
${collect ? `${`c${i}`}.unshift(r)\nr=${`c${i}`}` : 'r=undefined'}`
        if (L.go === undefined) {
          up.push(`if(e<input.length){\n${resume}\n}else ${lone}`)
          gapHeld = undefined
          break
        }
        gapHere(i)
        const m = hoist('rm', `_rmask([${maskRuns(L.go)}])`)
        up.push(`if(${m}[gl]===1){\n${resume}${gapAfterResume(i)}\n}else ${lone}`)
        break
      }
      case K_SEQ: {
        const values = code[ip] === OP_SEQ
        if (seqLast(code, L)) { up.push(values ? 'r=[r]' : 'r=undefined'); break }
        const resume = `${openFrame(i)}${tailCall(i, 'r')}\n${values ? `r=c${i}` : 'r=undefined'}`
        if (L.go === undefined) {
          up.push(`{\n${resume}\n}`)
          gapHeld = undefined
          break
        }
        gapHere(i)
        const m = hoist('rm', `_rmask([${maskRuns(L.go)}])`)
        const declined = values
          ? `r=[r,${L.empties.map(x => x === E_LIST ? '[]' : x === E_NULL ? 'null' : 'undefined').join(',')}]`
          : 'r=undefined'
        up.push(`if(${m}[gl]===1){\n${resume}${gapAfterResume(i)}\n}else ${declined}`)
        break
      }
      case K_NODE: {
        const build = fnRef(code[ip + 1]!)
        if (L.variant === V_PASS) {
          up.push(`if(r===undefined)r=collapseEmpty(ctx,${build},input,pos,e,${flags === 32})\npv=r`)
          break
        }
        const v = L.variant
        const own = (flags & 16) !== 0 || v === V_CHILDREN_FIELDS
        let fieldsAbove = false
        for (let j = 0; j < i; j++) {
          const A = levels[j]!
          if (A.kind === K_NODE && A.variant !== V_PASS && ((code[A.ip + 3]! & 16) !== 0 || A.variant === V_CHILDREN_FIELDS)) fieldsAbove = true
        }
        const fm = own ? `fm${i}` : 'undefined'
        const readF = own ? `const fm${i}=buildFieldMap(ctx._fields)\nctx._fields=f${i}\n` : fieldsAbove ? `ctx._fields=f${i}\n` : ''
        const span = 'new _SP(pos,e)'
        const state = v === V_GENERIC && (flags & 8) !== 0 ? 'ctx.state' : 'undefined'
        const omitsRaw = (flags & 2) !== 0
        const captureWide = v === V_GENERIC && (flags & 4) !== 0
        const readsRaw = v === V_PLAIN || v === V_COLLAPSE || (v === V_GENERIC && !omitsRaw)
        const lonePasses = v === V_COLLAPSE || v === V_CHILDREN_COLLAPSE || (v === V_GENERIC && (flags & 32) !== 0)
        const loneBuild = `${build}(pv===undefined?EMPTY_CH:[pv],${fm},${span},${readsRaw ? '[rawEntry(pv,input,pos,e)]' : 'EMPTY_CH'},${captureWide ? 'EMPTY_TLOG' : 'EMPTY_TL'},${state})`
        const loneNode = lonePasses ? `pv=pv!==undefined?pv:${loneBuild}` : `pv=${loneBuild}`
        let text = loneNode
        if (framed.has(i)) {
          const children = v === V_CHILDREN || v === V_CHILDREN_FIELDS || v === V_CHILDREN_COLLAPSE
          const frame = children
            ? `const kids=_capturedFlatChildren(ctx._cstChildren)
ctx._cstChildren=undefined
ctx._cstLeaves=undefined
pv=${lonePasses ? `kids.length===1?kids[0]:` : ''}${build}(kids,${fm},${span},EMPTY_CH,EMPTY_TL,${state})`
            : `const b=ctx._cstBuf
ctx._cstBuf=undefined
const kids=b.ch??(b.single!==undefined?[b.single]:EMPTY_CH)
const rk=${omitsRaw ? 'EMPTY_CH' : 'b.raw??(b.rawSingle!==undefined?[b.rawSingle]:EMPTY_CH)'}
pv=${lonePasses ? `kids.length===1?kids[0]:` : ''}${build}(kids,${fm},${span},rk,${captureWide ? 'b.tl??EMPTY_TLOG' : 'EMPTY_TL'},${state})`
          text = `if(fo){\nfo=false\n${frame}\n}else ${loneNode}`
        }
        up.push(`${readF}${text}\nr=pv`)
        break
      }
    }
  }

  const failRows = rows.length === 0 ? '' : hoist('rf', `[${rows.reverse().join(',')}]`)
  const body = `X:{
${down.join('\n')}
${installed(atomScope, `r=${atomName}(input,pos,ctx)`, 'a')}
if(r===FAIL){d=${d};break X}
pv=r
e=EC.e
${up.join('\n')}
ctx._cstBuf=sB;ctx._cstChildren=sC;ctx._cstLeaves=sV;ctx._cstRawChildren=sR;ctx._cstTriviaLog=sT;ctx._fields=sF
${publish('pv')}
EC.e=e
return r
}
ctx._cstBuf=sB;ctx._cstChildren=sC;ctx._cstLeaves=sV;ctx._cstRawChildren=sR;ctx._cstTriviaLog=sT;ctx._fields=sF
${failRows === '' ? '' : `_rfail(ctx,pos,${anyDirty ? 'el' : '0'},${failRows},d)\n`}return FAIL`
  return `function ${name}(input,pos,ctx){
const sB=ctx._cstBuf,sC=ctx._cstChildren,sV=ctx._cstLeaves,sR=ctx._cstRawChildren,sT=ctx._cstTriviaLog,sF=ctx._fields
ctx._cstBuf=undefined;ctx._cstChildren=undefined;ctx._cstLeaves=undefined;ctx._cstRawChildren=undefined;ctx._cstTriviaLog=undefined;ctx._fields=undefined
${anyDirty ? 'const el=ctx._errors!==undefined?ctx._errors.length:0\n' : ''}${anyWithCtx ? 'const st=ctx.state\n' : ''}let r,pv,e,gc=0,gl=0,fo=false,d=-1
${anyWithCtx ? `try{\n${body}\n}finally{ctx.state=st}` : body}
}`
}

/** What every lowered route shares: its tables and the failure of the levels above a failure. */
export const ROUTE_RUNTIME_PRELUDE = `function _rmask(runs){
const m=new Uint8Array(131)
for(let i=0;i<runs.length;i+=2)m.fill(1,runs[i],runs[i+1]+1)
m[130]=1
return m
}
function _rtab(runs){
const t=new Array(128).fill(undefined)
for(let i=0;i<runs.length;i+=3)t.fill(runs[i+2],runs[i],runs[i+1]+1)
return t
}
let _rgT
let _rgM
function _rgap(input,e,ctx){
let c=input.charCodeAt(e)
const T=ctx.trivia
if(T!==undefined){
if(T!==_rgT){
const fs=T._meta.firstSet
_rgT=T
_rgM=null
if(fs.kind==='empty'||fs.kind==='ranges'){
_rgM=new Uint8Array(129)
if(fs.kind==='ranges')for(const r of fs.ranges){
if(r.lo>127)_rgM[128]=1
else{_rgM.fill(1,r.lo,Math.min(r.hi,127)+1);if(r.hi>127)_rgM[128]=1}
}
}
}
if(_rgM===null||(c===c&&_rgM[c<128?c:128]===1)){
const s=_pfScan
if(s===null)return 130
c=input.charCodeAt(s(input,e))
}
}
return c<128?c:c>=128?128:129
}
function _rfail(ctx,pos,el,rows,d){
for(let i=0;i<rows.length;i++){
const w=rows[i]
if(w[0]>=d)continue
if(w[1]===0){
if(w[2]===1&&ctx._errors!==undefined&&ctx._errors.length>el)ctx._errors.length=el
if(ctx._fc!==true&&w[3]>=0){ctx._fe=pos;ctx._fx=FX[w[3]]}
}else if(w[1]===1){
if(ctx._fc===true)continue
const a=ctx._fx
ctx._fe=pos
if(a===undefined||a.length===0)ctx._fx=FX[w[3]]
}else{
let acc
const pre=w[4],suf=w[5]
for(let p=0;p<pre.length;p++)acc=_accSet(FX[pre[p]],acc)
const at=ctx._fe??pos
let best=pos
if(at>best){best=at;acc=undefined}
if(at===best)acc=_accSet(ctx._fx,acc)
if(ctx._fc===true){if(acc!==undefined)ctx._fx=acc;continue}
if(w[2]===1&&ctx._errors!==undefined&&ctx._errors.length>el)ctx._errors.length=el
if(best===pos)for(let p=0;p<suf.length;p++)acc=_accSet(FX[suf[p]],acc)
ctx._fe=pos
ctx._fx=acc??FX[w[3]]
}
}
}
`
