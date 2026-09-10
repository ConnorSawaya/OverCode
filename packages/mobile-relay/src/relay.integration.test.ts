import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { decodeFrame, encodeBytes, encodeFrame, type RelayFrame } from "./protocol"

const port = 41_000 + Math.floor(Math.random() * 500)
const baseUrl = `http://127.0.0.1:${port}`
const token = "integration-test-token-with-enough-length"
let relay: ChildProcess | undefined

beforeAll(async () => {
  relay = spawn(process.execPath, ["src/server.ts"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
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
    const connector = await openSocket(`${baseUrl.replace("http", "ws")}/connector?token=${connectorToken}`)
    expect((await nextFrame(connector)).type).toBe("connector.ready")

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
    expect(await devices.json()).toEqual([
      expect.objectContaining({ id: device.deviceId, name: "Pixel 7" }),
    ])
    expect((await fetch(`${baseUrl}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "482917" }),
    })).status).toBe(401)

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
    expect((await fetch(`${baseUrl}/sync/live`, { headers: { "x-overcode-channel-token": device.token } })).status).toBe(503)
    const revoked = await fetch(`${baseUrl}/revoke`, {
      method: "POST",
      headers: { "x-overcode-channel-token": connectorToken },
    })
    expect(revoked.status).toBe(204)
    expect((await fetch(`${baseUrl}/sync/live`, { headers: { "x-overcode-channel-token": connectorToken } })).status).toBe(503)
    connector.close()
  })

  test("authenticates, streams HTTP frames, and forwards terminal websocket frames", async () => {
    const connector = await openSocket(`${baseUrl.replace("http", "ws")}/connector?token=${token}`)
    expect((await nextFrame(connector)).type).toBe("connector.ready")

    const responsePromise = fetch(`${baseUrl}/api/stream`, {
      headers: { "x-overcode-channel-token": token, origin: "https://mobile.example" },
    })
    const request = await nextFrame(connector)
    expect(request.type).toBe("http.request")
    if (request.type !== "http.request") throw new Error("expected HTTP request")
    expect(request.headers.some(([key]) => key === "x-overcode-channel-token")).toBe(false)
    connector.send(encodeFrame({ type: "http.response", id: request.id, status: 200, headers: [["content-type", "text/plain"]] }))
    connector.send(encodeFrame({ type: "http.chunk", id: request.id, data: encodeBytes(new TextEncoder().encode("first")) }))
    connector.send(encodeFrame({ type: "http.chunk", id: request.id, data: encodeBytes(new TextEncoder().encode("second")) }))
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
    const pong = nextMessage(client)
    connector.send(encodeFrame({ type: "ws.accept", id: opened.id }))
    connector.send(encodeFrame({ type: "ws.data", id: opened.id, data: encodeBytes(new TextEncoder().encode("pong")), binary: false }))
    expect(await pong).toBe("pong")
    connector.send(encodeFrame({ type: "connector.revoke" }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await fetch(`${baseUrl}/api/stream`, { headers: { "x-overcode-channel-token": token } })).status).toBe(503)
    client.close()
    connector.close()
  })

  test("forwards client cancellation to the PC connector", async () => {
    const connectorToken = `cancel-${crypto.randomUUID()}-token-with-enough-length`
    const connector = await openSocket(`${baseUrl.replace("http", "ws")}/connector?token=${connectorToken}`)
    expect((await nextFrame(connector)).type).toBe("connector.ready")

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
    const connector = await openSocket(`${baseUrl.replace("http", "ws")}/connector?token=${connectorToken}`)
    expect((await nextFrame(connector)).type).toBe("connector.ready")

    const expired = await fetch(`${baseUrl}/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-overcode-channel-token": connectorToken },
      body: JSON.stringify({ code: "111222", expiresAt: Date.now() - 1 }),
    })
    expect(expired.status).toBe(400)

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
})

async function openSocket(url: string) {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error(`failed to open ${url}`))
  })
  return socket
}

async function nextFrame(socket: WebSocket) {
  const message = await nextMessage(socket)
  const frame = decodeFrame(message)
  if (!frame) throw new Error("invalid relay frame")
  return frame as RelayFrame
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
