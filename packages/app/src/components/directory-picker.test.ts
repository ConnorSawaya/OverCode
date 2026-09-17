import { describe, expect, test } from "bun:test"
import { directoryPickerKind, shouldUseDirectoryPickerV2 } from "./directory-picker-policy"

const local = {
  type: "sidecar",
  variant: "base",
  http: { url: "http://localhost:4096" },
} as const
const remote = {
  type: "ssh",
  host: "example.test",
  http: { url: "http://localhost:4096" },
} as const

describe("directoryPickerKind", () => {
  test("uses the native picker only for local desktop projects", () => {
    expect(directoryPickerKind("desktop", local)).toBe("native")
    expect(directoryPickerKind("desktop", remote)).toBe("server")
    expect(directoryPickerKind("web", local)).toBe("server")
  })
})

describe("shouldUseDirectoryPickerV2", () => {
  test("uses the server-backed v2 picker for mobile web profiles", () => {
    expect(shouldUseDirectoryPickerV2("web", true)).toBe(true)
    expect(shouldUseDirectoryPickerV2("desktop", true)).toBe(true)
    expect(shouldUseDirectoryPickerV2("web", false)).toBe(false)
  })
})
