import type { ServerWebSocket } from "bun"
import { randomInt, timingSafeEqual } from "node:crypto"
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
const MAX_CLIENT_SOCKETS = 64
const MAX_PENDING_HTTP = 128
const MAX_PENDING_HTTP_PER_DEVICE = 32
const MAX_DEVICES = 64
const MAX_BUFFERED_RESPONSE_CHUNKS = 256
const MAX_BUFFERED_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_PAIRING_ATTEMPTS = 8
const PAIRING_WINDOW_MS = 60_000
const PAIRING_TTL_MS = 5 * 60_000
const PAIRING_CODE_SPACE = 1_000_000
const MAX_PAIRING_CODE_ATTEMPTS = 64
const MAX_PAIRING_ATTEMPTS_ENTRIES = 10_000
const MAX_CONNECTOR_ATTEMPTS = 32
const CONNECTOR_ATTEMPT_WINDOW_MS = 60_000
const TRUST_PROXY = process.env.OVERCODE_RELAY_TRUST_PROXY === "true"
const METRICS_TOKEN = process.env.OVERCODE_RELAY_METRICS_TOKEN
const CORS_ORIGINS = new Set(
  (process.env.OVERCODE_RELAY_CORS_ORIGINS ?? "https://localhost,http://localhost,capacitor://localhost")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
)
const metrics = {
  httpActive: 0,
  httpRequests: 0,
  httpFailures: 0,
  httpLatencyMs: 0,
}

