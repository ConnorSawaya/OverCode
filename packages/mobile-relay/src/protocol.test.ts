import { describe, expect, test } from "bun:test"
import { decodeBytes, decodeFrame, encodeBytes, encodeFrame, type RelayFrame } from "./protocol"

describe("mobile relay protocol", () => {
  test("round trips request frames without losing binary bodies", () => {
    const body = new Uint8Array([0, 1, 2, 255])
    const frame: RelayFrame = {
      type: "http.request",
      id: "request-1",
      method: "POST",
      path: "/api/session",
      headers: [["content-type", "application/json"]],
      body: encodeBytes(body),
    }
    const decoded = decodeFrame(encodeFrame(frame))
    expect(decoded).toEqual(frame)
    expect([...decodeBytes(frame.body!)]).toEqual([...body])
  })

  test("returns undefined for malformed input", () => {
    expect(decodeFrame("not json")).toBeUndefined()
    expect(decodeFrame(JSON.stringify({ type: 3 }))).toBeUndefined()
    expect(
      decodeFrame(JSON.stringify({ type: "http.response", id: "request-1", status: "200", headers: [] })),
    ).toBeUndefined()
    expect(
      decodeFrame(JSON.stringify({ type: "ws.data", id: "socket-1", data: "not-base64!", binary: true })),
    ).toBeUndefined()
    expect(
      decodeFrame(JSON.stringify({ type: "ws.open", id: "socket-1", path: "https://local", headers: [] })),
    ).toBeUndefined()
    expect(
      decodeFrame(
        JSON.stringify({
          type: "http.request",
          id: "request-1",
          method: "GET",
          path: "//attacker.example/",
          headers: [],
        }),
      ),
    ).toBeUndefined()
    expect(
      decodeFrame(
        JSON.stringify({
          type: "http.response",
          id: "response-1",
          status: 200,
          headers: [["x-test", "safe\r\nInjected: true"]],
        }),
      ),
    ).toBeUndefined()
    expect(
      decodeFrame(JSON.stringify({ type: "ws.close", id: "socket-1", code: 1005 })),
    ).toBeUndefined()
    expect(
      decodeFrame(
        JSON.stringify({
          type: "device.paired",
          device: { id: "device-1", token: "short", name: "Pixel 7", pairedAt: "now", lastSeen: "now" },
        }),
      ),
    ).toBeUndefined()
  })

  test("accepts empty streaming payloads and close reasons", () => {
    expect(
      decodeFrame(
        encodeFrame({
          type: "ws.close",
          id: "socket-1",
          code: 1000,
          reason: "",
        }),
      ),
    ).toEqual({ type: "ws.close", id: "socket-1", code: 1000, reason: "" })
    expect(
      decodeFrame(
        encodeFrame({
          type: "http.response",
          id: "request-1",
          status: 204,
          headers: [["x-empty", ""]],
        }),
      ),
    ).toEqual({ type: "http.response", id: "request-1", status: 204, headers: [["x-empty", ""]] })
  })

  test("rejects invalid binary payloads instead of decoding them leniently", () => {
    expect(() => decodeBytes("not-base64")).toThrow("invalid base64 payload")
    expect(() => decodeBytes("ab=")).toThrow("invalid base64 payload")
  })
})
