import { describe, expect, test } from "bun:test"
import {
  AUTO_TITLE_METADATA_KEY,
  MANUAL_TITLE_METADATA_KEY,
  canAutoTitle,
  cleanGeneratedTitle,
  fallbackTitleFromPrompt,
  isDefaultTitle,
} from "@overcode-ai/core/session/title"

describe("shared session title policy", () => {
  test("recognizes generated default names but not meaningful names", () => {
    expect(isDefaultTitle("New session - 2026-09-14T20:45:25.665Z")).toBe(true)
    expect(isDefaultTitle("Unnamed 2")).toBe(true)
    expect(isDefaultTitle("Investigate relay latency")).toBe(false)
  })

  test("manual metadata permanently wins over automatic naming", () => {
    expect(canAutoTitle({ title: "New session", metadata: undefined })).toBe(true)
    expect(canAutoTitle({ title: "New session", metadata: { [AUTO_TITLE_METADATA_KEY]: true } })).toBe(true)
    expect(canAutoTitle({ title: "New session", metadata: { [MANUAL_TITLE_METADATA_KEY]: true } })).toBe(false)
    expect(canAutoTitle({ title: "Already named", metadata: undefined })).toBe(false)
  })

  test("normalizes a title-agent response into one safe line", () => {
    expect(cleanGeneratedTitle('<think>hidden</think>\nTitle: "Remote chat control"')).toBe("Remote chat control")
    expect(cleanGeneratedTitle("\n\n")).toBeUndefined()
    expect(fallbackTitleFromPrompt("Reply   with\nexactly OK")).toBe("Reply with exactly OK")
  })
})
