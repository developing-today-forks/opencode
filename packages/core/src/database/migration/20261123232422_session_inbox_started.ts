import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261123232422_session_inbox_started",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_inbox\` ADD \`started\` integer DEFAULT false NOT NULL;`)
    })
  },
}

export default migration
