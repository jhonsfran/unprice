import { env } from "cloudflare:workers"
import { createRoute } from "@hono/zod-openapi"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["lakehouse"]

const tableSchema = z.enum(["usage", "verification", "metadata", "entitlement_snapshot"])
const intervalSchema = z.enum(["1d", "7d", "30d", "90d"])
const targetEnvSchema = z.enum(["non_prod", "prod"])
type TableName = z.infer<typeof tableSchema>

const TABLE_NAMES: TableName[] = ["usage", "verification", "metadata", "entitlement_snapshot"]

const TABLE_URL_MATCHERS: Array<{ table: TableName; pattern: RegExp }> = [
  { table: "usage", pattern: /(^|[\/._-])usage([\/._-]|$)/i },
  { table: "verification", pattern: /(^|[\/._-])verification(s)?([\/._-]|$)/i },
  { table: "metadata", pattern: /(^|[\/._-])metadata([\/._-]|$)/i },
  {
    table: "entitlement_snapshot",
    pattern: /(^|[\/._-])entitlement[_-]?snapshot(s)?([\/._-]|$)/i,
  },
]

const workerRequestSchema = z.object({
  project_ids: z.array(z.string().min(1)).min(1),
  customer_ids: z.array(z.string().min(1)).optional(),
  tables: z.array(tableSchema).optional(),
  interval: intervalSchema,
  target_env: targetEnvSchema,
})

const workerResponseSchema = z.object({
  project_ids: z.array(z.string()),
  customer_ids: z.array(z.string()).nullable().optional(),
  interval: intervalSchema,
  interval_days: z.number().int(),
  window: z.object({
    start: z.string(),
    end: z.string(),
  }),
  table_files: z.record(z.array(z.string())).default({}),
  urls: z.union([z.array(z.string()), z.record(z.array(z.string()))]),
  errors: z.array(z.object({ table: z.string(), error: z.string() })).default([]),
  credentials: z
    .object({
      bucket: z.string(),
      r2_endpoint: z.string(),
      access_key_id: z.string(),
      secret_access_key: z.string(),
      session_token: z.string(),
      expiration: z.union([z.string(), z.number()]),
      ttl_seconds: z.number().int(),
      prefixes: z.array(z.string()),
    })
    .nullable()
    .optional(),
})

const requestSchema = z.object({
  projectId: z.string().optional(),
  customerId: z.string().optional(),
  tables: z.array(tableSchema).min(1).optional(),
  interval: intervalSchema.default("30d"),
  targetEnv: targetEnvSchema.default("non_prod"),
})

const responseSchema = z.object({
  projectIds: z.array(z.string()),
  customerIds: z.array(z.string()),
  interval: intervalSchema,
  intervalDays: z.number().int(),
  targetEnv: targetEnvSchema,
  window: z.object({
    start: z.string(),
    end: z.string(),
  }),
  tableFiles: z.record(z.array(z.string())),
  urls: z.array(z.string()),
  errors: z.array(z.object({ table: z.string(), error: z.string() })),
  credentials: z
    .object({
      bucket: z.string(),
      r2Endpoint: z.string(),
      accessKeyId: z.string(),
      secretAccessKey: z.string(),
      sessionToken: z.string(),
      expiration: z.union([z.string(), z.number()]),
      ttlSeconds: z.number().int(),
      prefixes: z.array(z.string()),
    })
    .nullable(),
})

export const route = createRoute({
  path: "/v1/lakehouse/file-plan",
  operationId: "lakehouse.getFilePlan",
  hide: env.NODE_ENV === "production",
  summary: "get scoped lakehouse file plan",
  description:
    "Return temporary R2 credentials and matching lakehouse parquet files in one response.",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(requestSchema, "Lakehouse file plan request payload"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(responseSchema, "Lakehouse file plan"),
    ...openApiErrorResponses,
  },
})

export type GetLakehouseFilePlanRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>

export type GetLakehouseFilePlanResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

const SCOPED_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,128}$/

function parseScopedId(value: string | undefined, fieldName: string): string | undefined {
  if (!value) {
    return undefined
  }

  if (!SCOPED_ID_PATTERN.test(value)) {
    throw new UnpriceApiError({
      code: "BAD_REQUEST",
      message: `${fieldName} format is invalid`,
    })
  }

  return value
}

function resolveScopedProjectId(params: {
  callerProjectId: string
  requestedProjectId?: string
  isMainWorkspace: boolean
}): string {
  if (
    !params.isMainWorkspace &&
    params.requestedProjectId &&
    params.requestedProjectId !== params.callerProjectId
  ) {
    throw new UnpriceApiError({
      code: "FORBIDDEN",
      message: "You are not allowed to access this project data",
    })
  }

  if (params.isMainWorkspace) {
    return params.requestedProjectId ?? params.callerProjectId
  }

  return params.callerProjectId
}

