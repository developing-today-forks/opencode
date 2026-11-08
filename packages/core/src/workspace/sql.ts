import { Workspace } from "@opencode/schema/workspace"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { WorkspaceDriver } from "./driver.js"

export const WorkspaceTable = sqliteTable("workspace", {
  id: text().$type<Workspace.ID>().primaryKey(),
  provider: text().notNull(),
  binding: text({ mode: "json" }).$type<WorkspaceDriver.Binding>(),
  created_at: integer().notNull(),
  last_used_at: integer().notNull(),
  last_snapshot_at: integer(),
  snapshot_retry_at: integer(),
})
