// MCP server for driving the Overcode test phone (dev tool, never shipped).
//
// Minimal stdio JSON-RPC implementation of MCP (2024-11-05, tools only, no
// external deps) wrapping script/phone-lib.ts, so any MCP-capable agent can
// operate the plugged-in phone through tools instead of raw adb.
//
// Run:  bun run script/mcp.ts   (from packages/mobile)
// Wire into a client as a stdio server with that command + cwd.
//
// Tools: devices, transport, launch, shot, tap, type_text, pair,
//        auto_pair, back, home, stay_on, crashes.

import {
  adb,
  autoPair,
  crashLog,
  enterPairingCode,
  shot,
  toDevice,
  transportStatus,
} from "./phone-lib";

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: Record<string, unknown> };

const TOOLS = [
  {
    name: "devices",
    description: "List attached Android devices (adb devices -l).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "transport",
    description: "Diagnose how this PC can reach the phone (USB vs WiFi, client isolation).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "launch",
    description: "Open the Overcode Mobile app on the phone.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "shot",
    description: "Screenshot the phone, pull + shrink it, return the local png path. Read it to see the screen.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Label for the file" } },
      additionalProperties: false,
    },
  },
  {
    name: "tap",
    description: "Tap the screen. Coordinates are 450-wide preview pixels — copy them from a screenshot this tool saved.",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    description: "Type text into the currently focused field on the phone.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "pair",
    description: "Enter a 6-digit pairing code on the phone pairing screen (verifies the field, taps the real Connect button), then screenshot.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "6-digit pairing code" } },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "auto_pair",
    description: "One-command pairing: mint a relay code, enter it on the phone, wait for the relay to confirm device.paired. Fails loudly on timeout.",
    inputSchema: {
      type: "object",
      properties: {
        relay: { type: "string", description: "Relay base URL (default production)" },
        timeout_ms: { type: "number", description: "Per-step timeout (default 45000)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "back",
    description: "Press the Android back button.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "home",
    description: "Press the Android home button.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "stay_on",
    description: "Keep the phone screen on while plugged in (on) or restore default (off).",
    inputSchema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
      additionalProperties: false,
    },
  },
  {
    name: "crashes",
    description: "Recent native/JS crashes for the app from logcat.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "devices":
      return textResult(await adb("devices", "-l"));
    case "transport":
      return textResult(await transportStatus());
    case "launch":
      await adb("shell", "monkey", "-p", "ai.overcode.mobile", "-c", "android.intent.category.LAUNCHER", "1");
      return textResult("launched");
    case "shot": {
      const path = await shot(typeof args.name === "string" && args.name ? args.name : undefined);
      return textResult(path);
    }
    case "tap": {
      if (typeof args.x !== "number" || typeof args.y !== "number") throw new Error("tap needs numeric x and y");
      const [dx, dy] = await toDevice(args.x, args.y);
      await adb("shell", "input", "tap", String(dx), String(dy));
      return textResult(`tapped device (${dx}, ${dy})`);
    }
    case "type_text": {
      if (typeof args.text !== "string" || !args.text) throw new Error("type_text needs text");
      await adb("shell", "input", "text", args.text.replaceAll(" ", "%s"));
      return textResult(`typed ${args.text.length} chars`);
    }
    case "pair": {
      const code = String(args.code ?? "").replace(/\D/g, "").slice(0, 6);
      if (code.length !== 6) throw new Error("pair needs a 6-digit code");
      await enterPairingCode(code);
      return textResult(await shot("pair-result"));
    }
    case "auto_pair": {
      const relay = typeof args.relay === "string" ? args.relay : undefined;
      const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 45000;
      await autoPair(relay, timeoutMs);
      return textResult("paired (see server log for PAIRED confirmation)");
    }
    case "back":
      await adb("shell", "input", "keyevent", "KEYCODE_BACK");
      return textResult("back pressed");
    case "home":
      await adb("shell", "input", "keyevent", "KEYCODE_HOME");
      return textResult("home pressed");
    case "stay_on": {
      await adb("shell", "svc", "power", "stayon", args.enabled === false ? "false" : "true");
      return textResult(await adb("shell", "settings", "get", "global", "stay_on_while_plugged_in"));
    }
    case "crashes":
      return textResult(await crashLog());
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function respond(id: JsonRpcId, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id: JsonRpcId, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function handle(request: JsonRpcRequest): Promise<void> {
  const id = request.id ?? null;
  try {
    switch (request.method) {
      case "initialize":
        respond(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "overcode-phone", version: "1.0.0" },
        });
        break;
      case "notifications/initialized":
      case "notifications/cancelled":
        break; // no reply for notifications
      case "ping":
        respond(id, {});
        break;
      case "tools/list":
        respond(id, { tools: TOOLS });
        break;
      case "tools/call": {
        const params = request.params ?? {};
        try {
          respond(id, await callTool(String(params.name), (params.arguments as Record<string, unknown>) ?? {}));
        } catch (error) {
          respond(id, errorResult(error instanceof Error ? error.message : String(error)));
        }
        break;
      }
      default:
        respondError(id, -32601, `method not found: ${request.method}`);
    }
  } catch (error) {
    respondError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line) as JsonRpcRequest);
    } catch {
      // Ignore malformed input lines; keep serving.
    }
  }
});
