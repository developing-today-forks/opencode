import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261030055406_blushing_adam_destine",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`route_attempt\` ADD \`cache_savings_usd\` real;`)
    })
  },
}

export default migration
