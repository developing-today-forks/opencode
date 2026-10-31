import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261031233710_route_attempt_credential",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`route_attempt\` ADD \`credential_id\` text;`)
    })
  },
}

export default migration