type ConnectorSocket = ServerWebSocket<SocketData>
type ClientSocket = ServerWebSocket<SocketData>
type PendingHttp = {
  deviceId?: string
  controller?: ReadableStreamDefaultController<Uint8Array>
  chunks: Uint8Array[]
  bufferedChunks: number
  bufferedBytes: number
  resolve: (response: Response) => void
  reject: (error: Error) => void
  responseStarted: boolean
  cancel: () => void
}
type Channel = {
  token: string
  connector?: ConnectorSocket
  pending: Map<string, PendingHttp>
  pendingReservations: number
  pendingReservationsByDevice: Map<string, number>
  sockets: Map<string, ClientSocket>
  socketReservations: number
  devices: Map<string, Device>
  pairing?: Pairing
}
type Device = {
  id: string
  token: string
  name: string
  deviceType: string
  pairedAt: string
  lastSeen: string
  status: "online" | "offline"
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
const connectorAttempts = new Map<string, { count: number; resetAt: number }>()

const server = Bun.serve<SocketData>({
  port: PORT,
  hostname: HOSTNAME,
  fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return securityHeaders(new Response("ok"))
    if (url.pathname === "/metrics") return handleMetrics(request)
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), request)

    if (isWebSocketRequest(request)) {
      const token = url.searchParams.get("token")
      if (!isRelayToken(token)) return new Response("Unauthorized", { status: 401 })

      const role = url.pathname === "/connector" ? "connector" : "client"
      if (role === "client" && !isAllowedWebSocketOrigin(request)) return new Response("Forbidden", { status: 403 })
      if (role === "connector" && !allowConnectorAttempt(request, server)) return new Response("Too many connection attempts", { status: 429 })
      const resolved = role === "connector" ? resolveConnector(token) : resolveAccessToken(token)
      const channel = resolved?.channel
      if (!channel) return new Response(role === "connector" ? "Too many active channels" : "PC connector is offline", { status: 503 })
      if (role === "client" && channel.socketReservations >= MAX_CLIENT_SOCKETS) return new Response("Too many mobile connections", { status: 429 })
      if (role === "client") channel.socketReservations += 1

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
      if (!upgraded) {
        if (role === "client") channel.socketReservations = Math.max(0, channel.socketReservations - 1)
        else maybeDeleteChannel(channel)
        return new Response("WebSocket upgrade failed", { status: 500 })
      }
      if (role === "client" && id && path) {
        queueMicrotask(() => {
          const current = channels.get(channel.token)
          if (!current?.connector) return closeClient(current, id, 1013, "PC connector is offline")
          if (resolved?.device) {
            resolved.device.lastSeen = new Date().toISOString()
            resolved.device.status = "online"
          }
          send(current.connector, { type: "ws.open", id, path, headers: headersFromRequest(request) })
        })
      }
      return undefined
    }

    if (url.pathname === "/pair") return handlePair(request, server).then((response) => cors(response, request))
    if (url.pathname === "/pairing") return handlePairingRegistration(request).then((response) => cors(response, request))
    if (url.pathname === "/revoke" && request.method === "POST") return cors(handleChannelRevoke(request), request)
    if (url.pathname === "/devices" && request.method === "GET") return cors(handleDevices(request), request)
    if (url.pathname === "/devices/register" && request.method === "POST")
      return handleDeviceRegister(request).then((response) => cors(response, request))
    if (url.pathname.startsWith("/devices/") && request.method === "DELETE")
      return cors(handleDeviceRevoke(request), request)
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
      if (socket.data.deviceId) {
        const device = channel.devices.get(socket.data.deviceId)
        if (device) {
          device.lastSeen = new Date().toISOString()
          device.status = "online"
        }
      }
    },
    message(socket, data) {
      const channel = channels.get(socket.data.channelToken)
      if (!channel) return socket.close(4404, "channel not found")
      if (byteLength(data) > MAX_FRAME_BYTES) return socket.close(1009, "frame too large")

      const frame = decodeFrame(data)
      if (!frame) return socket.close(4400, "invalid frame")
      if (socket.data.role === "connector") {
        if (channel.connector !== socket) return socket.close(4009, "replaced")
        handleConnectorFrame(channel, socket, frame)
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
        channel.sockets.clear()
        channel.socketReservations = 0
        channel.devices.forEach((device) => {
          device.status = "offline"
        })
      } else if (socket.data.id) {
        channel.sockets.delete(socket.data.id)
        channel.socketReservations = Math.max(0, channel.socketReservations - 1)
        if (socket.data.deviceId) {
          const device = channel.devices.get(socket.data.deviceId)
          if (device) device.status = isDeviceOnline(channel, device.id) ? "online" : "offline"
        }
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
  if (resolved?.device) {
    resolved.device.lastSeen = new Date().toISOString()
    resolved.device.status = "online"
  }

  const length = Number.parseInt(request.headers.get("content-length") ?? "0", 10)
  if (length > MAX_BODY_BYTES) return cors(new Response("Request body too large", { status: 413 }), request)
  if (channel.pending.size + channel.pendingReservations >= MAX_PENDING_HTTP)
    return cors(new Response("Too many active requests", { status: 429 }), request)
  if (
    resolved?.device &&
    (channel.pendingReservationsByDevice.get(resolved.device.id) ?? 0) >= MAX_PENDING_HTTP_PER_DEVICE
  )
    return cors(new Response("Too many active requests", { status: 429 }), request)

  channel.pendingReservations += 1
  if (resolved?.device) {
    const deviceId = resolved.device.id
    channel.pendingReservationsByDevice.set(deviceId, (channel.pendingReservationsByDevice.get(deviceId) ?? 0) + 1)
  }
  let reservation = true
  const releaseReservation = () => {
    if (!reservation) return
    reservation = false
    channel.pendingReservations = Math.max(0, channel.pendingReservations - 1)
    if (resolved?.device) {
      const deviceId = resolved.device.id
      const remaining = (channel.pendingReservationsByDevice.get(deviceId) ?? 1) - 1
      if (remaining > 0) channel.pendingReservationsByDevice.set(deviceId, remaining)
      else channel.pendingReservationsByDevice.delete(deviceId)
    }
  }
  metrics.httpActive += 1
  metrics.httpRequests += 1
  const startedAt = performance.now()
  const id = crypto.randomUUID()
  try {
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request, MAX_BODY_BYTES)
    if (body?.tooLarge) return cors(new Response("Request body too large", { status: 413 }), request)
    if (body?.error) return cors(new Response("Invalid request body", { status: 400 }), request)
    releaseReservation()

    const response = await new Promise<Response>((resolve, reject) => {
      const pending: PendingHttp = {
        ...(resolved?.device ? { deviceId: resolved.device.id } : {}),
        chunks: [],
        bufferedChunks: 0,
        bufferedBytes: 0,
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
      if (request.signal.aborted) return pending.cancel()
      if (!channel.connector) return pending.cancel()
      send(channel.connector, {
        type: "http.request",
        id,
        method: request.method,
        path: new URL(request.url).pathname + new URL(request.url).search,
        headers: headersFromRequest(request, resolved?.device?.id),
        ...(body?.value && body.value.byteLength > 0 ? { body: encodeBytes(body.value) } : {}),
      })
    }).catch((error) => {
      metrics.httpFailures += 1
      return new Response(error instanceof Error ? error.message : "Relay request failed", { status: 502 })
    })
    return cors(response, request)
  } finally {
    releaseReservation()
    metrics.httpActive -= 1
    metrics.httpLatencyMs += performance.now() - startedAt
  }
}

function handleConnectorFrame(channel: Channel, socket: ConnectorSocket, frame: RelayFrame) {
  if (channel.connector !== socket) return socket.close(4009, "replaced")
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
    pending.bufferedChunks += 1
    pending.bufferedBytes += chunk.byteLength
    if (pending.bufferedChunks > MAX_BUFFERED_RESPONSE_CHUNKS || pending.bufferedBytes > MAX_BUFFERED_RESPONSE_BYTES)
      return pending.cancel()
    if (pending.controller) {
      if ((pending.controller.desiredSize ?? 0) < -MAX_BUFFERED_RESPONSE_CHUNKS) return pending.cancel()
      pending.controller.enqueue(chunk)
      return
    }
    pending.chunks.push(chunk)
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
    else if (!pending.responseStarted)
      pending.reject(new Error("Connector ended the request before sending a response"))
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
    socket.close(
      frame.type === "ws.close" ? frame.code : 1011,
      frame.type === "ws.close" ? frame.reason : frame.message,
    )
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
  rememberRevokedToken(channel.token)
  channel.pending.forEach((pending) => {
    const error = new Error("Mobile access revoked")
    pending.controller?.error(error)
    pending.reject(error)
  })
  channel.pending.clear()
  channel.sockets.forEach((client) => client.close(4001, "Mobile access revoked"))
  channel.sockets.clear()
  channel.devices.forEach((device) => {
    deviceTokens.delete(device.token)
    rememberRevokedToken(device.token)
  })
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
  const next: Channel = {
    token,
    pending: new Map(),
    pendingReservations: 0,
    pendingReservationsByDevice: new Map(),
    sockets: new Map(),
    socketReservations: 0,
    devices: new Map(),
  }
  channels.set(token, next)
  return next
}

function resolveAccessToken(token: string): AccessResolution | undefined {
  if (revokedTokens.has(token)) return
  const channel = channels.get(token)
  if (channel) return { channel }
  const deviceChannel = deviceTokens.get(token)
  if (!deviceChannel) return
  const device = [...deviceChannel.devices.values()].find((item) => item.token === token)
  if (!device) return
  return { channel: deviceChannel, device }
}

function resolveConnector(token: string): AccessResolution | undefined {
  if (revokedTokens.has(token) || deviceTokens.has(token)) return
  const channel = getChannel(token)
  return channel ? { channel } : undefined
}

async function handlePair(request: Request, server: Bun.Server<SocketData>) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
  const body = await readJsonBody<{ code?: string; deviceName?: string; deviceType?: string }>(request, 16 * 1024)
  if (body.tooLarge) return new Response("Request body too large", { status: 413 })
  const address = clientAddress(request, server)
  prunePairingAttempts(Date.now())
  const attempt = pairingAttempts.get(address)
  const now = Date.now()
  if (!attempt || attempt.resetAt <= now) pairingAttempts.set(address, { count: 1, resetAt: now + PAIRING_WINDOW_MS })
  else if (attempt.count >= MAX_PAIRING_ATTEMPTS) return new Response("Pairing unavailable", { status: 429 })
  else attempt.count += 1

  const input = body.value
  const code = typeof input?.code === "string" ? normalizePairingCode(input.code) : ""
  const match = isPairingCode(code)
    ? [...channels.values()].find(
        (channel) => channel.pairing?.code === code && !channel.pairing.consumed && channel.pairing.expiresAt > now,
      )
    : undefined
  if (!match || !match.connector || !match.pairing) return new Response("Pairing unavailable", { status: 401 })
  if (match.devices.size >= MAX_DEVICES) return new Response("Device limit reached", { status: 429 })

  match.pairing.consumed = true
  const device: Device = {
    id: crypto.randomUUID(),
    token: `device_${crypto.randomUUID().replaceAll("-", "")}`,
    name: cleanDeviceName(input?.deviceName),
    deviceType: cleanDeviceType(input?.deviceType),
    pairedAt: new Date(now).toISOString(),
    lastSeen: new Date(now).toISOString(),
    status: "offline",
  }
  match.devices.set(device.id, device)
  deviceTokens.set(device.token, match)
  send(match.connector, { type: "device.paired", device })
  return json({ token: device.token, deviceId: device.id })
}

