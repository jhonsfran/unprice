import { z } from "zod"
import {
  type LakehouseEventForSource,
  type LakehouseFieldDefinition,
  type LakehouseJsonValue,
  getLakehouseSourceCurrentVersion,
  getLakehouseSourceFieldsForVersion,
  getLakehouseSourceSchema,
} from "./registry"
import type { LakehouseSource } from "./source"

export const lakehouseJsonValueSchema: z.ZodType<LakehouseJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(lakehouseJsonValueSchema),
    z.record(lakehouseJsonValueSchema),
  ])
)

function fieldToSchema(field: LakehouseFieldDefinition): z.ZodTypeAny {
  let schema: z.ZodTypeAny

  switch (field.type) {
    case "string":
      schema = z.string()
      break
    case "bytes":
      schema = z.union([z.string(), z.instanceof(Uint8Array)])
      break
    case "int64":
    case "int32":
      schema = z.number().int()
      break
    case "float64":
    case "float32":
    case "f64":
    case "f32":
      schema = z.number().finite()
      break
    case "boolean":
    case "bool":
      schema = z.boolean()
      break
    case "json":
      schema = lakehouseJsonValueSchema
      break
    case "datetime":
      schema = z.union([z.string(), z.date()])
      break
    case "timestamp":
      schema = z.union([z.number().int(), z.string(), z.date()])
      break
    case "list":
      schema = z.array(z.unknown())
      break
    case "struct":
      schema = z.record(z.unknown())
      break
    default: {
      const _never: never = field.type
      throw new Error(`Unsupported lakehouse field type: ${String(_never)}`)
    }
  }

  if (field.required) {
    return schema
  }

  return field.defaultValue === null ? schema.nullable().optional() : schema.optional()
}

export function buildLakehouseEventZodSchema(
  source: LakehouseSource,
  options?: { schemaVersion?: number }
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const schemaVersion = options?.schemaVersion ?? getLakehouseSourceCurrentVersion(source)
  const fields = getLakehouseSourceFieldsForVersion(source, schemaVersion)
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const field of fields) {
    shape[field.name] = fieldToSchema(field)
  }

  return z.object(shape)
}

const eventSchemaBySourceVersion = new Map<string, z.ZodObject<Record<string, z.ZodTypeAny>>>()

function getSchemaCacheKey(source: LakehouseSource, schemaVersion: number): string {
  return `${source}:${schemaVersion}`
}

export function getLakehouseSourceEventZodSchemaForVersion(
  source: LakehouseSource,
  schemaVersion: number
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const cacheKey = getSchemaCacheKey(source, schemaVersion)
  const cached = eventSchemaBySourceVersion.get(cacheKey)
  if (cached) {
    return cached
  }

  const schema = buildLakehouseEventZodSchema(source, { schemaVersion })
  eventSchemaBySourceVersion.set(cacheKey, schema)
  return schema
}

export const LAKEHOUSE_EVENT_ZOD_SCHEMAS: {
  [S in LakehouseSource]: z.ZodType<LakehouseEventForSource<S>>
} = {
  events: buildLakehouseEventZodSchema("events") as unknown as z.ZodType<
    LakehouseEventForSource<"events">
  >,
}

export function getLakehouseSourceEventZodSchema<S extends LakehouseSource>(
  source: S
): z.ZodType<LakehouseEventForSource<S>> {
  const currentVersion = getLakehouseSourceSchema(source).currentVersion
  return getLakehouseSourceEventZodSchemaForVersion(source, currentVersion) as unknown as z.ZodType<
    LakehouseEventForSource<S>
  >
}

export function parseLakehouseEvent<S extends LakehouseSource>(
  source: S,
  input: unknown,
  options?: { schemaVersion?: number }
): LakehouseEventForSource<S> {
  if (options?.schemaVersion !== undefined) {
    return getLakehouseSourceEventZodSchemaForVersion(source, options.schemaVersion).parse(
      input
    ) as LakehouseEventForSource<S>
  }

  return getLakehouseSourceEventZodSchema(source).parse(input)
}

export function safeParseLakehouseEvent<S extends LakehouseSource>(
  source: S,
  input: unknown,
  options?: { schemaVersion?: number }
) {
  if (options?.schemaVersion !== undefined) {
    return getLakehouseSourceEventZodSchemaForVersion(source, options.schemaVersion).safeParse(
      input
    )
  }

  return getLakehouseSourceEventZodSchema(source).safeParse(input)
}
