import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260917223521_exotic_talon",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`swarm\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`preset\` text NOT NULL,
          \`config\` text,
          \`agents\` text DEFAULT '[]' NOT NULL,
          \`result\` text,
          \`instrumentation\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_swarm_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`swarm_session_idx\` ON \`swarm\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
