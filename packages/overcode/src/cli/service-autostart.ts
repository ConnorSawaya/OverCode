import { basename } from "node:path"
import { disableAutoStart, enableAutoStart, type AutoStartEntry } from "@overcode-ai/autostart"

export const PRIMARY_SERVER_AUTOSTART_ID = "ai.overcode.server"

export function primaryServiceAutoStartCommand(input: {
  execPath: string
  argv: string[]
  cwd?: string
}): AutoStartEntry {
  const runtime = basename(input.execPath)
    .replace(/\.exe$/i, "")
    .toLowerCase()
  const entrypoint = input.argv[1]
  if (runtime === "bun" && !entrypoint) throw new Error("Failed to resolve the Overcode CLI entrypoint")
  return {
    id: PRIMARY_SERVER_AUTOSTART_ID,
    name: "Overcode background server",
    command: input.execPath,
    args: runtime === "bun" ? [entrypoint!, "serve"] : ["serve"],
    workingDirectory: input.cwd,
  }
}

export function enablePrimaryServiceAutoStart() {
  return enableAutoStart(
    primaryServiceAutoStartCommand({ execPath: process.execPath, argv: process.argv, cwd: process.cwd() }),
  )
}

export function disablePrimaryServiceAutoStart() {
  return disableAutoStart(PRIMARY_SERVER_AUTOSTART_ID)
}
