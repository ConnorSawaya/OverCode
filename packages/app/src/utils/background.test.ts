import { expect, test } from "bun:test"
import { BACKGROUND_PRESETS, backgroundImageFor } from "./background"

test("background presets resolve to their stored visual", () => {
  expect(backgroundImageFor("aurora", "")).toBe(BACKGROUND_PRESETS.aurora)
  expect(backgroundImageFor("none", "")).toBe("none")
})

test("custom backgrounds resolve to an image layer", () => {
  expect(backgroundImageFor("custom", "data:image/png;base64,abc")).toBe('url("data:image/png;base64,abc")')
  expect(backgroundImageFor("custom", "")).toBe("none")
})
