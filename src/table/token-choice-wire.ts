import { OP_CHOICE, OP_DISPATCH, OP_XFORM } from './ops.ts'

type RuntimeChoiceWire = {
  readonly sites: readonly number[]
  readonly choiceSites?: readonly number[]
}

type RuntimeChoiceDispatch = {
  readonly exclusive: boolean
}

/**
 * Prove that one sparse token site is anchored to the exact choice relation the
 * planner described. This is the shared closure/emitter trust boundary: merely
 * naming a site is insufficient, because malformed or stale wire must retain
 * the exact legacy assembly shape rather than activating token cursor state.
 *
 * Keep this table-only: the lexical planner consumes `token-outcome.ts`, whose
 * proof helpers intentionally have no runtime imports or opcode dependency.
 */
export function runtimeChoiceAnchorsSite(
  wire: RuntimeChoiceWire,
  siteIndex: number,
  code: ArrayLike<number>,
  dispatches: readonly RuntimeChoiceDispatch[],
): boolean {
  const choices = wire.choiceSites
  const siteAt = siteIndex * 4
  if (choices === undefined || choices.length % 3 !== 0
    || !Number.isInteger(siteIndex) || siteIndex < 0 || siteAt + 3 >= wire.sites.length) return false
  const siteDispatch = wire.sites[siteAt]
  if (!Number.isInteger(siteDispatch) || siteDispatch! < 0) return false
  for (let i = 0; i < choices.length; i += 3) {
    if (choices[i + 2] !== siteIndex) continue
    const choice: number = choices[i]!, arm: number = choices[i + 1]!
    if (!Number.isInteger(choice) || choice < 0 || code[choice] !== OP_CHOICE
      || !Number.isInteger(arm) || arm < 0) continue
    let owners = 0
    for (let j = 0; j < choices.length; j += 3) {
      if (choices[j] === choice && ++owners > 1) break
    }
    if (owners !== 1) continue
    const choiceDispatch: RuntimeChoiceDispatch | undefined = dispatches[code[choice + 1]!]
    const armCount: number = code[choice + 2]!
    if (choiceDispatch === undefined || choiceDispatch.exclusive
      || !Number.isInteger(armCount) || arm >= armCount) continue
    const armIp: number = code[choice + 4 + arm]!
    if (!Number.isInteger(armIp) || armIp < 0 || code[armIp] !== OP_XFORM) continue
    const dispatchIp: number = code[armIp + 2]!
    if (Number.isInteger(dispatchIp) && dispatchIp >= 0
      && code[dispatchIp] === OP_DISPATCH && code[dispatchIp + 2] === siteDispatch) return true
  }
  return false
}
