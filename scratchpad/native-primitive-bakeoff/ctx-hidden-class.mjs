/**
 * HIDDEN-CLASS STATE OF `_ctx` — measured, not inferred.
 *
 * Requires --allow-natives-syntax.
 *
 * The census on a real fused css artifact:
 *   1,580 `_ctx.<field>` reads
 *     306 `_ctx.<field> =` WRITES, to _fx _fe _cstChildren _cstRawChildren
 *         _cstLeaves _cstTriviaLog captureTrivia
 * None of those written fields exist on the object the caller constructs, so
 * each first write is a map TRANSITION. This measures whether that is true and
 * how many distinct maps result.
 *
 * Run:  node --allow-natives-syntax ctx-hidden-class.mjs
 */

// The context literals that actually occur, taken from the shipped call sites.
const mkWorkloadCapture = () => ({ trackLines: false, _triviaLog: [] })
const mkWorkloadPlain = () => ({ trackLines: false })
const mkDefaultNoLabels = () => ({ trackLines: false })
const mkDefaultWithLabels = () => ({ trackLines: false, triviaKindLabels: ['ws'] })
const mkWithErrors = () => ({ trackLines: false, _errors: [] })
const mkTracked = () => ({ trackLines: true, _lineStarts: [0], _lineScannedTo: 0 })

const shapes = [
  ['workload capture  {trackLines,_triviaLog}', mkWorkloadCapture],
  ['workload plain    {trackLines}', mkWorkloadPlain],
  ['defaultCtx no labels', mkDefaultNoLabels],
  ['defaultCtx w/ labels (cond. spread)', mkDefaultWithLabels],
  ['parseWithErrors   {...default,_errors}', mkWithErrors],
  ['trackedCtx        {...,_lineStarts,..}', mkTracked],
]

console.log('=== 1. DISTINCT MAPS AMONG CONSTRUCTION SITES (before any parse) ===')
const reps = shapes.map(([n, f]) => [n, f()])
const groups = []
for (const [name, o] of reps) {
  const g = groups.find(gr => %HaveSameMap(gr.rep, o))
  if (g) g.names.push(name)
  else groups.push({ rep: o, names: [name] })
}
console.log(`  ${reps.length} construction sites -> ${groups.length} DISTINCT maps`)
groups.forEach((g, i) => console.log(`   map ${i}: ${g.names.join('\n           ')}`))

console.log('\n=== 2. DOES A PARSE TRANSITION THE MAP? ===')
// Simulate exactly what the emitted artifact does to the ctx it is handed:
// it ASSIGNS fields that were never constructed on it.
const ctx = mkWorkloadCapture()
const pristine = mkWorkloadCapture()
console.log('  same map as a fresh literal, before:', %HaveSameMap(ctx, pristine))

// The writes the css artifact performs, in the order it performs them.
ctx._cstChildren = []
console.log('  after _ctx._cstChildren = [] :', %HaveSameMap(ctx, pristine))
ctx._cstRawChildren = []
ctx._cstLeaves = []
ctx._cstTriviaLog = []
ctx.captureTrivia = false
ctx._fx = 0
ctx._fe = 0
console.log('  after all 7 written fields  :', %HaveSameMap(ctx, pristine))

console.log('\n=== 3. IS THE TRANSITION CHAIN SHARED ACROSS PARSES? ===')
// A fresh ctx per parse walking the SAME write order shares the transition
// chain, so the final maps are identical and the ICs stay warm.
const mkFullyWritten = () => {
  const c = mkWorkloadCapture()
  c._cstChildren = []; c._cstRawChildren = []; c._cstLeaves = []
  c._cstTriviaLog = []; c.captureTrivia = false; c._fx = 0; c._fe = 0
  return c
}
const a = mkFullyWritten(), b = mkFullyWritten()
console.log('  two fresh ctxs, same write order, same map:', %HaveSameMap(a, b))

// …but a DIFFERENT write order produces a DIFFERENT map from the same fields.
const c2 = mkWorkloadCapture()
c2._fx = 0; c2._fe = 0; c2._cstChildren = []; c2._cstRawChildren = []
c2._cstLeaves = []; c2._cstTriviaLog = []; c2.captureTrivia = false
console.log('  same 7 fields, DIFFERENT write order, same map:', %HaveSameMap(a, c2))

console.log('\n=== 4. PRE-DECLARING THE FIELDS AT CONSTRUCTION ===')
// The proposed fix: construct with every field present, in one literal.
const mkPre = () => ({
  trackLines: false, _triviaLog: [], _cstChildren: undefined,
  _cstRawChildren: undefined, _cstLeaves: undefined, _cstTriviaLog: undefined,
  captureTrivia: undefined, _fx: 0, _fe: 0,
})
const p1 = mkPre(), p2 = mkPre()
console.log('  two pre-declared ctxs share a map:', %HaveSameMap(p1, p2))
p1._cstChildren = []; p1._fx = 5; p1.captureTrivia = true
console.log('  still same map after writing them:', %HaveSameMap(p1, p2))
console.log('  pre-declared vs write-built share a map:', %HaveSameMap(p1, a))
console.log('  dictionary mode? pre:', %HasDictionaryElements(p1), ' built:', %HasDictionaryElements(a))
