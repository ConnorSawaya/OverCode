import { RELAY_STALE_DEVICE_HEADER, RELAY_TOKEN_HEADER } from "@overcode-ai/mobile-relay/protocol"

export type MobilePairingConnection = {
  relay: string
  token: string
}

export function createPairingRecoveryFetch(input: {
  fetch: typeof globalThis.fetch
  getConnection: () => MobilePairingConnection | undefined
  onStalePairing: (connection: MobilePairingConnection) => void | Promise<void>
}): typeof globalThis.fetch {
  return async (request, init) => {
    const connection = input.getConnection()
    const requestToken = tokenFromRequest(request, init)
    const response = await input.fetch(request, init)
    if (!connection || (response.status !== 401 && response.status !== 404)) return response
    if (!sameOrigin(requestUrl(request), connection.relay)) return response
    if (requestToken !== connection.token) return response
    if (response.headers.get(RELAY_STALE_DEVICE_HEADER) !== "1") return response
    void Promise.resolve(input.onStalePairing(connection)).catch(() => undefined)
    return response
  }
}

function requestUrl(request: RequestInfo | URL) {
  if (typeof request === "string") return request
  if (request instanceof URL) return request.href
  return request.url
}

function tokenFromRequest(request: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(request instanceof Request ? request.headers : undefined)
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  return headers.get(RELAY_TOKEN_HEADER)
}

function sameOrigin(request: string, relay: string) {
  try {
    return new URL(request).origin === new URL(relay).origin
  } catch {
    return false
  }
}
