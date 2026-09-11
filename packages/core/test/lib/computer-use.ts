import { Effect } from "effect"
import { ComputerUse } from "@opencode-ai/core/computer-use"

export const frame = { id: "frame-local-1", data: "/9j/2Q==", mime: "image/jpeg" as const, width: 1600, height: 900 }
export const grantID = crypto.randomUUID()

type Request = { path: string; token: string | null; body: Record<string, unknown> }

export const computerBridge = () =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const env = {
        OVERCODE_COMPUTER_USE_URL: process.env.OVERCODE_COMPUTER_USE_URL,
        OVERCODE_COMPUTER_USE_TOKEN: process.env.OVERCODE_COMPUTER_USE_TOKEN,
      }
      const action = Promise.withResolvers<void>()
      const stop = Promise.withResolvers<void>()
      const disconnected = Promise.withResolvers<void>()
      const shutdown = Promise.withResolvers<Response>()
      const state = {
        token: crypto.randomUUID(),
        requests: [] as Request[],
        action: action.promise,
        stop: stop.promise,
        disconnected: disconnected.promise,
        respond: (request: Request): Response | Promise<Response> =>
          Response.json({
            result:
              request.path === "/stop" || request.body.action === "finish"
                ? { stopped: true }
                : { ok: true, frame, text: "controller output must not be echoed" },
          }),
      }
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const recorded = {
            path: new URL(request.url).pathname,
            token: request.headers.get("x-overcode-computer-token"),
            body: (await request.json()) as Record<string, unknown>,
          }
          state.requests.push(recorded)
          if (recorded.token !== state.token) return new Response("Unauthorized", { status: 401 })
          if (typeof recorded.body.sessionID !== "string" || typeof recorded.body.grantID !== "string")
            return Response.json({ error: "invalid_grant" }, { status: 400 })
          if (recorded.path === "/action") {
            request.signal.addEventListener("abort", () => disconnected.resolve(), { once: true })
            action.resolve()
          }
          if (recorded.path === "/stop") stop.resolve()
          return Promise.race([state.respond(recorded), shutdown.promise])
        },
      })
      process.env.OVERCODE_COMPUTER_USE_URL = server.url.origin
      process.env.OVERCODE_COMPUTER_USE_TOKEN = state.token
      return {
        ...state,
        get respond() {
          return state.respond
        },
        set respond(value) {
          state.respond = value
        },
        server,
        env,
        shutdown,
      }
    }),
    (fixture) =>
      Effect.promise(async () => {
        for (const request of fixture.requests) {
          if (typeof request.body.sessionID === "string" && typeof request.body.grantID === "string")
            ComputerUse.forget(request.body.sessionID, request.body.grantID)
        }
        for (const [key, value] of Object.entries(fixture.env)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        fixture.shutdown.resolve(new Response(null, { status: 503 }))
        await fixture.server.stop(true)
      }),
  )
