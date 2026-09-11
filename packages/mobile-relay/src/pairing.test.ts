import { describe, expect, test } from "bun:test"
import { createPairingUri, formatPairingCode, isPairingCode, isRelayToken, isRelayUrl, parsePairingUri } from "./pairing"

describe("mobile pairing", () => {
  test("round trips a relay channel without exposing extra fields", () => {
    const connection = { relay: "https://relay.example.test/", token: "A_token-with-long-enough-value" }
    const uri = createPairingUri(connection)

    expect(uri).toBe("overcode://mobile?relay=https%3A%2F%2Frelay.example.test%2F&token=A_token-with-long-enough-value")
    expect(parsePairingUri(uri)).toEqual({ relay: "https://relay.example.test", token: connection.token })
  })

  test("rejects malformed or non-relay pairing values", () => {
    expect(parsePairingUri("https://relay.example.test/?token=A_token-with-long-enough-value")).toBeUndefined()
    expect(parsePairingUri("overcode://mobile?relay=file%3A%2F%2F%2Ftmp&token=A_token-with-long-enough-value")).toBeUndefined()
    expect(parsePairingUri("overcode://mobile?relay=https%3A%2F%2Frelay.example.test&token=short")).toBeUndefined()
    expect(isRelayToken("A_token-with-long-enough-value")).toBe(true)
    expect(isRelayToken("token with spaces")).toBe(false)
  })

  test("only permits loopback HTTP relay URLs", () => {
    expect(isRelayUrl("https://relay.example.test")).toBe(true)
    expect(isRelayUrl("http://127.0.0.1:41000")).toBe(true)
    expect(isRelayUrl("http://relay.example.test")).toBe(false)
    expect(parsePairingUri("overcode://mobile?relay=http%3A%2F%2Frelay.example.test&code=482917")).toBeUndefined()
  })

  test("round trips short-lived six-digit codes", () => {
    const uri = createPairingUri({ relay: "https://relay.example.test", code: "482917" })
    expect(uri).toContain("code=482917")
    expect(parsePairingUri(uri)).toEqual({ relay: "https://relay.example.test", code: "482917" })
    expect(isPairingCode("482 917")).toBe(true)
    expect(formatPairingCode("482917")).toBe("482 917")
    expect(isPairingCode("48291")).toBe(false)
  })
})
