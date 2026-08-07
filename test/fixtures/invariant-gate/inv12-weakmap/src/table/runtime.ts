const cache = new WeakMap<object, unknown>()
export const remember = (map: object): void => { cache.set(map, true) }
