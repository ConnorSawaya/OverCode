import { describe, expect, test } from "bun:test"
import {
  LARGE_PASTE_CHARS,
  LARGE_PASTE_LINES,
  pastedTextStats,
  pastedTextTitle,
  shouldCreatePastedTextAttachment,
} from "./pasted-text"

describe("large pasted text detection", () => {
  test("keeps ordinary pastes inline", () => {
    const text = "hello world"
    expect(shouldCreatePastedTextAttachment(text)).toBe(false)
  })

  test("uses character and line thresholds without splitting the payload", () => {
    const byCharacters = "x".repeat(LARGE_PASTE_CHARS)
    const byLines = Array.from({ length: LARGE_PASTE_LINES }, () => "x").join("\n")
    expect(shouldCreatePastedTextAttachment(byCharacters)).toBe(true)
    expect(shouldCreatePastedTextAttachment(byLines)).toBe(true)
    expect(pastedTextStats("a\r\nb\nc")).toEqual({ charCount: 6, lineCount: 3 })
  })

  test("derives a bounded title from only the preview", () => {
    expect(pastedTextTitle("\n\n# Build a Codex-style composer\n" + "x".repeat(500_000))).toBe(
      "# Build a Codex-style composer",
    )
    expect(pastedTextTitle("\n\t" + "x".repeat(100))).toHaveLength(64)
  })
})
