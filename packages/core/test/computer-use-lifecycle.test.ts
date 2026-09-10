import { expect } from "bun:test"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, LayerMap } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ComputerUse } from "@opencode-ai/core/computer-use"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationError, LocationServices } from "@opencode-ai/core/location-services"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { computerBridge, grantID } from "./lib/computer-use"
import { testEffect } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_computer_lifecycle")
let work: Effect.Effect<void> = Effect.void
const runner = Layer.mock(SessionRunner.Service, { run: () => Effect.suspend(() => work) })
const it = testEffect(
  LayerNode.compile(LayerNode.group([SessionExecutionLocal.node, LayerNodePlatform.httpClient]), [
    [
      SessionStore.node,
      Layer.mock(SessionStore.Service, {
        get: (id) =>
          Effect.succeed(
            SessionSchema.Info.make({
              id,
              projectID: Project.ID.global,
              title: "fixture",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
              location: Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }),
            }),
          ),
      }),
    ],
    [
      LocationServiceMap.node,
      Layer.effect(
        LocationServiceMap.Service,
        LayerMap.make((_ref: Location.Ref) => runner as Layer.Layer<LocationServices, LocationError>),
      ),
    ],
  ]),
)

it.live("ordinary drains without used grants never call the controller", () =>
  Effect.gen(function* () {
    const bridge = yield* computerBridge()
    const execution = yield* SessionExecution.Service
    work = Effect.void
    yield* execution.resume(sessionID)
    expect(bridge.requests).toEqual([])
    expect(yield* execution.active).toEqual(new Set())
  }),
)

it.live("normal drain completion revokes only recorded grants and deduplicates repeated use", () =>
  Effect.gen(function* () {
    const bridge = yield* computerBridge()
    const execution = yield* SessionExecution.Service
    const other = crypto.randomUUID()
    work = Effect.sync(() => {
      ComputerUse.track(sessionID, grantID)
      ComputerUse.track(sessionID, other)
      ComputerUse.track(sessionID, grantID)
    })
    yield* execution.resume(sessionID)
    expect(new Set(bridge.requests.map((request) => request.body.grantID))).toEqual(new Set([grantID, other]))
    expect(bridge.requests.every((request) => request.path === "/stop" && request.body.sessionID === sessionID && request.token === bridge.token)).toBe(true)
    work = Effect.void
    yield* execution.resume(sessionID)
    expect(bridge.requests).toHaveLength(2)
  }),
)

it.live("revokes after a failed drain and preserves the original failure", () =>
  Effect.gen(function* () {
    const bridge = yield* computerBridge()
    const execution = yield* SessionExecution.Service
    const failure = new Error("fixture model failure")
    work = Effect.sync(() => ComputerUse.track(sessionID, grantID)).pipe(Effect.andThen(Effect.die(failure)))
    const exit = yield* execution.resume(sessionID).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(bridge.requests).toEqual([{ path: "/stop", token: bridge.token, body: { sessionID, grantID } }])
  }),
)

it.live("revokes when interrupted between tool calls without changing idle interruption semantics", () =>
  Effect.gen(function* () {
    const bridge = yield* computerBridge()
    const execution = yield* SessionExecution.Service
    const started = yield* Deferred.make<void>()
    work = Effect.sync(() => ComputerUse.track(sessionID, grantID)).pipe(
      Effect.andThen(Deferred.succeed(started, undefined)),
      Effect.andThen(Effect.never),
    )
    const run = yield* execution.resume(sessionID).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* execution.interrupt(sessionID)
    expect(Exit.hasInterrupts(yield* Fiber.await(run))).toBe(true)
    expect(bridge.requests).toEqual([{ path: "/stop", token: bridge.token, body: { sessionID, grantID } }])
    yield* execution.interrupt(sessionID)
    expect(bridge.requests).toHaveLength(1)
  }),
)

it.live("delayed cleanup snapshots grant A before HTTP and cannot consume a later grant B", () =>
  Effect.gen(function* () {
    const bridge = yield* computerBridge()
    const execution = yield* SessionExecution.Service
    const http = yield* HttpClient.HttpClient
    const stopped = Promise.withResolvers<Response>()
    const next = crypto.randomUUID()
    bridge.respond = (request) =>
      request.body.grantID === grantID ? stopped.promise : Response.json({ result: { stopped: true } })
    work = Effect.sync(() => ComputerUse.track(sessionID, grantID))
    const cleanup = yield* execution.resume(sessionID).pipe(Effect.forkChild)
    yield* Effect.promise(() => bridge.stop).pipe(Effect.timeout("3 seconds"))
    yield* ComputerUse.stopSession(http, sessionID)
    expect(bridge.requests).toHaveLength(1)
    ComputerUse.track(sessionID, next)
    stopped.resolve(Response.json({ result: { stopped: true } }))
    yield* Fiber.join(cleanup)
    expect(bridge.requests).toEqual([{ path: "/stop", token: bridge.token, body: { sessionID, grantID } }])
    work = Effect.void
    yield* execution.resume(sessionID)
    expect(bridge.requests.at(-1)?.body).toEqual({ sessionID, grantID: next })
    expect(bridge.requests).toHaveLength(2)
  }),
)
