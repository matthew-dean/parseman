// Same A/B, but each rule now ALLOCATES a node (realistic work) so dispatch is a
// smaller fraction of total — closer to a real grammar.
const isWs=c=>c===32||c===9||c===10||c===13
function skipWs(s,p){while(p<s.length&&isWs(s.charCodeAt(p)))p++;return p}

function makeA(){
  function value(s,p){p=skipWs(s,p);const c=s.charCodeAt(p)
    if(c===123)return object(s,p); if(c===91)return array(s,p); if(c===34)return str(s,p)
    if((c>=48&&c<=57)||c===45)return num(s,p); if(c===116||c===102)return bool(s,p); if(c===110)return nul(s,p); return null}
  function object(s,p){const st=p;p++;p=skipWs(s,p);const kids=[]
    if(s.charCodeAt(p)===125)return {t:'obj',s:st,e:p+1,kids}
    for(;;){p=skipWs(s,p);const k=str(s,p);if(!k)return null;p=k.e
      p=skipWs(s,p);if(s.charCodeAt(p)!==58)return null;p++
      const v=value(s,p);if(!v)return null;p=v.e;kids.push(k,v)
      p=skipWs(s,p);const c=s.charCodeAt(p);if(c===44){p++;continue}if(c===125)return {t:'obj',s:st,e:p+1,kids};return null}}
  function array(s,p){const st=p;p++;p=skipWs(s,p);const kids=[]
    if(s.charCodeAt(p)===93)return {t:'arr',s:st,e:p+1,kids}
    for(;;){const v=value(s,p);if(!v)return null;p=v.e;kids.push(v)
      p=skipWs(s,p);const c=s.charCodeAt(p);if(c===44){p++;continue}if(c===93)return {t:'arr',s:st,e:p+1,kids};return null}}
  function str(s,p){const st=p;if(s.charCodeAt(p)!==34)return null;p++
    for(;p<s.length;){const c=s.charCodeAt(p);if(c===92){p+=2;continue}if(c===34)return {t:'str',s:st,e:p+1,kids:null};p++}return null}
  function num(s,p){const st=p;if(s.charCodeAt(p)===45)p++;while(p<s.length){const c=s.charCodeAt(p);if((c>=48&&c<=57)||c===46||c===101||c===69||c===43||c===45)p++;else break}return {t:'num',s:st,e:p,kids:null}}
  function bool(s,p){const e=s.charCodeAt(p)===116?p+4:p+5;return {t:'bool',s:p,e,kids:null}}
  function nul(s,p){return {t:'nul',s:p,e:p+4,kids:null}}
  return value}

function makeB(){return{
  value(s,p,x){p=skipWs(s,p);const c=s.charCodeAt(p)
    if(c===123)return x.R.object(s,p,x); if(c===91)return x.R.array(s,p,x); if(c===34)return x.R.str(s,p,x)
    if((c>=48&&c<=57)||c===45)return x.R.num(s,p,x); if(c===116||c===102)return x.R.bool(s,p,x); if(c===110)return x.R.nul(s,p,x); return null},
  object(s,p,x){const st=p;p++;p=skipWs(s,p);const kids=[]
    if(s.charCodeAt(p)===125)return {t:'obj',s:st,e:p+1,kids}
    for(;;){p=skipWs(s,p);const k=x.R.str(s,p,x);if(!k)return null;p=k.e
      p=skipWs(s,p);if(s.charCodeAt(p)!==58)return null;p++
      const v=x.R.value(s,p,x);if(!v)return null;p=v.e;kids.push(k,v)
      p=skipWs(s,p);const c=s.charCodeAt(p);if(c===44){p++;continue}if(c===125)return {t:'obj',s:st,e:p+1,kids};return null}},
  array(s,p,x){const st=p;p++;p=skipWs(s,p);const kids=[]
    if(s.charCodeAt(p)===93)return {t:'arr',s:st,e:p+1,kids}
    for(;;){const v=x.R.value(s,p,x);if(!v)return null;p=v.e;kids.push(v)
      p=skipWs(s,p);const c=s.charCodeAt(p);if(c===44){p++;continue}if(c===93)return {t:'arr',s:st,e:p+1,kids};return null}},
  str(s,p,x){const st=p;if(s.charCodeAt(p)!==34)return null;p++
    for(;p<s.length;){const c=s.charCodeAt(p);if(c===92){p+=2;continue}if(c===34)return {t:'str',s:st,e:p+1,kids:null};p++}return null},
  num(s,p,x){const st=p;if(s.charCodeAt(p)===45)p++;while(p<s.length){const c=s.charCodeAt(p);if((c>=48&&c<=57)||c===46||c===101||c===69||c===43||c===45)p++;else break}return {t:'num',s:st,e:p,kids:null}},
  bool(s,p,x){const e=s.charCodeAt(p)===116?p+4:p+5;return {t:'bool',s:p,e,kids:null}},
  nul(s,p,x){return {t:'nul',s:p,e:p+4,kids:null}},
}}
function gen(d){if(d<=0)return '{"id":12345,"name":"item-name-here","active":true,"score":3.14159,"tag":null}'
  const k=[];for(let i=0;i<4;i++)k.push(gen(d-1));return '{"k":"vvvvv","n":987654,"arr":['+k.join(',')+'],"flag":false}'}
const INPUT='['+Array.from({length:6},()=>gen(4)).join(',')+']'
const A=makeA(),Rb=makeB(),x={R:Rb}
console.log('len',INPUT.length,'| A ok',A(INPUT,0).e===INPUT.length,'| B ok',Rb.value(INPUT,0,x).e===INPUT.length)
function bench(fn){for(let i=0;i<2000;i++)fn();const t=process.hrtime.bigint();for(let i=0;i<20000;i++)fn();return Number(process.hrtime.bigint()-t)/20000}
for(let r=0;r<3;r++){const a=bench(()=>A(INPUT,0)),b=bench(()=>Rb.value(INPUT,0,x))
  console.log(`round ${r}: A=${(a/1000).toFixed(1)}us B=${(b/1000).toFixed(1)}us  B/A=${(b/a).toFixed(3)}x`)}
