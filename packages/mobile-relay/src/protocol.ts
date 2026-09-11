import { isRelayToken } from "./pairing"

export const RELAY_PROTOCOL_VERSION = 2
export const RELAY_TOKEN_HEADER = "x-overcode-channel-token"

export type RelayHeaders = Array<[string, string]>
export type RelayDevice = {
  id: string
  token: string
  name: string
  deviceType?: string
  pairedAt: string
  lastSeen: string
  status?: "online" | "offline"
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
    const frame: unknown = JSON.parse(text)
    return isRelayFrame(frame) ? frame : undefined
  } catch {
    return
  }
}

export function encodeBytes(value: ArrayBuffer | ArrayBufferView) {
  return Buffer.from(toBytes(value)).toString("base64")
}

export function decodeBytes(value: string) {
  if (!isBase64(value)) throw new Error("invalid base64 payload")
  return new Uint8Array(Buffer.from(value, "base64"))
}

function toBytes(value: ArrayBuffer | ArrayBufferView) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

const MAX_FRAME_ID = 160
const MAX_PATH = 8_192
const MAX_HEADER_COUNT = 256
const MAX_HEADER_NAME = 256
const MAX_HEADER_VALUE = 8_192
const MAX_MESSAGE = 16_384
const MAX_CLOSE_REASON_BYTES = 123
const MAX_PAYLOAD_BASE64 = 16 * 1024 * 1024

function isRelayFrame(value: unknown): value is RelayFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false

  switch (value.type) {
    case "connector.hello":
    case "connector.ready":
      return isInteger(value.version) && value.version >= 0 && value.version <= 100
    case "connector.error":
      return isString(value.message, MAX_MESSAGE)
    case "connector.revoke":
      return true
    case "device.paired": {
      const device = value.device
      return (
        isRecord(device) &&
        isString(device.id, MAX_FRAME_ID) &&
        isRelayToken(device.token) &&
        isString(device.name, 80) &&
        (device.deviceType === undefined || isString(device.deviceType, 80)) &&
        isString(device.pairedAt, 80) &&
        isString(device.lastSeen, 80) &&
        (device.status === undefined || device.status === "online" || device.status === "offline")
      )
    }
    case "http.request":
      return (
        isString(value.id, MAX_FRAME_ID) &&
        isString(value.method, 16) &&
        /^[A-Z]+$/.test(value.method) &&
        isPath(value.path) &&
        isHeaders(value.headers) &&
        (value.body === undefined || isBase64(value.body))
      )
    case "http.cancel":
      return isString(value.id, MAX_FRAME_ID)
    case "http.response":
      return (
        isString(value.id, MAX_FRAME_ID) &&
        isInteger(value.status) &&
        value.status >= 100 &&
        value.status <= 599 &&
        isHeaders(value.headers)
      )
    case "http.chunk":
      return isString(value.id, MAX_FRAME_ID) && isBase64(value.data)
    case "http.end":
      return isString(value.id, MAX_FRAME_ID) && (value.error === undefined || isString(value.error, MAX_MESSAGE))
    case "ws.open":
      return isString(value.id, MAX_FRAME_ID) && isPath(value.path) && isHeaders(value.headers)
    case "ws.accept":
      return isString(value.id, MAX_FRAME_ID)
    case "ws.data":
      return isString(value.id, MAX_FRAME_ID) && isBase64(value.data) && typeof value.binary === "boolean"
    case "ws.close":
      return (
        isString(value.id, MAX_FRAME_ID) &&
        isInteger(value.code) &&
        isValidCloseCode(value.code) &&
        (value.reason === undefined || isCloseReason(value.reason))
      )
    case "ws.error":
      return isString(value.id, MAX_FRAME_ID) && isString(value.message, MAX_MESSAGE)
    default:
      return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown, max: number): value is string {
  return isText(value, max) && value.length > 0
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\u0000")
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
}

function isPath(value: unknown): value is string {
  return (
    isString(value, MAX_PATH) &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function isHeaders(value: unknown): value is RelayHeaders {
  return (
    Array.isArray(value) &&
    value.length <= MAX_HEADER_COUNT &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        isHeaderName(entry[0]) &&
        isHeaderValue(entry[1]),
    )
  )
}

function isHeaderName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_HEADER_NAME &&
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
  )
}

function isHeaderValue(value: unknown): value is string {
  return isText(value, MAX_HEADER_VALUE) && !value.includes("\r") && !value.includes("\n")
}

function isBase64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_PAYLOAD_BASE64 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
}

function isCloseReason(value: unknown): value is string {
  return isText(value, MAX_MESSAGE) && new TextEncoder().encode(value).byteLength <= MAX_CLOSE_REASON_BYTES
}

function isValidCloseCode(value: number) {
  return (value >= 1_000 && value <= 4_999 && ![1_004, 1_005, 1_006, 1_015].includes(value)) || value === 0
}
