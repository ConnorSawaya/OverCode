import { expect, mock, test } from "bun:test"

mock.module("electron", () => ({
  app: { getPath: () => "C:/overcode-test-user-data" },
  default: { app: { getPath: () => "C:/overcode-test-user-data" } },
  safeStorage: {
    decryptString: () => "",
    encryptString: () => Buffer.from(""),
    isEncryptionAvailable: () => true,
  },
}))
mock.module("electron-store", () => ({
  default: class {
    get() {
      return undefined
    }
    set() {}
    delete() {}
  },
}))

const { chunkHttpBody, prepareHttpResponseHeaders } = await import("./mobile-access")

test("prepares decoded response headers for relay forwarding", () => {
  const headers = prepareHttpResponseHeaders(
    new Headers({
      "content-encoding": "gzip",
      "content-length": "123",
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    }),
  )

  expect(headers).toEqual([
    ["cache-control", "no-cache"],
    ["content-type", "text/event-stream; charset=utf-8"],
  ])
})

test("splits large and SSE response bodies into bounded frames without changing bytes", () => {
  const body = new Uint8Array(64 * 1024 + 7)
  for (let index = 0; index < body.length; index++) body[index] = index % 251

  const chunks = [...chunkHttpBody(body)]
  expect(chunks.map((chunk) => chunk.byteLength)).toEqual([64 * 1024, 7])
  expect(chunks.every((chunk) => chunk.byteLength <= 64 * 1024)).toBe(true)
  expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from(body))

  const sse = new TextEncoder().encode("event: message\ndata: hello\n\n")
  expect([...chunkHttpBody(sse, 8)].map((chunk) => new TextDecoder().decode(chunk)).join("")).toBe(
    "event: message\ndata: hello\n\n",
  )
})

test("does not emit a frame for an empty response body", () => {
  expect([...chunkHttpBody(new Uint8Array())]).toEqual([])
})
