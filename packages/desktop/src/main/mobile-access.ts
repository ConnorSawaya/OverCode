import { safeStorage } from "electron"
import { randomBytes } from "node:crypto"
import { hostname } from "node:os"
import type { MobileAccessPlatform, MobileAccessState, MobileDevice } from "@opencode-ai/app"
import { createPairingUri, formatPairingCode, isPairingCode, isRelayToken, isRelayUrl } from "@opencode-ai/mobile-relay/pairing"
import {
  decodeBytes,
  decodeFrame,
  encodeBytes,
  encodeFrame,
  RELAY_PROTOCOL_VERSION,
  type RelayFrame,
} from "@opencode-ai/mobile-relay/protocol"
import type { ServerReadyData } from "../preload/types"
import { getStore } from "./store"
import { MOBILE_ACCESS_DEVICES_KEY, MOBILE_ACCESS_SECRET_KEY } from "./store-keys"

type LocalServer = Pick<ServerReadyData, "url" | "username" | "password">
type HttpRequestFrame = Extract<RelayFrame, { type: "http.request" }>
type WebSocketFrame = Extract<RelayFrame, { type: "ws.open" }>
type StoredDevice = MobileDevice & { token: string }

const DEFAULT_RELAY_URL = process.env.OVERCODE_RELAY_URL ?? "https://overcode-relay-production.up.railway.app"
const RECONNECT_DELAY_MS = 2_000
const REQUEST_TIMEOUT_MS = 20_000

export class MobileAccessController implements MobileAccessPlatform {
  private storedDevices: StoredDevice[] = readStoredDevices()
  private currentState: MobileAccessState = {
    status: "disabled",
    deviceId: hostname(),
    devices: publicDevices(this.storedDevices),
  }
  private listeners = new Set<(state: MobileAccessState) => void>()
  private socket: WebSocket | undefined
  private token: string | undefined
  private pairCode: string | undefined
  private pairExpiresAt: number | undefined
  private enabled = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private pairingTimer: ReturnType<typeof setTimeout> | undefined
  private pairingRequest: Promise<void> | undefined
  private readonly requests = new Map<string, AbortController>()
  private readonly terminalSockets = new Map<string, WebSocket>()

  constructor(
    private readonly options: {
      getLocalServer: () => Promise<LocalServer>
      relayUrl?: string
    },
  ) {}

  state() {
    return this.currentState
  }

  onState(callback: (state: MobileAccessState) => void) {
    this.listeners.add(callback)
    callback(this.currentState)
    return () => this.listeners.delete(callback)
  }

  async start() {
    if (this.enabled) return this.currentState
    const relayUrl = normalizeRelayUrl(this.options.relayUrl ?? DEFAULT_RELAY_URL)
    if (!relayUrl) return this.fail("relay_not_configured")
    if (!safeStorage.isEncryptionAvailable()) return this.fail("secure_storage_unavailable")

    const local = await this.options.getLocalServer().catch(() => undefined)
    if (!local?.url) return this.fail("local_server_unavailable")

    const storedToken = readStoredSecret()
    this.token = isRelayToken(storedToken) ? storedToken : randomBytes(32).toString("base64url")
    saveStoredSecret(this.token)
    this.pairCode = undefined
    this.pairExpiresAt = undefined
    this.enabled = true
    this.setState({
      status: "starting",
      relayUrl,
      deviceId: hostname(),
      devices: publicDevices(this.storedDevices),
    })
    this.armPairingExpiry()
    this.connect(relayUrl)
    return this.currentState
  }

  async newPairingCode() {
    if (!this.enabled || !this.currentState.relayUrl) return this.start()
    try {
      await this.registerPairing(this.currentState.relayUrl, true)
    } catch {
      return this.fail("pairing_registration_failed")
    }
    return this.currentState
  }

  async stop() {
    this.enabled = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.clearPairingExpiry()
    this.socket?.close(1000, "stopped")
    this.socket = undefined
    this.requests.forEach((request) => request.abort())
    this.requests.clear()
    this.terminalSockets.forEach((socket) => socket.close(1000, "stopped"))
    this.terminalSockets.clear()
    this.setState({ ...this.currentState, status: "disabled" })
    return this.currentState
  }

