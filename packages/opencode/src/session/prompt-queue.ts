export * as SessionPromptQueue from "./prompt-queue"

import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { Database } from "@opencode-ai/core/database/database"
import type { EventV2 } from "@opencode-ai/core/event"
import { MessageTable, SessionPromptQueueTable, SessionTable } from "@opencode-ai/core/session/sql"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { and, asc, eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { MessageID, SessionID } from "./schema"
import { PromptInput } from "./prompt-input"

type DatabaseService = Database.Interface["db"]
type Row = typeof SessionPromptQueueTable.$inferSelect

export const Info = Schema.Struct({
  id: MessageID,
  sessionID: SessionID,
  sequence: NonNegativeInt,
  status: Schema.Literal("queued"),
  timeCreated: NonNegativeInt,
  input: PromptInput,
})
export type Info = Schema.Schema.Type<typeof Info>

export class LifecycleConflict extends Schema.TaggedErrorClass<LifecycleConflict>()(
  "SessionPromptQueue.LifecycleConflict",
  { id: MessageID },
) {}

const locks = KeyedMutex.makeUnsafe<SessionID>()
const decode = Schema.decodeUnknownSync(PromptInput)
const encode = Schema.encodeSync(PromptInput)

const fromRow = (row: Row): Info => ({
  id: MessageID.make(row.id),
  sessionID: SessionID.make(row.session_id),
  sequence: row.sequence,
  status: "queued",
  timeCreated: row.time_created,
  input: decode(row.payload),
})

export const list = Effect.fn("SessionPromptQueue.list")(function* (db: DatabaseService, sessionID: SessionID) {
  const rows = yield* db
    .select()
    .from(SessionPromptQueueTable)
    .where(eq(SessionPromptQueueTable.session_id, sessionID))
    .orderBy(asc(SessionPromptQueueTable.sequence))
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRow)
})

export const sessions = Effect.fn("SessionPromptQueue.sessions")(function* (db: DatabaseService, directory: string) {
  const rows = yield* db
    .selectDistinct({ sessionID: SessionPromptQueueTable.session_id })
    .from(SessionPromptQueueTable)
    .innerJoin(SessionTable, eq(SessionTable.id, SessionPromptQueueTable.session_id))
    .where(eq(SessionTable.directory, directory))
    .all()
    .pipe(Effect.orDie)
  return rows.map((row) => SessionID.make(row.sessionID))
})

export const enqueue = Effect.fn("SessionPromptQueue.enqueue")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: PromptInput & { messageID: MessageID },
) {
  return yield* locks.withLock(input.sessionID)(
    Effect.gen(function* () {
      const existing = yield* db
        .select()
        .from(SessionPromptQueueTable)
        .where(eq(SessionPromptQueueTable.id, input.messageID))
        .get()
        .pipe(Effect.orDie)
      if (existing) {
        const stored = fromRow(existing)
        if (
          stored.sessionID !== input.sessionID ||
          JSON.stringify(encode(stored.input)) !== JSON.stringify(encode(input))
        )
          return yield* Effect.die(new LifecycleConflict({ id: input.messageID }))
        return stored
      }

      const timestamp = yield* DateTime.now
      yield* events.publish(SessionEvent.PromptQueueAdded, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        timestamp,
        input: encode(input),
      })
      const stored = yield* db
        .select()
        .from(SessionPromptQueueTable)
        .where(eq(SessionPromptQueueTable.id, input.messageID))
        .get()
        .pipe(Effect.orDie)
      if (!stored) return yield* Effect.die(new LifecycleConflict({ id: input.messageID }))
      return fromRow(stored)
    }),
  )
})

export const cancel = Effect.fn("SessionPromptQueue.cancel")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: { sessionID: SessionID; messageID: MessageID },
) {
  return yield* locks.withLock(input.sessionID)(
    Effect.gen(function* () {
      const existing = yield* db
        .select({ id: SessionPromptQueueTable.id })
        .from(SessionPromptQueueTable)
        .where(
          and(eq(SessionPromptQueueTable.session_id, input.sessionID), eq(SessionPromptQueueTable.id, input.messageID)),
        )
        .get()
        .pipe(Effect.orDie)
      yield* events.publish(SessionEvent.PromptQueueRemoved, {
        ...input,
        timestamp: yield* DateTime.now,
        reason: "cancel",
      })
      return existing !== undefined
    }),
  )
})

export function promote<E, R>(
  db: DatabaseService,
  events: EventV2.Interface,
  input: { sessionID: SessionID; messageID?: MessageID },
  persist: (prompt: PromptInput & { messageID: MessageID }) => Effect.Effect<unknown, E, R>,
): Effect.Effect<boolean, E, R> {
  return locks.withLock(input.sessionID)(
    Effect.gen(function* () {
      const where = input.messageID
        ? and(eq(SessionPromptQueueTable.session_id, input.sessionID), eq(SessionPromptQueueTable.id, input.messageID))
        : eq(SessionPromptQueueTable.session_id, input.sessionID)
      const row = yield* db
        .select()
        .from(SessionPromptQueueTable)
        .where(where)
        .orderBy(asc(SessionPromptQueueTable.sequence))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!row) return false

      const queued = fromRow(row)
      const message = yield* db
        .select({ sessionID: MessageTable.session_id })
        .from(MessageTable)
        .where(eq(MessageTable.id, queued.id))
        .get()
        .pipe(Effect.orDie)
      if (message && message.sessionID !== input.sessionID)
        return yield* Effect.die(new LifecycleConflict({ id: queued.id }))
      if (!message) yield* persist({ ...queued.input, messageID: queued.id })

      yield* events.publish(SessionEvent.PromptQueueRemoved, {
        sessionID: input.sessionID,
        messageID: queued.id,
        timestamp: yield* DateTime.now,
        reason: "promote",
      })
      return true
    }),
  )
}
