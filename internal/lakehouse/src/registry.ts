import type { LakehouseSource } from "./source"

export const LAKEHOUSE_PARTITION_COLUMNS = [] as const

export type LakehouseFieldType =
  | "string"
  | "int64"
  | "int32"
  | "float64"
  | "float32"
  | "f64"
  | "f32"
  | "boolean"
  | "bool"
  | "json"
  | "datetime"
  | "timestamp"
  | "bytes"
  | "list"
  | "struct"
export type LakehouseFieldDefaultValue =
  | string
  | number
  | boolean
  | null
  | Date
  | Uint8Array
  | Record<string, unknown>
  | unknown[]

export interface LakehouseFieldDefinition {
  name: string
  type: LakehouseFieldType
  required: boolean
  addedInVersion: number
  defaultValue: LakehouseFieldDefaultValue
  description: string
}

export interface LakehouseSourceSchemaDefinition {
  source: LakehouseSource
  firstVersion: number
  currentVersion: number
  streamName: string
  schemaFile: string
  sinkTable: string
  frontendTable: string
  tableAliases: readonly string[]
  partitionColumns: readonly string[]
  fields: readonly LakehouseFieldDefinition[]
}

type SourceSchemaMap = Record<LakehouseSource, LakehouseSourceSchemaDefinition>

export type CloudflarePipelineFieldType =
  | "list"
  | "struct"
  | "bytes"
  | "json"
  | "timestamp"
  | "f64"
  | "f32"
  | "int64"
  | "int32"
  | "bool"
  | "string"

