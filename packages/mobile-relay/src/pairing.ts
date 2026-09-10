export type MobileConnection = {
  relay: string
  token: string
  deviceId?: string
}

export type MobilePairing = {
  relay: string
  code: string
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,256}$/

export function createPairingUri(input: MobileConnection | MobilePairing) {
  const uri = new URL("overcode://mobile")
  uri.searchParams.set("relay", input.relay)
  if ("code" in input) uri.searchParams.set("code", normalizePairingCode(input.code))
  else uri.searchParams.set("token", input.token)
  return uri.toString()
}

export function parsePairingUri(value: string): MobileConnection | MobilePairing | undefined {
  let uri: URL
  try {
    uri = new URL(value.trim())
  } catch {
    return
  }

  if (uri.protocol !== "overcode:" || uri.hostname !== "mobile") return
  const relay = uri.searchParams.get("relay")
  const token = uri.searchParams.get("token")
  const code = uri.searchParams.get("code")
  if (!relay || (!token && !code) || (token && code)) return
  if (token && !TOKEN_PATTERN.test(token)) return
  if (code && !isPairingCode(code)) return

  let parsedRelay: URL
  try {
    parsedRelay = new URL(relay)
  } catch {
    return
  }
  if (!isRelayUrl(parsedRelay)) return
  parsedRelay.hash = ""
  parsedRelay.search = ""
  const normalizedRelay = parsedRelay.toString().replace(/\/$/, "")
  if (code) return { relay: normalizedRelay, code: normalizePairingCode(code) }
  return { relay: normalizedRelay, token: token! }
}

export function isRelayToken(value: string | null | undefined): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value)
}

/** Relay URLs carry bearer credentials, so HTTP is only safe on loopback. */
export function isRelayUrl(value: string | URL) {
  const url = typeof value === "string" ? safeUrl(value) : value
  if (!url) return false
  if (url.protocol === "https:") return true
  if (url.protocol !== "http:") return false
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]"
}

export function normalizePairingCode(value: string) {
  return value.replace(/\s+/g, "")
}

export function isPairingCode(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{6}$/.test(normalizePairingCode(value))
}

export function formatPairingCode(value: string) {
  const normalized = normalizePairingCode(value)
  return normalized.length === 6 ? `${normalized.slice(0, 3)} ${normalized.slice(3)}` : value
}

function safeUrl(value: string) {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}
