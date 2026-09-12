import type { ServerWebSocket } from "bun"
import {
  decodeBytes,
  decodeFrame,
  encodeBytes,
  encodeFrame,
  RELAY_PROTOCOL_VERSION,
  RELAY_TOKEN_HEADER,
  type RelayDevice,
  type RelayFrame,
  type RelayHeaders,
} from "./protocol"
import { isPairingCode, isRelayToken, normalizePairingCode } from "./pairing"

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10)
const HOSTNAME = process.env.HOST ?? "0.0.0.0"
const MAX_BODY_BYTES = 10 * 1024 * 1024
const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_CHANNELS = 1_000
const MAX_PAIRING_ATTEMPTS = 8
const PAIRING_WINDOW_MS = 60_000
const PAIRING_TTL_MS = 5 * 60_000
const metrics = {
  httpActive: 0,
  httpRequests: 0,
  httpFailures: 0,
  httpLatencyMs: 0,
}

type ConnectorSocket = ServerWebSocket<SocketData>
type ClientSocket = ServerWebSocket<SocketData>
type PendingHttp = {
  controller?: ReadableStreamDefaultController<Uint8Array>
  chunks: Uint8Array[]
  resolve: (response: Response) => void
  reject: (error: Error) => void
  responseStarted: boolean
  cancel: () => void
}
type Channel = {
  token: string
  connector?: ConnectorSocket
  pending: Map<string, PendingHttp>
  sockets: Map<string, ClientSocket>
  devices: Map<string, Device>
  pairing?: Pairing
}
type Device = {
  id: string
  token: string
  name: string
  pairedAt: string
  lastSeen: string
}
type Pairing = {
  code: string
  expiresAt: number
  consumed: boolean
}
type AccessResolution = {
  channel: Channel
  device?: Device
}
type SocketData = {
  role: "connector" | "client"
  token: string
  channelToken: string
  id?: string
  deviceId?: string
}

const channels = new Map<string, Channel>()
const deviceTokens = new Map<string, Channel>()
const revokedTokens = new Set<string>()
const pairingAttempts = new Map<string, { count: number; resetAt: number }>()

