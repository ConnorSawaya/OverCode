import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ComputerUse } from "@opencode-ai/core/computer-use"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ComputerUseTool } from "@opencode-ai/core/tool/computer-use"
import { BuiltInTools } from "@opencode-ai/core/tool/builtins"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { computerBridge, frame, grantID } from "./lib/computer-use"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionSchema.ID.make("ses_computer_owner")
const assertions: PermissionV2.AssertInput[] = []
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, ComputerUseTool.node, LayerNodePlatform.httpClient]),
    [
      [
        PermissionV2.node,
        Layer.mock(PermissionV2.Service, {
          assert: (input) =>
            Effect.sync(() => {
              assertions.push(input)
            }),
        }),
      ],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)
const call = (input: Record<string, unknown>) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-computer", name: "computer_use", input: { grantID, ...input } },
})

describe("computer_use validation", () => {
  test("validates normalized input, action-specific requirements and bounds", () => {
    const decode = Schema.decodeUnknownSync(ComputerUse.Input)
    for (const input of [
      { action: "screenshot" },
      { action: "finish" },
      { action: "move", frameId: "latest", x: 0, y: 1000 },
      { action: "click", frameId: "latest", x: 500, y: 500, button: "right" },
      { action: "doubleClick", frameId: "latest", x: 500, y: 500, button: "middle" },
      { action: "drag", frameId: "latest", x: 0, y: 1000, endX: 1000, endY: 0 },
      { action: "scroll", frameId: "latest", direction: "left", amount: 10 },
      { action: "type", frameId: "latest", text: "x".repeat(2000) },
      { action: "press", frameId: "latest", key: "Ctrl+A" },
    ] as const)
      expect(decode({ grantID, ...input })).toEqual({ grantID, ...input })
    for (const input of [
      { action: "start" },
      { action: "grant" },
      { action: "click", x: 1, y: 1 },
      { action: "type", text: "hello" },
      { action: "press", key: "Enter" },
      { action: "move", frameId: "latest", x: -1, y: 1 },
      { action: "move", frameId: "latest", x: 1001, y: 1 },
      { action: "move", frameId: "latest", x: 0.5, y: 1 },
      { action: "move", frameId: "latest", x: Infinity, y: 1 },
      { action: "move", frameId: "latest", x: 1 },
      { action: "drag", frameId: "latest", x: 1, y: 1 },
      { action: "drag", frameId: "latest", x: 1, y: 1, endX: 1001, endY: 0 },
      { action: "scroll", frameId: "latest", direction: "diagonal", amount: 1 },
      { action: "scroll", frameId: "latest", direction: "up", amount: 0 },
      { action: "scroll", frameId: "latest", direction: "down", amount: 11 },
      { action: "scroll", frameId: "latest", direction: "right", amount: 1.5 },
      { action: "click", frameId: "latest", x: 1, y: 1, button: "other" },
      { action: "type", frameId: "latest", text: "x".repeat(2001) },
      { action: "press", frameId: "", key: "Enter" },
    ])
      expect(() => decode({ grantID, ...input })).toThrow()
    for (const action of ["screenshot", "finish", "type"])
      for (const invalid of [undefined, null, "", "x".repeat(129), "grant with spaces", "grant/path", "grant\nID"])
        expect(() => decode({ action, grantID: invalid, text: "fixture", frameId: "latest" })).toThrow()
  })

  test("is a built-in leaf", () => {
    expect(BuiltInTools.node.dependencies).toContain(ComputerUseTool.node)
  })
})

