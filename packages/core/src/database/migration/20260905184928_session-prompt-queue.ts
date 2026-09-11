import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260905184928_session-prompt-queue",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_prompt_queue\` (
          \`sequence\` integer PRIMARY KEY AUTOINCREMENT,
          \`id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_prompt_queue_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_prompt_queue_id_idx\` ON \`session_prompt_queue\` (\`id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_prompt_queue_session_sequence_idx\` ON \`session_prompt_queue\` (\`session_id\`,\`sequence\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
