import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// Overcode publishes a small JSON manifest alongside its release artifacts.
// Keep this configurable so a private or local release feed can be used without
// changing the application code.
export const UPDATER_ENABLED = true
export const UPDATE_MANIFEST_URL =
  process.env.OVERCODE_UPDATE_URL?.trim() ||
  "https://raw.githubusercontent.com/ConnorSawaya/overcode/overcode-rebrand/packages/desktop/update.json"
