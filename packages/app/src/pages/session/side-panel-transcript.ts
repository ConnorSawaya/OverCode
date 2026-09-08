import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { sessionTitle } from "@/utils/session-title"

export type TranscriptRow = { id: string; user: boolean; text: string }

// Title for a side-chat session row: live title, then persisted info title,
// then the raw session ID. Shared by the picker and the transcript header.
export const chatTabTitle = (
  sessionId: string,
  infoTitle: string | undefined,
  session: Pick<Session, "title"> | undefined,
): string => (session && sessionTitle(session.title)) || infoTitle || sessionId

// Flattens a session's messages to text-only transcript rows. Messages
// without text content (tool calls, errors) are skipped.
export const transcriptRows = (
  messages: Message[] | undefined,
  partsFor: (messageID: string) => Part[] | undefined,
): TranscriptRow[] =>
  (messages ?? []).flatMap((message) => {
    const text = (partsFor(message.id) ?? [])
      .flatMap((part) => (part.type === "text" && part.text && !part.synthetic ? [part.text] : []))
      .join("\n")
      .trim()
    if (!text) return []
    return [{ id: message.id, user: message.role === "user", text }]
  })
