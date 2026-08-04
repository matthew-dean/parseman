export type WidgetOptions = {
  /** read below — must NOT be reported */
  width?: number
  /** declared and never read anywhere — must be reported */
  unreadKnob?: boolean
}
export const widget = (o: WidgetOptions): number => o.width ?? 0