const server = Bun.serve<SocketData>({
  port: PORT,
  hostname: HOSTNAME,
  fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    if (url.pathname === "/metrics") return new Response(renderMetrics(), { headers: { "content-type": "text/plain; version=0.0.4" } })
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), request)

    if (isWebSocketRequest(request)) {
      const token = url.searchParams.get("token")
      if (!isRelayToken(token)) return new Response("Unauthorized", { status: 401 })

      const role = url.pathname === "/connector" ? "connector" : "client"
      const resolved = role === "connector" ? resolveConnector(token) : resolveAccessToken(token)
      const channel = resolved?.channel
      if (!channel) return new Response(role === "connector" ? "Too many active channels" : "PC connector is offline", { status: 503 })

      const id = role === "client" ? crypto.randomUUID() : undefined
      const path = role === "client" ? upstreamWebSocketPath(url) : undefined
      const upgraded = server.upgrade(request, {
        data: {
          role,
          token,
          channelToken: channel.token,
          id,
          ...(resolved?.device ? { deviceId: resolved.device.id } : {}),
        },
      })
      if (!upgraded) return new Response("WebSocket upgrade failed", { status: 500 })
      if (role === "client" && id && path) {
        queueMicrotask(() => {
          const current = channels.get(channel.token)
          if (!current?.connector) return closeClient(current, id, 1013, "PC connector is offline")
          if (resolved?.device) resolved.device.lastSeen = new Date().toISOString()
          send(current.connector, { type: "ws.open", id, path, headers: headersFromRequest(request) })
        })
      }
      return undefined
    }

    if (url.pathname === "/pair") return handlePair(request).then((response) => cors(response, request))
    if (url.pathname === "/pairing") return handlePairingRegistration(request).then((response) => cors(response, request))
    if (url.pathname === "/revoke" && request.method === "POST") return cors(handleChannelRevoke(request), request)
    if (url.pathname === "/devices" && request.method === "GET") return cors(handleDevices(request), request)
    if (url.pathname === "/devices/register" && request.method === "POST") return handleDeviceRegister(request).then((response) => cors(response, request))
    if (url.pathname.startsWith("/devices/") && request.method === "DELETE") return cors(handleDeviceRevoke(request), request)
    return handleHttp(request)
  },
  websocket: {
    open(socket) {
      const channel = channels.get(socket.data.channelToken)
      if (!channel) return socket.close(4404, "channel not found")
      if (socket.data.role === "connector") {
        if (channel.connector && channel.connector !== socket) channel.connector.close(4009, "replaced")
        channel.connector = socket
        send(socket, { type: "connector.ready", version: RELAY_PROTOCOL_VERSION })
        return
      }
      if (!socket.data.id) return socket.close(4400, "missing socket id")
      channel.sockets.set(socket.data.id, socket)
    },
    message(socket, data) {
      const channel = channels.get(socket.data.channelToken)
      if (!channel) return socket.close(4404, "channel not found")
      if (byteLength(data) > MAX_FRAME_BYTES) return socket.close(1009, "frame too large")

      const frame = decodeFrame(data)
      if (!frame) return socket.close(4400, "invalid frame")
      if (socket.data.role === "connector") {
        handleConnectorFrame(channel, frame)
        return
      }
      if (socket.data.id && channel.connector) {
        if (frame.type === "ws.data") send(channel.connector, { ...frame, id: socket.data.id })
        if (frame.type === "ws.close") send(channel.connector, { ...frame, id: socket.data.id })
      }
    },
    close(socket) {
      const channel = channels.get(socket.data.token)
      if (!channel) return
      if (socket.data.role === "connector") {
        if (channel.connector !== socket) return
        channel.connector = undefined
        channel.pending.forEach((pending) => {
          pending.controller?.error(new Error("PC connector disconnected"))
          pending.reject(new Error("PC connector disconnected"))
        })
        channel.pending.clear()
        channel.sockets.forEach((client) => client.close(1011, "PC connector disconnected"))
        channel.sockets.clear()
      } else if (socket.data.id) {
        channel.sockets.delete(socket.data.id)
        if (channel.connector) send(channel.connector, { type: "ws.close", id: socket.data.id, code: 1000 })
      }
      maybeDeleteChannel(channel)
    },
  },
})

console.log(`overcode-relay listening on ${server.hostname}:${server.port}`)

async function handleHttp(request: Request) {
  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), request)

  const token = request.headers.get(RELAY_TOKEN_HEADER)
  if (!isRelayToken(token)) return cors(new Response("Unauthorized", { status: 401 }), request)
  const resolved = resolveAccessToken(token)
  const channel = resolved?.channel
  if (!channel?.connector) return cors(new Response("PC connector is offline", { status: 503 }), request)
  if (resolved?.device) resolved.device.lastSeen = new Date().toISOString()

  const length = Number.parseInt(request.headers.get("content-length") ?? "0", 10)
  if (length > MAX_BODY_BYTES) return cors(new Response("Request body too large", { status: 413 }), request)

  metrics.httpActive += 1
  metrics.httpRequests += 1
  const startedAt = performance.now()
  const id = crypto.randomUUID()
  try {
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
    if (body && body.byteLength > MAX_BODY_BYTES) return cors(new Response("Request body too large", { status: 413 }), request)

    const response = await new Promise<Response>((resolve, reject) => {
      const pending: PendingHttp = {
        chunks: [],
        responseStarted: false,
        resolve,
        reject,
        cancel: () => {
          if (!channel.pending.delete(id)) return
          if (channel.connector) send(channel.connector, { type: "http.cancel", id })
          reject(new Error("Request cancelled"))
        },
      }
      channel.pending.set(id, pending)
      const abort = () => pending.cancel()
      request.signal.addEventListener("abort", abort, { once: true })
      if (!channel.connector) return pending.cancel()
      send(channel.connector, {
        type: "http.request",
        id,
        method: request.method,
        path: new URL(request.url).pathname + new URL(request.url).search,
        headers: headersFromRequest(request, resolved?.device?.id),
        ...(body ? { body: encodeBytes(body) } : {}),
      })
    }).catch((error) => {
      metrics.httpFailures += 1
      return new Response(error instanceof Error ? error.message : "Relay request failed", { status: 502 })
    })
    return cors(response, request)
  } finally {
    metrics.httpActive -= 1
    metrics.httpLatencyMs += performance.now() - startedAt
  }
}

