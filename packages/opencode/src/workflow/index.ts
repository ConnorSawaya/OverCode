export * as Workflow from ".";

import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { LayerNode } from "@opencode-ai/core/effect/layer-node";
import { Database } from "@opencode-ai/core/database/database";
import { ascending } from "@opencode-ai/schema/identifier";
import { WorkflowHistoryTable, WorkflowInstanceTable, type WorkflowStepDef } from "@opencode-ai/core/workflow/sql";

export type StepDef = WorkflowStepDef;
export type Status = "running" | "completed" | "failed" | "cancelled";
export type StepReportStatus = "completed" | "failed";

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Workflow.NotFoundError", {
  instanceID: Schema.String,
}) {
  override get message() {
    return `Workflow "${this.instanceID}" not found.`;
  }
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("Workflow.InvalidError", {
  message: Schema.String,
}) {}

export type InstanceSummary = {
  id: string;
  name: string;
  status: Status;
  currentStep: StepDef | undefined;
  updatedAt: number;
};

export type InstanceDetail = InstanceSummary & {
  steps: StepDef[];
  context: Record<string, unknown>;
  history: Array<{ stepID: string; event: string; status?: string; result?: unknown; time: number }>;
};

export interface Interface {
  readonly start: (input: {
    name: string;
    steps: ReadonlyArray<StepDef>;
    context?: Record<string, unknown>;
  }) => Effect.Effect<{ id: string; currentStep: StepDef | undefined }, InvalidError>;
  readonly report: (input: {
    instanceID: string;
    stepID: string;
    status: StepReportStatus;
    result?: unknown;
    message?: string;
    contextPatch?: Record<string, unknown>;
  }) => Effect.Effect<{ status: Status; currentStep: StepDef | undefined }, InvalidError | NotFoundError>;
  readonly get: (instanceID: string) => Effect.Effect<InstanceDetail | undefined>;
  readonly list: (status?: Status) => Effect.Effect<InstanceSummary[]>;
  readonly cancel: (instanceID: string) => Effect.Effect<void, NotFoundError>;
  readonly resume: (instanceID: string) => Effect.Effect<InstanceDetail, NotFoundError>;
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Workflow") {}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

function toSummary(row: typeof WorkflowInstanceTable.$inferSelect): InstanceSummary {
  const steps = row.definition as StepDef[];
  return {
    id: row.id,
    name: row.name,
    status: row.status as Status,
    currentStep: steps.find((step) => step.id === row.current_step),
    updatedAt: row.time_updated,
  };
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service;

    const appendHistory = (input: {
      instanceID: string;
      stepID: string;
      event: string;
      status?: string;
      result?: unknown;
    }) =>
      db
        .insert(WorkflowHistoryTable)
        .values({
          id: `wfh_${ascending()}`,
          instance_id: input.instanceID,
          step_id: input.stepID,
          event: input.event,
          status: input.status,
          result: input.result ?? null,
        })
        .run();

    const record = (input: { instanceID: string; stepID: string; event: string; status?: string; result?: unknown }) => ({
      id: `wfh_${ascending()}`,
      instance_id: input.instanceID,
      step_id: input.stepID,
      event: input.event,
      status: input.status,
      result: input.result ?? null,
    });

    const read = Effect.fn("Workflow.read")(function* (instanceID: string) {
      const rows = yield* db.select().from(WorkflowInstanceTable).where(eq(WorkflowInstanceTable.id, instanceID)).all().pipe(Effect.orDie);
      const row = rows[0];
      if (!row) return undefined;
      const history = yield* db
        .select()
        .from(WorkflowHistoryTable)
        .where(eq(WorkflowHistoryTable.instance_id, instanceID))
        .orderBy(asc(WorkflowHistoryTable.time_created))
        .all()
        .pipe(Effect.orDie);
      const summary = toSummary(row);
      return {
        ...summary,
        steps: row.definition as StepDef[],
        context: row.context as Record<string, unknown>,
        history: history.map((entry) => ({
          stepID: entry.step_id,
          event: entry.event,
          status: entry.status ?? undefined,
          result: entry.result ?? undefined,
          time: entry.time_created,
        })),
      } satisfies InstanceDetail;
    });

    const start = Effect.fn("Workflow.start")(function* (input: {
      name: string;
      steps: ReadonlyArray<StepDef>;
      context?: Record<string, unknown>;
    }) {
      const name = input.name.trim();
      if (!name) return yield* new InvalidError({ message: "Workflow name must not be empty." });
      if (input.steps.length === 0) return yield* new InvalidError({ message: "Workflow needs at least one step." });
      const ids = input.steps.map((step) => step.id);
      if (ids.some((id) => !id || typeof id !== "string")) {
        return yield* new InvalidError({ message: "Every step needs a non-empty string id." });
      }
      if (new Set(ids).size !== ids.length) return yield* new InvalidError({ message: "Step ids must be unique." });
      const id = `wfl_${ascending()}`;
      const steps = input.steps.map((step) => ({ id: step.id, title: step.title, ...(step.instructions ? { instructions: step.instructions } : {}) }));
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(WorkflowInstanceTable)
              .values({
                id,
                name,
                status: "running",
                current_step: steps[0]!.id,
                definition: steps,
                context: input.context ?? {},
              })
              .run();
            yield* tx
              .insert(WorkflowHistoryTable)
              .values({ id: `wfh_${ascending()}`, instance_id: id, step_id: steps[0]!.id, event: "started" })
              .run();
          }),
        )
        .pipe(Effect.orDie);
      return { id, currentStep: steps[0] };
    });

    const report = Effect.fn("Workflow.report")(function* (input: {
      instanceID: string;
      stepID: string;
      status: StepReportStatus;
      result?: unknown;
      message?: string;
      contextPatch?: Record<string, unknown>;
    }) {
      const detail = yield* read(input.instanceID);
      if (!detail) return yield* new NotFoundError({ instanceID: input.instanceID });
      if (TERMINAL.has(detail.status)) {
        return yield* new InvalidError({ message: `Workflow is already ${detail.status}; terminal workflows cannot advance.` });
      }
      if (detail.currentStep?.id !== input.stepID) {
        return yield* new InvalidError({
          message: `Step "${input.stepID}" is not current (current: "${detail.currentStep?.id ?? "none"}"). Reports must target the current step.`,
        });
      }
      if (input.status === "failed") {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(WorkflowInstanceTable)
                .set({ status: "failed", current_step: null, context: { ...detail.context, ...(input.contextPatch ?? {}) } })
                .where(eq(WorkflowInstanceTable.id, input.instanceID))
                .run();
              yield* tx.insert(WorkflowHistoryTable).values(
                record({
                  instanceID: input.instanceID,
                  stepID: input.stepID,
                  event: "failed",
                  status: "failed",
                  result: input.result ?? input.message ?? null,
                }),
              ).run();
            }),
          )
          .pipe(Effect.orDie);
        return { status: "failed" as Status, currentStep: undefined };
      }
      const position = detail.steps.findIndex((step) => step.id === input.stepID);
      const next = detail.steps[position + 1];
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (next) {
              yield* tx
                .update(WorkflowInstanceTable)
                .set({ current_step: next.id, context: { ...detail.context, ...(input.contextPatch ?? {}) } })
                .where(eq(WorkflowInstanceTable.id, input.instanceID))
                .run();
            } else {
              yield* tx
                .update(WorkflowInstanceTable)
                .set({ status: "completed", current_step: null, context: { ...detail.context, ...(input.contextPatch ?? {}) } })
                .where(eq(WorkflowInstanceTable.id, input.instanceID))
                .run();
            }
            yield* tx.insert(WorkflowHistoryTable).values(
              record({
                instanceID: input.instanceID,
                stepID: input.stepID,
                event: next ? "advanced" : "completed",
                status: "completed",
                result: input.result ?? input.message ?? null,
              }),
            ).run();
          }),
        )
        .pipe(Effect.orDie);
      return { status: (next ? "running" : "completed") as Status, currentStep: next };
    });

    const get = Effect.fn("Workflow.get")(function* (instanceID: string) {
      return yield* read(instanceID);
    });

    const list = Effect.fn("Workflow.list")(function* (status?: Status) {
      const rows = yield* (status
        ? db.select().from(WorkflowInstanceTable).where(eq(WorkflowInstanceTable.status, status)).all()
        : db.select().from(WorkflowInstanceTable).all()
      ).pipe(Effect.orDie);
      return rows.map(toSummary).sort((a, b) => b.updatedAt - a.updatedAt);
    });

    const cancel = Effect.fn("Workflow.cancel")(function* (instanceID: string) {
      const detail = yield* read(instanceID);
      if (!detail) return yield* new NotFoundError({ instanceID });
      if (TERMINAL.has(detail.status)) return;
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(WorkflowInstanceTable)
              .set({ status: "cancelled", current_step: null })
              .where(eq(WorkflowInstanceTable.id, instanceID))
              .run();
            yield* tx.insert(WorkflowHistoryTable).values(
              record({ instanceID, stepID: detail.currentStep?.id ?? "", event: "cancelled" }),
            ).run();
          }),
        )
        .pipe(Effect.orDie);
    });

    const resume = Effect.fn("Workflow.resume")(function* (instanceID: string) {
      const detail = yield* read(instanceID);
      if (!detail) return yield* new NotFoundError({ instanceID });
      if (!TERMINAL.has(detail.status)) {
        yield* appendHistory({
          instanceID,
          stepID: detail.currentStep?.id ?? "",
          event: "resumed",
        }).pipe(Effect.orDie);
      }
      return (yield* read(instanceID))!;
    });

    return Service.of({ start, report, get, list, cancel, resume });
  }),
);

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] });
