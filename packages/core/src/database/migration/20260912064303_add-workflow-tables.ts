import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260912064303_add-workflow-tables",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workflow_history\` (
          \`id\` text PRIMARY KEY,
          \`instance_id\` text NOT NULL,
          \`step_id\` text NOT NULL,
          \`event\` text NOT NULL,
          \`status\` text,
          \`result\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_workflow_history_instance_id_workflow_instance_id_fk\` FOREIGN KEY (\`instance_id\`) REFERENCES \`workflow_instance\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workflow_instance\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`status\` text NOT NULL,
          \`current_step\` text,
          \`definition\` text NOT NULL,
          \`context\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`workflow_history_instance_idx\` ON \`workflow_history\` (\`instance_id\`);`)
      yield* tx.run(`CREATE INDEX \`workflow_instance_status_idx\` ON \`workflow_instance\` (\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
