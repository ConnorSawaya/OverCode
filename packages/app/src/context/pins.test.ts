import { describe, expect, test } from "bun:test"
import { chatPinKey, toggleChatPin, toggleProjectPin, type PinnedChat } from "./pins"

describe("pins", () => {
  test("builds a stable key per server and session", () => {
    expect(chatPinKey({ server: "a", sessionID: "1" })).toBe("a\n1")
    expect(chatPinKey({ server: "a", sessionID: "1" })).toBe(chatPinKey({ server: "a", sessionID: "1" }))
    expect(chatPinKey({ server: "a", sessionID: "1" })).not.toBe(chatPinKey({ server: "b", sessionID: "1" }))
  })

  test("pins a chat to the front and unpins on second toggle", () => {
    const first: PinnedChat = { server: "local", sessionID: "ses_1" }
    const second: PinnedChat = { server: "local", sessionID: "ses_2" }
    const pinned = toggleChatPin(toggleChatPin([], first), second)
    expect(pinned).toEqual([second, first])
    expect(toggleChatPin(pinned, first)).toEqual([second])
  })

  test("treats same session on different servers as distinct pins", () => {
    const list = toggleChatPin([], { server: "a", sessionID: "1" })
    const next = toggleChatPin(list, { server: "b", sessionID: "1" })
    expect(next).toEqual([
      { server: "b", sessionID: "1" },
      { server: "a", sessionID: "1" },
    ])
  })

  test("pins a project to the front and unpins on second toggle", () => {
    const pinned = toggleProjectPin(toggleProjectPin([], "/a"), "/b")
    expect(pinned).toEqual(["/b", "/a"])
    expect(toggleProjectPin(pinned, "/a")).toEqual(["/b"])
  })

  test("treats equivalent project paths as the same pin", () => {
    const pinned = toggleProjectPin([], "C:\\repo")
    expect(toggleProjectPin(pinned, "C:/repo/")).toEqual([])
  })
})
