import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { LayerNode } from "@opencode-ai/core/effect/layer-node";
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder";
import { Workflow } from "@/workflow";
import { disposeAllInstances } from "../fixture/fixture";
import { testEffect } from "../lib/effect";
import { afterEach } from "bun:test";

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Workflow.node]), []));

afterEach(async () => {
  await disposeAllInstances();
});

const STEPS = [
  { id: "plan", title: "Plan the change", instructions: "Write the plan." },
  { id: "build", title: "Build it" },
  { id: "verify", title: "Verify with tests" },
];

describe("workflow.store", () => {
  it.instance("starts with the first step current", () =>
    Effect.gen(function* () {
      const workflows = yield* Workflow.Service;
      const started = yield* workflows.start({ name: "release", steps: STEPS });
      expect(started.id.startsWith("wfl_")).toBe(true);
      expect(started.currentStep?.id).toBe("plan");
    }),
  );

  it.instance("advances through steps and completes", () =>
    Effect.gen(function* () {
      const workflows = yield* Workflow.Service;
      const started = yield* workflows.start({ name: "release", steps: STEPS, context: { repo: "overcode" } });
      const first = yield* workflows.report({ instanceID: started.id, stepID: "plan", status: "completed", result: "planned" });
      expect(first.status).toBe("running");
      expect(first.currentStep?.id).toBe("build");
      const second = yield* workflows.report({
        instanceID: started.id,
        stepID: "build",
        status: "completed",
        contextPatch: { built: true },
      });
      expect(second.currentStep?.id).toBe("verify");
      const done = yield* workflows.report({ instanceID: started.id, stepID: "verify", status: "completed" });
      expect(done.status).toBe("completed");
      expect(done.currentStep).toBeUndefined();
      const detail = yield* workflows.get(started.id);
      expect(detail?.context).toMatchObject({ repo: "overcode", built: true });
      expect(detail?.history.map((entry) => entry.event)).toEqual(["started", "advanced", "advanced", "completed"]);
    }),
  );

  it.instance("fail-closes on wrong step, terminal mutation, and bad definitions", () =>
    Effect.gen(function* () {
      const workflows = yield* Workflow.Service;
      const empty = yield* workflows.start({ name: "x", steps: [] }).pipe(Effect.flip);
      expect(empty).toBeInstanceOf(Workflow.InvalidError);
      const duped = yield* workflows.start({ name: "x", steps: [{ id: "a", title: "A" }, { id: "a", title: "A2" }] }).pipe(Effect.flip);
      expect(duped).toBeInstanceOf(Workflow.InvalidError);

      const started = yield* workflows.start({ name: "job", steps: STEPS });
      const wrong = yield* workflows.report({ instanceID: started.id, stepID: "build", status: "completed" }).pipe(Effect.flip);
      expect(wrong).toBeInstanceOf(Workflow.InvalidError);

      yield* workflows.report({ instanceID: started.id, stepID: "plan", status: "failed", message: "nope" });
      const detail = yield* workflows.get(started.id);
      expect(detail?.status).toBe("failed");
      const late = yield* workflows.report({ instanceID: started.id, stepID: "build", status: "completed" }).pipe(Effect.flip);
      expect(late).toBeInstanceOf(Workflow.InvalidError);
      const missing = yield* workflows.report({ instanceID: "wfl_missing", stepID: "plan", status: "completed" }).pipe(Effect.flip);
      expect(missing).toBeInstanceOf(Workflow.NotFoundError);
    }),
  );

  it.instance("resume logs continuation and returns current state", () =>
    Effect.gen(function* () {
      const workflows = yield* Workflow.Service;
      const started = yield* workflows.start({ name: "job", steps: STEPS });
      const resumed = yield* workflows.resume(started.id);
      expect(resumed.currentStep?.id).toBe("plan");
      expect(resumed.history.map((entry) => entry.event)).toEqual(["started", "resumed"]);
    }),
  );

  it.instance("lists and cancels", () =>
    Effect.gen(function* () {
      const workflows = yield* Workflow.Service;
      const first = yield* workflows.start({ name: "one", steps: STEPS });
      yield* workflows.start({ name: "two", steps: STEPS });
      expect((yield* workflows.list()).length).toBe(2);
      expect((yield* workflows.list("running")).length).toBe(2);
      yield* workflows.cancel(first.id);
      expect((yield* workflows.list("cancelled")).length).toBe(1);
      expect((yield* workflows.list("running")).length).toBe(1);
      const detail = yield* workflows.get(first.id);
      expect(detail?.history.map((entry) => entry.event)).toEqual(["started", "cancelled"]);
    }),
  );

  it.instance("state survives across service reads (restart simulation)", () =>
    Effect.gen(function* () {
      const workflows = yield* Workflow.Service;
      const started = yield* workflows.start({ name: "job", steps: STEPS });
      yield* workflows.report({ instanceID: started.id, stepID: "plan", status: "completed" });
      // Fresh read from the same database, as after a process restart.
      const again = yield* workflows.get(started.id);
      expect(again?.status).toBe("running");
      expect(again?.currentStep?.id).toBe("build");
      expect(again?.history.length).toBe(2);
    }),
  );
});
