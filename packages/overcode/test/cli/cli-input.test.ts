import { describe, expect, test } from "bun:test"
import {
  cliAttachHeaders,
  isCliExitCommand,
  isCliNewSessionCommand,
  normalizeCliAttachUrl,
  parseCliModel,
  resolveCliInput,
} from "@/cli/cmd/cli"

describe("cli input", () => {
  test("prefers piped input when no message is given", () => {
    expect(resolveCliInput(undefined, "piped")).toBe("piped")
  })

  test("prefers message when no pipe is present", () => {
    expect(resolveCliInput("hello", undefined)).toBe("hello")
  })

  test("joins message and piped input", () => {
    expect(resolveCliInput("hello", "world")).toBe("hello\nworld")
  })

  test("returns undefined when both are missing", () => {
    expect(resolveCliInput(undefined, undefined)).toBeUndefined()
  })
})

describe("cli exit commands", () => {
  test("matches exit variants", () => {
    expect(isCliExitCommand("/exit")).toBe(true)
    expect(isCliExitCommand("/quit")).toBe(true)
    expect(isCliExitCommand("exit")).toBe(true)
    expect(isCliExitCommand("  /Q  ")).toBe(true)
  })

  test("rejects normal prompts", () => {
    expect(isCliExitCommand("hello")).toBe(false)
    expect(isCliExitCommand("/new")).toBe(false)
    expect(isCliExitCommand("")).toBe(false)
  })

  test("matches new session command", () => {
    expect(isCliNewSessionCommand("/new")).toBe(true)
    expect(isCliNewSessionCommand(" /NEW ")).toBe(true)
    expect(isCliNewSessionCommand("/exit")).toBe(false)
  })
})

describe("cli model parsing", () => {
  test("parses provider/model", () => {
    expect(parseCliModel("anthropic/claude-sonnet-4-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
  })

  test("keeps slashes inside model id", () => {
    expect(parseCliModel("openrouter/org/model")).toEqual({
      providerID: "openrouter",
      modelID: "org/model",
    })
  })

  test("rejects missing model part", () => {
    expect(parseCliModel("anthropic")).toBeUndefined()
    expect(parseCliModel(undefined)).toBeUndefined()
    expect(parseCliModel("")).toBeUndefined()
  })
})

describe("cli remote transport", () => {
  test("normalizes supported attach URLs", () => {
    expect(normalizeCliAttachUrl("https://relay.example.test/")).toBe("https://relay.example.test")
    expect(normalizeCliAttachUrl("http://127.0.0.1:41235")).toBe("http://127.0.0.1:41235")
    expect(normalizeCliAttachUrl("file:///tmp/overcode")).toBeUndefined()
    expect(normalizeCliAttachUrl("not a url")).toBeUndefined()
  })

  test("combines basic auth and relay channel headers", () => {
    const headers = cliAttachHeaders({
      environment: {
        OVERCODE_SERVER_USERNAME: "overcode",
        OVERCODE_SERVER_PASSWORD: "server-password",
        OVERCODE_CHANNEL_TOKEN: "relay-token",
      },
    })
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from("overcode:server-password").toString("base64")}`,
    )
    expect(headers.get("x-overcode-channel-token")).toBe("relay-token")
  })
})
