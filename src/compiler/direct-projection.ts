/**
 * Recognise the deliberately tiny transform shape whose result is already one
 * of a sequence's values: `([, value]) => value`.
 *
 * This is a descriptor extraction, not callback source execution.  Anything
 * with defaults, rest, nesting, a block body, or an expression is left as an
 * ordinary callback.  `fnSrc` is preferred because serialized grammars carry
 * the author's stable source; live combinators fall back to the function's own
 * source only for the same exact syntax.
 */
export function directArrayProjection(
  fn: (...args: never[]) => unknown,
  fnSrc: string | undefined,
  arity: number,
): number | null {
  let source = fnSrc
  if (source === undefined) {
    source = Function.prototype.toString.call(fn)
    if (source.includes('[native code]')) return null
  }

  const match = /^\s*\(\s*\[([^\]]*)\]\s*\)\s*=>\s*([A-Za-z_$][\w$]*)\s*$/.exec(source)
  if (match === null) return null

  const slots = match[1]!.split(',').map(slot => slot.trim())
  // Array destructuring may omit trailing elements (`([key]) => key`) while
  // the sequence still has more children.  Only an explicit slot can be the
  // result, and an over-long pattern cannot describe this sequence.
  if (slots.length > arity) return null

  const result = match[2]!
  let selected = -1
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!
    if (slot === '') continue
    if (!/^[A-Za-z_$][\w$]*$/.test(slot)) return null
    if (slot === result) {
      if (selected >= 0) return null
      selected = i
    }
  }
  return selected >= 0 ? selected : null
}
