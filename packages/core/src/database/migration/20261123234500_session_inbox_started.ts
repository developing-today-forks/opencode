import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261123234500_session_inbox_started",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_inbox\` ADD \`time_started\` integer;`)
    })
  },
}

export default migration
