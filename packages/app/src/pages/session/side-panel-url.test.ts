import { describe, expect, test } from "bun:test"
import { browserAddress, normalizeBrowserUrl } from "./side-panel-url"

describe("normalizeBrowserUrl", () => {
  test("adds https to bare hosts", () => {
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com/")
  })

  test("keeps explicit http urls", () => {
    expect(normalizeBrowserUrl("http://localhost:3000/preview")).toBe("http://localhost:3000/preview")
  })

  test("rejects empty and non-http schemes", () => {
    expect(normalizeBrowserUrl("   ")).toBeUndefined()
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeUndefined()
    expect(normalizeBrowserUrl("file:///etc/passwd")).toBeUndefined()
  })

  test("rejects malformed input", () => {
    expect(normalizeBrowserUrl("https://")).toBeUndefined()
  })
})

describe("browserAddress", () => {
  test("supports local development servers and web searches", () => {
    expect(browserAddress("localhost:3000/preview")).toBe("http://localhost:3000/preview")
    expect(browserAddress("127.0.0.1:4173")).toBe("http://127.0.0.1:4173/")
    expect(browserAddress("[::1]:3000")).toBe("http://[::1]:3000/")
    expect(browserAddress("solid js docs")).toBe("https://www.google.com/search?q=solid%20js%20docs")
    expect(browserAddress("weather")).toBe("https://www.google.com/search?q=weather")
    expect(browserAddress("example.com/path")).toBe("https://example.com/path")
  })
  test("does not execute pasted scripts or open local files", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,hello", "file:///C:/secret", "about:blank", "  "])
      expect(browserAddress(value)).toBeUndefined()
  })
})