export const lakehouseSourceSchemaRegistry = {
  events: {
    source: "events",
    firstVersion: 1,
    currentVersion: 5,
    streamName: "lakehouse_events_stream",
    schemaFile: "events.json",
    sinkTable: "events",
    frontendTable: "events",
    tableAliases: ["events"],
    partitionColumns: LAKEHOUSE_PARTITION_COLUMNS,
    fields: [
      {
        name: "event_date",
        type: "datetime",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description:
          "UTC event date column for filters. Cloudflare Data Catalog partitioning is sink-managed ingestion time, not this business date.",
      },
      {
        name: "schema_version",
        type: "int32",
        required: true,
        addedInVersion: 1,
        defaultValue: 1,
        description: "Schema version for this event payload.",
      },
      {
        name: "id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Unique ingestion event identifier.",
      },
      {
        name: "project_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Project identifier.",
      },
      {
        name: "customer_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Customer identifier.",
      },
      {
        name: "workspace_id",
        type: "string",
        required: false,
        addedInVersion: 3,
        defaultValue: "",
        description: "Workspace identifier that owned the API key used for ingestion.",
      },
      {
        name: "environment",
        type: "string",
        required: false,
        addedInVersion: 3,
        defaultValue: "",
        description: "Application environment that accepted the event.",
      },
      {
        name: "api_key_id",
        type: "string",
        required: false,
        addedInVersion: 3,
        defaultValue: null,
        description: "API key identifier that authorized the event.",
      },
      {
        name: "source_type",
        type: "string",
        required: false,
        addedInVersion: 3,
        defaultValue: "unknown",
        description: "Source type such as api_key, system, or unknown.",
      },
      {
        name: "source_id",
        type: "string",
        required: false,
        addedInVersion: 3,
        defaultValue: "",
        description: "Stable source identifier, usually the API key id.",
      },
      {
        name: "source_name",
        type: "string",
        required: false,
        addedInVersion: 3,
        defaultValue: null,
        description: "Optional source display name.",
      },
      {
        name: "run_id",
        type: "string",
        required: false,
        addedInVersion: 4,
        defaultValue: null,
        description: "Budget run identifier when the event was consumed through a run.",
      },
      {
        name: "trace_id",
        type: "string",
        required: false,
        addedInVersion: 4,
        defaultValue: null,
        description: "Optional trace identifier for grouping related run events.",
      },
      {
        name: "parent_run_id",
        type: "string",
        required: false,
        addedInVersion: 4,
        defaultValue: null,
        description: "Optional parent budget run identifier for nested run workflows.",
      },
      {
        name: "workload_type",
        type: "string",
        required: false,
        addedInVersion: 4,
        defaultValue: null,
        description: "Run workload type such as agent, workflow, job, tool, or custom.",
      },
      {
        name: "workload_id",
        type: "string",
        required: false,
        addedInVersion: 4,
        defaultValue: null,
        description: "Optional workload identifier supplied for run attribution.",
      },
      {
        name: "ingestion_mode",
        type: "string",
        required: false,
        addedInVersion: 5,
        defaultValue: null,
        description: "Ingestion path for the event: async, sync, or run.",
      },
      {
        name: "request_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Request identifier tied to the raw ingestion event.",
      },
      {
        name: "idempotency_key",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Logical idempotency key used to deduplicate ingestion events.",
      },
      {
        name: "slug",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Raw event slug.",
      },
      {
        name: "timestamp",
        type: "timestamp",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Raw event timestamp (epoch milliseconds).",
      },
      {
        name: "received_at",
        type: "timestamp",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Timestamp when the ingestion request was received.",
      },
      {
        name: "handled_at",
        type: "timestamp",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Timestamp when the queue consumer handled the event.",
      },
      {
        name: "state",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Ingestion lifecycle state: processed, rejected, or failed.",
      },
      {
        name: "rejection_reason",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description:
          "Business rejection reason such as CUSTOMER_NOT_FOUND, NO_MATCHING_ENTITLEMENT, INVALID_AGGREGATION_PROPERTIES, or UNROUTABLE_EVENT.",
      },
      {
        name: "failure_stage",
        type: "string",
        required: false,
        addedInVersion: 4,
        defaultValue: null,
        description: "Internal stage where failed ingestion processing stopped.",
      },
      {
        name: "failure_reason",
        type: "string",
        required: false,
        addedInVersion: 4,
        defaultValue: null,
        description: "Stable machine-readable reason for failed ingestion processing.",
      },
      {
        name: "failure_message",
        type: "string",
        required: false,
        addedInVersion: 4,
        defaultValue: null,
        description: "Human-readable failure message for replayable ingestion failures.",
      },
      {
        name: "replayable",
        type: "bool",
        required: false,
        addedInVersion: 4,
        defaultValue: false,
        description: "Whether a failed event has enough payload evidence for replay.",
      },
      {
        name: "payload_json",
        type: "string",
        required: false,
        addedInVersion: 4,
        defaultValue: null,
        description: "Serialized replay payload for failed replayable ingestion events.",
      },
      {
        name: "properties",
        type: "json",
        required: true,
        addedInVersion: 1,
        defaultValue: {},
        description: "Raw event properties payload.",
      },
      {
        name: "canonical_audit_id",
        type: "string",
        required: false,
        addedInVersion: 2,
        defaultValue: null,
        description:
          "Deterministic SHA-256 audit identifier for query-time deduplication across R2.",
      },
      {
        name: "payload_hash",
        type: "string",
        required: false,
        addedInVersion: 2,
        defaultValue: null,
        description:
          "SHA-256 of stable business fields for conflict detection on idempotency key reuse.",
      },
    ],
  },
  web_events: {
    source: "web_events",
    firstVersion: 1,
    currentVersion: 1,
    streamName: "lakehouse_web_events_stream",
    schemaFile: "web_events.json",
    sinkTable: "web_events",
    frontendTable: "web_events",
    tableAliases: ["web_events"],
    partitionColumns: LAKEHOUSE_PARTITION_COLUMNS,
    fields: [
      {
        name: "schema_version",
        type: "int32",
        required: true,
        addedInVersion: 1,
        defaultValue: 1,
        description: "Schema version for this row.",
      },
      {
        name: "event_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Unique row identifier (UUID). Readers deduplicate on it.",
      },
      {
        name: "kind",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Row kind: page_hit, plan_view, plan_click, or signup.",
      },
      {
        name: "timestamp",
        type: "timestamp",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Event time (RFC 3339, UTC).",
      },
      {
        name: "project_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Project that owns the page or the sign-up.",
      },
      {
        name: "session_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: "",
        description: "Visitor session id from track.js. Empty for sign-ups without a session.",
      },
      {
        name: "page_id",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Pricing page id.",
      },
      {
        name: "plan_id",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Plan id, when known (sign-ups).",
      },
      {
        name: "plan_version_id",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Plan version id (plan_view, plan_click, signup).",
      },
      {
        name: "customer_id",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Customer id created by a sign-up.",
      },
      {
        name: "signup_status",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description:
          "Sign-up status: waiting_payment_provider_setup, signup_success, or signup_failed.",
      },
      {
        name: "pathname",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Page path of a page hit.",
      },
      {
        name: "url",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Full URL of a page hit.",
      },
      {
        name: "referrer",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Referrer domain, or (direct).",
      },
      {
        name: "referrer_url",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Full referrer URL, or (direct).",
      },
      {
        name: "locale",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Browser locale.",
      },
      {
        name: "country",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Country code from the edge geolocation.",
      },
      {
        name: "region",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Region from the edge geolocation.",
      },
      {
        name: "city",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "City from the edge geolocation.",
      },
      {
        name: "continent",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Continent from the edge geolocation.",
      },
      {
        name: "device",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Device type: desktop, mobile, tablet, or another user-agent type.",
      },
      {
        name: "device_vendor",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Device vendor from the user agent.",
      },
      {
        name: "device_model",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Device model from the user agent.",
      },
      {
        name: "browser",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Browser name from the user agent.",
      },
      {
        name: "browser_version",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Browser version from the user agent.",
      },
      {
        name: "os",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Operating system from the user agent.",
      },
      {
        name: "os_version",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Operating system version from the user agent.",
      },
      {
        name: "engine",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Rendering engine from the user agent.",
      },
      {
        name: "engine_version",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "Rendering engine version from the user agent.",
      },
      {
        name: "cpu_architecture",
        type: "string",
        required: false,
        addedInVersion: 1,
        defaultValue: null,
        description: "CPU architecture from the user agent.",
      },
      {
        name: "bot",
        type: "bool",
        required: false,
        addedInVersion: 1,
        defaultValue: false,
        description: "Whether the user agent looked like a bot.",
      },
    ],
  },
  budget_journal: {
    source: "budget_journal",
    firstVersion: 1,
    currentVersion: 1,
    streamName: "lakehouse_budget_journal_stream",
    schemaFile: "budget_journal.json",
    sinkTable: "budget_journal",
    frontendTable: "budget_journal",
    tableAliases: ["budget_journal"],
    partitionColumns: LAKEHOUSE_PARTITION_COLUMNS,
    fields: [
      {
        name: "schema_version",
        type: "int32",
        required: true,
        addedInVersion: 1,
        defaultValue: 1,
        description: "Schema version for this row.",
      },
      {
        name: "project_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "Project that owns the budget.",
      },
      {
        name: "budget_key",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "The budget's key within its project.",
      },
      {
        name: "seq",
        type: "int64",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description:
          "Per-budget write sequence. Readers deduplicate on (project_id, budget_key, seq) and keep an operation's highest seq.",
      },
      {
        name: "operation_id",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description:
          "The row's id: h_<n> for a hold, o:<key hash> for a charge or record, l:<key hash> for a lease.",
      },
      {
        name: "kind",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "hold, charge, record, or lease.",
      },
      {
        name: "status",
        type: "string",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "open, settled, released, or done.",
      },
      {
        name: "timestamp",
        type: "timestamp",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "When the budget wrote this version of the row (RFC 3339, UTC).",
      },
      {
        name: "data",
        type: "json",
        required: true,
        addedInVersion: 1,
        defaultValue: null,
        description: "The operation row as the budget keeps it, amounts as decimal strings.",
      },
    ],
  },
} as const satisfies SourceSchemaMap

