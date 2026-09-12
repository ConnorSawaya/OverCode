import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { LayerNode } from "@opencode-ai/core/effect/layer-node";
import { SandboxTool, runSandboxed, truncateOutput } from "@/tool/sandbox";
import { Tool } from "@/tool/tool";
import { Agent } from "@/agent/agent";
import { Truncate } from "@/tool/truncate";
import { SessionID, MessageID } from "@/session/schema";
import { testEffect } from "../lib/effect";

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
};

const it = testEffect(LayerNode.compile(LayerNode.group([Agent.node, Truncate.node]), []));

const run = Effect.fn("SandboxToolTest.run")(function* (args: Tool.InferParameters<typeof SandboxTool>) {
  const info = yield* SandboxTool;
  const tool = yield* info.init();
  return yield* tool.execute(args, ctx);
});

describe("tool.sandbox", () => {
  it.instance("runs a command and returns the envelope", () =>
    Effect.gen(function* () {
      const result = yield* run({ command: [process.execPath, "-e", "console.log('hi sandbox')"] });
      expect(result.output).toContain("returncode: 0");
      expect(result.output).toContain("hi sandbox");
    }),
  );

  it.instance("reports non-zero exits with stderr", () =>
    Effect.gen(function* () {
      const result = yield* run({ command: [process.execPath, "-e", "console.error('boom'); process.exit(3)"] });
      expect(result.output).toContain("returncode: 3");
      expect(result.output).toContain("boom");
    }),
  );

  it.instance("writes files into an empty temp workdir", () =>
    Effect.gen(function* () {
      const result = yield* run({
        command: [process.execPath, "-e", "console.log(require('fs').readFileSync('note.txt', 'utf8'))"],
        files: { "note.txt": "sandbox-note" },
      });
      expect(result.output).toContain("sandbox-note");
    }),
  );

  it.instance("refuses path escapes", () =>
    Effect.gen(function* () {
      const direct = yield* Effect.promise(() =>
        runSandboxed({ command: [process.execPath, "-e", "1"], files: { "../evil.txt": "x" } }),
      );
      expect(direct.returncode).toBe(2);
      expect(direct.stderr).toContain("refusing path escape");
    }),
  );

  it.instance("kills on timeout", () =>
    Effect.gen(function* () {
      const direct = yield* Effect.promise(() =>
        runSandboxed({ command: [process.execPath, "-e", "setInterval(() => {}, 100)"], timeoutMs: 500 }),
      );
      expect(direct.timedOut).toBe(true);
    }),
  );

  test("truncates huge output", () => {
    expect(truncateOutput("x".repeat(70 * 1024))).toContain("truncated at 64 KiB");
    expect(truncateOutput("short")).toBe("short");
  });
});
