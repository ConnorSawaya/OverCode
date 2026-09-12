import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ComputerUse } from "@opencode-ai/core/computer-use"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { ComputerUseTool } from "@/tool/computer-use"
import { BrowserTool } from "@/tool/browser"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { computerBridge, frame, grantID } from "../../../core/test/lib/computer-use"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(FetchHttpClient.layer, Layer.mock(Agent.Service, {}), Layer.mock(Truncate.Service, {})),
)

function context(controller = new AbortController()) {
  const permissions: Array<Parameters<Tool.Context["ask"]>[0]> = []
  const updates: Array<Parameters<Tool.Context["metadata"]>[0]> = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_computer_owner"),
    messageID: MessageID.make("msg_computer_owner"),
    agent: "build",
    abort: controller.signal,
    messages: [],
    ask: (input) =>
      Effect.sync(() => {
        permissions.push(input)
      }),
    metadata: (input) =>
      Effect.sync(() => {
        updates.push(input)
      }),
  }
  return { ctx, permissions, updates }
}

const init = Effect.gen(function* () {
  const tool = yield* ComputerUseTool
  return yield* Tool.init(tool)
})

describe("v1 computer_use", () => {
  it.live("returns a JPEG attachment and compact frame metadata using the authoritative session", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const tool = yield* init
      const test = context()
      expect(tool.id).toBe("computer_use")
      const input = { action: "screenshot" as const, grantID, sessionID: "ses_attacker" }
      const result = yield* tool.execute(input, test.ctx)
      expect(result.attachments).toEqual([
        { type: "file", mime: "image/jpeg", url: `data:image/jpeg;base64,${frame.data}`, filename: "computer.jpg" },
      ])
      expect(result.metadata).toMatchObject({
        computerUse: true,
        action: "screenshot",
        frameId: frame.id,
        width: 1600,
        height: 900,
      })
      expect(result.output).toContain("normalized integers 0..1000")
      expect(result.output).not.toContain(frame.data)
      expect(bridge.requests[0]?.body).toEqual({ action: "screenshot", grantID, sessionID: test.ctx.sessionID })
      expect(test.permissions).toEqual([
        { permission: "computer_use", patterns: ["*"], always: ["*"], metadata: { action: "screenshot" } },
      ])
      const http = yield* HttpClient.HttpClient
      yield* ComputerUse.stopSession(http, test.ctx.sessionID)
      expect(bridge.requests.at(-1)?.body).toEqual({ sessionID: test.ctx.sessionID, grantID })
    }),
  )

  it.live("omits typed text and unsolicited screenshots from output, metadata and title", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const tool = yield* init
      const test = context()
      const text = "typed private text \u2603"
      const result = yield* tool.execute({ action: "type", grantID, frameId: frame.id, text }, test.ctx)
      expect(result.title).toBe("Computer: type")
      expect(result.attachments).toBeUndefined()
      expect(result.output).toBe('{"action":"type","ok":true}')
      expect(JSON.stringify([result, test.updates, test.permissions])).not.toContain(text)
      expect(bridge.requests[0]?.body).toMatchObject({ action: "type", text })
    }),
  )

  it.live("reports native consent unavailable, rejects wrong hosts and keeps browser independent", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const tool = yield* init
      const test = context()
      delete process.env.OVERCODE_COMPUTER_USE_URL
      const missing = yield* tool.execute({ action: "screenshot", grantID }, test.ctx).pipe(Effect.exit)
      expect(Exit.isFailure(missing) && Cause.pretty(missing.cause)).toContain("native consent")
      process.env.OVERCODE_COMPUTER_USE_URL = "http://example.com"
      const invalid = yield* tool.execute({ action: "screenshot", grantID }, test.ctx).pipe(Effect.exit)
      expect(Exit.isFailure(invalid) && Cause.pretty(invalid.cause)).toContain("loopback origin")
      expect(bridge.requests).toEqual([])
      const browser = yield* BrowserTool
      const def = yield* Tool.init(browser)
      expect(def.description).not.toContain('surface="computer"')
      expect(Object.keys(def.parameters.fields)).not.toContain("surface")
      expect(Object.keys(def.parameters.fields)).not.toContain("frameId")
    }),
  )

  it.live("aborts after request disconnect, awaits revocation, and preserves the original abort reason", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const tool = yield* init
      const controller = new AbortController()
      const test = context(controller)
      const stopped = Promise.withResolvers<Response>()
      bridge.respond = (request) => (request.path === "/stop" ? stopped.promise : new Promise<Response>(() => {}))
      let completed = false
      const work = yield* tool.execute({ action: "type", grantID, frameId: frame.id, text: "fixture" }, test.ctx).pipe(
        Effect.exit,
        Effect.tap(() =>
          Effect.sync(() => {
            completed = true
          }),
        ),
        Effect.forkChild,
      )
      yield* Effect.promise(() => bridge.action)
      const next = crypto.randomUUID()
      ComputerUse.track(test.ctx.sessionID, next)
      const reason = new Error("original fixture abort")
      yield* Effect.sync(() => controller.abort(reason))
      yield* Effect.promise(() => bridge.stop).pipe(Effect.timeout("3 seconds"))
      expect(completed).toBe(false)
      expect(bridge.requests.at(-1)).toEqual({
        path: "/stop",
        token: bridge.token,
        body: { sessionID: test.ctx.sessionID, grantID },
      })
      stopped.resolve(Response.json({ result: { stopped: true } }))
      const exit = yield* Fiber.join(work)
      expect(
        Exit.isFailure(exit) && exit.cause.reasons.some((item) => Cause.isDieReason(item) && item.defect === reason),
      ).toBe(true)
      yield* Effect.promise(() => bridge.disconnected).pipe(Effect.timeout("2 seconds"))
      const http = yield* HttpClient.HttpClient
      yield* ComputerUse.stopSession(http, test.ctx.sessionID)
      expect(bridge.requests.at(-1)?.body).toEqual({ sessionID: test.ctx.sessionID, grantID: next })
    }),
  )

  it.live("recoverable errors retain their typed flag and grant without exposing native payloads", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const tool = yield* init
      const test = context()
      for (const code of ["stale_frame", "invalid_frameId", "invalid_key", "invalid_chord", "action_in_progress"]) {
        bridge.respond = () => Response.json({ error: code }, { status: 409 })
        const exit = yield* tool
          .execute({ action: "press", grantID, frameId: frame.id, key: "Enter" }, test.ctx)
          .pipe(Effect.exit)
        expect(
          Exit.isFailure(exit) &&
            exit.cause.reasons.some(
              (reason) =>
                Cause.isDieReason(reason) &&
                reason.defect instanceof ComputerUse.UnavailableError &&
                reason.defect.recoverable === true,
            ),
        ).toBe(true)
        expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("Computer use retryable:")
      }
      expect(bridge.requests.every((request) => request.path === "/action")).toBe(true)
      bridge.respond = () => Response.json({ result: { frame } })
      const result = yield* tool.execute({ action: "screenshot", grantID }, test.ctx)
      expect(result.attachments).toHaveLength(1)
    }),
  )

  it.live("native consent rejection is fatal and stops only the supplied grant", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const tool = yield* init
      const test = context()
      bridge.respond = (request) =>
        request.path === "/stop"
          ? Response.json({ result: { stopped: true } })
          : Response.json({ error: `native_consent_required ${bridge.token}` }, { status: 403 })
      const exit = yield* tool.execute({ action: "screenshot", grantID }, test.ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("Explicit native consent")
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).not.toContain(bridge.token)
      expect(bridge.requests.map((request) => [request.path, request.body.grantID])).toEqual([
        ["/action", grantID],
        ["/stop", grantID],
      ])
    }),
  )

  it.live("an already-aborted call revokes without input, and finish never needs fresh permission", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const tool = yield* init
      const controller = new AbortController()
      controller.abort(new Error("already aborted"))
      const exit = yield* tool.execute({ action: "screenshot", grantID }, context(controller).ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(bridge.requests.map((request) => request.path)).toEqual(["/stop"])
      const test = context()
      const result = yield* tool.execute({ action: "finish", grantID }, test.ctx)
      expect(result.metadata.stopped).toBe(true)
      expect(test.permissions).toEqual([])
      expect(bridge.requests.at(-1)?.body).toEqual({ sessionID: test.ctx.sessionID, grantID, action: "finish" })
      const http = yield* HttpClient.HttpClient
      yield* ComputerUse.stopSession(http, test.ctx.sessionID)
      expect(bridge.requests).toHaveLength(2)
    }),
  )

  it.live("schema rejects unnormalized input before asking permission", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const tool = yield* init
      const test = context()
      for (const input of [
        { action: "move" as const, x: 1001, y: 1, frameId: frame.id },
        { action: "click" as const, x: 1, y: 1 },
      ]) {
        const exit = yield* tool.execute({ grantID, ...input }, test.ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }
      expect(test.permissions).toEqual([])
      expect(bridge.requests).toEqual([])
      expect(ComputerUse.name).toBe(tool.id)
    }),
  )
})
