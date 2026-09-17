import { describe, expect, test } from "bun:test"
import { detectServerProtocol } from "./server-protocol"

const server = { url: "http://localhost:4096" }
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const mockFetch = (run: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) =>
  Object.assign(run, { preconnect: globalThis.fetch.preconnect })

describe("detectServerProtocol", () => {
  test("recognizes V2 when both API generations expose health endpoints", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({ healthy: true, version: "1.18.4" }))
      if (path === "/api/health") return Promise.resolve(json({ healthy: true }))
      if (path === "/project") return Promise.resolve(json([{ id: "global" }]))
      return Promise.resolve(json({}, 404))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v2")
  })

  test("recognizes V2 when only the current health endpoint exists", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({}, 404))
      if (path === "/api/health") return Promise.resolve(json({ healthy: true }))
      if (path === "/project") return Promise.resolve(json([{ id: "global" }]))
      return Promise.resolve(json({}, 404))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v2")
  })

  test("recognizes standalone V2 servers without a legacy project route", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({}, 404))
      if (path === "/api/health") return Promise.resolve(json({ healthy: true }))
      if (path === "/api/location")
        return Promise.resolve(json({ directory: "/tmp/demo", project: { id: "global", directory: "/tmp/demo" } }))
      return Promise.resolve(json({}, 404))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v2")
  })

  test("passes the mobile channel token while probing routes", async () => {
    const calls: Array<{ path: string; token: string | null }> = []
    const fetcher = mockFetch((input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      calls.push({
        path: url.pathname,
        token: new Headers(input instanceof Request ? input.headers : init?.headers).get("x-overcode-channel-token"),
      })
      if (url.pathname === "/global/health") return Promise.resolve(json({}, 404))
      if (url.pathname === "/api/health") return Promise.resolve(json({ healthy: true }))
      return Promise.resolve(json([{ id: "global" }]))
    })

    expect(await detectServerProtocol({ ...server, token: "device_token-long-enough" }, fetcher)).toBe("v2")
    expect(calls.every((call) => call.token === "device_token-long-enough")).toBe(true)
  })

  test("recognizes the transitional V1 API health response", async () => {
    const fetcher = mockFetch((input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (path === "/global/health") return Promise.resolve(json({}, 404))
      return Promise.resolve(json({ healthy: true }))
    })

    expect(await detectServerProtocol(server, fetcher)).toBe("v1")
  })
})
