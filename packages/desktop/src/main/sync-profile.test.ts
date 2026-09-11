import { describe, expect, test } from "bun:test"
import { mergeProfileFields, mergeProjectVisibility, providerIDsFromModel } from "./sync-profile"

describe("sync profile provider requirements", () => {
  test("collects unique provider IDs from model preferences", () => {
    expect(
      providerIDsFromModel({
        user: [
          { providerID: "anthropic", modelID: "claude" },
          { providerID: "openai", modelID: "gpt" },
          { providerID: "anthropic", modelID: "other" },
        ],
        recent: [
          { providerID: "google", modelID: "gemini" },
          { providerID: "openai", modelID: "gpt" },
        ],
      }),
    ).toEqual(["anthropic", "google", "openai"])
  })

  test("ignores malformed and oversized provider IDs", () => {
    expect(
      providerIDsFromModel({
        user: [
          null,
          { providerID: "", modelID: "empty" },
          { providerID: "x".repeat(161), modelID: "long" },
          { providerID: "valid", modelID: "model" },
        ],
        recent: "not-an-array",
      }),
    ).toEqual(["valid"])
  })

  test("merges independent offline fields without overwriting local changes", () => {
    const result = mergeProfileFields({
      local: { model: { selected: "local" }, settings: { theme: "dark" } },
      localClocks: {
        model: { updatedAt: 20, deviceID: "desktop-a" },
        settings: { updatedAt: 10, deviceID: "desktop-a" },
      },
      incoming: { model: { selected: "remote" }, settings: { theme: "light" } },
      incomingClocks: {
        model: { updatedAt: 15, deviceID: "desktop-b" },
        settings: { updatedAt: 30, deviceID: "desktop-b" },
      },
      incomingFallbackClock: { updatedAt: 30, deviceID: "desktop-b" },
    })

    expect(result.data).toEqual({ model: { selected: "local" }, settings: { theme: "light" } })
    expect(result.changed).toBe(true)
  })

  test("uses device ID as a deterministic tie breaker", () => {
    const result = mergeProfileFields({
      local: { model: "a" },
      localClocks: { model: { updatedAt: 10, deviceID: "desktop-a" } },
      incoming: { model: "b" },
      incomingClocks: { model: { updatedAt: 10, deviceID: "desktop-b" } },
      incomingFallbackClock: { updatedAt: 10, deviceID: "desktop-b" },
    })

    expect(result.data.model).toBe("b")
  })

  test("keeps a newer project close/reopen decision deterministic", () => {
    const result = mergeProjectVisibility({
      local: { projectA: true },
      localClocks: { projectA: { updatedAt: 10, deviceID: "desktop-a" } },
      incoming: { projectA: false },
      incomingClocks: { projectA: { updatedAt: 20, deviceID: "desktop-b" } },
      incomingFallbackClock: { updatedAt: 20, deviceID: "desktop-b" },
    })

    expect(result.data).toEqual({ projectA: false })
    expect(result.clocks.projectA).toEqual({ updatedAt: 20, deviceID: "desktop-b" })
    expect(result.changed).toBe(true)
  })
})
