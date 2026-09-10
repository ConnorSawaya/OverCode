import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { ComputerUse } from "@opencode-ai/core/computer-use"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { computerBridge, grantID } from "../../../core/test/lib/computer-use"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(SessionStatus.node))

it.instance("ordinary idle transitions make no HTTP calls; only a session's recorded grants are revoked", () =>
  Effect.gen(function* () {
    const bridge = yield* computerBridge()
    const status = yield* SessionStatus.Service
    const sessionID = SessionID.make("ses_computer_idle")
    const other = SessionID.make("ses_computer_other")
    yield* status.set(sessionID, { type: "busy" })
    expect(bridge.requests).toEqual([])
    yield* status.set(other, { type: "idle" })
    expect(bridge.requests).toEqual([])
    ComputerUse.track(sessionID, grantID)
    ComputerUse.track(sessionID, grantID)
    yield* status.set(other, { type: "idle" })
    expect(bridge.requests).toEqual([])
    expect(yield* status.get(sessionID)).toEqual({ type: "busy" })
    yield* status.set(sessionID, { type: "idle" })
    expect(bridge.requests).toEqual([{ path: "/stop", token: bridge.token, body: { sessionID, grantID } }])
    expect(yield* status.get(sessionID)).toEqual({ type: "idle" })
    yield* status.set(sessionID, { type: "idle" })
    expect(bridge.requests).toHaveLength(1)
  }),
)

it.instance("delayed idle cleanup for grant A cannot revoke or forget newly used grant B", () =>
  Effect.gen(function* () {
    const bridge = yield* computerBridge()
    const status = yield* SessionStatus.Service
    const sessionID = SessionID.make("ses_computer_idle_race")
    const next = crypto.randomUUID()
    const stopped = Promise.withResolvers<Response>()
    bridge.respond = (request) =>
      request.body.grantID === grantID ? stopped.promise : Response.json({ result: { stopped: true } })
    ComputerUse.track(sessionID, grantID)
    const cleanup = yield* status.set(sessionID, { type: "idle" }).pipe(Effect.forkChild)
    yield* Effect.promise(() => bridge.stop).pipe(Effect.timeout("3 seconds"))
    ComputerUse.track(sessionID, next)
    stopped.resolve(Response.json({ result: { stopped: true } }))
    yield* Fiber.join(cleanup)
    expect(bridge.requests).toEqual([{ path: "/stop", token: bridge.token, body: { sessionID, grantID } }])
    yield* status.set(sessionID, { type: "idle" })
    expect(bridge.requests.at(-1)?.body).toEqual({ sessionID, grantID: next })
    expect(bridge.requests).toHaveLength(2)
  }),
)
