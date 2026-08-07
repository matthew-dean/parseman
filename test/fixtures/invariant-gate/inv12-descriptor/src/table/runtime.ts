export function artifact(): object {
  const map = {}
  Object.defineProperty(map, Symbol.for('parseman.test'), { value: true })
  return map
}
