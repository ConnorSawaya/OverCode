export const SIDE_PANEL_WIDTH_MIN = 320
export const SIDE_PANEL_WIDTH_MAX = 1000
export const SIDE_PANEL_WIDTH_RATIO = 0.65

export function sidePanelWidthMax(available: number | undefined) {
  if (available === undefined) return SIDE_PANEL_WIDTH_MAX
  return Math.max(SIDE_PANEL_WIDTH_MIN, Math.min(SIDE_PANEL_WIDTH_MAX, Math.round(available * SIDE_PANEL_WIDTH_RATIO)))
}

export function clampSidePanelWidth(input: { width: number; available: number | undefined }) {
  return Math.min(Math.max(input.width, SIDE_PANEL_WIDTH_MIN), sidePanelWidthMax(input.available))
}