function handleConnectorFrame(channel: Channel, frame: RelayFrame) {
  if (frame.type === "connector.revoke") {
    revokeChannel(channel)
    return
  }
  if (frame.type === "connector.hello") {
    if (channel.connector) send(channel.connector, { type: "connector.ready", version: RELAY_PROTOCOL_VERSION })
    return
  }
  if (frame.type === "http.response") {
    const pending = channel.pending.get(frame.id)
    if (!pending || pending.responseStarted) return
    pending.responseStarted = true
    pending.resolve(new Response(pendingStream(pending), { status: frame.status, headers: frame.headers }))
    return
  }
  if (frame.type === "http.chunk") {
    const pending = channel.pending.get(frame.id)
    if (!pending) return
    const chunk = decodeBytes(frame.data)
    if (pending.controller) pending.controller.enqueue(chunk)
    else pending.chunks.push(chunk)
    return
  }
  if (frame.type === "http.end") {
    const pending = channel.pending.get(frame.id)
    if (!pending) return
    channel.pending.delete(frame.id)
    if (frame.error) {
      const error = new Error(frame.error)
      pending.controller?.error(error)
      pending.reject(error)
      return
    }
    if (pending.controller) pending.controller.close()
    else if (!pending.responseStarted) pending.reject(new Error("Connector ended the request before sending a response"))
    return
  }
  if (frame.type === "ws.accept") return
  if (frame.type === "ws.data") {
    const socket = channel.sockets.get(frame.id)
    if (!socket) return
    socket.send(frame.binary ? decodeBytes(frame.data) : new TextDecoder().decode(decodeBytes(frame.data)))
    return
  }
  if (frame.type === "ws.close" || frame.type === "ws.error") {
    const socket = channel.sockets.get(frame.id)
    if (!socket) return
    socket.close(frame.type === "ws.close" ? frame.code : 1011, frame.type === "ws.close" ? frame.reason : frame.message)
    channel.sockets.delete(frame.id)
  }
}

function handleChannelRevoke(request: Request) {
  const channel = authorizeConnector(request)
  if (!channel) return new Response("Unauthorized", { status: 401 })
  revokeChannel(channel)
  return new Response(null, { status: 204 })
}

function revokeChannel(channel: Channel) {
  revokedTokens.add(channel.token)
  while (revokedTokens.size > 10_000) revokedTokens.delete(revokedTokens.values().next().value as string)
  channel.pending.forEach((pending) => {
    const error = new Error("Mobile access revoked")
    pending.controller?.error(error)
    pending.reject(error)
  })
  channel.pending.clear()
  channel.sockets.forEach((client) => client.close(4001, "Mobile access revoked"))
  channel.sockets.clear()
  channel.devices.forEach((device) => deviceTokens.delete(device.token))
  channel.devices.clear()
  const connector = channel.connector
  channel.connector = undefined
  channels.delete(channel.token)
  connector?.close(4001, "Mobile access revoked")
}

function pendingStream(pending: PendingHttp) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      pending.controller = controller
      pending.chunks.splice(0).forEach((chunk) => controller.enqueue(chunk))
    },
    cancel() {
      pending.cancel()
    },
  })
}

function getChannel(token: string) {
  if (revokedTokens.has(token)) return
  const existing = channels.get(token)
  if (existing) return existing
  if (channels.size >= MAX_CHANNELS) return
  const next: Channel = { token, pending: new Map(), sockets: new Map(), devices: new Map() }
  channels.set(token, next)
  return next
}

function resolveAccessToken(token: string): AccessResolution | undefined {
  const channel = channels.get(token)
  if (channel) return { channel }
  const deviceChannel = deviceTokens.get(token)
  if (!deviceChannel) return
  const device = [...deviceChannel.devices.values()].find((item) => item.token === token)
  if (!device) return
  return { channel: deviceChannel, device }
}

function resolveConnector(token: string): AccessResolution | undefined {
  const channel = getChannel(token)
  return channel ? { channel } : undefined
}

