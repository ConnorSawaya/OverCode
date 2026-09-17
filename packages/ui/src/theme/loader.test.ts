import { afterEach, describe, expect, test } from "bun:test"
import { loadThemeFromUrl } from "./loader"

const originalFetch = globalThis.fetch

function mockFetch(implementation: () => Response | Promise<Response>): typeof fetch {
  return Object.assign(
    async (..._args: Parameters<typeof fetch>) => implementation(),
    { preconnect: originalFetch.preconnect },
  )
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("theme URL loader", () => {
  test("only fetches http and https URLs", async () => {
    await expect(loadThemeFromUrl("file:///tmp/theme.json")).rejects.toThrow("http or https")
    await expect(loadThemeFromUrl("not a URL")).rejects.toThrow("invalid")
  })

  test("validates the downloaded theme", async () => {
    globalThis.fetch = mockFetch(() => new Response(JSON.stringify({ id: "bad" }), { status: 200 }))
    await expect(loadThemeFromUrl("https://themes.example.test/bad.json")).rejects.toThrow("Theme")
  })

  test("returns a valid theme and reports HTTP failures", async () => {
    const valid = {
      id: "remote-theme",
      name: "Remote theme",
      light: {
        palette: {
          neutral: "#f7f7f7",
          ink: "#171717",
          primary: "#6757d9",
          success: "#16834b",
          warning: "#a36a00",
          error: "#c43d3d",
          info: "#4e74c9",
        },
      },
      dark: {
        palette: {
          neutral: "#171717",
          ink: "#f7f7f7",
          primary: "#9c8fff",
          success: "#55d98b",
          warning: "#f0bd4a",
          error: "#ff756e",
          info: "#88a8ff",
        },
      },
    }
    globalThis.fetch = mockFetch(() => new Response(JSON.stringify(valid), { status: 200 }))
    await expect(loadThemeFromUrl("https://themes.example.test/theme.json")).resolves.toMatchObject({
      id: "remote-theme",
    })

    globalThis.fetch = mockFetch(() => new Response(null, { status: 503, statusText: "Unavailable" }))
    await expect(loadThemeFromUrl("https://themes.example.test/theme.json")).rejects.toThrow("Unavailable")
  })
})
