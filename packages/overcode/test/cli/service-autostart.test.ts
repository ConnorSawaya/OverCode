import { describe, expect, test } from "bun:test"
import { primaryServiceAutoStartCommand } from "../../src/cli/service-autostart"

describe("primary CLI service auto-start", () => {
  test("runs the primary server through Bun", () => {
    expect(
      primaryServiceAutoStartCommand({
        execPath: "C:\\Program Files\\Bun\\bun.exe",
        argv: ["bun", "C:\\overcode\\packages\\overcode\\src\\index.ts"],
        cwd: "C:\\overcode",
      }),
    ).toEqual({
      id: "ai.overcode.server",
      name: "Overcode background server",
      command: "C:\\Program Files\\Bun\\bun.exe",
      args: ["C:\\overcode\\packages\\overcode\\src\\index.ts", "serve"],
      workingDirectory: "C:\\overcode",
    })
  })

  test("runs serve directly from a compiled CLI", () => {
    expect(
      primaryServiceAutoStartCommand({ execPath: "/opt/overcode/overcode", argv: ["/opt/overcode/overcode"] }),
    ).toMatchObject({ command: "/opt/overcode/overcode", args: ["serve"] })
  })

  test("requires a script when running through Bun", () => {
    expect(() => primaryServiceAutoStartCommand({ execPath: "bun", argv: ["bun"] })).toThrow(
      "Failed to resolve the Overcode CLI entrypoint",
    )
  })
})
