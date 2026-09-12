import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Timestamps } from "../database/schema.sql";

export type WorkflowStepDef = {
  id: string;
  title: string;
  instructions?: string;
};

export const WorkflowInstanceTable = sqliteTable(
  "workflow_instance",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    status: text().notNull(),
    current_step: text(),
    definition: text({ mode: "json" }).notNull().$type<WorkflowStepDef[]>(),
    context: text({ mode: "json" }).notNull().$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [index("workflow_instance_status_idx").on(table.status)],
);

export const WorkflowHistoryTable = sqliteTable(
  "workflow_history",
  {
    id: text().primaryKey(),
    instance_id: text()
      .notNull()
      .references(() => WorkflowInstanceTable.id, { onDelete: "cascade" }),
    step_id: text().notNull(),
    event: text().notNull(),
    status: text(),
    result: text({ mode: "json" }).$type<unknown>(),
    time_created: integer().notNull().$default(() => Date.now()),
  },
  (table) => [index("workflow_history_instance_idx").on(table.instance_id)],
);
