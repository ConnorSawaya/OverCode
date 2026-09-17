import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import {
  decodeBytes,
  decodeFrame,
  encodeBytes,
  encodeFrame,
  RELAY_STALE_DEVICE_HEADER,
  type RelayFrame,
} from "./protocol"

const port = 41_000 + Math.floor(Math.random() * 500)
const baseUrl = `http://127.0.0.1:${port}`
const token = "integration-test-token-with-enough-length"
let relay: ChildProcess | undefined

beforeAll(async () => {
  relay = spawn(process.execPath, ["src/server.ts"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", RELAY_WEBSOCKET_IDLE_TIMEOUT_SECONDS: "1" },
    stdio: "ignore",
  })
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error("relay did not start")
})

afterAll(() => relay?.kill())

describe("relay forwarding", () => {
  test("exchanges a one-time code for a persistent device token and supports device revocation", async () => {
    const connectorToken = "pairing-test-token-with-enough-length"
    const connector = await openSocket(`${baseUrl.replace("http", "ws")}/connector?token=${connectorToken}`, true)

    const expiresAt = Date.now() + 5 * 60_000
    const registered = await fetch(`${baseUrl}/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-overcode-channel-token": connectorToken },
      body: JSON.stringify({ code: "482 917", expiresAt }),
    })
    expect(registered.status).toBe(200)

    const paired = await fetch(`${baseUrl}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "482917", deviceName: "Pixel 7" }),
    })
    expect(paired.status).toBe(200)
    const device = (await paired.json()) as { token: string; deviceId: string }
    expect(device.token).toMatch(/^device_/)

    const devices = await fetch(`${baseUrl}/devices`, { headers: { "x-overcode-channel-token": connectorToken } })
    const listed = (await devices.json()) as Array<{ id: string; name: string; lastSeen: string }>
    expect(listed).toEqual([expect.objectContaining({ id: device.deviceId, name: "Pixel 7" })])
    const lastSeen = listed[0]?.lastSeen
    expect(lastSeen).toBeString()
    const presence = await fetch(new URL("/presence", baseUrl), {
      method: "POST",
      headers: { "x-overcode-channel-token": device.token, origin: "https://mobile.example" },
    })
    expect(presence.status).toBe(204)
    expect(presence.headers.get("access-control-allow-origin")).toBe("https://mobile.example")
    const afterPresence = await fetch(new URL("/devices", baseUrl), {
      headers: { "x-overcode-channel-token": connectorToken },
    })
    const refreshed = (await afterPresence.json()) as Array<{ lastSeen: string }>
    expect(Date.parse(refreshed[0]?.lastSeen ?? "")).toBeGreaterThanOrEqual(Date.parse(lastSeen!))
    const connectorPresence = await fetch(new URL("/presence", baseUrl), {
      method: "POST",
      headers: { "x-overcode-channel-token": connectorToken },
    })
    expect(connectorPresence.status).toBe(401)
    expect(
      (
        await fetch(`${baseUrl}/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "482917" }),
        })
      ).status,
    ).toBe(401)

    const responsePromise = fetch(`${baseUrl}/sync/live`, {
      headers: { "x-overcode-channel-token": device.token, "x-overcode-device-id": "spoofed-device" },
    })
    const request = await nextFrame(connector)
    expect(request.type).toBe("http.request")
    if (request.type !== "http.request") throw new Error("expected HTTP request")
    expect(request.headers).toContainEqual(["x-overcode-device-id", device.deviceId])
    expect(request.headers).not.toContainEqual(["x-overcode-device-id", "spoofed-device"])
    connector.send(encodeFrame({ type: "http.response", id: request.id, status: 204, headers: [] }))
    connector.send(encodeFrame({ type: "http.end", id: request.id }))
    expect((await responsePromise).status).toBe(204)

    const removed = await fetch(`${baseUrl}/devices/${device.deviceId}`, {
      method: "DELETE",
      headers: { "x-overcode-channel-token": connectorToken },
    })
    expect(removed.status).toBe(204)
    const removedDevice = await fetch(`${baseUrl}/sync/live`, { headers: { "x-overcode-channel-token": device.token } })
    expect(removedDevice.status).toBe(401)
    expect(removedDevice.headers.get(RELAY_STALE_DEVICE_HEADER)).toBe("1")
    expect(removedDevice.headers.get("access-control-expose-headers")).toContain(RELAY_STALE_DEVICE_HEADER)
    const revoked = await fetch(`${baseUrl}/revoke`, {
      method: "POST",
      headers: { "x-overcode-channel-token": connectorToken },
    })
    expect(revoked.status).toBe(204)
    expect(
      (await fetch(`${baseUrl}/sync/live`, { headers: { "x-overcode-channel-token": connectorToken } })).status,
    ).toBe(401)
    connector.close()
  })

  test("authenticates, streams HTTP frames, and forwards terminal websocket frames", async () => {
    const connector = await openSocket(`${baseUrl.replace("http", "ws")}/connector?token=${token}`, true)

    const responsePromise = fetch(`${baseUrl}/api/stream`, {
      headers: { "x-overcode-channel-token": token, origin: "https://mobile.example" },
    })
    const request = await nextFrame(connector)
    expect(request.type).toBe("http.request")
    if (request.type !== "http.request") throw new Error("expected HTTP request")
    expect(request.headers.some(([key]) => key === "x-overcode-channel-token")).toBe(false)
    connector.send(
      encodeFrame({ type: "http.response", id: request.id, status: 200, headers: [["content-type", "text/plain"]] }),
    )
    connector.send(
      encodeFrame({ type: "http.chunk", id: request.id, data: encodeBytes(new TextEncoder().encode("first")) }),
    )
    connector.send(
      encodeFrame({ type: "http.chunk", id: request.id, data: encodeBytes(new TextEncoder().encode("second")) }),
    )
    connector.send(encodeFrame({ type: "http.end", id: request.id }))

    const response = await responsePromise
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("https://mobile.example")
    expect(await response.text()).toBe("firstsecond")
    expect((await fetch(`${baseUrl}/api/stream`)).status).toBe(401)
    expect((await fetch(`${baseUrl}/api/stream`, { method: "OPTIONS" })).status).toBe(204)

    const openedPromise = nextFrame(connector)
    const client = await openSocket(`${baseUrl.replace("http", "ws")}/terminal/connect?token=${token}`)
    const opened = await openedPromise
    expect(opened.type).toBe("ws.open")
    if (opened.type !== "ws.open") throw new Error("expected websocket open")
    client.send("ping")
    const textInput = await nextFrame(connector)
    expect(textInput).toMatchObject({ type: "ws.data", id: opened.id, binary: false })
    if (textInput.type !== "ws.data") throw new Error("expected websocket text data")
    expect(new TextDecoder().decode(decodeBytes(textInput.data))).toBe("ping")
    client.send(new Uint8Array([0, 1, 2, 255]))
    const binaryInput = await nextFrame(connector)
    expect(binaryInput).toMatchObject({ type: "ws.data", id: opened.id, binary: true })
    if (binaryInput.type !== "ws.data") throw new Error("expected websocket binary data")
    expect([...decodeBytes(binaryInput.data)]).toEqual([0, 1, 2, 255])
    const pong = nextMessage(client)
    connector.send(encodeFrame({ type: "ws.accept", id: opened.id }))
    connector.send(
      encodeFrame({
        type: "ws.data",
        id: opened.id,
        data: encodeBytes(new TextEncoder().encode("pong")),
        binary: false,
      }),
    )
    expect(await pong).toBe("pong")
    connector.send(encodeFrame({ type: "connector.revoke" }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const revoked = await fetch(`${baseUrl}/api/stream`, { headers: { "x-overcode-channel-token": token } })
    expect(revoked.status).toBe(401)
    expect(revoked.headers.get(RELAY_STALE_DEVICE_HEADER)).toBe("1")
    client.close()
    connector.close()
  })

  test("does not let upstream auth responses impersonate stale relay pairing", async () => {
    const connectorToken = `upstream-${crypto.randomUUID()}-token-with-enough-length`
    const connector = await openSocket(`${baseUrl.replace("http", "ws")}/connector?token=${connectorToken}`, true)

    const responsePromise = fetch(`${baseUrl}/api/upstream-auth`, {
      headers: { "x-overcode-channel-token": connectorToken },
    })
    const request = await nextFrame(connector)
    expect(request.type).toBe("http.request")
    if (request.type !== "http.request") throw new Error("expected HTTP request")
    connector.send(
      encodeFrame({
        type: "http.response",
        id: request.id,
        status: 401,
        headers: [[RELAY_STALE_DEVICE_HEADER, "1"]],
      }),
    )
    connector.send(encodeFrame({ type: "http.end", id: request.id }))

    const response = await responsePromise
    expect(response.status).toBe(401)
    expect(response.headers.get(RELAY_STALE_DEVICE_HEADER)).toBeNull()
    connector.close()
  })

  test("forwards client cancellation to the PC connector", async () => {
    const connectorToken = `cancel-${crypto.randomUUID()}-token-with-enough-length`
    const connector = await openSocket(`${baseUrl.replace("http", "ws")}/connector?token=${connectorToken}`, true)

    const abort = new AbortController()
    const responsePromise = fetch(`${baseUrl}/sync/cancel`, {
      headers: { "x-overcode-channel-token": connectorToken },
      signal: abort.signal,
    }).catch(() => undefined)
    const request = await nextFrame(connector)
    expect(request.type).toBe("http.request")
    if (request.type !== "http.request") throw new Error("expected HTTP request")

    abort.abort()
    const cancellation = await nextFrame(connector)
    expect(cancellation).toEqual({ type: "http.cancel", id: request.id })
    await responsePromise.catch(() => undefined)
    connector.close()
  })

  test("rejects expired pairing codes and rate-limits invalid attempts", async () => {
    const connectorToken = `expiry-${crypto.randomUUID()}-token-with-enough-length`
    const connector = await openSocket(`${baseUrl.replace("http", "ws")}/connector?token=${connectorToken}`, true)

    const expired = await fetch(`${baseUrl}/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-overcode-channel-token": connectorToken },
      body: JSON.stringify({ code: "111222", expiresAt: Date.now() - 1 }),
    })
    expect(expired.status).toBe(400)

    const tooFar = await fetch(`${baseUrl}/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-overcode-channel-token": connectorToken },
      body: JSON.stringify({ code: "111333", expiresAt: Date.now() + 6 * 60_000 }),
    })
    expect(tooFar.status).toBe(400)

    const address = `test-${crypto.randomUUID()}`
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await fetch(`${baseUrl}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": address },
        body: JSON.stringify({ code: "000000" }),
      })
      expect(response.status).toBe(401)
    }
    const limited = await fetch(`${baseUrl}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": address },
      body: JSON.stringify({ code: "000000" }),
    })
    expect(limited.status).toBe(429)
    connector.close()
  })

  test("reclaims a connector channel after a hard disconnect", async () => {
    const connectorToken = `orphan-${crypto.randomUUID()}-token-with-enough-length`
    const url = `${baseUrl.replace("http", "ws")}/connector?token=${connectorToken}`
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const socket = new WebSocket(${JSON.stringify(url)}); socket.onopen = () => { socket.send(${JSON.stringify(encodeFrame({ type: "connector.hello", version: 2 }))}); console.log("ready") }; socket.onerror = () => process.exit(1); setInterval(() => {}, 1000)`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    try {
      await waitForChildReady(child)
      const connectedChannels = await metricValue("channels")
      child.kill()
      await waitFor(
        () => metricValue("channels"),
        (value) => value < connectedChannels,
        5_000,
      )
    } finally {
      child.kill()
    }
  })

  test("keeps an idle connector alive with relay heartbeats", async () => {
    const connectorToken = `heartbeat-${crypto.randomUUID()}-token-with-enough-length`
    const connector = await openSocket(`${baseUrl.replace("http", "ws")}/connector?token=${connectorToken}`, true)
    await new Promise((resolve) => setTimeout(resolve, 1_500))

    const responsePromise = fetch(`${baseUrl}/heartbeat`, {
      headers: { "x-overcode-channel-token": connectorToken },
    })
    let request: RelayFrame
    do {
      request = await nextFrameWithTimeout(connector, 2_000)
      if (request.type === "connector.ping") connector.send(encodeFrame({ type: "connector.pong" }))
    } while (request.type === "connector.ping")
    expect(request.type).toBe("http.request")
    if (request.type !== "http.request") throw new Error("expected HTTP request")
    connector.send(encodeFrame({ type: "http.response", id: request.id, status: 204, headers: [] }))
    connector.send(encodeFrame({ type: "http.end", id: request.id }))
    expect((await responsePromise).status).toBe(204)
    connector.close()
  })
})

