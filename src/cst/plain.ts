/**
 * The objects a parse keeps until it ends — leaves, spans, default nodes, field
 * captures, capture buffers — built by constructor calls rather than object literals.
 *
 * V8 keeps an allocation site, and decides per site whether to allocate straight into
 * old space (pretenuring), only for literals. That decision is taken during warm-up and
 * depends on where scavenges happen to fall, so it splits otherwise identical processes
 * into a fast and a slow mode, and any change in bundle layout re-rolls it. A `new`
 * call has no allocation site, so these objects are never pretenured.
 *
 * Each constructor's `prototype` is `Object.prototype`: what it builds is a plain object,
 * indistinguishable from the literal it replaces (`Object.getPrototypeOf`, `constructor`,
 * structured clone, deep equality). Each one assigns every field in the same order, so
 * each kind has one shape.
 */
import type { Span } from '../types.ts'
import type { CstCaptureBuf } from './capture-buffer.ts'

export type PlainLeaf = { _tag: 'leaf'; value: unknown; span: Span }
export type PlainNode = { _tag: 'node'; type: string; span: Span; state: unknown; children: unknown[] }
export type PlainField = { name: string; value: unknown; span: Span }

function SpanFn(this: { start: number; end: number }, start: number, end: number): void {
  this.start = start
  this.end = end
}
function LeafFn(this: PlainLeaf, value: unknown, start: number, end: number): void {
  this._tag = 'leaf'
  this.value = value
  this.span = new PlainSpan(start, end)
}
/** A leaf around a span the caller already holds (a re-captured item). */
function LeafOfFn(this: PlainLeaf, value: unknown, span: Span): void {
  this._tag = 'leaf'
  this.value = value
  this.span = span
}
function NodeFn(this: PlainNode, type: string, span: Span, state: unknown, children: unknown[]): void {
  this._tag = 'node'
  this.type = type
  this.span = span
  this.state = state
  this.children = children
}
function FieldFn(this: PlainField, name: string, value: unknown, start: number, end: number): void {
  this.name = name
  this.value = value
  this.span = new PlainSpan(start, end)
}
/** Every field assigned, so `{}`, `{ rawOnly: true }` and `{ noRaw: true, rawLen: 0 }` share one shape. */
function BufFn(this: CstCaptureBuf, rawOnly: true | undefined, noRaw: true | undefined, rawLen: number | undefined): void {
  this.rawOnly = rawOnly
  this.noRaw = noRaw
  this.rawLen = rawLen
  this.single = undefined
  this.ch = undefined
  this.rawSingle = undefined
  this.raw = undefined
  this.tl = undefined
}
for (const f of [SpanFn, LeafFn, LeafOfFn, NodeFn, FieldFn, BufFn]) f.prototype = Object.prototype

// ponytail: a function constructor is the only spelling whose instances keep
// Object.prototype; TypeScript has no type for it, hence the one cast per kind.
export const PlainSpan = SpanFn as unknown as new (start: number, end: number) => Span
export const PlainLeaf = LeafFn as unknown as new (value: unknown, start: number, end: number) => PlainLeaf
export const PlainLeafOf = LeafOfFn as unknown as new (value: unknown, span: Span) => PlainLeaf
export const PlainNode = NodeFn as unknown as new (type: string, span: Span, state: unknown, children: unknown[]) => PlainNode
export const PlainField = FieldFn as unknown as new (name: string, value: unknown, start: number, end: number) => PlainField
export const PlainBuf = BufFn as unknown as new (rawOnly: true | undefined, noRaw: true | undefined, rawLen: number | undefined) => CstCaptureBuf