describe("computer_use local bridge", () => {
  it.live("registers, returns screenshot media without structured base64, and binds authoritative context", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const registry = yield* ToolRegistry.Service
      assertions.length = 0
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["computer_use"])
      const result = yield* settleTool(
        registry,
        call({ action: "screenshot", sessionID: "ses_attacker", runID: "bad" }),
      )
      expect(result.output?.structured).toEqual({
        action: "screenshot",
        ok: true,
        frameId: frame.id,
        width: frame.width,
        height: frame.height,
      })
      expect(result.output?.content).toEqual([
        { type: "text", text: expect.stringContaining("normalized integers 0..1000") },
        { type: "file", uri: `data:image/jpeg;base64,${frame.data}`, mime: "image/jpeg", name: "computer.jpg" },
      ])
      expect(result.result.type).toBe("content")
      expect(JSON.stringify(result.output?.structured)).not.toContain(frame.data)
      expect(bridge.requests).toEqual([
        { path: "/action", token: bridge.token, body: { action: "screenshot", sessionID, grantID } },
      ])
      expect(assertions).toEqual([
        {
          action: "computer_use",
          resources: ["*"],
          save: ["*"],
          metadata: { action: "screenshot" },
          sessionID,
          agent: toolIdentity.agent,
          source: { type: "tool", messageID: toolIdentity.assistantMessageID, callID: "call-computer" },
        },
      ])
      const http = yield* HttpClient.HttpClient
      yield* ComputerUse.stopSession(http, sessionID)
      expect(bridge.requests.at(-1)?.body).toEqual({ sessionID, grantID })
    }),
  )

  it.live("never captures after input, strips text and unsolicited images, and finishes through /action", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const registry = yield* ToolRegistry.Service
      const text = "private typed text \u2603"
      const result = yield* settleTool(registry, call({ action: "type", frameId: frame.id, text }))
      expect(bridge.requests[0]?.body).toEqual({ sessionID, grantID, action: "type", frameId: frame.id, text })
      expect(result.output?.content).toEqual([{ type: "text", text: '{"action":"type","ok":true}' }])
      expect(JSON.stringify(result)).not.toContain(text)
      expect(JSON.stringify(result)).not.toContain(frame.data)
      assertions.length = 0
      expect(yield* executeTool(registry, call({ action: "finish" }))).toEqual({
        type: "text",
        value: '{"action":"finish","ok":true,"stopped":true}',
      })
      expect(assertions).toEqual([])
      expect(bridge.requests.map((request) => [request.path, request.body.action])).toEqual([
        ["/action", "type"],
        ["/action", "finish"],
      ])
      expect(bridge.requests.at(-1)?.body).toEqual({ sessionID, grantID, action: "finish" })
      const http = yield* HttpClient.HttpClient
      yield* ComputerUse.stopSession(http, sessionID)
      expect(bridge.requests).toHaveLength(2)
    }),
  )

  it.live("fails closed without env or for wrong hosts, paths, schemes and alternate loopback spellings", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const registry = yield* ToolRegistry.Service
      delete process.env.OVERCODE_COMPUTER_USE_TOKEN
      expect(yield* executeTool(registry, call({ action: "screenshot" }))).toMatchObject({
        type: "error",
        value: expect.stringContaining("native consent"),
      })
      process.env.OVERCODE_COMPUTER_USE_TOKEN = bridge.token
      delete process.env.OVERCODE_COMPUTER_USE_URL
      expect(yield* executeTool(registry, call({ action: "screenshot" }))).toMatchObject({ type: "error" })
      for (const url of [
        "http://localhost:1234",
        "https://127.0.0.1",
        "http://example.com",
        "http://127.0.0.2",
        "http://127.1",
        "http://2130706433",
        "http://0x7f000001",
        "http://[::1]",
        "http://user:password@127.0.0.1",
        `${bridge.server.url}action`,
        `${bridge.server.url}?secret=1`,
        `${bridge.server.url}#fragment`,
        " http://127.0.0.1",
        "http://127.0.0.1:99999",
      ]) {
        process.env.OVERCODE_COMPUTER_USE_URL = url
        expect(yield* executeTool(registry, call({ action: "screenshot" }))).toMatchObject({
          type: "error",
          value: expect.stringContaining("controller URL"),
        })
      }
      expect(bridge.requests).toEqual([])
    }),
  )

  it.live("does not follow redirects or expose controller errors, and rejects missing screenshot frames", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const registry = yield* ToolRegistry.Service
      const cases = [
        () => new Response(null, { status: 307, headers: { location: `${bridge.server.url}leak` } }),
        () => Response.json({ error: `consent denied ${bridge.token}` }, { status: 403 }),
        () => Response.json({ result: { ok: false }, error: "native_consent_required" }, { status: 403 }),
        () => Response.json({ error: "stale_frame" }, { status: 403 }),
        () => Response.json({ result: { ok: true } }),
        () => new Response("not json", { status: 500 }),
      ]
      for (const respond of cases) {
        bridge.respond = (request) =>
          request.path === "/stop" ? Response.json({ result: { stopped: true } }) : respond()
        const result = yield* executeTool(registry, call({ action: "screenshot" }))
        expect(result).toMatchObject({ type: "error", value: expect.stringContaining("Computer use unavailable") })
        expect(JSON.stringify(result)).not.toContain(bridge.token)
      }
      expect(bridge.requests.some((request) => request.path === "/leak")).toBe(false)
      expect(bridge.requests.filter((request) => request.path === "/stop")).toHaveLength(cases.length)
    }),
  )

  it.live("rejects invalid input before transport or permission", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const registry = yield* ToolRegistry.Service
      assertions.length = 0
      expect(yield* executeTool(registry, call({ action: "click", x: 500, y: 500 }))).toMatchObject({ type: "error" })
      for (const action of ["screenshot", "finish"])
        expect(yield* executeTool(registry, call({ action, grantID: undefined }))).toMatchObject({ type: "error" })
      expect(bridge.requests).toEqual([])
      expect(assertions).toEqual([])
    }),
  )

  it.live("stale frame, invalid frame/key/chord and busy errors are retryable without revocation", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const registry = yield* ToolRegistry.Service
      const http = yield* HttpClient.HttpClient
      for (const code of [
        "stale_frame",
        "invalid_frameId",
        "invalid_key",
        "invalid_chord",
        "invalid_key_chord",
        "action_in_progress",
      ]) {
        bridge.respond = () => Response.json({ error: code }, { status: 409 })
        expect(yield* executeTool(registry, call({ action: "press", key: "Enter", frameId: frame.id }))).toMatchObject({
          type: "error",
          value: expect.stringContaining("Computer use retryable:"),
        })
      }
      expect(bridge.requests.every((request) => request.path === "/action" && request.body.grantID === grantID)).toBe(
        true,
      )
      bridge.respond = () => Response.json({ result: { frame } })
      expect((yield* executeTool(registry, call({ action: "screenshot" }))).type).toBe("content")
      yield* ComputerUse.stopSession(http, sessionID)
      expect(bridge.requests.filter((request) => request.path === "/stop").map((request) => request.body)).toEqual([
        { sessionID, grantID },
      ])
    }),
  )

  it.live("unreachable native consent fails closed and clears only the attempted grant", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const registry = yield* ToolRegistry.Service
      const http = yield* HttpClient.HttpClient
      yield* Effect.promise(() => bridge.server.stop(true))
      expect(yield* executeTool(registry, call({ action: "screenshot" }))).toMatchObject({
        type: "error",
        value: expect.stringContaining("Explicit native consent"),
      })
      yield* ComputerUse.stopSession(http, sessionID)
      expect(bridge.requests).toEqual([])
    }),
  )

  it.live("a delayed finish for A removes only A and leaves B for its own cleanup", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const registry = yield* ToolRegistry.Service
      const http = yield* HttpClient.HttpClient
      const finished = Promise.withResolvers<Response>()
      const next = crypto.randomUUID()
      bridge.respond = (request) =>
        request.path === "/action" ? finished.promise : Response.json({ result: { stopped: true } })
      const work = yield* executeTool(registry, call({ action: "finish" })).pipe(Effect.forkChild)
      yield* Effect.promise(() => bridge.action)
      ComputerUse.track(sessionID, next)
      finished.resolve(Response.json({ result: { stopped: true } }))
      yield* Fiber.join(work)
      expect(bridge.requests).toEqual([
        { path: "/action", token: bridge.token, body: { sessionID, grantID, action: "finish" } },
      ])
      yield* ComputerUse.stopSession(http, sessionID)
      expect(bridge.requests.at(-1)?.body).toEqual({ sessionID, grantID: next })
    }),
  )

  it.live("interruption disconnects /action and awaits independent /stop before preserving interruption", () =>
    Effect.gen(function* () {
      const bridge = yield* computerBridge()
      const registry = yield* ToolRegistry.Service
      const stopped = Promise.withResolvers<Response>()
      bridge.respond = (request) => (request.path === "/stop" ? stopped.promise : new Promise<Response>(() => {}))
      const work = yield* settleTool(registry, call({ action: "type", frameId: frame.id, text: "fixture" })).pipe(
        Effect.forkChild,
      )
      yield* Effect.promise(() => bridge.action)
      const next = crypto.randomUUID()
      ComputerUse.track(sessionID, next)
      let completed = false
      const interrupt = yield* Fiber.interrupt(work).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            completed = true
          }),
        ),
        Effect.forkChild,
      )
      yield* Effect.promise(() => bridge.stop).pipe(Effect.timeout("3 seconds"))
      expect(completed).toBe(false)
      expect(bridge.requests.at(-1)).toEqual({ path: "/stop", token: bridge.token, body: { sessionID, grantID } })
      stopped.resolve(Response.json({ result: { stopped: true } }))
      yield* Fiber.join(interrupt)
      expect(Exit.hasInterrupts(yield* Fiber.await(work))).toBe(true)
      yield* Effect.promise(() => bridge.disconnected).pipe(Effect.timeout("2 seconds"))
      const http = yield* HttpClient.HttpClient
      yield* ComputerUse.stopSession(http, sessionID)
      expect(bridge.requests.at(-1)?.body).toEqual({ sessionID, grantID: next })
    }),
  )

  it.live(
    "bounds best-effort revocation even when /stop hangs",
    () =>
      Effect.gen(function* () {
        const bridge = yield* computerBridge()
        const registry = yield* ToolRegistry.Service
        bridge.respond = () => new Promise<Response>(() => {})
        const work = yield* settleTool(registry, call({ action: "screenshot" })).pipe(Effect.forkChild)
        yield* Effect.promise(() => bridge.action)
        const start = Date.now()
        yield* Fiber.interrupt(work)
        expect(Date.now() - start).toBeLessThan(2500)
        expect(Exit.hasInterrupts(yield* Fiber.await(work))).toBe(true)
        expect(bridge.requests.at(-1)?.path).toBe("/stop")
      }),
    5000,
  )
})
