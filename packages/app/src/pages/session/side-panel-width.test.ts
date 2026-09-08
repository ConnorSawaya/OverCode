import { expect, test } from "bun:test"
import { clampSidePanelWidth, sidePanelWidthMax } from "./side-panel-width"

test("side panel stays balanced on wide and narrow chat layouts", () => {
  expect(sidePanelWidthMax(1600)).toBe(1000)
  expect(sidePanelWidthMax(900)).toBe(585)
  expect(clampSidePanelWidth({ width: 1200, available: 1600 })).toBe(1000)
  expect(clampSidePanelWidth({ width: 240, available: 1600 })).toBe(320)
  expect(clampSidePanelWidth({ width: 400, available: 700 })).toBe(400)
})