async function handlePair(request: Request) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
  const body = await readJsonBody<{ code?: string; deviceName?: string }>(request, 16 * 1024)
  if (body.tooLarge) return new Response("Request body too large", { status: 413 })
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
  const attempt = pairingAttempts.get(address)
  const now = Date.now()
  if (!attempt || attempt.resetAt <= now) pairingAttempts.set(address, { count: 1, resetAt: now + PAIRING_WINDOW_MS })
  else if (attempt.count >= MAX_PAIRING_ATTEMPTS) return new Response("Pairing unavailable", { status: 429 })
  else attempt.count += 1

  const input = body.value
  const code = input?.code ? normalizePairingCode(input.code) : ""
  const match = isPairingCode(code)
    ? [...channels.values()].find((channel) => channel.pairing?.code === code && !channel.pairing.consumed && channel.pairing.expiresAt > now)
    : undefined
  if (!match || !match.connector || !match.pairing) return new Response("Pairing unavailable", { status: 401 })

  match.pairing.consumed = true
  const device: Device = {
    id: crypto.randomUUID(),
    token: `device_${crypto.randomUUID().replaceAll("-", "")}`,
    name: cleanDeviceName(input?.deviceName),
    pairedAt: new Date(now).toISOString(),
    lastSeen: new Date(now).toISOString(),
  }
  match.devices.set(device.id, device)
  deviceTokens.set(device.token, match)
  send(match.connector, { type: "device.paired", device })
  return json({ token: device.token, deviceId: device.id })
}

async function handlePairingRegistration(request: Request) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
  const body = await readJsonBody<{ code?: string; expiresAt?: number }>(request, 16 * 1024)
  if (body.tooLarge) return new Response("Request body too large", { status: 413 })
  const token = request.headers.get(RELAY_TOKEN_HEADER)
  if (!isRelayToken(token)) return new Response("Unauthorized", { status: 401 })
  const channel = channels.get(token)
  if (!channel || !channel.connector) return new Response("PC connector is offline", { status: 503 })
  const input = body.value
  const code = input?.code ? normalizePairingCode(input.code) : ""
  const expiresAt = typeof input?.expiresAt === "number" ? input.expiresAt : 0
  if (!isPairingCode(code) || expiresAt <= Date.now() || expiresAt > Date.now() + PAIRING_TTL_MS) return new Response("Invalid pairing", { status: 400 })
  channel.pairing = { code, expiresAt, consumed: false }
  return json({ ok: true })
}

function handleDevices(request: Request) {
  const channel = authorizeConnector(request)
  if (!channel) return new Response("Unauthorized", { status: 401 })
  return json([...channel.devices.values()].map(({ token: _token, ...device }) => device))
}

async function handleDeviceRegister(request: Request) {
  const channel = authorizeConnector(request)
  if (!channel) return new Response("Unauthorized", { status: 401 })
  const body = await readJsonBody<{ devices?: RelayDevice[] }>(request, 1 * 1024 * 1024)
  if (body.tooLarge) return new Response("Request body too large", { status: 413 })
  const input = body.value
  if (!Array.isArray(input?.devices) || input.devices.length > 1_000) return new Response("Invalid devices", { status: 400 })
  for (const device of input.devices) {
    if (!device || typeof device.id !== "string" || typeof device.token !== "string" || !isRelayToken(device.token)) continue
    const next: Device = {
      id: device.id.slice(0, 120),
      token: device.token,
      name: cleanDeviceName(device.name),
      pairedAt: typeof device.pairedAt === "string" ? device.pairedAt : new Date().toISOString(),
      lastSeen: typeof device.lastSeen === "string" ? device.lastSeen : new Date().toISOString(),
    }
    channel.devices.set(next.id, next)
    deviceTokens.set(next.token, channel)
  }
  return json({ ok: true })
}

function handleDeviceRevoke(request: Request) {
  const channel = authorizeConnector(request)
  if (!channel) return new Response("Unauthorized", { status: 401 })
  const id = new URL(request.url).pathname.slice("/devices/".length)
  const device = channel.devices.get(id)
  if (!device) return new Response("Not found", { status: 404 })
  channel.devices.delete(id)
  deviceTokens.delete(device.token)
  for (const [socketID, socket] of channel.sockets) {
    if (socket.data.deviceId !== id) continue
    socket.close(4001, "Device revoked")
    channel.sockets.delete(socketID)
  }
  return new Response(null, { status: 204 })
}

