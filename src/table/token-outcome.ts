import type { LexicalOutcomeMatch } from '../compiler/token-alphabet.ts'
import { OP_CHOICE, OP_DISPATCH, OP_XFORM } from './ops.ts'

export type RuntimeRangeOutcomeKind =
  | 'direct'
  | 'ascii-prefix'
  | 'function-open-excluding-url-calc'

type RuntimeFixedChoiceWire = {
  readonly recognizerOffsets: readonly number[]
  readonly recognizerData: readonly number[]
  readonly outcomeOffsets: readonly number[]
  readonly outcomeData: readonly number[]
  readonly routes: readonly number[]
  readonly accepted: readonly number[]
}

type RuntimeFixedChoicePlan = {
  readonly recognizer: number
  readonly family: number
  readonly routeStart: number
  readonly routeCount: number
}

/** Assembly-time projection of the one bounded choice decision we inline. */
export type RuntimeFixedChoiceDecision = {
  readonly base: RegExp
  readonly exact: string
  readonly exactFold: boolean
  readonly exactOutcome: number
  readonly exactArm: number
  readonly exactFlags: number
  readonly genericOutcome: number
  readonly genericArm: number
  readonly genericFlags: number
}

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

/**
 * The one proof boundary shared by the compiler and table runtime for outcome
 * predicates that can be decided from an already-recognized source range.
 *
 * Keep this module parser-free and allocation-free at parse time. The compiler
 * calls it before publishing a dispatch site; closure/emitted assemblers call
 * it only while rebuilding a program's matcher pool. Returning a matcher kind,
 * rather than merely a boolean, prevents those readers from duplicating the
 * two bounded-regex spelling proofs.
 */
export function runtimeRangeOutcomeKind(
  kind: LexicalOutcomeMatch['kind'],
  value = '',
  flags = '',
  caseInsensitive = false,
): RuntimeRangeOutcomeKind | undefined {
  if (kind !== 'matches') return 'direct'
  let folded = caseInsensitive
  for (let i = 0; i < flags.length; i++) {
    const flag = flags.charCodeAt(i)
    if (flag === 105) folded = true // i
    else if (flag !== 103) return undefined // g is stripped by the wire serializer
  }
  if (value === '^(?!(?:url|calc)\\($).+\\($' && folded) {
    return 'function-open-excluding-url-calc'
  }
  if (value.length < 2 || value.charCodeAt(0) !== 94) return undefined // ^
  for (let i = 1; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122
      || code >= 48 && code <= 57 || code === 95 || code === 45)) return undefined
  }
  return 'ascii-prefix'
}

/**
 * Prove and project the bounded atomic-opener decision shared by closure and
 * emitted assembly. Anything outside this exact shape stays on the generic
 * recognizer/classifier path.
 */
export function runtimeFixedChoiceDecision(
  wire: RuntimeFixedChoiceWire,
  constants: readonly unknown[],
  plan: RuntimeFixedChoicePlan,
): RuntimeFixedChoiceDecision | undefined {
  const at = wire.recognizerOffsets[plan.recognizer]
  if (at === undefined || at < 0 || wire.recognizerData[at] !== 3 || wire.recognizerData[at + 2] !== 2) return undefined
  const lexEnd = at + wire.recognizerData[at + 1]!
  const baseAt = at + 3
  if (wire.recognizerData[baseAt] !== 2 || wire.recognizerData[baseAt + 1] !== 3) return undefined
  const base = constants[wire.recognizerData[baseAt + 2]!]
  const repeatAt = baseAt + 3
  if (!(base instanceof RegExp) || wire.recognizerData[repeatAt] !== 5
    || wire.recognizerData[repeatAt + 2] !== 0 || wire.recognizerData[repeatAt + 3] !== 1
    || wire.recognizerData[repeatAt + 4] !== 1 || wire.recognizerData[repeatAt + 5] !== 0) return undefined
  const suffixAt = repeatAt + 6
  if (wire.recognizerData[suffixAt] !== 0 || wire.recognizerData[suffixAt + 1] !== 4
    || wire.recognizerData[suffixAt + 3] !== 0 || suffixAt + 4 !== lexEnd
    || constants[wire.recognizerData[suffixAt + 2]!] !== '(' || plan.routeCount !== 2) return undefined

  const route = (index: number): { arm: number; flags: number; outcome: number } | undefined => {
    const ri = plan.routeStart + index * 4
    const arm = wire.routes[ri], flags = wire.routes[ri + 1]
    const acceptedAt = wire.routes[ri + 2], acceptedCount = wire.routes[ri + 3]
    const outcome = acceptedAt === undefined ? undefined : wire.accepted[acceptedAt]
    if (!Number.isInteger(arm) || arm! < 0 || !Number.isInteger(flags)
      || !Number.isInteger(acceptedAt) || acceptedAt! < 0 || acceptedCount !== 1
      || !Number.isInteger(outcome) || outcome! < 0) return undefined
    return { arm: arm!, flags: flags!, outcome: outcome! }
  }
  const exactRoute = route(0), genericRoute = route(1)
  if (exactRoute === undefined || genericRoute === undefined
    || (exactRoute.flags & 3) !== 0 || (genericRoute.flags & 3) !== 1) return undefined
  const outcomeAt = (id: number): number => {
    for (const offset of wire.outcomeOffsets) if (wire.outcomeData[offset] === id) return offset
    return -1
  }
  const exactAt = outcomeAt(exactRoute.outcome), matcherAt = outcomeAt(genericRoute.outcome)
  if (exactAt < 0 || matcherAt < 0 || exactRoute.outcome === genericRoute.outcome
    || wire.outcomeData[exactAt + 1] !== plan.family || wire.outcomeData[matcherAt + 1] !== plan.family
    || wire.outcomeData[exactAt + 2] !== 0 || wire.outcomeData[matcherAt + 2] !== 3) return undefined
  const exact = constants[wire.outcomeData[exactAt + 3]!]
  const matcher = constants[wire.outcomeData[matcherAt + 3]!]
  const exactFold = wire.outcomeData[exactAt + 4]
  if (typeof exact !== 'string' || !(matcher instanceof RegExp) || exactFold !== 0 && exactFold !== 1
    || runtimeRangeOutcomeKind('matches', matcher.source, matcher.flags) !== 'function-open-excluding-url-calc') return undefined
  return {
    base,
    exact,
    exactFold: exactFold === 1,
    exactOutcome: exactRoute.outcome,
    exactArm: exactRoute.arm,
    exactFlags: exactRoute.flags,
    genericOutcome: genericRoute.outcome,
    genericArm: genericRoute.arm,
    genericFlags: genericRoute.flags,
  }
}
