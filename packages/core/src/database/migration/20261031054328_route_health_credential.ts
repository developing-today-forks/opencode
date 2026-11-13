import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261031054328_route_health_credential",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`route_health\` ADD \`credential_id\` text;`)
    })
  },
}

export default migration
