export const AUTO_TITLE_METADATA_KEY = "overcode.autoTitle"
export const MANUAL_TITLE_METADATA_KEY = "overcode.manualTitle"

const DEFAULT_TITLE_PREFIXES = ["New session - ", "Child session - "]

export function isDefaultTitle(title: string) {
  const normalized = title.trim()
  if (!normalized) return true
  if (
    /^(?:session|new session|untitled|unnamed|chat|new chat|conversation|new conversation)(?:[\s_-]*\d+)?$/i.test(
      normalized,
    )
  )
    return true

  return DEFAULT_TITLE_PREFIXES.some((prefix) => {
    const suffix = normalized.slice(prefix.length)
    return normalized.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(suffix)
  })
}

export function canAutoTitle(input: { title: string; metadata?: Record<string, unknown> | null }) {
  return isDefaultTitle(input.title) && input.metadata?.[MANUAL_TITLE_METADATA_KEY] !== true
}

export function cleanGeneratedTitle(value: string) {
  const line = value
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .split("\n")
    .map((item) => item.trim())
    .find(Boolean)
  if (!line) return

  const cleaned = line
    .replace(/^(?:title|subject)\s*:\s*/i, "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
  if (!cleaned) return
  return cleaned.length > 100 ? `${cleaned.slice(0, 97)}...` : cleaned
}

/** Keep chat history useful even when an optional title request times out. */
export function fallbackTitleFromPrompt(value: string) {
  const cleaned = value.replace(/\s+/g, " ").trim()
  if (!cleaned) return "New conversation"
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned
}
