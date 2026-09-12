declare global {
  const OVERCODE_VERSION: string
  const OVERCODE_CHANNEL: string
}

export const InstallationVersion = typeof OVERCODE_VERSION === "string" ? OVERCODE_VERSION : "local"
export const InstallationChannel = typeof OVERCODE_CHANNEL === "string" ? OVERCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
