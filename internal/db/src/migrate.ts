import { eq, sql } from "drizzle-orm"
import { createConnection } from "./createConnection"
import * as schema from "./schema"
import { hashStringSHA256, newId } from "./utils"

import { FEATURE_SLUGS } from "@unprice/config"
import { migrate } from "drizzle-orm/neon-serverless/migrator"
import { env } from "../env"

async function main() {
  const start = Date.now()
  console.info("⏳ Running migrations for environment:", env.VERCEL_ENV)

  const db = createConnection({
    env: env.VERCEL_ENV,
    primaryDatabaseUrl: env.DATABASE_URL,
    read1DatabaseUrl: env.DATABASE_READ1_URL,
    read2DatabaseUrl: env.DATABASE_READ2_URL,
    logger: env.DRIZZLE_LOG,
    singleton: false,
  })

  await migrate(db, { migrationsFolder: "src/migrations" })

  let userExists = await db.query.users
    .findFirst({
      where: (fields, operators) => operators.eq(fields.email, "seb@unprice.dev"),
    })
    .then((user) => user ?? null)

  if (!userExists) {
    // create initial user
    const user = await db
      .insert(schema.users)
      .values({
        id: newId("user"),
        email: "seb@unprice.dev",
        name: "sebastian franco",
        emailVerified: new Date(),
        image: "https://avatars.githubusercontent.com/u/28306808?v=4",
        theme: "dark",
        defaultWorkspaceSlug: "unprice-admin",
      })
      .onConflictDoNothing()
      .returning()
      .then((user) => user[0] ?? null)

    userExists = user
  }

  if (!userExists) throw "Error creating user"

  const unpriceWorkspace = await db.query.workspaces.findFirst({
    where: (fields, operators) => operators.eq(fields.slug, "unprice-admin"),
  })

  const workspaceId = unpriceWorkspace?.id ?? newId("workspace")
  let workspace: typeof schema.workspaces.$inferSelect | null = null

  if (!unpriceWorkspace?.id) {
    // create initial workspace
    workspace = await db
      .insert(schema.workspaces)
      .values({
        id: workspaceId,
        slug: "unprice-admin",
        name: "unprice",
        isPersonal: false,
        imageUrl: "https://avatars.githubusercontent.com/u/28306808?v=4",
        unPriceCustomerId: "",
        enabled: true,
        isInternal: true,
        isMain: true,
        createdBy: userExists.id,
        plan: "PRO",
      })
      .returning()
      .then((workspace) => workspace[0] ?? null)
  } else {
    // update initial workspace
    workspace = await db
      .update(schema.workspaces)
      .set({
        imageUrl: "https://avatars.githubusercontent.com/u/28306808?v=4",
        isPersonal: false,
        isInternal: true,
        enabled: true,
        isMain: true,
        plan: "PRO",
      })
      .where(eq(schema.workspaces.id, workspaceId))
      .returning()
      .then((workspace) => workspace[0] ?? null)
  }

  if (!workspace) throw "Error creating workspace"

  const member = await db.query.members.findFirst({
    where: (fields, operators) =>
      operators.and(
        operators.eq(fields.userId, userExists.id),
        operators.eq(fields.workspaceId, workspace.id)
      ),
  })

  if (!member) {
    // add the user as a member of the workspace
    await db
      .insert(schema.members)
      .values({
        userId: userExists.id,
        workspaceId: workspace.id,
        role: "OWNER",
      })
      .onConflictDoNothing()
  }

  const unpriceProject = await db.query.projects.findFirst({
    where: (fields, operators) => operators.eq(fields.slug, "unprice-admin"),
  })

  const unpriceProjectId = unpriceProject?.id ?? newId("project")
  let project: typeof schema.projects.$inferSelect | null = null

  if (!unpriceProject?.id) {
    // create project
    project = await db
      .insert(schema.projects)
      .values({
        id: unpriceProjectId,
        name: "unprice",
        slug: "unprice-admin",
        workspaceId: workspaceId,
        url: "https://unprice.dev",
        enabled: true,
        isInternal: true,
        isMain: true,
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
        isMain: true,
        enabled: true,
        isInternal: true,
        defaultCurrency: "EUR",
        timezone: "UTC",
      })
      .where(eq(schema.projects.id, unpriceProjectId))
      .returning()
      .then((project) => project[0] ?? null)
  }

  if (!project) throw "Error creating project"

  // get user's email
  let unpriceOwner = await db.query.customers.findFirst({
    where: (fields, operators) => operators.eq(fields.email, "seb@unprice.dev"),
  })

  if (!unpriceOwner) {
    // create initial customer for the user, this can be changed later
    unpriceOwner = await db
      .insert(schema.customers)
      .values({
        id: newId("customer"),
        name: "unprice",
        projectId: project.id,
        email: userExists.email,
        // stripe customer test
        stripeCustomerId: "cus_QCzIbAwmpxZeEA",
        timezone: "UTC",
        defaultCurrency: "EUR",
        isMain: true,
      })
      .returning()
      .then((customer) => customer[0])
  }

  if (!unpriceOwner) throw "Error creating customer"

  // update workspace with the new customer
  await db
    .update(schema.workspaces)
    .set({ unPriceCustomerId: unpriceOwner.id })
    .where(eq(schema.workspaces.id, workspace.id))

  // upsert default features configuration
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
    .onConflictDoUpdate({
      target: [schema.features.slug, schema.features.projectId],
      set: {
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        unit: sql`excluded.unit`,
      },
    })

  // create api key for the user
  if (env.UNPRICE_API_KEY) {
    // generate hash of the key
    const apiKeyHash = await hashStringSHA256(env.UNPRICE_API_KEY)
    // find the api key for the project
    const apiKey = await db.query.apikeys.findFirst({
      where: (fields, operators) =>
        operators.and(
          operators.eq(fields.projectId, project.id),
          operators.eq(fields.isRoot, true),
          operators.eq(fields.hash, apiKeyHash)
        ),
    })

    if (!apiKey) {
      // create the api key
      const apiKeyHash = await hashStringSHA256(env.UNPRICE_API_KEY)

      const apiKey = await db
        .insert(schema.apikeys)
        .values({
          id: newId("apikey"),
          name: "unprice",
          hash: apiKeyHash,
          projectId: project.id,
          isRoot: true,
          createdAtM: Date.now(),
        })
        .returning()
        .then((apiKey) => apiKey[0] ?? null)

      if (!apiKey) throw "Error creating api key"
    }
  }

  // print all relevant data and save it to unfisical
  const end = Date.now()

  console.info(`✅ Migrations completed in ${end - start}ms`)
  process.exit(0)
}

main().catch((e) => {
  console.error("Migration failed")
  console.error(e)
  process.exit(1)
})
