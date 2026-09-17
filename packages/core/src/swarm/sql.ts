import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { SessionTable } from "../session/sql"
import type { SessionSchema } from "../session/schema"

/** Durable swarm record. Agents/results/instrumentation are JSON columns so one row fully describes a run. */
export const SwarmTable = sqliteTable(
  "swarm",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    status: text().notNull(),
    preset: text().notNull(),
    config: text({ mode: "json" }).$type<Record<string, unknown>>(),
    agents: text({ mode: "json" }).$type<Record<string, unknown>[]>().notNull().default([]),
    result: text({ mode: "json" }).$type<Record<string, unknown>>(),
    instrumentation: text({ mode: "json" }).$type<Record<string, unknown>>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [index("swarm_session_idx").on(table.session_id)],
)
