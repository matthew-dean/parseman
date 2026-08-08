import { readMark } from './reader.ts'
/* The planted violation is in `./reader.ts`: it mints `Symbol('fx.mark')`
 * independently instead of importing this one, so the two are not equal and the
 * property written here is invisible there. */
export const MARK = Symbol('fx.mark')
export const stamp = (o: Record<symbol, unknown>): unknown => {
  o[MARK] = 1
  return readMark(o)
}
