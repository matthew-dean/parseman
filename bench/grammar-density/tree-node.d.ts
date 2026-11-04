/** Types for `tree-node.js`: the fixtures' constructor-built tree nodes. */
export type TreeNodeObject = {
  type: string
  span: { start: number; end: number }
  children: unknown[]
  rawCount: number
  triviaLen: number
}
export declare const TreeNode: new (type: string, start: number, end: number, children: unknown[], rawCount: number, triviaLen: number) => TreeNodeObject
export declare const SpanKeepingNode: new (type: string, span: { start: number; end: number }, children: unknown[]) => { type: string; span: { start: number; end: number }; children: unknown[] }
