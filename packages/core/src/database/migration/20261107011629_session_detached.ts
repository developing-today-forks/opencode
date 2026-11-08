import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261107011629_session_detached",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `session_v2` ADD COLUMN `detached` integer;")
    })
  },
}

export default migration