const tableAliasToSource = new Map<string, LakehouseSource>()
for (const source of Object.keys(lakehouseSourceSchemaRegistry) as LakehouseSource[]) {
  const entry = lakehouseSourceSchemaRegistry[source]
  for (const alias of entry.tableAliases) {
    tableAliasToSource.set(alias, source)
  }
}

export function getLakehouseSourceRegistry(): Readonly<SourceSchemaMap> {
  return lakehouseSourceSchemaRegistry
}

export function getLakehouseSourceSchema(source: LakehouseSource): LakehouseSourceSchemaDefinition {
  return lakehouseSourceSchemaRegistry[source]
}

function validateSchemaVersion(
  source: LakehouseSource,
  version: number,
  schema: LakehouseSourceSchemaDefinition
) {
  if (!Number.isInteger(version)) {
    throw new Error(`Schema version for source '${source}' must be an integer`)
  }
  if (version < schema.firstVersion || version > schema.currentVersion) {
    throw new Error(
      `Schema version ${version} for source '${source}' is out of range (${schema.firstVersion}..${schema.currentVersion})`
    )
  }
}

export function getLakehouseSourceCurrentVersion(source: LakehouseSource): number {
  return getLakehouseSourceSchema(source).currentVersion
}

export function getLakehouseSourceFieldsForVersion(
  source: LakehouseSource,
  schemaVersion: number
): LakehouseFieldDefinition[] {
  const schema = getLakehouseSourceSchema(source)
  validateSchemaVersion(source, schemaVersion, schema)
  return schema.fields.filter((field) => field.addedInVersion <= schemaVersion)
}

