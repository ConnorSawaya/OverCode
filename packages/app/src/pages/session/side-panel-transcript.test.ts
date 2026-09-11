import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { transcriptRows } from "./side-panel-transcript"

const message = (id: string): Message =>
  ({ id, sessionID: "session", role: "user", time: { created: 1 } }) as Message

describe("transcriptRows", () => {
  test("keeps user-facing text and hides synthetic context routing notes", () => {
    const first = message("one")
    const second = message("two")
    const parts: Record<string, Part[]> = {
      one: [
        { id: "text-one", type: "text", text: "Visible question", sessionID: "session", messageID: "one" } as Part,
      ],
      two: [
        {
          id: "text-two",
          type: "text",
          text: "Internal project path",
          synthetic: true,
          sessionID: "session",
          messageID: "two",
        } as Part,
        { id: "text-three", type: "text", text: "Visible answer", sessionID: "session", messageID: "two" } as Part,
      ],
    }

    expect(transcriptRows([first, second], (id) => parts[id])).toEqual([
      { id: "one", user: true, text: "Visible question" },
      { id: "two", user: true, text: "Visible answer" },
    ])
  })
})
