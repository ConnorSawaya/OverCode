// Overcode durable workflows: agent-facing tool over the Workflow store.
//
// Long jobs keep going across restarts because every transition is a SQLite
// row, not memory. The store fail-closes (wrong step, empty definition,
// duplicate ids, terminal mutation all error), so the tool surface stays thin.

import { Effect, Schema } from "effect";
import { Workflow } from "../workflow";
import * as Tool from "./tool";
import DESCRIPTION from "./workflow.txt";

const StepDef = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  instructions: Schema.optional(Schema.String),
});

export const Parameters = Schema.Struct({
  action: Schema.Literals(["start", "report", "status", "resume", "list", "cancel"]),
  name: Schema.optional(Schema.String).annotate({ description: "Workflow name (start only)" }),
  steps: Schema.optional(Schema.Array(StepDef)).annotate({ description: "Ordered steps (start only)" }),
  context: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Initial context (start only)",
  }),
  instanceID: Schema.optional(Schema.String).annotate({ description: "Workflow id (report/status/resume/cancel)" }),
  stepID: Schema.optional(Schema.String).annotate({ description: "Current step id (report only)" }),
  status: Schema.optional(Schema.Literals(["completed", "failed"])).annotate({ description: "Step outcome (report only)" }),
  result: Schema.optional(Schema.Unknown).annotate({ description: "Step result for history (report only)" }),
  contextPatch: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Merged into context for later steps (report only)",
  }),
  filter: Schema.optional(Schema.Literals(["running", "completed", "failed", "cancelled"])).annotate({
    description: "Status filter (list only)",
  }),
});

export const WorkflowTool = Tool.define(
  "workflow",
  Effect.gen(function* () {
    const workflows = yield* Workflow.Service;

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "workflow",
            patterns: [],
            always: [],
            metadata: {},
          });
          switch (params.action) {
            case "start": {
              if (!params.name || !params.steps) {
                return { title: "Workflow not started", output: "start needs { name, steps: [{ id, title }] }.", metadata: {} };
              }
              const started = yield* workflows.start({
                name: params.name,
                steps: params.steps,
                context: (params.context as Record<string, unknown> | undefined) ?? {},
              }).pipe(
                Effect.catchTag("Workflow.InvalidError", (error) => Effect.succeed({ invalid: error.message })),
              );
              if ("invalid" in started) return { title: "Workflow not started", output: started.invalid, metadata: {} };
              return {
                title: `Workflow started: ${params.name}`,
                output: [`id: ${started.id}`, "", "current step:", formatStep(started.currentStep)].join("\n"),
                metadata: {},
              };
            }
            case "report": {
              if (!params.instanceID || !params.stepID || !params.status) {
                return { title: "Step not reported", output: "report needs { instanceID, stepID, status }.", metadata: {} };
              }
              const outcome = yield* workflows
                .report({
                  instanceID: params.instanceID,
                  stepID: params.stepID,
                  status: params.status,
                  result: params.result,
                  contextPatch: (params.contextPatch as Record<string, unknown> | undefined) ?? {},
                })
                .pipe(
                  Effect.catchTags({
                    "Workflow.InvalidError": (error) => Effect.succeed({ invalid: error.message }),
                    "Workflow.NotFoundError": (error) => Effect.succeed({ invalid: error.message }),
                  }),
                );
              if ("invalid" in outcome) return { title: "Step not reported", output: outcome.invalid, metadata: {} };
              return {
                title: outcome.currentStep ? `Next step: ${outcome.currentStep.title}` : `Workflow ${outcome.status}`,
                output: [
                  `status: ${outcome.status}`,
                  "",
                  outcome.currentStep ? `current step:\n${formatStep(outcome.currentStep)}` : "no further steps.",
                ].join("\n"),
                metadata: {},
              };
            }
            case "status":
            case "resume": {
              if (!params.instanceID) {
                return { title: "No workflow", output: `${params.action} needs { instanceID }.`, metadata: {} };
              }
              if (params.action === "resume") {
                const resumed = yield* workflows.resume(params.instanceID).pipe(
                  Effect.catchTag("Workflow.NotFoundError", (error) => Effect.succeed({ invalid: error.message })),
                );
                if ("invalid" in resumed) return { title: "No workflow", output: resumed.invalid, metadata: {} };
                return { title: `Workflow: ${resumed.name} (${resumed.status})`, output: formatDetail(resumed), metadata: {} };
              }
              const detail = yield* workflows.get(params.instanceID);
              if (!detail) {
                return { title: "No workflow", output: `Unknown workflow "${params.instanceID}".`, metadata: {} };
              }
              return { title: `Workflow: ${detail.name} (${detail.status})`, output: formatDetail(detail), metadata: {} };
            }
            case "list": {
              const items = yield* workflows.list(params.filter);
              if (items.length === 0) return { title: "Workflows", output: "No workflows yet.", metadata: {} };
              return {
                title: `Workflows (${items.length})`,
                output: items
                  .map((item) => `- ${item.id} [${item.status}] ${item.name}${item.currentStep ? ` → ${item.currentStep.title}` : ""}`)
                  .join("\n"),
                metadata: {},
              };
            }
            case "cancel": {
              if (!params.instanceID) return { title: "Not cancelled", output: "cancel needs { instanceID }.", metadata: {} };
              yield* workflows.cancel(params.instanceID).pipe(
                Effect.catchTag("Workflow.NotFoundError", (error) => Effect.succeed({ invalid: error.message })),
              );
              return { title: "Workflow cancelled", output: `Cancelled ${params.instanceID}.`, metadata: {} };
            }
          }
        }).pipe(Effect.orDie),
    };
  }),
);

function formatStep(step: { id: string; title: string; instructions?: string } | undefined): string {
  if (!step) return "(none)";
  return [`- id: ${step.id}`, `- title: ${step.title}`, ...(step.instructions ? [`- instructions: ${step.instructions}`] : [])].join("\n");
}

function formatDetail(detail: {
  name: string;
  status: string;
  currentStep: { id: string; title: string } | undefined;
  steps: Array<{ id: string; title: string }>;
  context: Record<string, unknown>;
  history: Array<{ stepID: string; event: string; status?: string }>;
}): string {
  return [
    `current: ${detail.currentStep ? `${detail.currentStep.id} — ${detail.currentStep.title}` : "(terminal)"}`,
    `steps: ${detail.steps.map((step) => step.id).join(" → ")}`,
    `context: ${JSON.stringify(detail.context)}`,
    "history:",
    ...detail.history.map((entry) => `- ${entry.event} ${entry.stepID}${entry.status ? ` (${entry.status})` : ""}`),
  ].join("\n");
}
