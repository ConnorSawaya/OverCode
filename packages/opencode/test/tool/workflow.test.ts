import { afterEach, describe, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { LayerNode } from "@opencode-ai/core/effect/layer-node";
import { WorkflowTool } from "@/tool/workflow";
import { Workflow } from "@/workflow";
import { Tool } from "@/tool/tool";
import { Truncate } from "@/tool/truncate";
import { Agent } from "@/agent/agent";
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

const it = testEffect(
  LayerNode.compile(LayerNode.group([Workflow.node, Truncate.node, Agent.node]), [
    [
      Workflow.node,
      Layer.mock(Workflow.Service, {
        start: () => Effect.succeed({ id: "wfl_test", currentStep: { id: "plan", title: "Plan" } }),
        report: () => Effect.succeed({ status: "running" as const, currentStep: { id: "build", title: "Build" } }),
        get: () =>
          Effect.succeed({
            id: "wfl_test",
            name: "job",
            status: "running" as const,
            currentStep: { id: "plan", title: "Plan" },
            updatedAt: 0,
            steps: [{ id: "plan", title: "Plan" }],
            context: {},
            history: [{ stepID: "plan", event: "started", time: 0 }],
          }),
        list: () => Effect.succeed([{ id: "wfl_test", name: "job", status: "running" as const, currentStep: undefined, updatedAt: 0 }]),
        cancel: () => Effect.void,
        resume: () =>
          Effect.succeed({
            id: "wfl_test",
            name: "job",
            status: "running" as const,
            currentStep: { id: "plan", title: "Plan" },
            updatedAt: 0,
            steps: [{ id: "plan", title: "Plan" }],
            context: {},
            history: [],
          }),
      }),
    ],
  ]),
);

afterEach(async () => {
  asked.length = 0;
  await disposeAllInstances();
});

const run = Effect.fn("WorkflowToolTest.run")(function* (args: Tool.InferParameters<typeof WorkflowTool>) {
  const info = yield* WorkflowTool;
  const tool = yield* info.init();
  return yield* tool.execute(args, ctx);
});

describe("tool.workflow", () => {
  it.instance("starts and shows the first step", () =>
    Effect.gen(function* () {
      const result = yield* run({ action: "start", name: "job", steps: [{ id: "plan", title: "Plan" }] });
      expect(result.output).toContain("wfl_test");
      expect(result.output).toContain("plan");
      expect(asked).toContain("workflow");
    }),
  );

  it.instance("reports and shows the next step", () =>
    Effect.gen(function* () {
      const result = yield* run({ action: "report", instanceID: "wfl_test", stepID: "plan", status: "completed" });
      expect(result.output).toContain("Build");
    }),
  );

  it.instance("shows status", () =>
    Effect.gen(function* () {
      const result = yield* run({ action: "status", instanceID: "wfl_test" });
      expect(result.output).toContain("plan");
    }),
  );

  it.instance("lists and cancels", () =>
    Effect.gen(function* () {
      const listed = yield* run({ action: "list" });
      expect(listed.output).toContain("wfl_test");
      const cancelled = yield* run({ action: "cancel", instanceID: "wfl_test" });
      expect(cancelled.output).toContain("Cancelled");
    }),
  );

  it.instance("asks for missing arguments instead of failing", () =>
    Effect.gen(function* () {
      const result = yield* run({ action: "start" });
      expect(result.output).toContain("needs { name, steps");
    }),
  );
});
