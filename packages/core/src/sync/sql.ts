import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core"

/** One stable identity per local Overcode installation. */
export const SyncStateTable = sqliteTable("sync_state", {
  id: text().primaryKey(),
  device_id: text().notNull(),
  time_created: integer().notNull(),
  time_updated: integer().notNull(),
})

/**
 * Append-only account sync journal.  This is intentionally separate from the
 * session event table: session deletion removes its local projection/history,
 * while this journal retains the delete event as a tombstone until peers have
 * received it.  `revision` is the local monotonic cursor used for deltas.
 */
export const SyncChangeTable = sqliteTable(
  "sync_change",
  {
    revision: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
    id: text().notNull(),
    aggregate_id: text().notNull(),
    seq: integer().notNull(),
    type: text().notNull(),
    data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    source_device: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("sync_change_id_idx").on(table.id),
    index("sync_change_revision_idx").on(table.revision),
    index("sync_change_aggregate_idx").on(table.aggregate_id, table.seq),
  ],
)

/**
 * Latest portable profile snapshot received from each trusted installation.
 * Keeping one row per origin lets the desktop merge profiles deterministically
 * without overwriting a local change just because a peer was briefly offline.
 */
export const SyncProfileTable = sqliteTable(
  "sync_profile",
  {
    device_id: text().primaryKey(),
    updated_at: integer().notNull(),
    data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [index("sync_profile_updated_idx").on(table.updated_at)],
)

/**
 * Machine-local filesystem mapping for a portable project identity. The
 * source path is informational only; local_worktree is the path used by the
 * local project projection and may be null until the user maps a folder.
 */
export const SyncProjectMappingTable = sqliteTable("sync_project_mapping", {
  project_id: text().primaryKey(),
  source_worktree: text().notNull(),
  local_worktree: text(),
  time_updated: integer().notNull(),
})

export type SyncChange = typeof SyncChangeTable.$inferSelect
export type SyncProfile = typeof SyncProfileTable.$inferSelect
export type SyncProjectMapping = typeof SyncProjectMappingTable.$inferSelect