async function handlePairingRegistration(request: Request) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
  const body = await readJsonBody<{ code?: string; expiresAt?: number; renew?: boolean }>(request, 16 * 1024)
  if (body.tooLarge) return new Response("Request body too large", { status: 413 })
  const token = request.headers.get(RELAY_TOKEN_HEADER)
  if (!isRelayToken(token)) return new Response("Unauthorized", { status: 401 })
  const channel = channels.get(token)
  if (!channel || !channel.connector) return new Response("PC connector is offline", { status: 503 })
  const input = body.value
  const now = Date.now()
  const legacyCode = typeof input?.code === "string" ? normalizePairingCode(input.code) : ""
  const legacyExpiresAt = typeof input?.expiresAt === "number" ? input.expiresAt : 0

  // Older desktop builds supplied their own code. Keep accepting that shape
  // while new builds ask the relay to allocate the code atomically.
  if (legacyCode || legacyExpiresAt) {
    if (!isPairingCode(legacyCode) || legacyExpiresAt <= now || legacyExpiresAt > now + PAIRING_TTL_MS)
      return new Response("Invalid pairing", { status: 400 })
    if (pairingCodeInUse(legacyCode, now, channel)) return new Response("Pairing code already in use", { status: 409 })
    channel.pairing = { code: legacyCode, expiresAt: legacyExpiresAt, consumed: false }
    return json({ code: legacyCode, expiresAt: legacyExpiresAt })
  }

  if (input?.renew !== true && channel.pairing && !channel.pairing.consumed && channel.pairing.expiresAt > now)
    return json({ code: channel.pairing.code, expiresAt: channel.pairing.expiresAt })

  const code = allocatePairingCode(now, channel)
  if (!code) return new Response("Pairing unavailable", { status: 503 })
  const expiresAt = now + PAIRING_TTL_MS
  channel.pairing = { code, expiresAt, consumed: false }
  return json({ code, expiresAt })
}