function mapUpstreamStatusCode(
  status: number
): "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" {
  if (status === 400) return "BAD_REQUEST"
  if (status === 422) return "BAD_REQUEST"
  if (status === 401) return "UNAUTHORIZED"
  if (status === 403) return "FORBIDDEN"
  if (status === 404) return "NOT_FOUND"
  return "BAD_REQUEST"
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

function inferTableFromUrl(value: string): TableName | undefined {
  for (const entry of TABLE_URL_MATCHERS) {
    if (entry.pattern.test(value)) {
      return entry.table
    }
  }
  return undefined
}

function normalizeTableFiles(params: {
  requestedTables?: TableName[]
  workerTableFiles: Record<string, string[]>
  urls: string[]
  urlsByTable?: Record<string, string[]>
}): Record<string, string[]> {
  const requestedTables = params.requestedTables?.length ? params.requestedTables : TABLE_NAMES
  const tableFiles: Record<TableName, string[]> = {
    usage: [],
    verification: [],
    metadata: [],
    entitlement_snapshot: [],
  }

  for (const tableName of TABLE_NAMES) {
    const workerFiles = params.workerTableFiles[tableName]
    if (Array.isArray(workerFiles) && workerFiles.length > 0) {
      tableFiles[tableName] = dedupeStrings(
        workerFiles.filter((value): value is string => typeof value === "string")
      )
    }

    const mappedUrls = params.urlsByTable?.[tableName]
    if (tableFiles[tableName].length === 0 && Array.isArray(mappedUrls) && mappedUrls.length > 0) {
      tableFiles[tableName] = dedupeStrings(
        mappedUrls.filter((value): value is string => typeof value === "string")
      )
    }
  }

  const unresolved = new Set(
    requestedTables.filter((tableName) => tableFiles[tableName].length === 0)
  )
  if (params.urls.length > 0 && unresolved.size > 0) {
    for (const url of params.urls) {
      const tableName = inferTableFromUrl(url)
      if (!tableName || !unresolved.has(tableName)) {
        continue
      }
      tableFiles[tableName].push(url)
    }

    for (const tableName of unresolved) {
      tableFiles[tableName] = dedupeStrings(tableFiles[tableName])
    }
  }

  if (params.urls.length > 0 && requestedTables.length === 1) {
    const [singleTable] = requestedTables
    if (singleTable && tableFiles[singleTable].length === 0) {
      tableFiles[singleTable] = dedupeStrings(params.urls)
    }
  }

  const normalized: Record<string, string[]> = {}
  for (const tableName of TABLE_NAMES) {
    if (requestedTables.includes(tableName) || tableFiles[tableName].length > 0) {
      normalized[tableName] = tableFiles[tableName]
    }
  }

  return normalized
}

export const registerGetLakehouseFilePlanV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const body = c.req.valid("json")
    const key = await keyAuth(c)
    const requestedProjectId = parseScopedId(body.projectId, "projectId")
    const scopedCustomerId = parseScopedId(body.customerId, "customerId")
    const callerProjectId = c.get("projectId")

    if (!callerProjectId) {
      throw new UnpriceApiError({
        code: "UNAUTHORIZED",
        message: "project id is required",
      })
    }

    const scopedProjectId = resolveScopedProjectId({
      callerProjectId,
      requestedProjectId,
      isMainWorkspace: key.project.workspace.isMain,
    })

    const upstreamPayload = workerRequestSchema.parse({
      project_ids: [scopedProjectId],
      customer_ids: scopedCustomerId ? [scopedCustomerId] : undefined,
      tables: body.tables,
      interval: body.interval,
      target_env: body.targetEnv,
    })

    const baseUrl = c.env.LAKEHOUSE_FILE_PLAN_BASE_URL.replace(/\/+$/, "")
    const token = c.env.LAKEHOUSE_API_TOKEN

    const upstreamResponse = await fetch(`${baseUrl}/v1/lakehouse/files`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(upstreamPayload),
    })

    const rawText = await upstreamResponse.text()

    let parsedBody: unknown = {}
    if (rawText) {
      try {
        parsedBody = JSON.parse(rawText)
      } catch {
        parsedBody = {}
      }
    }

    if (!upstreamResponse.ok) {
      const detail = (() => {
        if (typeof parsedBody !== "object" || parsedBody === null || !("detail" in parsedBody)) {
          return `Lakehouse worker returned ${upstreamResponse.status}`
        }

        const { detail } = parsedBody
        if (typeof detail === "string") {
          return detail
        }
        if (detail && typeof detail === "object") {
          return JSON.stringify(detail)
        }

        return `Lakehouse worker returned ${upstreamResponse.status}`
      })()

      if (upstreamResponse.status >= 500) {
        throw new UnpriceApiError({
          code: "INTERNAL_SERVER_ERROR",
          message: detail,
        })
      }

      throw new UnpriceApiError({
        code: mapUpstreamStatusCode(upstreamResponse.status),
        message: detail,
      })
    }

    const workerResponse = workerResponseSchema.parse(parsedBody)
    const urlsByTable = Array.isArray(workerResponse.urls) ? undefined : workerResponse.urls
    const urls = Array.isArray(workerResponse.urls)
      ? workerResponse.urls
      : dedupeStrings(Object.values(workerResponse.urls).flat())
    const tableFiles = normalizeTableFiles({
      requestedTables: upstreamPayload.tables,
      workerTableFiles: workerResponse.table_files,
      urls,
      urlsByTable,
    })

    return c.json(
      {
        projectIds: workerResponse.project_ids,
        customerIds: workerResponse.customer_ids ?? [],
        interval: workerResponse.interval,
        intervalDays: workerResponse.interval_days,
        targetEnv: body.targetEnv,
        window: workerResponse.window,
        tableFiles,
        urls,
        errors: workerResponse.errors,
        credentials: workerResponse.credentials
          ? {
              bucket: workerResponse.credentials.bucket,
              r2Endpoint: workerResponse.credentials.r2_endpoint,
              accessKeyId: workerResponse.credentials.access_key_id,
              secretAccessKey: workerResponse.credentials.secret_access_key,
              sessionToken: workerResponse.credentials.session_token,
              expiration: workerResponse.credentials.expiration,
              ttlSeconds: workerResponse.credentials.ttl_seconds,
              prefixes: workerResponse.credentials.prefixes,
            }
          : null,
      },
      HttpStatusCodes.OK
    )
  })
