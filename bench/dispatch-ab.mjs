// Dispatch A/B: sealed direct-call vs ctx.R by-name dispatch.
// Identical rule bodies; ONLY the sibling-call mechanism differs.
// A recursion/dispatch-heavy JSON parser over a large nested input.

// ---- shared scanning helpers (identical in both) ----
const isWs = c => c===32||c===9||c===10||c===13
function skipWs(s,p){ while(p<s.length && isWs(s.charCodeAt(p))) p++; return p }

// ================= FORM A: sealed closure, direct sibling calls =================
function makeA(){
  function value(s,p){
    p = skipWs(s,p)
    const c = s.charCodeAt(p)
    if(c===123) return object(s,p)      // {
    if(c===91) return array(s,p)        // [
    if(c===34) return str(s,p)          // "
    if((c>=48&&c<=57)||c===45) return num(s,p) // digit or -
    if(c===116||c===102) return bool(s,p)
    if(c===110) return nul(s,p)
    return -1
  }
  function object(s,p){
    p++; p=skipWs(s,p)
    if(s.charCodeAt(p)===125) return p+1
    for(;;){
      p=skipWs(s,p); p=str(s,p); if(p<0) return -1
      p=skipWs(s,p); if(s.charCodeAt(p)!==58) return -1; p++    // :
      p=value(s,p); if(p<0) return -1
      p=skipWs(s,p); const c=s.charCodeAt(p)
      if(c===44){p++;continue} if(c===125) return p+1; return -1
    }
  }
  function array(s,p){
    p++; p=skipWs(s,p)
    if(s.charCodeAt(p)===93) return p+1
    for(;;){
      p=value(s,p); if(p<0) return -1
      p=skipWs(s,p); const c=s.charCodeAt(p)
      if(c===44){p++;continue} if(c===93) return p+1; return -1
    }
  }
  function str(s,p){
    if(s.charCodeAt(p)!==34) return -1; p++
    for(;p<s.length;){ const c=s.charCodeAt(p); if(c===92){p+=2;continue} if(c===34) return p+1; p++ }
    return -1
  }
  function num(s,p){ if(s.charCodeAt(p)===45)p++; while(p<s.length){const c=s.charCodeAt(p); if((c>=48&&c<=57)||c===46||c===101||c===69||c===43||c===45)p++; else break} return p }
  function bool(s,p){ return s.charCodeAt(p)===116 ? p+4 : p+5 }
  function nul(s,p){ return p+4 }
  return value
}

// ============= FORM B: rule map, sibling calls via ctx.R.name(...) =============
function makeB(){
  return {
    value(s,p,ctx){
      p = skipWs(s,p)
      const c = s.charCodeAt(p)
      if(c===123) return ctx.R.object(s,p,ctx)
      if(c===91) return ctx.R.array(s,p,ctx)
      if(c===34) return ctx.R.str(s,p,ctx)
      if((c>=48&&c<=57)||c===45) return ctx.R.num(s,p,ctx)
      if(c===116||c===102) return ctx.R.bool(s,p,ctx)
      if(c===110) return ctx.R.nul(s,p,ctx)
      return -1
    },
    object(s,p,ctx){
      p++; p=skipWs(s,p)
      if(s.charCodeAt(p)===125) return p+1
      for(;;){
        p=skipWs(s,p); p=ctx.R.str(s,p,ctx); if(p<0) return -1
        p=skipWs(s,p); if(s.charCodeAt(p)!==58) return -1; p++
        p=ctx.R.value(s,p,ctx); if(p<0) return -1
        p=skipWs(s,p); const c=s.charCodeAt(p)
        if(c===44){p++;continue} if(c===125) return p+1; return -1
      }
    },
    array(s,p,ctx){
      p++; p=skipWs(s,p)
      if(s.charCodeAt(p)===93) return p+1
      for(;;){
        p=ctx.R.value(s,p,ctx); if(p<0) return -1
        p=skipWs(s,p); const c=s.charCodeAt(p)
        if(c===44){p++;continue} if(c===93) return p+1; return -1
      }
    },
    str(s,p,ctx){
      if(s.charCodeAt(p)!==34) return -1; p++
      for(;p<s.length;){ const c=s.charCodeAt(p); if(c===92){p+=2;continue} if(c===34) return p+1; p++ }
      return -1
    },
    num(s,p,ctx){ if(s.charCodeAt(p)===45)p++; while(p<s.length){const c=s.charCodeAt(p); if((c>=48&&c<=57)||c===46||c===101||c===69||c===43||c===45)p++; else break} return p },
    bool(s,p,ctx){ return s.charCodeAt(p)===116 ? p+4 : p+5 },
    nul(s,p,ctx){ return p+4 },
  }
}

// ---- big nested input ----
function gen(depth){
  if(depth<=0) return '{"id":12345,"name":"item-name-here","active":true,"score":3.14159,"tag":null}'
  const kids=[]; for(let i=0;i<4;i++) kids.push(gen(depth-1))
  return '{"k":"vvvvv","n":987654,"arr":['+kids.join(',')+'],"flag":false}'
}
const INPUT = '['+Array.from({length:6},()=>gen(4)).join(',')+']'
console.log('input length:', INPUT.length)

const A = makeA()
const Rb = makeB(); const ctxB = { R: Rb }  // built once, shape-stable, NO freeze

// correctness: both consume the whole input
console.log('A end:', A(INPUT,0), '/ B end:', Rb.value(INPUT,0,ctxB), '/ len:', INPUT.length)

function bench(label, fn, iters){
  for(let i=0;i<2000;i++) fn()            // warm
  const t=process.hrtime.bigint()
  for(let i=0;i<iters;i++) fn()
  const ns = Number(process.hrtime.bigint()-t)/iters
  console.log(label.padEnd(28), (ns/1000).toFixed(2)+' us/parse')
  return ns
}

const N = 20000
let a,b
for(let round=0; round<3; round++){
  console.log('-- round '+round+' --')
  a = bench('A sealed direct-call', ()=>A(INPUT,0), N)
  b = bench('B ctx.R by-name', ()=>Rb.value(INPUT,0,ctxB), N)
  console.log('  B/A =', (b/a).toFixed(3)+'x')
}