function handleDevices(request: Request) {
  const channel = authorizeConnector(request)
  if (!channel) return new Response("Unauthorized", { status: 401 })
  return json([...channel.devices.values()].map((device) => publicDevice(channel, device)))
}

async function handleDeviceRegister(request: Request) {
  const channel = authorizeConnector(request)
  if (!channel) return new Response("Unauthorized", { status: 401 })
  const body = await readJsonBody<{ devices?: RelayDevice[] }>(request, 1 * 1024 * 1024)
  if (body.tooLarge) return new Response("Request body too large", { status: 413 })
  const input = body.value
  if (!Array.isArray(input?.devices) || input.devices.length > MAX_DEVICES) return new Response("Invalid devices", { status: 400 })
  for (const device of input.devices) {
    if (!device || typeof device.id !== "string" || typeof device.token !== "string" || !isRelayToken(device.token)) continue
    if (revokedTokens.has(device.token)) continue
    const id = device.id.trim().slice(0, 120)
    if (!id) continue
    const previous = channel.devices.get(id)
    if (previous && previous.token !== device.token) {
      deviceTokens.delete(previous.token)
      rememberRevokedToken(previous.token)
    }
    const next: Device = {
      id,
      token: device.token,
      name: cleanDeviceName(device.name),
      deviceType: cleanDeviceType(device.deviceType),
      pairedAt: typeof device.pairedAt === "string" ? device.pairedAt : new Date().toISOString(),
      lastSeen: previous?.lastSeen ?? (typeof device.lastSeen === "string" ? device.lastSeen : new Date().toISOString()),
      status: "offline",
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
  rememberRevokedToken(device.token)
  channel.pending.forEach((pending) => {
    if (pending.deviceId === id) pending.cancel()
  })
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

function allocatePairingCode(now: number, currentChannel: Channel) {
  for (let attempt = 0; attempt < MAX_PAIRING_CODE_ATTEMPTS; attempt += 1) {
    const code = randomInt(0, PAIRING_CODE_SPACE).toString().padStart(6, "0")
    if (!pairingCodeInUse(code, now, currentChannel)) return code
  }
  return undefined
}

function pairingCodeInUse(code: string, now: number, except?: Channel) {
  for (const channel of channels.values()) {
    if (channel === except) continue
    const pairing = channel.pairing
    if (pairing && !pairing.consumed && pairing.expiresAt > now && pairing.code === code) return true
  }
  return false
}

function clientAddress(request: Request, server: Bun.Server<SocketData>) {
  if (TRUST_PROXY) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    if (forwarded && forwarded.length <= 128) return forwarded
  }
  return server.requestIP(request)?.address ?? "unknown"
}

function allowConnectorAttempt(request: Request, server: Bun.Server<SocketData>) {
  const now = Date.now()
  const address = clientAddress(request, server)
  const attempt = connectorAttempts.get(address)
  if (!attempt || attempt.resetAt <= now) {
    connectorAttempts.set(address, { count: 1, resetAt: now + CONNECTOR_ATTEMPT_WINDOW_MS })
    pruneConnectorAttempts(now)
    return true
  }
  if (attempt.count >= MAX_CONNECTOR_ATTEMPTS) return false
  attempt.count += 1
  return true
}

function prunePairingAttempts(now: number) {
  for (const [address, attempt] of pairingAttempts) {
    if (attempt.resetAt <= now) pairingAttempts.delete(address)
  }
  while (pairingAttempts.size > MAX_PAIRING_ATTEMPTS_ENTRIES) {
    pairingAttempts.delete(pairingAttempts.keys().next().value as string)
  }
}

function pruneConnectorAttempts(now: number) {
  for (const [address, attempt] of connectorAttempts) {
    if (attempt.resetAt <= now) connectorAttempts.delete(address)
  }
  while (connectorAttempts.size > MAX_PAIRING_ATTEMPTS_ENTRIES) {
    connectorAttempts.delete(connectorAttempts.keys().next().value as string)
  }
}

function handleMetrics(request: Request) {
  if (!METRICS_TOKEN || !safeTokenEquals(request.headers.get("authorization"), `Bearer ${METRICS_TOKEN}`))
    return securityHeaders(new Response("Not found", { status: 404 }))
  return securityHeaders(
    new Response(renderMetrics(), {
      headers: { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" },
    }),
  )
}

function safeTokenEquals(actual: string | null, expected: string) {
  if (!actual) return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function cleanDeviceName(value: string | undefined) {
  const name =
    typeof value === "string"
      ? value
          .trim()
          .replace(/[\r\n\t]+/g, " ")
          .slice(0, 80)
      : "Overcode Mobile"
  return name || "Overcode Mobile"
}

function cleanDeviceType(value: string | undefined) {
  const type =
    typeof value === "string"
      ? value
          .trim()
          .replace(/[\r\n\t]+/g, " ")
          .slice(0, 80)
      : ""
  return type || "Android phone"
}

function publicDevice(channel: Channel, device: Device): Omit<RelayDevice, "token"> {
  return {
    id: device.id,
    name: device.name,
    deviceType: device.deviceType,
    pairedAt: device.pairedAt,
    lastSeen: device.lastSeen,
    status: isDeviceOnline(channel, device.id) ? "online" : "offline",
  }
}

function isDeviceOnline(channel: Channel, deviceId: string) {
  if (!channel.connector) return false
  if ([...channel.sockets.values()].some((socket) => socket.data.deviceId === deviceId)) return true
  return [...channel.pending.values()].some((pending) => pending.deviceId === deviceId)
}

async function readJsonBody<T>(request: Request, maxBytes: number): Promise<{ value?: T; tooLarge?: boolean }> {
  const body = await readBody(request, maxBytes)
  if (body.tooLarge || body.error || !body.value) return body.tooLarge ? { tooLarge: true } : {}
  try {
    return { value: JSON.parse(new TextDecoder().decode(body.value)) as T }
  } catch {
    return {}
  }
}

async function readBody(request: Request, maxBytes: number): Promise<{ value?: Uint8Array; tooLarge?: boolean; error?: boolean }> {
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (!Number.isFinite(declared) || declared < 0) return { error: true }
  if (declared > maxBytes) return { tooLarge: true }
  if (!request.body) return { value: new Uint8Array() }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read().catch(() => undefined)
    if (!next) return { error: true }
    if (next.done) return { value: joinBytes(chunks, total) }
    total += next.value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return { tooLarge: true }
    }
    chunks.push(next.value)
  }
}

function joinBytes(chunks: Uint8Array[], total: number) {
  const value = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    value.set(chunk, offset)
    offset += chunk.byteLength
  }
  return value
}

function json(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
}

function maybeDeleteChannel(channel: Channel) {
  // Keep channels with trusted devices across a transient connector restart.
  // The PC reconnects with the same encrypted channel token and re-registers
  // its devices; deleting this channel here would force every phone to pair
  // again after an otherwise normal app/computer restart.
  if (
    channel.connector ||
    channel.pending.size > 0 ||
    channel.pendingReservations > 0 ||
    channel.sockets.size > 0 ||
    channel.socketReservations > 0 ||
    channel.devices.size > 0
  )
    return
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
    "authorization",
    "cookie",
    "proxy-authorization",
    RELAY_TOKEN_HEADER,
    "x-overcode-device-id",
  ])
  const headers = [...request.headers.entries()].filter(([key]) => {
    const normalized = key.toLowerCase()
    return !blocked.has(normalized) && normalized !== "forwarded" && !normalized.startsWith("x-forwarded-")
  })
  if (deviceId) headers.push(["x-overcode-device-id", deviceId])
  return headers
}