function authorizeConnector(request: Request) {
  const token = request.headers.get(RELAY_TOKEN_HEADER)
  if (!isRelayToken(token)) return
  const channel = channels.get(token)
  return channel?.connector ? channel : undefined
}

function cleanDeviceName(value: string | undefined) {
  const name = typeof value === "string" ? value.trim().replace(/[\r\n\t]+/g, " ").slice(0, 80) : "Overcode Mobile"
  return name || "Overcode Mobile"
}

async function readJsonBody<T>(request: Request, maxBytes: number): Promise<{ value?: T; tooLarge?: boolean }> {
  const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10)
  if (declared > maxBytes) return { tooLarge: true }
  const body = await request.arrayBuffer()
  if (body.byteLength > maxBytes) return { tooLarge: true }
  try {
    return { value: JSON.parse(new TextDecoder().decode(body)) as T }
  } catch {
    return {}
  }
}

function json(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } })
}

function maybeDeleteChannel(channel: Channel) {
  if (channel.connector || channel.pending.size > 0 || channel.sockets.size > 0) return
  channel.devices.forEach((device) => deviceTokens.delete(device.token))
  channels.delete(channel.token)
}

function closeClient(channel: Channel | undefined, id: string, code: number, reason: string) {
  const socket = channel?.sockets.get(id)
  if (!socket) return
  socket.close(code, reason)
  channel?.sockets.delete(id)
}

function send(socket: ServerWebSocket<SocketData>, frame: RelayFrame) {
  if (socket.readyState === 1) socket.send(encodeFrame(frame))
}

function isWebSocketRequest(request: Request) {
  return request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket"
}

function upstreamWebSocketPath(url: URL) {
  const next = new URL(url)
  next.searchParams.delete("token")
  return next.pathname + next.search
}

function headersFromRequest(request: Request, deviceId?: string): RelayHeaders {
  const blocked = new Set([
    "connection",
    "content-length",
    "host",
    "upgrade",
    RELAY_TOKEN_HEADER,
    "x-overcode-device-id",
  ])
  const headers = [...request.headers.entries()].filter(([key]) => !blocked.has(key.toLowerCase()))
  if (deviceId) headers.push(["x-overcode-device-id", deviceId])
  return headers
}

function cors(response: Response, request: Request) {
  const headers = new Headers(response.headers)
  headers.set("access-control-allow-origin", request.headers.get("origin") ?? "*")
  headers.set("access-control-allow-headers", "authorization, content-type, x-overcode-directory, x-overcode-channel-token")
  headers.set("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
  headers.set("access-control-max-age", "86400")
  return new Response(response.body, { status: response.status, headers })
}

function byteLength(value: string | ArrayBuffer | ArrayBufferView) {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength
  if (value instanceof ArrayBuffer) return value.byteLength
  return value.byteLength
}

function renderMetrics() {
  const activeChannels = [...channels.values()].filter((channel) => channel.connector).length
  const activeClients = [...channels.values()].reduce((total, channel) => total + channel.sockets.size, 0)
  const averageLatency = metrics.httpRequests === 0 ? 0 : metrics.httpLatencyMs / metrics.httpRequests
  return [
    "# TYPE overcode_relay_channels gauge",
    `overcode_relay_channels ${activeChannels}`,
    "# TYPE overcode_relay_clients gauge",
    `overcode_relay_clients ${activeClients}`,
    "# TYPE overcode_relay_http_active gauge",
    `overcode_relay_http_active ${metrics.httpActive}`,
    "# TYPE overcode_relay_http_requests_total counter",
    `overcode_relay_http_requests_total ${metrics.httpRequests}`,
    "# TYPE overcode_relay_http_failures_total counter",
    `overcode_relay_http_failures_total ${metrics.httpFailures}`,
    "# TYPE overcode_relay_http_latency_ms gauge",
    `overcode_relay_http_latency_ms ${averageLatency.toFixed(2)}`,
    "",
  ].join("\n")
}