  async revoke() {
    const socket = this.socket
    const relayUrl = this.currentState.relayUrl
    let revoked = false
    if (this.token && relayUrl) {
      revoked = await fetch(`${relayUrl}/revoke`, {
        method: "POST",
        headers: { "x-overcode-channel-token": this.token },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
        .then((response) => response.ok)
        .catch(() => false)
    }
    if (!revoked && socket?.readyState === WebSocket.OPEN) this.send(socket, { type: "connector.revoke" })
    await this.stop()
    getStore().delete(MOBILE_ACCESS_SECRET_KEY)
    this.token = undefined
    this.pairCode = undefined
    this.pairExpiresAt = undefined
    this.storedDevices = []
    saveStoredDevices(this.storedDevices)
    this.setState({ status: "disabled", deviceId: hostname() })
    return this.currentState
  }

  async rotate() {
    await this.revoke()
    return this.start()
  }

  async revokeDevice(deviceId: string) {
    if (!this.token || !this.currentState.relayUrl) return this.currentState.devices ?? []
    const response = await fetch(`${this.currentState.relayUrl}/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      headers: { "x-overcode-channel-token": this.token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok && response.status !== 404) throw new Error("device_revoke_failed")
    this.storedDevices = this.storedDevices.filter((device) => device.id !== deviceId)
    saveStoredDevices(this.storedDevices)
    return this.refreshDevices()
  }

  dispose() {
    return this.stop()
  }

  private connect(relayUrl: string) {
    if (!this.enabled || !this.token) return
    const relay = new URL(relayUrl)
    relay.protocol = relay.protocol === "https:" ? "wss:" : "ws:"
    relay.pathname = "/connector"
    relay.search = ""
    relay.searchParams.set("token", this.token)

    const socket = new WebSocket(relay)
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket || !this.enabled) return
      this.send(socket, { type: "connector.hello", version: RELAY_PROTOCOL_VERSION })
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      if (typeof event.data !== "string" && !(event.data instanceof ArrayBuffer)) return
      const frame = decodeFrame(event.data)
      if (!frame) return
      void this.handleFrame(socket, frame)
    }
    socket.onerror = () => undefined
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = undefined
      if (!this.enabled) return
      this.setState({ ...this.currentState, status: "error", error: "relay_connection_failed" })
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined
        this.connect(relayUrl)
      }, RECONNECT_DELAY_MS)
    }
  }

  private async handleFrame(socket: WebSocket, frame: RelayFrame) {
    if (frame.type === "connector.ready") {
      this.setState({ ...this.currentState, status: "online", error: undefined })
      const relayUrl = this.currentState.relayUrl
      if (relayUrl) void this.registerPairing(relayUrl).catch(() => this.fail("pairing_registration_failed"))
      return
    }
    if (frame.type === "device.paired") {
      const device = normalizeStoredDevice(frame.device)
      this.storedDevices = [
        ...this.storedDevices.filter((item) => item.id !== device.id),
        device,
      ]
      saveStoredDevices(this.storedDevices)
      this.setState({ ...this.currentState, devices: publicDevices(this.storedDevices) })
      return
    }
    if (frame.type === "http.request") {
      await this.handleHttp(socket, frame)
      return
    }
    if (frame.type === "http.cancel") {
      this.requests.get(frame.id)?.abort()
      return
    }
    if (frame.type === "ws.open") {
      await this.handleWebSocket(socket, frame)
      return
    }
    if (frame.type === "ws.data") {
      const terminal = this.terminalSockets.get(frame.id)
      if (!terminal || terminal.readyState !== WebSocket.OPEN) return
      terminal.send(frame.binary ? decodeBytes(frame.data) : new TextDecoder().decode(decodeBytes(frame.data)))
      return
    }
    if (frame.type === "ws.close") {
      this.terminalSockets.get(frame.id)?.close(frame.code, frame.reason)
      this.terminalSockets.delete(frame.id)
    }
  }

  private async handleHttp(relay: WebSocket, frame: HttpRequestFrame) {
    const abort = new AbortController()
    this.requests.set(frame.id, abort)
    try {
      const local = await this.options.getLocalServer()
      const target = localTarget(local.url, frame.path)
      if (!target) throw new Error("invalid_local_target")
      const headers = new Headers(frame.headers)
      for (const name of [
        "host",
        "content-length",
        "connection",
        "transfer-encoding",
        "upgrade",
        "authorization",
        "cookie",
        "proxy-authorization",
        "forwarded",
        "x-overcode-channel-token",
        "x-overcode-device-id",
      ]) {
        headers.delete(name)
      }
      for (const [name] of headers) {
        if (name.toLowerCase().startsWith("x-forwarded-")) headers.delete(name)
      }
      if (local.password) {
        headers.set("authorization", basicAuth(local.username ?? "opencode", local.password))
      }
      const response = await fetch(target, {
        method: frame.method,
        headers,
        body: frame.body ? decodeBytes(frame.body) : undefined,
        redirect: "manual",
        signal: abort.signal,
      })
      this.send(relay, {
        type: "http.response",
        id: frame.id,
        status: response.status,
        // Electron/Node fetch transparently decodes compressed responses while
        // retaining the original content-encoding header. The relay forwards
        // these chunks verbatim, so forwarding that header would make the
        // phone try to decompress an already-decoded body a second time.
        headers: relayResponseHeaders(response.headers),
      })
      const reader = response.body?.getReader()
      if (reader) {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          if (next.value?.byteLength) this.send(relay, { type: "http.chunk", id: frame.id, data: encodeBytes(next.value) })
        }
      }
      this.send(relay, { type: "http.end", id: frame.id })
    } catch (error) {
      if (abort.signal.aborted) return
      this.send(relay, { type: "http.end", id: frame.id, error: error instanceof Error ? error.message : "request_failed" })
    } finally {
      this.requests.delete(frame.id)
    }
  }

  private async handleWebSocket(relay: WebSocket, frame: WebSocketFrame) {
    try {
      const local = await this.options.getLocalServer()
      const target = localTarget(local.url, frame.path)
      if (!target) throw new Error("invalid_local_target")
      target.searchParams.delete("token")
      target.searchParams.delete("auth_token")
      if (local.password && !target.searchParams.has("ticket"))
        target.searchParams.set("auth_token", Buffer.from(`${local.username ?? "opencode"}:${local.password}`).toString("base64"))
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:"
      const socket = new WebSocket(target)
      socket.binaryType = "arraybuffer"
      this.terminalSockets.set(frame.id, socket)
      socket.onopen = () => this.send(relay, { type: "ws.accept", id: frame.id })
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          this.send(relay, { type: "ws.data", id: frame.id, data: encodeBytes(new TextEncoder().encode(event.data)), binary: false })
          return
        }
        if (event.data instanceof ArrayBuffer) {
          this.send(relay, { type: "ws.data", id: frame.id, data: encodeBytes(event.data), binary: true })
        }
      }
      socket.onerror = () => this.send(relay, { type: "ws.error", id: frame.id, message: "terminal_connection_failed" })
      socket.onclose = (event) => {
        this.terminalSockets.delete(frame.id)
        this.send(relay, { type: "ws.close", id: frame.id, code: normalizeCloseCode(event.code), reason: limitCloseReason(event.reason) })
      }
    } catch (error) {
      this.send(relay, { type: "ws.error", id: frame.id, message: error instanceof Error ? error.message : "terminal_connection_failed" })
    }
  }

  private send(socket: WebSocket, frame: RelayFrame) {
    if (socket.readyState === WebSocket.OPEN) socket.send(encodeFrame(frame))
  }

  private fail(error: string) {
    this.setState({ ...this.currentState, status: "error", error })
    return this.currentState
  }

  private async registerPairing(relayUrl: string, renew = false) {
    while (this.pairingRequest) await this.pairingRequest.catch(() => undefined)
    const request = this.registerPairingNow(relayUrl, renew)
    this.pairingRequest = request
    try {
      await request
    } finally {
      if (this.pairingRequest === request) this.pairingRequest = undefined
    }
  }

  private async registerPairingNow(relayUrl: string, renew: boolean) {
    if (!this.token || !this.enabled) return
    const token = this.token
    const response = await fetch(`${relayUrl}/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-overcode-channel-token": this.token },
      body: JSON.stringify(renew ? { renew: true } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`pairing_registration_failed:${response.status}`)
    const pairing = (await response.json()) as { code?: unknown; expiresAt?: unknown }
    if (
      this.token !== token ||
      !this.enabled ||
      typeof pairing.code !== "string" ||
      !isPairingCode(pairing.code) ||
      typeof pairing.expiresAt !== "number" ||
      !Number.isFinite(pairing.expiresAt)
    )
      throw new Error("invalid_pairing_response")
    this.pairCode = pairing.code
    this.pairExpiresAt = pairing.expiresAt
    this.setState({
      ...this.currentState,
      pairUri: createPairingUri({ relay: relayUrl, code: pairing.code }),
      pairCode: formatPairingCode(pairing.code),
      pairExpiresAt: pairing.expiresAt,
      error: undefined,
    })
    this.armPairingExpiry()
    await this.registerDevices(relayUrl)
    await this.refreshDevices()
  }

  private armPairingExpiry() {
    this.clearPairingExpiry()
    if (!this.pairExpiresAt) return
    this.pairingTimer = setTimeout(() => {
      this.pairingTimer = undefined
      if (!this.enabled || !this.pairExpiresAt || this.pairExpiresAt > Date.now()) return
      this.pairCode = undefined
      this.pairExpiresAt = undefined
      this.setState({ ...this.currentState, pairUri: undefined, pairCode: undefined, pairExpiresAt: undefined })
    }, Math.max(0, this.pairExpiresAt - Date.now()) + 100)
  }

  private clearPairingExpiry() {
    if (this.pairingTimer) clearTimeout(this.pairingTimer)
    this.pairingTimer = undefined
  }

  private async registerDevices(relayUrl: string) {
    if (!this.token || this.storedDevices.length === 0) return
    const response = await fetch(`${relayUrl}/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-overcode-channel-token": this.token },
      body: JSON.stringify({ devices: this.storedDevices }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`device_registration_failed:${response.status}`)
  }

  private async refreshDevices() {
    if (!this.token || !this.currentState.relayUrl) return this.currentState.devices ?? []
    const response = await fetch(`${this.currentState.relayUrl}/devices`, {
      headers: { "x-overcode-channel-token": this.token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`device_list_failed:${response.status}`)
    const devices = ((await response.json()) as MobileDevice[]).filter(isMobileDevice).map(normalizeMobileDevice)
    this.setState({ ...this.currentState, devices })
    return devices
  }

  private setState(next: MobileAccessState) {
    this.currentState = next
    this.listeners.forEach((listener) => listener(next))
  }
}

function relayResponseHeaders(headers: Headers) {
  const blocked = new Set(["connection", "content-encoding", "content-length", "transfer-encoding"])
  return [...headers.entries()].filter(([name]) => !blocked.has(name.toLowerCase()))
}

function normalizeRelayUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (!trimmed) return
  try {
    const url = new URL(trimmed)
    if (!isRelayUrl(url)) return
    return url.toString().replace(/\/$/, "")
  } catch {
    return
  }
}

function localTarget(localUrl: string, path: string) {
  try {
    const base = new URL(localUrl)
    if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password) return undefined
    const target = new URL(path, base)
    if (target.origin !== base.origin || !path.startsWith("/") || path.startsWith("//")) return undefined
    target.hash = ""
    return target
  } catch {
    return undefined
  }
}

function basicAuth(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function normalizeCloseCode(value: number) {
  return Number.isInteger(value) && value >= 1_000 && value <= 4_999 && ![1_004, 1_005, 1_006, 1_015].includes(value)
    ? value
    : 1_011
}

function limitCloseReason(value: string) {
  if (new TextEncoder().encode(value).byteLength <= 123) return value
  return new TextDecoder().decode(new TextEncoder().encode(value).slice(0, 120))
}

function readStoredSecret() {
  const encoded = getStore().get(MOBILE_ACCESS_SECRET_KEY)
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    encoded.length > 1_024 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    !safeStorage.isEncryptionAvailable()
  ) return
  try {
    return safeStorage.decryptString(Buffer.from(encoded, "base64"))
  } catch {
    return
  }
}

function saveStoredSecret(value: string) {
  getStore().set(MOBILE_ACCESS_SECRET_KEY, safeStorage.encryptString(value).toString("base64"))
}

function readStoredDevices(): StoredDevice[] {
  const encoded = getStore().get(MOBILE_ACCESS_DEVICES_KEY)
  if (typeof encoded !== "string" || encoded.length > 1_000_000 || !safeStorage.isEncryptionAvailable()) return []
  try {
    const value = JSON.parse(safeStorage.decryptString(Buffer.from(encoded, "base64"))) as unknown
    if (!Array.isArray(value)) return []
    return value.filter(isStoredDevice).slice(0, 64)
  } catch {
    return []
  }
}

function saveStoredDevices(value: StoredDevice[]) {
  getStore().set(MOBILE_ACCESS_DEVICES_KEY, safeStorage.encryptString(JSON.stringify(value)).toString("base64"))
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    item.id.length <= 160 &&
    isRelayToken(item.token) &&
    typeof item.name === "string" &&
    item.name.length <= 80 &&
    typeof item.pairedAt === "string" &&
    item.pairedAt.length <= 80 &&
    Number.isFinite(Date.parse(item.pairedAt)) &&
    typeof item.lastSeen === "string" &&
    item.lastSeen.length <= 80 &&
    Number.isFinite(Date.parse(item.lastSeen))
  )
}

function isMobileDevice(value: unknown): value is MobileDevice {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    item.id.length <= 160 &&
    typeof item.name === "string" &&
    item.name.length <= 80 &&
    typeof item.pairedAt === "string" &&
    item.pairedAt.length <= 80 &&
    Number.isFinite(Date.parse(item.pairedAt)) &&
    typeof item.lastSeen === "string" &&
    item.lastSeen.length <= 80 &&
    Number.isFinite(Date.parse(item.lastSeen))
  )
}

function publicDevices(value: StoredDevice[]): MobileDevice[] {
  return value.map(({ token: _token, ...device }) => normalizeMobileDevice(device))
}

function normalizeStoredDevice(device: StoredDevice): StoredDevice {
  return {
    ...device,
    deviceType: device.deviceType?.trim() || "Android phone",
  }
}

function normalizeMobileDevice(device: MobileDevice): MobileDevice {
  return {
    ...device,
    deviceType: device.deviceType?.trim() || "Android phone",
  }
}
