import { describe, expect, test } from "bun:test"
import { serviceAutoStartCommand } from "./auto-start"

describe("service auto-start command", () => {
  test("uses the current script when running through Bun", () => {
    expect(
      serviceAutoStartCommand({
        execPath: "C:\\Program Files\\Bun\\bun.exe",
        argv: ["bun", "C:\\overcode\\packages\\cli\\src\\index.ts"],
        cwd: "C:\\overcode",
      }),
    ).toEqual({
      id: "ai.overcode.server",
      name: "Overcode background server",
      command: "C:\\Program Files\\Bun\\bun.exe",
      args: ["C:\\overcode\\packages\\cli\\src\\index.ts", "service", "start"],
      workingDirectory: "C:\\overcode",
    })
  })

  test("uses the compiled executable directly", () => {
    expect(serviceAutoStartCommand({ execPath: "/opt/overcode/overcode-cli", argv: ["service", "enable"] })).toEqual(
      expect.objectContaining({
        command: "/opt/overcode/overcode-cli",
        args: ["service", "start"],
      }),
    )
  })

  test("fails when Bun has no script entrypoint", () => {
    expect(() => serviceAutoStartCommand({ execPath: "bun", argv: ["bun"] })).toThrow(
      "Failed to resolve the Overcode CLI entrypoint",
    )
  })
})
