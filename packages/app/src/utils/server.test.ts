import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, serverRequestHeaders } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to opencode", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "opencode", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("opencode:secret"))
  })
})

describe("serverRequestHeaders", () => {
  test("includes relay auth and the encoded directory", () => {
    const headers = serverRequestHeaders(
      { url: "https://relay.example.test", username: "conny", password: "secret", token: "device-token" },
      "C:\\Projects\\Overcode",
    )

    expect(headers.get("authorization")).toBe(`Basic ${btoa("conny:secret")}`)
    expect(headers.get("x-overcode-channel-token")).toBe("device-token")
    expect(headers.get("x-opencode-directory")).toBe("C%3A%5CProjects%5COvercode")
  })
})
