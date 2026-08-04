export type Result = { ok: boolean }
export function tag(r: Result): Result {
  Object.defineProperty(r, 'legacy', {
    configurable: true,
    get(): never { throw new TypeError('removed') },
  })
  return r
}