export function listLakehouseSourceSchemas(): LakehouseSourceSchemaDefinition[] {
  return Object.values(lakehouseSourceSchemaRegistry)
}

export function getLakehouseFieldNames(source: LakehouseSource, schemaVersion?: number): string[] {
  if (schemaVersion === undefined) {
    return getLakehouseSourceSchema(source).fields.map((field) => field.name)
  }

  return getLakehouseSourceFieldsForVersion(source, schemaVersion).map((field) => field.name)
}

export function getLakehouseFieldDefinition(
  source: LakehouseSource,
  fieldName: string,
  schemaVersion?: number
): LakehouseFieldDefinition | undefined {
  const fields =
    schemaVersion === undefined
      ? getLakehouseSourceSchema(source).fields
      : getLakehouseSourceFieldsForVersion(source, schemaVersion)

  return fields.find((field) => field.name === fieldName)
}

export function resolveLakehouseSourceFromTable(tableName: string): LakehouseSource | undefined {
  return tableAliasToSource.get(tableName)
}

export function isLakehouseField(
  source: LakehouseSource,
  fieldName: string,
  schemaVersion?: number
): boolean {
  return !!getLakehouseFieldDefinition(source, fieldName, schemaVersion)
}

export function toCloudflarePipelineSchema(source: LakehouseSource): {
  fields: Array<{
    name: string
    type: CloudflarePipelineFieldType
    required: boolean
  }>
} {
  const toCloudflareType = (fieldType: LakehouseFieldType): CloudflarePipelineFieldType => {
    switch (fieldType) {
      case "string":
      case "list":
      case "struct":
      case "bytes":
      case "json":
      case "int64":
      case "int32":
      case "f64":
      case "f32":
      case "timestamp":
        return fieldType
      case "float64":
        return "f64"
      case "float32":
        return "f32"
      case "boolean":
      case "bool":
        // Cloudflare stream schema type is `bool` (not `boolean`).
        return "bool"
      case "datetime":
        // Cloudflare does not expose `datetime`; normalize to `timestamp`.
        return "timestamp"
      default: {
        const _never: never = fieldType
        throw new Error(`Unsupported lakehouse field type for Cloudflare schema: ${String(_never)}`)
      }
    }
  }

  return {
    fields: getLakehouseSourceSchema(source).fields.map((field) => ({
      name: field.name,
      type: toCloudflareType(field.type),
      required: field.required,
    })),
  }
}

export interface CloudflareLakehousePipelineDefinition {
  source: LakehouseSource
  stream: string
  sink: string
  sinkTable: string
  pipeline: string
  schemaFile: string
}

export function buildCloudflareLakehousePipelineDefinitions(
  prefix = "lakehouse"
): CloudflareLakehousePipelineDefinition[] {
  return listLakehouseSourceSchemas().map((entry) => {
    const suffixBySource: Record<LakehouseSource, string> = {
      events: "events",
      web_events: "web_events",
      budget_journal: "budget_journal",
    }
    const suffix = suffixBySource[entry.source]

    return {
      source: entry.source,
      stream: entry.streamName,
      sink: `${prefix}_${suffix}_sink`,
      sinkTable: entry.sinkTable,
      pipeline: `${prefix}_${suffix}_pipeline`,
      schemaFile: entry.schemaFile,
    }
  })
}

