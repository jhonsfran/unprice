import { Pool, neonConfig } from "@neondatabase/serverless"
import { FEATURE_SLUGS } from "@unprice/config"
import * as schema from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import { and, eq } from "drizzle-orm"
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless"
import ws from "ws"

// Set the WebSocket proxy to work with the local instance
neonConfig.wsProxy = (host) => `${host}:5433/v1`
// Disable all authentication and encryption
neonConfig.useSecureWebSocket = false
neonConfig.pipelineTLS = false
neonConfig.pipelineConnect = false
neonConfig.webSocketConstructor = ws

async function main() {
  const db = drizzleNeon(
    new Pool({
      connectionString: process.env.DATABASE_URL_MIGRATOR,
    }),
    {
      schema: schema,
    }
  )

  // create user
  const user = await db
    .insert(schema.users)
    .values({
      id: newId("user"),
      email: "seb@unprice.dev",
      name: "sebastian franco",
      emailVerified: new Date(),
      image: "",
      theme: "dark",
      defaultWorkspaceSlug: "unprice",
    })
    .onConflictDoNothing()
    .returning()
    .then((user) => user[0] ?? null)

  if (!user) throw "Error creating user"

  const unpriceWorkspace = await db.query.workspaces.findFirst({
    where: (fields, operators) => operators.eq(fields.slug, "unprice"),
  })

  const workspaceId = unpriceWorkspace?.id ?? newId("workspace")
  let workspace: typeof schema.workspaces.$inferSelect | null = null

  if (!unpriceWorkspace?.id) {
    // create
    workspace = await db
      .insert(schema.workspaces)
      .values({
        id: workspaceId,
        slug: "unprice",
        name: "unprice",
        isPersonal: false,
        imageUrl: "",
        unPriceCustomerId: "",
        plan: "PRO",
        enabled: true,
        isInternal: true,
        isMain: true,
        createdBy: user.id,
      })
      .returning()
      .then((workspace) => workspace[0] ?? null)
  } else {
    // update
    workspace = await db
      .update(schema.workspaces)
      .set({
        plan: "PRO",
        isPersonal: false,
        isInternal: true,
        enabled: true,
        isMain: true,
      })
      .where(eq(schema.workspaces.id, workspaceId))
      .returning()
      .then((workspace) => workspace[0] ?? null)
  }

  if (!workspace) throw "Error creating workspace"

  // add the user as a member of the workspace
  await db
    .insert(schema.members)
    .values({
      userId: user.id,
      workspaceId: workspace.id,
      role: "OWNER",
    })
    .onConflictDoNothing()

  const unpriceProject = await db.query.projects.findFirst({
    where: (fields, operators) => operators.eq(fields.slug, "unprice"),
  })

  // if main project id is set, it must match the unprice project id
  if (process.env.MAIN_PROJECT_ID && unpriceProject?.id !== process.env.MAIN_PROJECT_ID) {
    throw "Main project ID does not match"
  }

  let project: typeof schema.projects.$inferSelect | null = null

  if (!unpriceProject) {
    // create project
    project = await db
      .insert(schema.projects)
      .values({
        id: process.env.MAIN_PROJECT_ID ?? newId("project"),
        name: "unprice",
        slug: "unprice",
        workspaceId: workspaceId,
        url: "https://unprice.dev",
        enabled: true,
        isInternal: true,
        defaultCurrency: "EUR",
        timezone: "UTC",
      })
      .returning()
      .then((project) => project[0] ?? null)
  } else {
    // update
    project = await db
      .update(schema.projects)
      .set({
        enabled: true,
        isInternal: true,
        defaultCurrency: "EUR",
        timezone: "UTC",
      })
      .where(eq(schema.projects.id, unpriceProject.id))
      .returning()
      .then((project) => project[0] ?? null)
  }

  if (!project) throw "Error creating project"

  // get user's email
  let unpriceOwner = await db.query.customers.findFirst({
    where: (fields, operators) =>
      and(
        operators.eq(fields.email, "seb@unprice.dev"),
        operators.eq(fields.projectId, project.id),
        operators.eq(fields.isMain, true)
      ),
  })

  if (!unpriceOwner) {
    unpriceOwner = await db
      .insert(schema.customers)
      .values({
        id: newId("customer"),
        name: "unprice",
        projectId: project.id,
        email: user.email,
        timezone: "UTC",
        defaultCurrency: "EUR",
        isMain: true,
      })
      .returning()
      .then((customer) => customer[0])
  } else {
    // update
    unpriceOwner = await db
      .update(schema.customers)
      .set({
        timezone: "UTC",
        defaultCurrency: "EUR",
        isMain: true,
        email: user.email,
        name: user.name ?? user.email,
      })
      .where(eq(schema.customers.id, unpriceOwner.id))
      .returning()
      .then((customer) => customer[0])
  }

  if (!unpriceOwner) throw "Error creating customer"

  // update workspace with the new customer
  await db
    .update(schema.workspaces)
    .set({ unPriceCustomerId: unpriceOwner.id })
    .where(eq(schema.workspaces.id, workspace.id))

  // create default features
  await db
    .insert(schema.features)
    .values(
      Object.values(FEATURE_SLUGS).map((feature) => ({
        id: newId("feature"),
        slug: feature.SLUG,
        title: feature.TITLE,
        description: feature.DESCRIPTION,
        projectId: project.id,
        unit: feature.UNIT,
      }))
    )
    .onConflictDoNothing()

  process.exit(0)
}

main().catch((e) => {
  console.error("Migration failed")
  console.error(e)
  process.exit(1)
})
