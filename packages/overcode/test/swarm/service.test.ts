import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { TestInstance } from "../fixture/fixture"
import { ConfigV1 } from "@overcode-ai/core/v1/config/config"
import { ModelV2 } from "@overcode-ai/core/model"
import { ProviderV2 } from "@overcode-ai/core/provider"
import { SessionV1 } from "@overcode-ai/core/v1/session"
import { LayerNode } from "@overcode-ai/core/effect/layer-node"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@overcode-ai/core/cross-spawn-spawner"
import { Database } from "@overcode-ai/core/database/database"
import { Env } from "../../src/env"
import { Format } from "../../src/format"
import { FSUtil } from "@overcode-ai/core/fs-util"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Instruction } from "../../src/session/instruction"
import { LLM } from "../../src/session/llm"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { MessageV2 } from "../../src/session/message-v2"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Question } from "../../src/question"
import { Ripgrep } from "@overcode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionProjector } from "@overcode-ai/core/session/projector"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@overcode-ai/core/shell"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import { SystemPrompt } from "../../src/session/system"
import { SessionSummary } from "../../src/session/summary"
import { Todo } from "../../src/session/todo"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Swarm } from "../../src/swarm/service"
import { SwarmSchema } from "../../src/swarm/schema"
import { parseResult } from "../../src/swarm/service"
import { resolvePreset } from "../../src/swarm/preset"
import { SwarmConfig } from "../../src/swarm/config"
import { TestLLMServer } from "../lib/llm-server"
import { testEffect } from "../lib/effect"
import path from "path"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const makeMcp = () =>
  Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed([]),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in swarm tests"),
      authenticate: () => Effect.die("unexpected MCP auth in swarm tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in swarm tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })
const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const swarmRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  Swarm.node,
])

const makeLayer = () =>
  LayerNode.compile(LayerNode.group([swarmRoot, testLLMServerNode]), [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
  ])

