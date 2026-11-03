import { EMITTED_PARAMS } from '../../src/table/emit-assembly.ts'

/**
 * A test wrapper that forwards to a printed assembly factory declares that factory's
 * arity, as a printed `function(EC, …)` does. The runtime refuses a factory whose
 * declared helper count is not the list it passes (`assertFactoryArity`).
 */
export function forwardingFactory<F extends (...args: never[]) => unknown>(fn: F): F {
  return Object.defineProperty(fn, 'length', { value: EMITTED_PARAMS.length })
}
