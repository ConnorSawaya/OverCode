import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  autoStartPath,
  disableAutoStart,
  enableAutoStart,
  isAutoStartEnabled,
  renderAutoStart,
} from "."

const entry = {
  id: "ai.overcode.server",
  name: "Overcode background server",
  command: "C:\\Program Files\\Overcode\\overcode.exe",
  args: ["service", "start", "--name=main pc"],
  workingDirectory: "C:\\Users\\person\\Overcode",
}

describe("auto-start", () => {
  test("uses user-scoped locations for every supported platform", () => {
    expect(autoStartPath(entry.id, { platform: "win32", appData: "C:\\AppData" })).toContain("Startup")
    expect(autoStartPath(entry.id, { platform: "darwin", home: "/Users/person" })).toBe(
      "/Users/person/Library/LaunchAgents/ai.overcode.server.plist",
    )
    expect(autoStartPath(entry.id, { platform: "linux", home: "/home/person" })).toBe(
      "/home/person/.config/autostart/ai.overcode.server.desktop",
    )
  })

  test("renders argument-safe launchers", () => {
    const windows = renderAutoStart(entry, "win32")
    expect(windows).toContain('start "" /b "C:\\Program Files\\Overcode\\overcode.exe"')
    expect(windows).toContain('"--name=main pc"')

    const mac = renderAutoStart(entry, "darwin")
    expect(mac).toContain("<key>ProgramArguments</key>")
    expect(mac).toContain("<string>--name=main pc</string>")

    const linux = renderAutoStart(entry, "linux")
    expect(linux).toContain("Name=Overcode background server")
    expect(linux).toContain('"--name=main pc"')
  })

  test("writes atomically and removes only the requested launcher", async () => {
    const home = await mkdtemp(join(process.env.TEMP ?? "/tmp", "overcode-autostart-test-"))
    const context = { platform: "linux", home }
    const file = await enableAutoStart(entry, context)
    expect(await isAutoStartEnabled(entry.id, context)).toBe(true)
    expect(await readFile(file, "utf8")).toContain("overcode.exe")
    expect(await disableAutoStart(entry.id, context)).toBe(true)
    expect(await isAutoStartEnabled(entry.id, context)).toBe(false)
    expect(await disableAutoStart(entry.id, context)).toBe(false)
  })
})
