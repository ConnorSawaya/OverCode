import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@overcode-ai/core/v1/session"
import {
  canAutoTitle,
  isDefaultTitle,
  MANUAL_TITLE_METADATA_KEY,
  userRequestedTitleChange,
} from "../../src/session/session"

function userMessage(text: string, options?: { synthetic?: boolean }) {
  return {
    info: { role: "user" },
    parts: [{ type: "text", text, synthetic: options?.synthetic }],
  } as unknown as SessionV1.WithParts
}

describe("session title policy", () => {
  test("recognizes placeholder titles as unnamed", () => {
    for (const title of [
      "",
      "   ",
      "Session",
      "Session 2",
      "New session",
      "New session - 2026-09-14T00:00:00.000Z",
      "Child session - 2026-09-14T00:00:00.000Z",
      "Untitled",
      "New chat",
    ]) {
      expect(isDefaultTitle(title)).toBe(true)
    }
  })

  test("does not treat a meaningful title as unnamed", () => {
    expect(isDefaultTitle("Fix mobile relay heartbeat")).toBe(false)
    expect(isDefaultTitle("Session planning notes")).toBe(false)
  })

  test("preserves manual ownership even for a placeholder-looking title", () => {
    expect(canAutoTitle({ title: "Session" })).toBe(true)
    expect(canAutoTitle({ title: "Session", metadata: { [MANUAL_TITLE_METADATA_KEY]: true } })).toBe(false)
    expect(canAutoTitle({ title: "AI-generated title", metadata: { overcodeAutoTitle: true } })).toBe(false)
  })

  test("requires an explicit chat title request for the rename tool", () => {
    expect(userRequestedTitleChange([userMessage("Please rename this chat to Mobile Relay")])).toBe(true)
    expect(userRequestedTitleChange([userMessage("Change the conversation title to Pairing")])).toBe(true)
    expect(userRequestedTitleChange([userMessage("Rename this variable in the parser")])).toBe(false)
    expect(userRequestedTitleChange([userMessage("Please fix the chat connection")])).toBe(false)
  })

  test("uses only the latest user message and ignores synthetic text", () => {
    expect(
      userRequestedTitleChange([userMessage("Rename this chat to an old title"), userMessage("Now fix the API error")]),
    ).toBe(false)
    expect(userRequestedTitleChange([userMessage("Rename this chat", { synthetic: true })])).toBe(false)
  })
})
