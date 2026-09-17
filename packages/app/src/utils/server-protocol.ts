import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

export type ServerProtocol = "v1" | "v2"

function headers(server: ServerConnection.HttpBase) {
  const result: Record<string, string> = {}
  if (server.password) {
    result.Authorization = `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`
  }
  if (server.token) result["x-overcode-channel-token"] = server.token
  return Object.keys(result).length > 0 ? result : undefined
}

async function probe(server: ServerConnection.HttpBase, fetch: typeof globalThis.fetch, path: string) {
  const response = await fetch(new URL(path, server.url), {
    headers: headers(server),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return
  const value: unknown = await response.json()
  if (!value || typeof value !== "object") return
  return value
}

export async function detectServerProtocol(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
): Promise<ServerProtocol> {
  const legacy = await probe(server, fetch, "/global/health").catch(() => undefined)
  const current = await probe(server, fetch, "/api/health").catch(() => undefined)

  // Current Overcode servers expose both health endpoints during the V1/V2
  // transition, so health alone cannot identify the API generation. Probe a
  // V2-only route before falling back to the legacy API. Standalone V2
  // servers (CLI `service start` / desktop background CLI) have no `/project`
  // route, so `/api/location` is the primary discriminator.
  if (current && "healthy" in current && current.healthy === true) {
    const location = await probe(server, fetch, "/api/location").catch(() => undefined)
    if (location && typeof location === "object" && "directory" in location && "project" in location) return "v2"
    const project = await probe(server, fetch, "/project").catch(() => undefined)
    if (Array.isArray(project)) return "v2"
  }

  if (legacy && "healthy" in legacy && legacy.healthy === true) return "v1"
  if (current && "healthy" in current && current.healthy === true) return "v1"
  return "v2"
}