async function openSocket(url: string, connector = false) {
  const socket = new WebSocket(url)
  socket.addEventListener("message", (event) => {
    const frame = decodeFrame(event.data)
    if (frame?.type === "connector.ping") socket.send(encodeFrame({ type: "connector.pong" }))
  })
  const readyPromise = connector ? waitForConnectorReady(socket) : undefined
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      if (connector) socket.send(encodeFrame({ type: "connector.hello", version: 2 }))
      resolve()
    }
    socket.onerror = () => reject(new Error(`failed to open ${url}`))
  })
  await readyPromise
  return socket
}

async function nextFrame(socket: WebSocket) {
  const message = await nextMessage(socket)
  const frame = decodeFrame(message)
  if (!frame) throw new Error("invalid relay frame")
  return frame as RelayFrame
}

async function nextFrameWithTimeout(socket: WebSocket, timeoutMs: number) {
  return Promise.race([
    nextFrame(socket),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("relay frame timed out")), timeoutMs)),
  ])
}

async function waitForConnectorReady(socket: WebSocket) {
  while (true) {
    const frame = await nextFrameWithTimeout(socket, 2_000)
    if (frame.type === "connector.ping") continue
    if (frame.type !== "connector.ready") throw new Error(`unexpected connector frame: ${frame.type}`)
    return frame
  }
}

async function nextMessage(socket: WebSocket) {
  return new Promise<string>((resolve, reject) => {
    socket.onmessage = (event) => {
      socket.onmessage = null
      socket.onerror = null
      if (typeof event.data === "string") resolve(event.data)
      else reject(new Error("unexpected binary relay frame"))
    }
    socket.onerror = () => reject(new Error("relay websocket error"))
  })
}

async function metricValue(name: string) {
  const response = await fetch(`${baseUrl}/metrics`)
  const body = await response.text()
  const match = body.match(new RegExp(`^overcode_relay_${name} ([0-9]+(?:\\.[0-9]+)?)$`, "m"))
  if (!match) throw new Error(`missing relay metric: ${name}`)
  return Number(match[1])
}

async function waitForChildReady(child: ChildProcess) {
  await new Promise<void>((resolve, reject) => {
    let output = ""
    const timeout = setTimeout(() => reject(new Error(`connector child did not open: ${output}`)), 2_000)
    child.stdout?.on("data", (chunk) => {
      output += String(chunk)
      if (!output.includes("ready")) return
      clearTimeout(timeout)
      resolve()
    })
    child.once("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`connector child exited before opening: ${code}; ${output}`))
    })
  })
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(await read())) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("relay condition timed out")
}
