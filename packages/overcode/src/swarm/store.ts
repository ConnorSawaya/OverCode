export * as SwarmStore from "./store"

import { Database } from "@overcode-ai/core/database/database"
import { SwarmTable } from "@overcode-ai/core/swarm/sql"
import { desc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { SwarmSchema } from "./schema"

// Decode helpers. Store failures surface as defects (DB errors), not domain errors.
const decode = {
  record: (row: typeof SwarmTable.$inferSelect): SwarmSchema.Record => ({
    id: SwarmSchema.ID.make(row.id),
    sessionID: row.session_id as SwarmSchema.Record["sessionID"],
    status: row.status as SwarmSchema.Record["status"],
    preset: row.preset as SwarmSchema.Record["preset"],
    config: (row.config ?? {}) as SwarmSchema.Record["config"],
      agents: (row.agents ?? []) as unknown as SwarmSchema.Record["agents"],
    result: (row.result ?? undefined) as SwarmSchema.Record["result"],
    instrumentation: (row.instrumentation ?? undefined) as SwarmSchema.Record["instrumentation"],
    timeCreated: row.time_created ?? 0,
    timeUpdated: row.time_updated ?? 0,
  }),
}

export const create = Effect.fn("SwarmStore.create")(function* (record: SwarmSchema.Record) {
  const { db } = yield* Database.Service
  const now = Date.now()
  yield* db
    .insert(SwarmTable)
    .values({
      id: record.id,
      session_id: record.sessionID,
      status: record.status,
      preset: record.preset,
      config: record.config as unknown as Record<string, unknown>,
      agents: record.agents as unknown as Record<string, unknown>[],
      result: (record.result ?? null) as unknown as Record<string, unknown>,
      instrumentation: (record.instrumentation ?? null) as unknown as Record<string, unknown>,
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      time_created: now,
      time_updated: now,
    })
    .run()
    .pipe(Effect.orDie)
  return record
})

export const update = Effect.fn("SwarmStore.update")(function* (
  id: SwarmSchema.ID,
  patch: Partial<Pick<SwarmSchema.Record, "status" | "agents" | "result" | "instrumentation" | "config">>,
) {
  const { db } = yield* Database.Service
  yield* db
    .update(SwarmTable)
    .set({
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.agents !== undefined ? { agents: patch.agents as unknown as Record<string, unknown>[] } : {}),
      ...(patch.result !== undefined ? { result: patch.result as unknown as Record<string, unknown> } : {}),
      ...(patch.instrumentation !== undefined
        ? { instrumentation: patch.instrumentation as unknown as Record<string, unknown> }
        : {}),
      ...(patch.config !== undefined ? { config: patch.config as unknown as Record<string, unknown> } : {}),
      time_updated: Date.now(),
    })
    .where(eq(SwarmTable.id, id))
    .run()
    .pipe(Effect.orDie)
})

export const addUsage = Effect.fn("SwarmStore.addUsage")(function* (
  id: SwarmSchema.ID,
  usage: { cost: number; input: number; output: number; reasoning: number },
) {
  const { db } = yield* Database.Service
  const row = yield* db.select().from(SwarmTable).where(eq(SwarmTable.id, id)).get().pipe(Effect.orDie)
  if (!row) return
  yield* db
    .update(SwarmTable)
    .set({
      cost: (row.cost ?? 0) + usage.cost,
      tokens_input: (row.tokens_input ?? 0) + usage.input,
      tokens_output: (row.tokens_output ?? 0) + usage.output,
      tokens_reasoning: (row.tokens_reasoning ?? 0) + usage.reasoning,
      time_updated: Date.now(),
    })
    .where(eq(SwarmTable.id, id))
    .run()
    .pipe(Effect.orDie)
})

export const get = Effect.fn("SwarmStore.get")(function* (id: SwarmSchema.ID) {
  const { db } = yield* Database.Service
  const row = yield* db.select().from(SwarmTable).where(eq(SwarmTable.id, id)).get().pipe(Effect.orDie)
  return row ? decode.record(row) : undefined
})

export const listBySession = Effect.fn("SwarmStore.listBySession")(function* (sessionID: SwarmSchema.Record["sessionID"]) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(SwarmTable)
    .where(eq(SwarmTable.session_id, sessionID))
    .orderBy(desc(SwarmTable.time_created))
    .all()
    .pipe(Effect.orDie)
  return rows.map(decode.record)
})

export const latestBySession = Effect.fn("SwarmStore.latestBySession")(function* (
  sessionID: SwarmSchema.Record["sessionID"],
) {
  const all = yield* listBySession(sessionID)
  return all[0]
})
