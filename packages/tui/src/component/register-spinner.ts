import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerOvercodeSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}

/** @deprecated Use {@link registerOvercodeSpinner} instead. Kept for backwards compatibility. */
export const registerOpencodeSpinner = registerOvercodeSpinner
