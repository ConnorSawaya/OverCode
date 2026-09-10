export const RELAY_PROTOCOL_VERSION = 2
export const RELAY_TOKEN_HEADER = "x-overcode-channel-token"

export type RelayHeaders = Array<[string, string]>
export type RelayDevice = {
  id: string
  token: string
  name: string
  pairedAt: string
  lastSeen: string
}

export type RelayFrame =
  | { type: "connector.hello"; version: number }
  | { type: "connector.ready"; version: number }
  | { type: "connector.error"; message: string }
  | { type: "connector.revoke" }
  | { type: "device.paired"; device: RelayDevice }
  | {
      type: "http.request"
      id: string
      method: string
      path: string
      headers: RelayHeaders
      body?: string
    }
  | { type: "http.cancel"; id: string }
  | { type: "http.response"; id: string; status: number; headers: RelayHeaders }
  | { type: "http.chunk"; id: string; data: string }
  | { type: "http.end"; id: string; error?: string }
  | { type: "ws.open"; id: string; path: string; headers: RelayHeaders }
  | { type: "ws.accept"; id: string }
  | { type: "ws.data"; id: string; data: string; binary: boolean }
  | { type: "ws.close"; id: string; code: number; reason?: string }
  | { type: "ws.error"; id: string; message: string }

export function encodeFrame(frame: RelayFrame) {
  return JSON.stringify(frame)
}

export function decodeFrame(value: string | ArrayBuffer | ArrayBufferView): RelayFrame | undefined {
  const text = typeof value === "string" ? value : new TextDecoder().decode(toBytes(value))
  try {
    const frame = JSON.parse(text) as RelayFrame
    if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return
    return frame
  } catch {
    return
  }
}

export function encodeBytes(value: ArrayBuffer | ArrayBufferView) {
  return Buffer.from(toBytes(value)).toString("base64")
}

export function decodeBytes(value: string) {
  return new Uint8Array(Buffer.from(value, "base64"))
}

function toBytes(value: ArrayBuffer | ArrayBufferView) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}
