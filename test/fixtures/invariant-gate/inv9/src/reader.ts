/* A second, private mint of the same description. Type-checks, runs, and always
 * reads `undefined`. */
const MARK = Symbol('fx.mark')
export const readMark = (o: Record<symbol, unknown>): unknown => o[MARK]
