import { afterEach, describe, expect } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { LayerNode } from "@opencode-ai/core/effect/layer-node";
import { discoveryDef, Parameters } from "@/tool/discovery";
import { Tool } from "@/tool/tool";
import { MCP } from "@/mcp";
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js";
import { SessionID, MessageID } from "@/session/schema";
import { disposeAllInstances } from "../fixture/fixture";
import { testEffect } from "../lib/effect";

const asked: string[] = [];
const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (req) =>
    Effect.sync(() => {
      asked.push(req.permission);
    }),
};

const bundled = [
  { name: "read", source: "builtin", description: "Read file contents from disk" },
  { name: "shell", source: "builtin", description: "Run shell commands" },
];

const weatherClient = {} as MCP.McpTool["client"];

const it = testEffect(
  LayerNode.compile(LayerNode.group([MCP.node]), [
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () =>
          Effect.succeed({
            weather_current: {
              def: {
                name: "current",
                description: "current weather for a city",
                inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
              } as MCPToolDef,
              client: weatherClient,
            },
          }),
        clients: () => Effect.succeed({ weather: weatherClient as never }),
        status: () => Effect.succeed({ weather: { status: "connected" } as never }),
      }),
    ],
  ]),
);

afterEach(async () => {
  asked.length = 0;
  await disposeAllInstances();
});

const def = discoveryDef(() => Effect.succeed(bundled));
const run = (args: Schema.Schema.Type<typeof Parameters>) => def.execute(args, ctx);

describe("tool.discover", () => {
  it.instance("searches MCP tools by plain language", () =>
    Effect.gen(function* () {
      const result = yield* run({ action: "search", query: "weather in a city" });
      expect(result.output).toContain("weather_current");
      expect(result.output).toContain("[mcp:weather]");
      expect(asked).toContain("discover");
    }),
  );

  it.instance("searches bundled tools and points at describe", () =>
    Effect.gen(function* () {
      const result = yield* run({ action: "search", query: "read file contents" });
      expect(result.output).toContain("read");
      expect(result.output).toContain("describe");
    }),
  );

  it.instance("says so when nothing matches", () =>
    Effect.gen(function* () {
      const result = yield* run({ action: "search", query: "teleport quasar banter" });
      expect(result.output).toContain("No tools match");
    }),
  );

  it.instance("lists categories with server health", () =>
    Effect.gen(function* () {
      const result = yield* run({ action: "categories" });
      expect(result.output).toContain("mcp:weather");
      expect(result.output).toContain("connected");
      expect(result.output).toContain("builtin");
    }),
  );

  it.instance("describes one MCP tool with arguments", () =>
    Effect.gen(function* () {
      const result = yield* run({ action: "describe", name: "weather_current" });
      expect(result.output).toContain("current weather for a city");
      expect(result.output).toContain("city");
    }),
  );

  it.instance("names known tools when describe misses", () =>
    Effect.gen(function* () {
      const result = yield* run({ action: "describe", name: "nope_missing" });
      expect(result.output).toContain("No tool named");
      expect(result.output).toContain("weather_current");
    }),
  );
});
