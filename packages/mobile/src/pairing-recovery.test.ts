import { describe, expect, test } from "bun:test"
import { RELAY_STALE_DEVICE_HEADER, RELAY_TOKEN_HEADER } from "@overcode-ai/mobile-relay/protocol"
import { createPairingRecoveryFetch, type MobilePairingConnection } from "./pairing-recovery"

const connection: MobilePairingConnection = {
  relay: "https://relay.example.test",
  token: "device_token",
}

function response(status: number, stale = false) {
  return new Response(null, {
    status,
    headers: stale ? { [RELAY_STALE_DEVICE_HEADER]: "1" } : undefined,
  })
}

describe("createPairingRecoveryFetch", () => {
  test("reports a stale relay pairing for auth and not-found responses", async () => {
    const stale: MobilePairingConnection[] = []
    const fetch = createPairingRecoveryFetch({
      fetch: async () => response(401, true),
      getConnection: () => connection,
      onStalePairing: (value) => {
        stale.push(value)
      },
    })

    await fetch(`${connection.relay}/api/project`, { headers: { [RELAY_TOKEN_HEADER]: connection.token } })

    const notFoundFetch = createPairingRecoveryFetch({
      fetch: async () => response(404, true),
      getConnection: () => connection,
      onStalePairing: (value) => {
        stale.push(value)
      },
    })
    await notFoundFetch(`${connection.relay}/api/project`, { headers: { [RELAY_TOKEN_HEADER]: connection.token } })

    expect(stale).toEqual([connection, connection])
  })

  test("preserves valid pairing for upstream auth/not-found responses", async () => {
    let cleared = false
    const fetch = createPairingRecoveryFetch({
      fetch: async () => response(401),
      getConnection: () => connection,
      onStalePairing: () => {
        cleared = true
      },
    })
    await fetch(`${connection.relay}/api/project`, { headers: { [RELAY_TOKEN_HEADER]: connection.token } })
    await createPairingRecoveryFetch({
      fetch: async () => response(404),
      getConnection: () => connection,
      onStalePairing: () => {
        cleared = true
      },
    })(`${connection.relay}/api/project`, { headers: { [RELAY_TOKEN_HEADER]: connection.token } })

    expect(cleared).toBe(false)
  })

  test("ignores stale markers from another origin or without an active pairing", async () => {
    let cleared = 0
    const fetch = createPairingRecoveryFetch({
      fetch: async () => response(401, true),
      getConnection: () => undefined,
      onStalePairing: () => {
        cleared++
      },
    })
    await fetch(`${connection.relay}/api/project`, { headers: { [RELAY_TOKEN_HEADER]: connection.token } })

    const otherOrigin = createPairingRecoveryFetch({
      fetch: async () => response(401, true),
      getConnection: () => connection,
      onStalePairing: () => {
        cleared++
      },
    })
    await otherOrigin("https://other.example.test/api/project", { headers: { [RELAY_TOKEN_HEADER]: connection.token } })

    expect(cleared).toBe(0)
  })

  test("captures the pairing used by the request", async () => {
    let current: MobilePairingConnection | undefined = connection
    let cleared: MobilePairingConnection | undefined
    const fetch = createPairingRecoveryFetch({
      fetch: async () => {
        current = undefined
        return response(401, true)
      },
      getConnection: () => current,
      onStalePairing: (value) => {
        cleared = value
      },
    })

    await fetch(`${connection.relay}/api/project`, { headers: { [RELAY_TOKEN_HEADER]: connection.token } })

    expect(cleared).toEqual(connection)
  })

  test("does not clear a new pairing for a delayed request made with an old token", async () => {
    const oldConnection = connection
    const newConnection = { ...connection, token: "new_device_token" }
    let active = newConnection
    let cleared = 0
    const fetch = createPairingRecoveryFetch({
      fetch: async () => response(401, true),
      getConnection: () => active,
      onStalePairing: () => {
        cleared++
      },
    })

    await fetch(`${oldConnection.relay}/api/project`, { headers: { [RELAY_TOKEN_HEADER]: oldConnection.token } })

    expect(cleared).toBe(0)
  })
})
