export const LARGE_PASTE_CHARS = 12_000
export const LARGE_PASTE_LINES = 200

export type PastedTextStats = {
  charCount: number
  lineCount: number
}

export type PastedTextMetadata = {
  type: "pasted_text"
  pastedTextId: string
  title: string
  charCount: number
  lineCount: number
}

export function isPastedTextMetadata(value: unknown): value is PastedTextMetadata {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<PastedTextMetadata>
  return (
    item.type === "pasted_text" &&
    typeof item.pastedTextId === "string" &&
    typeof item.title === "string" &&
    typeof item.charCount === "number" &&
    typeof item.lineCount === "number"
  )
}

export function pastedTextStats(text: string): PastedTextStats {
  let lineCount = 1
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) lineCount++
  }
  return { charCount: text.length, lineCount }
}

export function shouldCreatePastedTextAttachment(text: string, stats = pastedTextStats(text)) {
  return stats.charCount >= LARGE_PASTE_CHARS || stats.lineCount >= LARGE_PASTE_LINES
}

export function pastedTextTitle(text: string) {
  const preview = text.slice(0, 300)
  const line = preview
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean)
  if (!line) return "Pasted text"
  const normalized = line.replace(/\s+/g, " ")
  return normalized.length > 64 ? `${normalized.slice(0, 61)}...` : normalized
}

export function formatPastedTextSize(charCount: number) {
  if (charCount < 1_000) return `${charCount} characters`
  if (charCount < 1_000_000) return `${(charCount / 1_000).toFixed(1)}K characters`
  return `${(charCount / 1_000_000).toFixed(1)}M characters`
}

export function releaseLocalPastedTextBlob(blob: { id: string; url: string }) {
  if (!blob.id.startsWith("paste_local_")) return
  URL.revokeObjectURL(blob.url)
}