function cors(response: Response, request: Request) {
  const headers = new Headers(response.headers)
  addSecurityHeaders(headers)
  for (const name of [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-expose-headers",
    "access-control-max-age",
  ])
    headers.delete(name)
  const origin = request.headers.get("origin")
  if (origin && CORS_ORIGINS.has(origin)) headers.set("access-control-allow-origin", origin)
  headers.set("access-control-allow-headers", "authorization, content-type, x-opencode-directory, x-overcode-channel-token")
  headers.set("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
  headers.set("access-control-max-age", "86400")
  headers.append("vary", "Origin")
  return new Response(response.body, { status: response.status, headers })
}

function isAllowedWebSocketOrigin(request: Request) {
  const origin = request.headers.get("origin")
  return !origin || CORS_ORIGINS.has(origin)
}

function rememberRevokedToken(token: string) {
  revokedTokens.add(token)
  while (revokedTokens.size > 10_000) revokedTokens.delete(revokedTokens.values().next().value as string)
}

function securityHeaders(response: Response) {
  const headers = new Headers(response.headers)
  addSecurityHeaders(headers)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function addSecurityHeaders(headers: Headers) {
  headers.set("cache-control", "no-store")
  headers.set("x-content-type-options", "nosniff")
  headers.set("x-frame-options", "DENY")
  headers.set("referrer-policy", "no-referrer")
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains")
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
