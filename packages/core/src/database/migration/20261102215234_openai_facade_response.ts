import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261102215234_openai_facade_response",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`openai_facade_response\` (
          \`id\` text PRIMARY KEY,
          \`time_created\` integer NOT NULL,
          \`time_expires\` integer NOT NULL,
          \`previous_response_id\` text,
          \`depth\` integer NOT NULL,
          \`model\` text NOT NULL,
          \`resolved_model\` text NOT NULL,
          \`request_items\` text NOT NULL,
          \`response_items\` text NOT NULL,
          \`usage\` text
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`openai_facade_response_expires_idx\` ON \`openai_facade_response\` (\`time_expires\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`openai_facade_response_previous_idx\` ON \`openai_facade_response\` (\`previous_response_id\`);`,
      )
    })
  },
}

export default migration
