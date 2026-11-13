import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261028203055_route_attempt_continuation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`route_attempt\` ADD \`continuation_of\` integer;`)
      yield* tx.run(`ALTER TABLE \`route_attempt\` ADD \`continuation_index\` integer DEFAULT 0;`)
      yield* tx.run(`CREATE INDEX \`route_attempt_continuation_idx\` ON \`route_attempt\` (\`continuation_of\`);`)
    })
  },
}

export default migration