const it = testEffect(makeLayer())

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

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

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(dir, "overcode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const fence = (value: object) => `\`\`\`json swarm-result\n${JSON.stringify(value)}\n\`\`\``

const seedParent = Effect.fn("test.seedParent")(function* (
  permission?: { permission: string; pattern: string; action: "allow" | "deny" }[],
) {
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({
    title: "Swarm parent",
    permission: permission ?? [{ permission: "*", pattern: "*", action: "allow" }],
  })
  const userID = MessageID.ascending()
  yield* sessions.updateMessage({
    id: userID,
    role: "user",
    sessionID: parent.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userID,
    sessionID: parent.id,
    type: "text",
    text: "fix the thing",
  })
  return parent
})

describe("swarm pure units", () => {
  test("parseResult decodes a valid fence", () => {
    const result = parseResult(
      `Some prose\n\n${fence({ summary: "did it", confidence: 0.9, filesTouched: ["a.ts"] })}`,
      "solver-1",
      "solver",
    )
    expect(result.status).toBe("completed")
    expect(result.summary).toBe("did it")
    expect(result.filesTouched).toEqual(["a.ts"])
  })

  test("parseResult fails without a fence", () => {
    const result = parseResult("just prose, no block", "solver-1", "solver")
    expect(result.status).toBe("failed")
    expect(result.summary).toContain("just prose")
  })

  test("parseResult fails on invalid JSON", () => {
    const result = parseResult("```json swarm-result\n{nope\n```", "solver-1", "solver")
    expect(result.status).toBe("failed")
    expect(result.concerns?.join("")).toContain("JSON")
  })

  test("resolvePreset clamps and defaults", () => {
    expect(resolvePreset({}).preset).toBe("balanced")
    expect(resolvePreset({}).workers).toBe(4)
    expect(resolvePreset({ preset: "fast" }).workers).toBe(2)
    expect(resolvePreset({ preset: "max" }).workers).toBe(8)
    expect(resolvePreset({ workers: 99 }).workers).toBe(16)
    expect(resolvePreset({ workers: 0 }).workers).toBe(4)
    expect(resolvePreset({ repairAttempts: 9 }).repairAttempts).toBe(5)
  })

  test("normalizes legacy snake_case config and allows per-run disable", () => {
    const global = SwarmConfig.normalize({
      preset: "deep",
      max_rounds: 1,
      max_model_calls: 3,
      max_tokens: 4000,
      repair_attempts: 0,
      timeout_ms: 20000,
      stop_when_verified: false,
      role_models: { judge: "test/model" },
    })
    expect(global?.preset).toBe("deep")
    expect(global?.maxRounds).toBe(1)
    expect(global?.maxModelCalls).toBe(3)
    expect(global?.roleModels).toEqual({ judge: "test/model" })
    expect(SwarmConfig.resolve({ global, override: { enabled: false } }).enabled).toBe(false)
  })
})

const bodyIncludes = (text: string) => (hit: { body: Record<string, unknown> }) =>
  JSON.stringify(hit.body).includes(text)

const parentTexts = Effect.fn("test.parentTexts")(function* (sessionID: SessionID) {
  const page = yield* MessageV2.page({ sessionID, limit: 100 })
  return page.items.flatMap((msg) => msg.parts).flatMap((part) => (part.type === "text" ? [part.text] : []))
})

describe("swarm service", () => {
  it.instance("create persists a queued record", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const swarm = yield* Swarm.Service
      const parent = yield* sessions.create({ title: "P" })
      const record = yield* swarm.create({ sessionID: parent.id, task: "t", preset: "fast" })
      expect(record.status).toBe("queued")
      expect(record.preset).toBe("fast")
      const loaded = yield* swarm.get(record.id)
      expect(loaded?.id).toBe(record.id)
      expect(yield* swarm.listBySession(parent.id)).toHaveLength(1)
    }),
  )

  it.instance("runs a fast research swarm end-to-end", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* writeConfig(directory, providerCfg(llm.url))
      const swarm = yield* Swarm.Service
      const parent = yield* seedParent()
      // One queued reply per parallel solver (queue entries are single-use).
      yield* llm.textMatch(bodyIncludes("independent Solver"), `Analysis done.\n${fence({ summary: "use approach X", confidence: 0.8 })}`)
      yield* llm.textMatch(bodyIncludes("independent Solver"), `Analysis done.\n${fence({ summary: "use approach X", confidence: 0.8 })}`)
      yield* llm.textMatch(bodyIncludes("You are the Judge"), `Decision made.\n${fence({ summary: "Final answer: do X." })}`)

      const { record } = yield* swarm.runSync({ sessionID: parent.id, task: "research X", preset: "fast", model: ref })

      expect(record.status).toBe("completed")
      expect(record.agents.map((a) => `${a.role}:${a.status}`)).toEqual([
        "solver:completed",
        "solver:completed",
        "judge:completed",
      ])
      expect(record.instrumentation?.modelCalls).toBe(3)
      const texts = yield* parentTexts(parent.id)
      expect(texts.some((text) => text.includes("Swarm completed"))).toBe(true)
      expect(texts.some((text) => text.includes("Final answer: do X."))).toBe(true)
    }),
  )

  it.instance("implements, verifies, and repairs", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* writeConfig(directory, providerCfg(llm.url))
      const sessions = yield* Session.Service
      const swarm = yield* Swarm.Service
      const parent = yield* seedParent([
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "edit", pattern: "secret.txt", action: "deny" },
      ])
      yield* llm.textMatch(bodyIncludes("independent Solver"), `Solved.\n${fence({ summary: "add a note", proposedChanges: [{ path: "notes.txt", description: "append note" }] })}`)
      yield* llm.textMatch(bodyIncludes("independent Solver"), `Solved.\n${fence({ summary: "add a note", proposedChanges: [{ path: "notes.txt", description: "append note" }] })}`)
      yield* llm.textMatch(
        bodyIncludes("You are the Judge"),
        `Apply it.\n${fence({ summary: "Write notes.txt.", proposedChanges: [{ path: "notes.txt", description: "append note" }, { path: "secret.txt", description: "do not touch" }] })}`,
      )
      yield* llm.textMatch(
        bodyIncludes("ONLY agent allowed to edit"),
        `Applied.\n${fence({ summary: "edited notes.txt", filesTouched: ["notes.txt"] })}`,
      )
      yield* llm.textMatch(
        bodyIncludes("Verify the applied solution"),
        `Checked.\n${fence({ summary: "one failure", testsRun: [{ name: "unit", passed: false, output: "FAIL expected X" }] })}`,
      )
      yield* llm.textMatch(
        bodyIncludes("Repair agent"),
        `Fixed.\n${fence({ summary: "fixed the expectation" })}`,
      )
      yield* llm.textMatch(
        bodyIncludes("Re-verify after repair"),
        `Checked again.\n${fence({ summary: "all green", testsRun: [{ name: "unit", passed: true, output: "PASS" }] })}`,
      )

      const { record } = yield* swarm.runSync({ sessionID: parent.id, task: "add a note", preset: "fast", model: ref })

      expect(record.status).toBe("completed")
      expect(record.instrumentation?.repairRounds).toBe(1)
      expect(record.instrumentation?.verified).toBe(true)
      expect(record.instrumentation?.testsPassed).toBe(1)
      const implementer = record.agents.find((a) => a.role === "implementer")
      expect(implementer?.status).toBe("completed")
      const child = yield* sessions.get(implementer!.sessionID)
      const rules = child.permission ?? []
      const allows = (pattern: string) =>
        rules.filter((r) => r.action === "allow" && r.pattern === pattern).map((r) => r.permission)
      // Ownership enforced: notes.txt writable, everything else denied…
      expect(allows("notes.txt")).toEqual(expect.arrayContaining(["edit"]))
      expect(rules.some((r) => r.action === "deny" && r.pattern === "*" && r.permission === "edit")).toBe(true)
      expect(rules.some((r) => r.action === "deny" && r.pattern === "*" && r.permission === "bash")).toBe(true)
      // …but the parent deny on secret.txt still wins over ownership.
      expect(allows("secret.txt")).toEqual([])
      const texts = yield* parentTexts(parent.id)
      expect(texts.some((text) => text.includes("1 files changed") || text.includes("files changed"))).toBe(true)
    }),
  )

  it.instance("survives a solver failure", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* writeConfig(directory, providerCfg(llm.url))
      const swarm = yield* Swarm.Service
      const parent = yield* seedParent()
      yield* llm.textMatch(bodyIncludes("solver 1 of 2"), "I have no idea, sorry.")
      yield* llm.textMatch(bodyIncludes("solver 2 of 2"), `Solved.\n${fence({ summary: "approach Y" })}`)
      yield* llm.textMatch(bodyIncludes("You are the Judge"), `Done.\n${fence({ summary: "Go with Y." })}`)

      const { record } = yield* swarm.runSync({ sessionID: parent.id, task: "research Y", preset: "fast", model: ref })

      expect(record.status).toBe("completed")
      expect(record.agents.find((a) => a.id === "solver-1")?.status).toBe("failed")
      expect(record.agents.find((a) => a.id === "solver-2")?.status).toBe("completed")
    }),
  )

  it.instance("enforces the model-call budget", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* writeConfig(directory, providerCfg(llm.url))
      const swarm = yield* Swarm.Service
      const parent = yield* seedParent()
      yield* llm.textMatch(bodyIncludes("independent Solver"), `Solved.\n${fence({ summary: "x" })}`)

      const exit = yield* swarm.runSync({ sessionID: parent.id, task: "t", preset: "fast", model: ref, config: { maxModelCalls: 1 } }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(Cause.pretty(exit.cause))).toContain("budget")
      }
      expect((yield* swarm.listBySession(parent.id))[0]?.status).toBe("failed")
    }),
  )

  it.instance("direct start persists attachments on the task message", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* writeConfig(directory, providerCfg(llm.url))
      const sessions = yield* Session.Service
      const swarm = yield* Swarm.Service
      const parent = yield* sessions.create({ title: "Attach" })
      const record = yield* swarm.start({
        sessionID: parent.id,
        task: "review the attachment",
        preset: "fast",
        model: ref,
        parts: [
          { type: "text", text: "review the attachment" },
          { type: "file", mime: "text/plain", filename: "notes.txt", url: "file:///tmp/notes.txt" },
        ],
      })
      const page = yield* MessageV2.page({ sessionID: parent.id, limit: 20 })
      const parts = page.items.flatMap((message) => message.parts)
      expect(parts.some((part) => part.type === "text" && part.text === "review the attachment")).toBe(true)
      expect(parts.some((part) => part.type === "file" && part.filename === "notes.txt")).toBe(true)
      yield* swarm.cancel(record.id)
    }),
  )

  it.instance("surfaces attached local files to every worker", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* writeConfig(directory, providerCfg(llm.url))
      const swarm = yield* Swarm.Service
      const parent = yield* seedParent()
      yield* llm.textMatch(bodyIncludes("Files attached to the task"), `Analysis done.\n${fence({ summary: "saw the file" })}`)
      yield* llm.textMatch(bodyIncludes("Files attached to the task"), `Analysis done.\n${fence({ summary: "saw the file" })}`)
      yield* llm.textMatch(bodyIncludes("You are the Judge"), `Decision.\n${fence({ summary: "Final: done." })}`)

      const { record } = yield* swarm.runSync({
        sessionID: parent.id,
        task: "review the attachment",
        preset: "fast",
        model: ref,
        parts: [{ type: "file", mime: "text/plain", filename: "notes.txt", url: "file:///tmp/notes.txt" }],
      })

      expect(record.status).toBe("completed")
      expect(record.agents.filter((agent) => agent.role === "solver").every((agent) => agent.status === "completed")).toBe(true)
    }),
  )

  it.instance("cancel stops a running swarm", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      yield* writeConfig(directory, providerCfg(llm.url))
      const swarm = yield* Swarm.Service
      const parent = yield* seedParent()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      yield* llm.hold(`Working…\n${fence({ summary: "late" })}`, gate)

      const record = yield* swarm.start({ sessionID: parent.id, task: "slow task", preset: "fast", model: ref })
      expect((yield* parentTexts(parent.id)).some((text) => text === "slow task")).toBe(true)
      let running = false
      for (let i = 0; i < 200 && !running; i++) {
        const current = yield* swarm.get(record.id)
        running = (current?.agents ?? []).some((a) => a.status === "running")
        if (!running) yield* Effect.sleep("20 millis")
      }
      expect(running).toBe(true)
      yield* swarm.cancel(record.id)
      release()
      const final = yield* swarm.get(record.id)
      expect(final?.status).toBe("cancelled")
      expect(final?.agents.every((agent) => ["cancelled", "completed", "failed"].includes(agent.status))).toBe(true)
    }),
  )
})
