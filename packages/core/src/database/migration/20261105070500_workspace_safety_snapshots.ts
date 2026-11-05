import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261105070500_workspace_safety_snapshots",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `workspace` ADD COLUMN `last_snapshot_at` integer;")
      yield* tx.run("ALTER TABLE `workspace` ADD COLUMN `snapshot_retry_at` integer;")
    })
  },
}

export default migration
