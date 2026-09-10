import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260910144323_sync-project-mapping",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`sync_project_mapping\` (
          \`project_id\` text PRIMARY KEY,
          \`source_worktree\` text NOT NULL,
          \`local_worktree\` text,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
