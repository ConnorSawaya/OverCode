import { access, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir, platform as hostPlatform } from "node:os"
import { dirname as hostDirname, posix, win32 } from "node:path"

export type AutoStartPlatform = "win32" | "darwin" | "linux"

export type AutoStartContext = {
  platform?: string
  home?: string
  appData?: string
  xdgConfigHome?: string
}

export type AutoStartEntry = {
  id: string
  name: string
  command: string
  args?: string[]
  workingDirectory?: string
}

function platform(value: string): AutoStartPlatform | undefined {
  if (value === "win32" || value === "darwin" || value === "linux") return value
  return undefined
}

function safeId(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new Error("Auto-start id contains invalid characters")
  return value
}

export function autoStartPath(id: string, context: AutoStartContext = {}) {
  const target = platform(context.platform ?? hostPlatform())
  if (!target) return undefined
  const name = safeId(id)
  const home = context.home ?? homedir()
  const join = target === "win32" ? win32.join : posix.join

  if (target === "win32") {
    const appData = context.appData ?? process.env.APPDATA ?? join(home, "AppData", "Roaming")
    return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${name}.cmd`)
  }
  if (target === "darwin") return join(home, "Library", "LaunchAgents", `${name}.plist`)
  return join(
    context.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
    "autostart",
    `${name}.desktop`,
  )
}

export function renderAutoStart(entry: AutoStartEntry, target: AutoStartPlatform) {
  safeId(entry.id)
  const args = entry.args ?? []

  if (target === "win32") {
    const workingDirectory = entry.workingDirectory ? `cd /d ${quoteWindows(entry.workingDirectory)}\r\n` : ""
    return [
      "@echo off",
      workingDirectory +
        `start "" /b ${quoteWindows(entry.command)}${args.map((arg) => ` ${quoteWindows(arg)}`).join("")}`,
      "",
    ].join("\r\n")
  }

  if (target === "darwin") {
    const argumentsXml = [entry.command, ...args].map((value) => `    <string>${escapeXml(value)}</string>`).join("\n")
    const workingDirectory = entry.workingDirectory
      ? `\n  <key>WorkingDirectory</key>\n  <string>${escapeXml(entry.workingDirectory)}</string>`
      : ""
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(entry.id)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>${workingDirectory}
</dict>
</plist>
`
  }

  const workingDirectory = entry.workingDirectory ? `\nPath=${quoteDesktop(entry.workingDirectory)}` : ""
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=${escapeDesktopField(entry.name)}
Exec=${[entry.command, ...args].map(quoteDesktop).join(" ")}${workingDirectory}
Terminal=false
X-GNOME-Autostart-enabled=true
`
}

export async function enableAutoStart(entry: AutoStartEntry, context: AutoStartContext = {}) {
  const target = platform(context.platform ?? hostPlatform())
  if (!target) throw new Error(`Auto-start is not supported on ${context.platform ?? hostPlatform()}`)
  const file = autoStartPath(entry.id, { ...context, platform: target })
  if (!file) throw new Error(`Auto-start is not supported on ${target}`)
  await mkdir(hostDirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, renderAutoStart(entry, target), { encoding: "utf8", mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  return file
}

export async function disableAutoStart(id: string, context: AutoStartContext = {}) {
  const file = autoStartPath(id, context)
  if (!file) return false
  const existed = await isAutoStartEnabled(id, context)
  await rm(file, { force: true })
  return existed
}

export async function isAutoStartEnabled(id: string, context: AutoStartContext = {}) {
  const file = autoStartPath(id, context)
  if (!file) return false
  return access(file).then(
    () => true,
    () => false,
  )
}

function quoteWindows(value: string) {
  return `"${value.replace(/"/g, '\\"')}"`
}

function quoteDesktop(value: string) {
  if (/^[a-zA-Z0-9_./:@+=,-]+$/.test(value)) return value
  return `"${value.replace(/([\\"])/g, "\\$1").replace(/%/g, "%%")}"`
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function escapeDesktopField(value: string) {
  return value.replace(/[\r\n]/g, " ")
}
