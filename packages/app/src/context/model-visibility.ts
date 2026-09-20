export type ModelVisibility = "show" | "hide"

export function isModelVisible(input: { visibility?: ModelVisibility; configured: boolean; firstParty: boolean }) {
  if (input.visibility === "hide") return false
  if (input.visibility === "show") return true
  return input.configured || input.firstParty
}
