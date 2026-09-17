import type { DesktopTheme, ThemePaletteColors, ThemeSeedColors, ThemeVariant } from "./types"

const THEME_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const VARIABLE = /^var\(--[a-zA-Z0-9_-]+\)$/
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const SAFE_CSS_VALUE = /^(?:[a-zA-Z0-9_.%#(),+\s-]|var\(--[a-zA-Z0-9_-]+\))+$/

export type ThemeValidation = { ok: true; theme: DesktopTheme } | { ok: false; error: string }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hex(value: unknown): value is `#${string}` {
  return typeof value === "string" && COLOR.test(value)
}

function cssValue(value: unknown) {
  return typeof value === "string" && (COLOR.test(value) || VARIABLE.test(value))
}

function palette(value: unknown): value is ThemePaletteColors {
  if (!record(value)) return false
  const required = ["neutral", "ink", "primary", "success", "warning", "error", "info"]
  if (!required.every((key) => hex(value[key]))) return false
  return ["accent", "interactive", "diffAdd", "diffDelete"].every((key) => value[key] === undefined || hex(value[key]))
}

function seeds(value: unknown): value is ThemeSeedColors {
  if (!record(value)) return false
  return ["neutral", "primary", "success", "warning", "error", "info", "interactive", "diffAdd", "diffDelete"].every(
    (key) => hex(value[key]),
  )
}

function overrides(value: unknown, allowEffects: boolean) {
  if (value === undefined) return true
  if (!record(value)) return false
  return Object.entries(value).every(
    ([key, item]) =>
      KEY.test(key) && typeof item === "string" && (allowEffects ? SAFE_CSS_VALUE.test(item) : cssValue(item)),
  )
}

function variant(value: unknown): value is ThemeVariant {
  if (!record(value)) return false
  const hasPalette = value.palette !== undefined
  const hasSeeds = value.seeds !== undefined
  if (hasPalette === hasSeeds) return false
  if (hasPalette ? !palette(value.palette) : !seeds(value.seeds)) return false
  return overrides(value.overrides, false) && overrides(value.v2Overrides, true)
}

/** Validate an imported theme before it is registered and converted to CSS. */
export function validateDesktopTheme(value: unknown): ThemeValidation {
  if (!record(value)) return { ok: false, error: "Theme must be a JSON object." }
  if (typeof value.id !== "string" || !THEME_ID.test(value.id)) {
    return { ok: false, error: "Theme id must use lowercase letters, numbers, and hyphens." }
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0 || value.name.length > 80) {
    return { ok: false, error: "Theme name must be between 1 and 80 characters." }
  }
  if (!variant(value.light) || !variant(value.dark)) {
    return { ok: false, error: "Theme needs valid light and dark color variants." }
  }
  return { ok: true, theme: value as unknown as DesktopTheme }
}

export function parseDesktopTheme(value: unknown): DesktopTheme {
  const result = validateDesktopTheme(value)
  if (!result.ok) throw new Error(result.error)
  return result.theme
}
