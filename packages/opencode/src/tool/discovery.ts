// Overcode tool discovery: search / categories / describe over every tool
// the agent can actually call (built-in + custom + MCP).
//
// Mirrors the thetoolforthat 4-verb shape (search/list/get/recommend) reduced
// to what an agent loop needs: ranked search returns names only (cheap),
// describe returns the full schema for exactly one tool (expensive, on demand).

import { Effect, Schema } from "effect";
import { MCP } from "../mcp";
import { scoreSkill } from "../skill/activation";
import * as Tool from "./tool";
import DESCRIPTION from "./discovery.txt";

export const Parameters = Schema.Struct({
  action: Schema.Literals(["search", "categories", "describe"]),
  query: Schema.optional(Schema.String).annotate({ description: "Plain-language capability query (search only)" }),
  name: Schema.optional(Schema.String).annotate({ description: "Exact tool name (describe only)" }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Max results for search (default 8, max 25)" }),
});

export type Entry = {
  name: string;
  source: string;
  description: string;
  schema?: unknown;
};

// Built WITHOUT Tool.define on purpose: the registry constructs this tool
// and injects its own bundled list, so discovery must not depend back on the
// registry service (that would be a build-time self-dependency).
export function discoveryDef(listBundled: () => Effect.Effect<Entry[]>): Tool.DefWithoutID<typeof Parameters> {
  const execute = (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service;
      yield* ctx.ask({
        permission: "discover",
        patterns: [],
        always: [],
        metadata: {},
      });

      const bundled = yield* listBundled();
      const mcpTools = yield* mcp.tools();
      const mcpStatus = yield* mcp.status();
      const clients = yield* mcp.clients();
      const serverOf = (client: unknown) =>
        Object.entries(clients).find(([, value]) => value === client)?.[0] ?? "unknown";

      const entries: Entry[] = [
        ...bundled,
        ...Object.entries(mcpTools).map(([name, item]) => ({
          name,
          source: `mcp:${serverOf(item.client)}`,
          description: item.def.description ?? "",
          schema: item.def.inputSchema,
        })),
      ];
      return yield* runAction(params, entries, mcpStatus);
    }).pipe(Effect.orDie);

  return { description: DESCRIPTION, parameters: Parameters, execute: execute as Tool.Def["execute"] };
}

function runAction(
  params: Schema.Schema.Type<typeof Parameters>,
  entries: Entry[],
  mcpStatus: Record<string, unknown>,
): Effect.Effect<Tool.ExecuteResult> {
  return Effect.gen(function* () {
    if (params.action === "categories") {
            const counts = new Map<string, number>();
            for (const entry of entries) counts.set(entry.source, (counts.get(entry.source) ?? 0) + 1);
            const lines = [...counts.entries()]
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([source, count]) => {
                const server = source.startsWith("mcp:") ? source.slice(4) : undefined;
                const health = server ? (mcpStatus[server] as { status?: string } | undefined)?.status : undefined;
                return `- ${source}: ${count} tool${count === 1 ? "" : "s"}${health ? ` (${health})` : ""}`;
              });
            return { title: "Tool categories", output: lines.join("\n") || "No tools available.", metadata: {} };
          }

          if (params.action === "describe") {
            const name = (params.name ?? "").trim();
            const found = entries.find((entry) => entry.name === name);
            if (!found) {
              const names = entries.map((entry) => entry.name).join(", ");
              return { title: "Tool not found", output: `No tool named "${name}". Known tools: ${names || "none"}`, metadata: {} };
            }
            const schemaSummary =
              found.schema && typeof found.schema === "object"
                ? summarizeSchema(found.schema as Record<string, unknown>)
                : "(schema not available)";
            return {
              title: `Tool: ${found.name}`,
              output: [`source: ${found.source}`, "", found.description || "(no description)", "", "arguments:", schemaSummary]
                .join("\n")
                .slice(0, 4000),
              metadata: {},
            };
          }

          const query = (params.query ?? "").trim();
          if (!query) {
            return {
              title: "Tool search",
              output: "Provide a query, e.g. { action: \"search\", query: \"read a web page\" }.",
              metadata: {},
            };
          }
          const limit = Math.min(Math.max(params.limit ?? 8, 1), 25);
          const ranked = entries
            .map((entry, index) => ({ entry, score: scoreSkill(entry, query), index }))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .slice(0, limit);
          if (ranked.length === 0) {
            return {
              title: "Tool search",
              output: `No tools match "${query}". Try "categories" to browse sources, or enable an MCP server.`,
              metadata: {},
            };
          }
          return {
            title: `Tools matching "${query}"`,
            output:
              ranked.map((item) => `- ${item.entry.name} [${item.entry.source}]: ${oneLine(item.entry.description)}`).join("\n") +
              "\n\nUse { action: \"describe\", name } for full arguments of one tool.",
            metadata: {},
          };
  });
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 160) || "(no description)";
}

function summarizeSchema(schema: Record<string, unknown>): string {
  const properties = schema.properties as Record<string, { description?: unknown }> | undefined;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  if (!properties || typeof properties !== "object") return JSON.stringify(schema).slice(0, 1000);
  return Object.entries(properties)
    .map(([name, def]) => `- ${name}${required.has(name) ? " (required)" : ""}: ${typeof def?.description === "string" ? def.description : ""}`.trimEnd())
    .join("\n");
}
