import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260909120000_cross-device-sync",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`sync_state\` (
          \`id\` text PRIMARY KEY,
          \`device_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`sync_change\` (
          \`revision\` integer PRIMARY KEY AUTOINCREMENT,
          \`id\` text NOT NULL,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          \`source_device\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`sync_change_id_idx\` ON \`sync_change\` (\`id\`);`)
      yield* tx.run(`CREATE INDEX \`sync_change_revision_idx\` ON \`sync_change\` (\`revision\`);`)
      yield* tx.run(`CREATE INDEX \`sync_change_aggregate_idx\` ON \`sync_change\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`
        CREATE TABLE \`sync_profile\` (
          \`device_id\` text PRIMARY KEY,
          \`updated_at\` integer NOT NULL,
          \`data\` text NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`sync_profile_updated_idx\` ON \`sync_profile\` (\`updated_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
