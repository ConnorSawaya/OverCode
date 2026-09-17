import { ServerConnection } from "@/context/server"
import type { Platform } from "@/context/platform"

export function directoryPickerKind(platform: Platform["platform"], server: ServerConnection.Any) {
  if (platform === "desktop" && ServerConnection.local(server)) return "native" as const
  return "server" as const
}

export function shouldUseDirectoryPickerV2(platform: Platform["platform"], newLayout: boolean) {
  return newLayout && (platform === "desktop" || platform === "web")
}
