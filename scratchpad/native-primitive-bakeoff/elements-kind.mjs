/**
 * Reports the ACTUAL V8 elements kind for each candidate shape, rather than
 * assuming the fast one. Requires --allow-natives-syntax.
 *   node --allow-natives-syntax elements-kind.mjs
 */
const N = 27
const fns = Array.from({ length: N }, (_, i) => x => x + i)

const objStr = {}
for (let i = 0; i < N; i++) objStr[`Rule${i}`] = fns[i]

const objInt = {}
for (let i = 0; i < N; i++) objInt[i] = fns[i]

const arr = fns.slice()
const arrFrozen = Object.freeze(fns.slice())

const objSparse = {}
for (let i = 0; i < N; i++) objSparse[i * 37 + 1000] = fns[i]

const objHoley = {}
for (let i = 0; i < N; i++) if (i % 3 !== 0) objHoley[i] = fns[i]

const label = (name, o) => {
  console.log(`\n=== ${name} ===`)
  console.log('  HasFastPackedElements:', %HasFastPackedElements(o))
  console.log('  HasDictionaryElements:', %HasDictionaryElements(o))
  console.log('  HasHoleyElements     :', %HasHoleyElements(o))
  console.log('  HasObjectElements    :', %HasObjectElements(o))
}

label('object, string keys (today\'s _map)', objStr)
label('object, dense int keys 0..26', objInt)
label('plain Array', arr)
label('Object.freeze(Array)', arrFrozen)
label('object, SPARSE int keys (i*37+1000)', objSparse)
label('object, HOLEY int keys (every 3rd missing)', objHoley)