export type LakehouseJsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: LakehouseJsonValue }
  | LakehouseJsonValue[]

type LakehouseFieldValueByType<T extends LakehouseFieldType> = T extends "string"
  ? string
  : T extends "int64" | "int32" | "float64" | "float32" | "f64" | "f32"
    ? number
    : T extends "boolean" | "bool"
      ? boolean
      : T extends "json"
        ? LakehouseJsonValue
        : T extends "timestamp"
          ? string | number | Date
          : T extends "datetime"
            ? string | Date
            : T extends "bytes"
              ? string | Uint8Array
              : T extends "list"
                ? unknown[]
                : T extends "struct"
                  ? Record<string, unknown>
                  : never

type Simplify<T> = { [K in keyof T]: T[K] } & {}
type UnionToIntersection<T> = (T extends unknown ? (input: T) => void : never) extends (
  input: infer I
) => void
  ? I
  : never

type LakehouseFieldToProperty<T> = T extends {
  name: infer Name extends string
  type: infer FieldType extends LakehouseFieldType
  required: infer Required extends boolean
}
  ? Required extends true
    ? { [K in Name]: LakehouseFieldValueByType<FieldType> }
    : { [K in Name]?: LakehouseFieldValueByType<FieldType> }
  : never

type LakehouseEventFromFields<T extends readonly unknown[]> = Simplify<
  UnionToIntersection<LakehouseFieldToProperty<T[number]>>
>

type EventsEventFromRegistry = LakehouseEventFromFields<
  (typeof lakehouseSourceSchemaRegistry)["events"]["fields"]
>

type WebEventsEventFromRegistry = LakehouseEventFromFields<
  (typeof lakehouseSourceSchemaRegistry)["web_events"]["fields"]
>

type BudgetJournalEventFromRegistry = LakehouseEventFromFields<
  (typeof lakehouseSourceSchemaRegistry)["budget_journal"]["fields"]
>

export type LakehouseEventBySource = {
  events: EventsEventFromRegistry
  web_events: WebEventsEventFromRegistry
  budget_journal: BudgetJournalEventFromRegistry
}

export type LakehouseEventForSource<S extends LakehouseSource> = LakehouseEventBySource[S]

for (const source of Object.keys(lakehouseSourceSchemaRegistry) as LakehouseSource[]) {
  const schema = lakehouseSourceSchemaRegistry[source]

  if (schema.firstVersion > schema.currentVersion) {
    throw new Error(
      `Invalid version range for source '${source}': firstVersion=${schema.firstVersion}, currentVersion=${schema.currentVersion}`
    )
  }

  const fieldNames = new Set<string>()
  for (const field of schema.fields) {
    if (fieldNames.has(field.name)) {
      throw new Error(`Duplicate field '${field.name}' in source '${source}'`)
    }
    fieldNames.add(field.name)

    if (
      !Number.isInteger(field.addedInVersion) ||
      field.addedInVersion < schema.firstVersion ||
      field.addedInVersion > schema.currentVersion
    ) {
      throw new Error(
        `Field '${field.name}' on source '${source}' has invalid addedInVersion=${field.addedInVersion}`
      )
    }
  }

  for (const partitionField of schema.partitionColumns) {
    if (!fieldNames.has(partitionField)) {
      throw new Error(
        `Partition field '${partitionField}' is missing from source '${source}' schema fields`
      )
    }
  }

  const schemaVersionField = schema.fields.find((field) => field.name === "schema_version")
  if (!schemaVersionField) {
    throw new Error(`Source '${source}' must include a schema_version field`)
  }
  if (
    (schemaVersionField.type !== "int32" && schemaVersionField.type !== "int64") ||
    !schemaVersionField.required
  ) {
    throw new Error(`Source '${source}' schema_version field must be required int32 or int64`)
  }
}
