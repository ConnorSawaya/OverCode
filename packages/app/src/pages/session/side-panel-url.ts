// Normalizes a side-browser address-bar value to an embeddable http(s) URL.
// Returns undefined for empty or non-http(s) input.
export const normalizeBrowserUrl = (value: string): string | undefined => {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(?=[:/]|$)/i.test(trimmed)
  const scheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !local && !/^[\w.-]+:\d+(?:\/|$)/.test(trimmed)
  const next = scheme ? trimmed : `${local ? "http" : "https"}://${trimmed}`
  try {
    const parsed = new URL(next)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

// Address-bar searches are explicit user input, separate from agent URL validation.
export const browserAddress = (value: string) => {
  const text = value.trim()
  if (!text) return undefined
  if (/^(javascript|data|file|about|vbscript):/i.test(text)) return undefined
  if (/\s/.test(text) || (!text.includes(".") && !text.includes(":") && !text.includes("/")))
    return `https://www.google.com/search?q=${encodeURIComponent(text)}`
  return normalizeBrowserUrl(text)
}
