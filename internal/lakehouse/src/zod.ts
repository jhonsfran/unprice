import { z } from "zod"
import {
  type LakehouseFieldDefinition,
  type LakehouseJsonValue,
  getLakehouseSourceCurrentVersion,
  getLakehouseSourceFieldsForVersion,
} from "./registry"
import type { LakehouseSource } from "./source"

export const lakehouseJsonValueSchema: z.ZodType<LakehouseJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(lakehouseJsonValueSchema),
    z.record(z.string(), lakehouseJsonValueSchema),
  ])
)

function fieldToSchema(field: LakehouseFieldDefinition): z.ZodTypeAny {
  let schema: z.ZodTypeAny

  switch (field.type) {
    case "string":
      schema = z.string()
      break
    case "int64":
    case "int32":
      schema = z.number().int()
      break
    case "bool":
      schema = z.boolean()
      break
    case "json":
      schema = lakehouseJsonValueSchema
      break
    case "timestamp":
      schema = z.union([z.number().int(), z.string(), z.date()])
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
