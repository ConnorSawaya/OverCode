import {
  disableAutoStart,
  enableAutoStart,
  type AutoStartEntry,
} from "@overcode-ai/autostart"
import { basename } from "node:path"

export const BACKGROUND_SERVER_AUTOSTART_ID = "ai.overcode.server"

export function serviceAutoStartCommand(input: { execPath: string; argv: string[]; cwd?: string }): AutoStartEntry {
  const runtime = basename(input.execPath).replace(/\.exe$/i, "").toLowerCase()
  if (runtime === "bun") {
    const entrypoint = input.argv[1]
    if (!entrypoint) throw new Error("Failed to resolve the Overcode CLI entrypoint")
    return {
      id: BACKGROUND_SERVER_AUTOSTART_ID,
      name: "Overcode background server",
      command: input.execPath,
      args: [entrypoint, "service", "start"],
      workingDirectory: input.cwd,
    }
  }
  return {
    id: BACKGROUND_SERVER_AUTOSTART_ID,
    name: "Overcode background server",
    command: input.execPath,
    args: ["service", "start"],
    workingDirectory: input.cwd,
  }
}

export function enableServiceAutoStart() {
  return enableAutoStart(
    serviceAutoStartCommand({ execPath: process.execPath, argv: process.argv, cwd: process.cwd() }),
  )
}

export function disableServiceAutoStart() {
  return disableAutoStart(BACKGROUND_SERVER_AUTOSTART_ID)
}
