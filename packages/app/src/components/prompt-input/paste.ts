import { shouldCreatePastedTextAttachment } from "@opencode-ai/session-ui/v2/prompt-input/pasted-text"

export function normalizePaste(text: string) {
  if (!text.includes("\r")) return text
  return text.replace(/\r\n?/g, "\n")
}

export function pasteMode(text: string) {
  if (shouldCreatePastedTextAttachment(text)) return "manual"
  if (text.includes("\n") || text.includes("\r")) return "manual"
  return "native"
}
