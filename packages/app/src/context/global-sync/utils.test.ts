import { describe, expect, test } from "bun:test"
import type {
  AgentListOutput,
  ModelDefaultOutput,
  ModelListOutput,
  ProviderListOutput,
} from "@overcode-ai/client/promise"
import {
  directoryKey,
  normalizeAgentList,
  normalizePermissionRequest,
  normalizeProviderList,
  normalizeV2ProviderList,
} from "./utils"

describe("normalizeAgentList", () => {
  test("adapts current agents to the app agent shape", () => {
    const result = normalizeAgentList([
      {
        id: "build",
        name: "Build",
        mode: "primary",
        hidden: false,
        color: "primary",
        model: { id: "gpt-5", providerID: "openai", variant: "high" },
        request: { settings: { temperature: 0.2, topP: 0.9 }, headers: {}, body: {} },
        system: "Build software",
        permissions: [{ action: "read", resource: "*", effect: "allow" }],
      },
    ] as unknown as AgentListOutput["data"])

    expect(result).toEqual([
      {
        name: "build",
        description: undefined,
        mode: "primary",
        hidden: false,
        temperature: 0.2,
        topP: 0.9,
        color: "primary",
        permission: [{ permission: "read", pattern: "*", action: "allow" }],
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "high",
        prompt: "Build software",
        options: { temperature: 0.2, topP: 0.9 },
        steps: undefined,
      },
    ])
  })

  test("tolerates current agents without request settings", () => {
    const result = normalizeAgentList([
      {
        id: "general",
        name: "General",
        mode: "primary",
        hidden: false,
        color: "primary",
        request: { headers: {}, body: {} },
        permissions: [],
      },
    ] as unknown as AgentListOutput["data"])

    expect(result[0]).toMatchObject({ name: "general", temperature: undefined, topP: undefined })
  })

  test("adapts V2 agents without losing the app shape", () => {
    const result = normalizeAgentList([
      {
        id: "build",
        model: { id: "mimo-v2.5-free", providerID: "opencode", variant: "default" },
        request: { headers: {}, body: {} },
        mode: "primary",
        hidden: false,
        permissions: [],
      },
    ])

    expect(result).toEqual([
      {
        name: "build",
        description: undefined,
        mode: "primary",
        hidden: false,
        temperature: undefined,
        topP: undefined,
        color: undefined,
        permission: [],
        model: { providerID: "opencode", modelID: "mimo-v2.5-free" },
        variant: "default",
        prompt: undefined,
        options: {},
        steps: undefined,
      },
    ])
  })
})

describe("normalizePermissionRequest", () => {
  test("adapts the current permission request to app state", () => {
    expect(
      normalizePermissionRequest({
        id: "permission-1",
        sessionID: "session-1",
        action: "read",
        resources: ["README.md"],
        save: ["*.md"],
        metadata: { path: "README.md" },
        source: { type: "tool", messageID: "message-1", callID: "call-1" },
      }),
    ).toEqual({
      id: "permission-1",
      sessionID: "session-1",
      permission: "read",
      patterns: ["README.md"],
      always: ["*.md"],
      metadata: { path: "README.md" },
      tool: { messageID: "message-1", callID: "call-1" },
    })
  })
})

describe("normalizeProviderList", () => {
  test("groups current models into the app provider catalog", () => {
    const result = normalizeProviderList(
      [{ id: "openai", name: "OpenAI", package: "@ai-sdk/openai" }] as ProviderListOutput["data"],
      [
        {
          id: "gpt-5",
          modelID: "gpt-5",
          providerID: "openai",
          name: "GPT-5",
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          variants: [{ id: "high" }],
          time: { released: 1 },
          cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
          status: "active",
          enabled: true,
          limit: { context: 128_000, output: 8_192 },
        },
        {
          id: "gpt-old",
          modelID: "gpt-old",
          providerID: "openai",
          name: "GPT Old",
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "deprecated",
          enabled: true,
          limit: { context: 1, output: 1 },
        },
      ] as ModelListOutput["data"],
      { id: "gpt-5", providerID: "openai" } as ModelDefaultOutput["data"],
    )

    expect(result.connected).toEqual(["openai"])
    expect(result.defaultModel).toEqual({ providerID: "openai", modelID: "gpt-5" })
    expect(result.default).toEqual({ openai: "gpt-5" })
    expect(result.all.get("openai")?.models["gpt-old"]).toBeUndefined()
    expect(result.all.get("openai")?.models["gpt-5"]).toMatchObject({
      id: "gpt-5",
      providerID: "openai",
      capabilities: { toolcall: true, attachment: true },
      cost: { input: 1, output: 2 },
      variants: { high: {} },
    })
  })

  test("preserves an empty current default", () => {
    expect(normalizeProviderList([] as ProviderListOutput["data"], [], null).defaultModel).toBeNull()
  })

  test("adapts the flat V2 catalog without dropping request metadata", () => {
    const result = normalizeV2ProviderList(
      [
        {
          id: "native",
          name: "Native",
          api: { type: "native", url: "https://native.example.test", settings: { mode: "native" } },
          request: { headers: { "x-provider": "native" }, body: { providerOption: true } },
        },
      ] as never,
      [
        {
          id: "model",
          providerID: "native",
          name: "Native Model",
          api: { type: "native", id: "native-model", settings: { modelOption: true } },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          request: { headers: { "x-model": "model" }, body: { modelOption: true }, variant: "high" },
          variants: [{ id: "high", headers: { "x-variant": "high" }, body: { effort: "high" } }],
          time: { released: 0 },
          cost: [
            { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
            { tier: { type: "context", size: 200_000 }, input: 3, output: 4, cache: { read: 0, write: 0 } },
          ],
          status: "active",
          enabled: true,
          limit: { context: 128_000, output: 8_192 },
        },
        {
          id: "old",
          providerID: "native",
          name: "Old",
          api: { type: "native", id: "old" },
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          request: { headers: {}, body: {} },
          variants: [],
          time: { released: 1 },
          cost: [],
          status: "deprecated",
          enabled: true,
          limit: { context: 1, output: 1 },
        },
      ] as never,
      { providerID: "missing", modelID: "missing" },
    )

    const provider = result.all.get("native")!
    const model = provider.models.model
    expect(provider.options).toMatchObject({ mode: "native", providerOption: true, headers: { "x-provider": "native" } })
    expect(model).toMatchObject({
      api: { id: "native-model", npm: "native", url: "" },
      options: { modelOption: true, variant: "high" },
      headers: { "x-model": "model" },
      release_date: "1970-01-01",
      variants: { high: { effort: "high", headers: { "x-variant": "high" } } },
      cost: {
        tiers: [{ tier: { type: "context", size: 200_000 } }],
        experimentalOver200K: { input: 3, output: 4 },
      },
    })
    expect(provider.models.old).toBeUndefined()
    expect(result.defaultModel).toBeNull()
    expect(result.default).toEqual({ native: "model" })
  })
})

describe("directoryKey", () => {
  test("normalizes slashes", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\overcode"))).toBe("C:/Repos/sst/overcode")
    expect(String(directoryKey("C:/Repos/sst/overcode"))).toBe("C:/Repos/sst/overcode")
  })

  test("preserves backslashes in posix paths", () => {
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/sst/overcode/"))).toBe("C:/Repos/sst/overcode")
    expect(String(directoryKey("C:/"))).toBe("C:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})
