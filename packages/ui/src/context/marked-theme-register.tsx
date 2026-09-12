import { registerCustomTheme } from "@pierre/diffs"
import { OvercodeTheme } from "./marked-theme"

let registered = false

export function registerOvercodeTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("Overcode", () => Promise.resolve(OvercodeTheme))
}
