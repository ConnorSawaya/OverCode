import { describe, expect } from "bun:test"
import { ConfigV1 } from "@overcode-ai/core/v1/config/config"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { AppNodeBuilder } from "@overcode-ai/core/effect/app-node-builder"
import { LayerNode } from "@overcode-ai/core/effect/layer-node"
import { FSUtil } from "@overcode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@overcode-ai/core/cross-spawn-spawner"
import { Database } from "@overcode-ai/core/database/database"
import { Session as SessionNs } from "@/session/session"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { httpApiLayer } from "./httpapi-layer"
import path from "path"

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const appLayer = AppNodeBuilder.build(
  LayerNode.group([FSUtil.node, CrossSpawnSpawner.node, InstanceStore.node, Database.node, SessionNs.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

const api = (directory: string) =>
  HttpServer.HttpServer.use((server) =>
    Effect.sync(() => {
      const base = HttpServer.formatAddress(server.address)
      return (pathname: string, init?: RequestInit) =>
        globalThis.fetch(new URL(pathname, base), {
          ...init,
          headers: { "content-type": "application/json", ...(init?.headers ?? {}), "x-overcode-directory": directory },
        })
    }),
  )

const post = (call: (pathname: string, init?: RequestInit) => Promise<Response>, pathname: string, body: unknown) =>
  Effect.promise(async () => {
    const response = await call(pathname, { method: "POST", body: JSON.stringify(body) })
    const text = await response.text()
    return { status: response.status, json: text ? (JSON.parse(text) as unknown) : undefined }
  })

const get = (call: (pathname: string, init?: RequestInit) => Promise<Response>, pathname: string) =>
  Effect.promise(async () => {
    const response = await call(pathname)
    const text = await response.text()
    return { status: response.status, json: text ? (JSON.parse(text) as unknown) : undefined }
  })

const providerCfg = (url: string): Partial<ConfigV1.Info> => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const fence = (value: object) => `\`\`\`json swarm-result\n${JSON.stringify(value)}\n\`\`\``
const bodyIncludes = (text: string) => (hit: { body: Record<string, unknown> }) =>
  JSON.stringify(hit.body).includes(text)

describe("swarm http api", () => {
  it.instance(
    "start/get/list/agents/cancel lifecycle",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const fs = yield* FSUtil.Service
        yield* fs.writeWithDirs(
          path.join(directory, "overcode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json", ...providerCfg(llm.url) }),
        )
        const call = yield* api(directory)
        const created = yield* post(call, "/session", {})
        expect(created.status).toBe(200)
        const sessionID = (created.json as { id: string }).id

        // Hold solver replies so the engine stays mid-flight deterministically.
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        yield* llm.hold("Working…", gate)

        const started = yield* post(call, "/swarm", {
          sessionID,
          task: "do things",
          preset: "fast",
          model: { providerID: "test", modelID: "test-model" },
        })
        expect(started.status).toBe(200)
        const id = (started.json as { id: string }).id
        expect(typeof id).toBe("string")

        let ready = false
        for (let i = 0; i < 200 && !ready; i++) {
          const fetched = yield* get(call, `/swarm/${id}?sessionID=${sessionID}`)
          const agents = (fetched.json as { status: string; agents: { status: string }[] }).agents ?? []
          ready = agents.length === 2 && agents.some((a) => a.status === "running")
          if (!ready) yield* Effect.sleep("20 millis")
        }
        expect(ready).toBe(true)

        const listed = yield* get(call, `/swarm?sessionID=${sessionID}`)
        expect(listed.status).toBe(200)
        expect((listed.json as unknown[]).length).toBe(1)

        const agents = yield* get(call, `/swarm/${id}/agents?sessionID=${sessionID}`)
        expect(agents.status).toBe(200)
        expect((agents.json as unknown[]).length).toBe(2)

        const cancelled = yield* post(call, `/swarm/${id}/cancel?sessionID=${sessionID}`, {})
        expect(cancelled.status).toBe(200)
        expect(cancelled.json).toBe(true)
        release()
        expect(((yield* get(call, `/swarm/${id}?sessionID=${sessionID}`)).json as { status: string }).status).toBe("cancelled")

        const missing = yield* get(call, `/swarm/swm_nope?sessionID=${sessionID}`)
        expect(missing.status).toBe(404)
      }).pipe(Effect.provide(TestLLMServer.layer)),
    { timeout: 60000 },
  )

  it.instance(
    "mode swarm prompt runs the coordinator over http",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const fs = yield* FSUtil.Service
        yield* fs.writeWithDirs(
          path.join(directory, "overcode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json", ...providerCfg(llm.url) }),
        )
        const call = yield* api(directory)
        const created = yield* post(call, "/session", {})
        const sessionID = (created.json as { id: string }).id
        // mode:"swarm" without a preset resolves to balanced: planner + 4 solvers + critic + judge.
        yield* llm.textMatch(bodyIncludes("You are the Planner"), `Plan.\n${fence({ summary: "do X in three steps" })}`)
        for (let i = 0; i < 4; i++) {
          yield* llm.textMatch(
            bodyIncludes("independent Solver"),
            `Analysis done.\n${fence({ summary: "use approach X", confidence: 0.8 })}`,
          )
        }
        yield* llm.textMatch(bodyIncludes("You are the Critic"), `Reviewed.\n${fence({ summary: "looks sound" })}`)
        yield* llm.textMatch(bodyIncludes("You are the Judge"), `Decision made.\n${fence({ summary: "Final answer: do X." })}`)

        const prompted = yield* post(call, `/session/${sessionID}/message`, {
          mode: "swarm",
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "research X" }],
        })
        expect(prompted.status).toBe(200)
        const message = prompted.json as { info: { role: string }; parts: { type: string; text?: string }[] }
        expect(message.info.role).toBe("assistant")
        const text = message.parts.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n")
        expect(text).toContain("Swarm completed")
        expect(text).toContain("Final answer: do X.")

        const listed = yield* get(call, `/swarm?sessionID=${sessionID}`)
        const records = listed.json as { status: string; agents: { role: string; status: string }[] }[]
        expect(records).toHaveLength(1)
        expect(records[0]?.status).toBe("completed")
        expect(records[0]?.agents.map((a) => `${a.role}:${a.status}`)).toEqual([
          "planner:completed",
          "solver:completed",
          "solver:completed",
          "solver:completed",
          "solver:completed",
          "critic:completed",
          "judge:completed",
        ])
      }).pipe(Effect.provide(TestLLMServer.layer)),
    { timeout: 60000 },
  )
})
