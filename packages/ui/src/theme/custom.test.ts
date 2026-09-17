import { describe, expect, test } from "bun:test"
import { parseDesktopTheme, validateDesktopTheme } from "./custom"

const theme = {
  id: "night-drive",
  name: "Night Drive",
  light: {
    palette: {
      neutral: "#f7f7f7",
      ink: "#171717",
      primary: "#6757d9",
      success: "#16834b",
      warning: "#a36a00",
      error: "#c43d3d",
      info: "#4e74c9",
    },
    overrides: { "text-strong": "#171717" },
  },
  dark: {
    seeds: {
      neutral: "#171717",
      primary: "#9c8fff",
      success: "#55d98b",
      warning: "#f0bd4a",
      error: "#ff756e",
      info: "#88a8ff",
      interactive: "#88a8ff",
      diffAdd: "#55d98b",
      diffDelete: "#ff756e",
    },
    v2Overrides: {
      "v2-elevation-raised": "0px 2px 4px 0px var(--v2-alpha-dark-8)",
    },
  },
} as const

describe("custom themes", () => {
  test("accepts compact palettes, seeds, and safe overrides", () => {
    const result = validateDesktopTheme(theme)
    expect(result.ok).toBe(true)
    expect(parseDesktopTheme(theme).id).toBe("night-drive")
  })

  test("rejects malformed ids and CSS injection characters", () => {
    expect(validateDesktopTheme({ ...theme, id: "Night Drive" }).ok).toBe(false)
    expect(
      validateDesktopTheme({
        ...theme,
        light: { ...theme.light, overrides: { "text-strong": "#fff; color:red" } },
      }).ok,
    ).toBe(false)
  })

  test("requires both light and dark variants", () => {
    const result = validateDesktopTheme({ ...theme, dark: undefined })
    expect(result).toEqual({ ok: false, error: "Theme needs valid light and dark color variants." })
  })
})
