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
  })
})
