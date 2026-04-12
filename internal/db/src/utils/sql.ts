import { projects } from "../schema/projects"
import { cuid } from "./fields"

// for rest of tables
export const projectID = {
  id: cuid("id").notNull(),
  projectId: cuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
}
