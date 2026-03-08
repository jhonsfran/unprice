import {
  type LakehouseFieldDefinition,
  type LakehouseSourceSchemaDefinition,
  getLakehouseSourceSchema,
  resolveLakehouseSourceFromTable,
} from "./registry"

export type LakehouseQueryJoinType = "inner" | "left"
export type LakehouseQuerySortDirection = "asc" | "desc"
export type LakehouseFilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "between"
  | "contains"
  | "is_null"
  | "is_not_null"

export type LakehouseFilterValue = string | number | boolean | null

export interface LakehouseQueryTableRef {
  table: string
  alias?: string
}

export interface LakehouseQueryColumnRef {
  table?: string
  column: string
}

export interface LakehouseQueryProjection extends LakehouseQueryColumnRef {
  alias?: string
  /**
   * Applies schema-evolution defaults for fields added after source firstVersion.
   * Expression form: CASE WHEN schema_version >= addedInVersion THEN value ELSE defaultValue END
   */
  applyEvolutionDefault?: boolean
}

export interface LakehouseQueryJoinCondition {
  left: LakehouseQueryColumnRef
  right: LakehouseQueryColumnRef
}

export interface LakehouseQueryJoin {
  type?: LakehouseQueryJoinType
  table: string
  alias?: string
  on: LakehouseQueryJoinCondition[]
}

export interface LakehouseQueryFilter {
  column: LakehouseQueryColumnRef
  op: LakehouseFilterOperator
  value?: LakehouseFilterValue | LakehouseFilterValue[]
  values?: [LakehouseFilterValue, LakehouseFilterValue]
}

export interface LakehouseQueryOrderBy {
  column: LakehouseQueryColumnRef
  direction?: LakehouseQuerySortDirection
}

export interface LakehouseQuerySpec {
  from: LakehouseQueryTableRef
  select: LakehouseQueryProjection[]
  /** When true, emits SELECT DISTINCT to deduplicate result rows. */
  distinct?: boolean
  joins?: LakehouseQueryJoin[]
  where?: LakehouseQueryFilter[]
  groupBy?: LakehouseQueryColumnRef[]
  orderBy?: LakehouseQueryOrderBy[]
  limit?: number
}

export interface BuiltLakehouseQuery {
  sql: string
  params: unknown[]
}

interface ResolvedTable {
  table: string
  alias: string
  source: LakehouseSourceSchemaDefinition
}

interface ResolvedColumn {
  sql: string
  tableAlias: string
  table: ResolvedTable
  field: LakehouseFieldDefinition
}

const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER_REGEX.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`)
  }
  return `"${value}"`
}

function resolveTable(table: string, alias?: string): ResolvedTable {
  const source = resolveLakehouseSourceFromTable(table)
  if (!source) {
    throw new Error(`Unknown lakehouse table: ${table}`)
  }

  const schema = getLakehouseSourceSchema(source)
  const resolvedAlias = alias ?? table

  return {
    table,
    alias: resolvedAlias,
    source: schema,
  }
}

function resolveColumn(
  column: LakehouseQueryColumnRef,
  tableAliases: Map<string, ResolvedTable>,
  fallbackTableAlias: string
): ResolvedColumn {
  const tableAlias = column.table ?? fallbackTableAlias
  const resolvedTable = tableAliases.get(tableAlias)
  if (!resolvedTable) {
    throw new Error(`Unknown table alias in query: ${tableAlias}`)
  }

  const field = resolvedTable.source.fields.find((entry) => entry.name === column.column)
  if (!field) {
    throw new Error(`Unknown column '${column.column}' on table '${resolvedTable.table}'`)
  }

  return {
    sql: `${quoteIdentifier(tableAlias)}.${quoteIdentifier(column.column)}`,
    tableAlias,
    table: resolvedTable,
    field,
  }
}

function compileFilter(
  filter: LakehouseQueryFilter,
  tableAliases: Map<string, ResolvedTable>,
  fallbackTableAlias: string,
  params: unknown[]
): string {
  const fieldRef = resolveColumn(filter.column, tableAliases, fallbackTableAlias).sql

  switch (filter.op) {
    case "eq":
      params.push(filter.value ?? null)
      return `${fieldRef} = ?`
    case "neq":
      params.push(filter.value ?? null)
      return `${fieldRef} <> ?`
    case "gt":
      params.push(filter.value ?? null)
      return `${fieldRef} > ?`
    case "gte":
      params.push(filter.value ?? null)
      return `${fieldRef} >= ?`
    case "lt":
      params.push(filter.value ?? null)
      return `${fieldRef} < ?`
    case "lte":
      params.push(filter.value ?? null)
      return `${fieldRef} <= ?`
    case "contains":
      params.push(`%${String(filter.value ?? "")}%`)
      return `${fieldRef} LIKE ?`
    case "is_null":
      return `${fieldRef} IS NULL`
    case "is_not_null":
      return `${fieldRef} IS NOT NULL`
    case "in": {
      if (!Array.isArray(filter.value) || filter.value.length === 0) {
        throw new Error(`'in' filter requires a non-empty array`)
      }

      params.push(...filter.value)
      const placeholders = filter.value.map(() => "?").join(", ")
      return `${fieldRef} IN (${placeholders})`
    }
    case "between": {
      if (!filter.values || filter.values.length !== 2) {
        throw new Error(`'between' filter requires two values`)
      }
      params.push(filter.values[0], filter.values[1])
      return `${fieldRef} BETWEEN ? AND ?`
    }
    default:
      throw new Error(`Unsupported filter operator: ${String(filter.op)}`)
  }
}

function quoteTableRef(table: string, alias: string): string {
  const quotedTable = quoteIdentifier(table)
  const quotedAlias = quoteIdentifier(alias)
  if (table === alias) {
    return quotedTable
  }
  return `${quotedTable} AS ${quotedAlias}`
}

function applyEvolutionDefaultProjection(column: ResolvedColumn): string {
  if (column.field.addedInVersion <= column.table.source.firstVersion) {
    return column.sql
  }

  const defaultValue = column.field.defaultValue
  const schemaVersionField = column.table.source.fields.find(
    (field) => field.name === "schema_version"
  )

  if (!schemaVersionField) {
    throw new Error(`Table '${column.table.table}' is missing required schema_version field`)
  }

  const schemaVersionSql = `${quoteIdentifier(column.tableAlias)}.${quoteIdentifier("schema_version")}`
  const addedInVersion = column.field.addedInVersion
  const defaultSql = inlineSqlValue(defaultValue)

  return `CASE WHEN ${schemaVersionSql} >= ${addedInVersion} THEN ${column.sql} ELSE ${defaultSql} END`
}

function escapeSqlString(value: string): string {
  // Use split and join for broader Node compat (ES2015+)
  return value.split("'").join("''")
}

function inlineSqlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL"
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot inline non-finite numbers")
    }
    return String(value)
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE"
  }
  return `'${escapeSqlString(String(value))}'`
}

export function buildLakehouseQuery(spec: LakehouseQuerySpec): BuiltLakehouseQuery {
  if (!spec.select.length) {
    throw new Error("Query select must include at least one column")
  }

  const from = resolveTable(spec.from.table, spec.from.alias)
  const tableAliases = new Map<string, ResolvedTable>([[from.alias, from]])

  const joins = spec.joins ?? []
  for (const join of joins) {
    const resolved = resolveTable(join.table, join.alias)
    if (tableAliases.has(resolved.alias)) {
      throw new Error(`Duplicate table alias: ${resolved.alias}`)
    }
    tableAliases.set(resolved.alias, resolved)
  }

  const params: unknown[] = []
  const selectSql = spec.select
    .map((column) => {
      const resolvedColumn = resolveColumn(column, tableAliases, from.alias)
      const expression = column.applyEvolutionDefault
        ? applyEvolutionDefaultProjection(resolvedColumn)
        : resolvedColumn.sql
      if (!column.alias) {
        return expression
      }
      return `${expression} AS ${quoteIdentifier(column.alias)}`
    })
    .join(", ")

  const sqlParts = [
    spec.distinct ? `SELECT DISTINCT ${selectSql}` : `SELECT ${selectSql}`,
    `FROM ${quoteTableRef(from.table, from.alias)}`,
  ]

  for (const join of joins) {
    const resolvedJoin = tableAliases.get(join.alias ?? join.table)
    if (!resolvedJoin) {
      throw new Error(`Unknown join alias: ${join.alias ?? join.table}`)
    }
    if (!join.on.length) {
      throw new Error(`Join '${resolvedJoin.table}' requires at least one condition`)
    }

    const joinType = (join.type ?? "inner").toUpperCase()
    const conditions = join.on
      .map((condition) => {
        const left = resolveColumn(condition.left, tableAliases, from.alias).sql
        const right = resolveColumn(condition.right, tableAliases, from.alias).sql
        return `${left} = ${right}`
      })
      .join(" AND ")

    sqlParts.push(
      `${joinType} JOIN ${quoteTableRef(resolvedJoin.table, resolvedJoin.alias)} ON ${conditions}`
    )
  }

  if (spec.where?.length) {
    const whereSql = spec.where
      .map((filter) => compileFilter(filter, tableAliases, from.alias, params))
      .join(" AND ")
    sqlParts.push(`WHERE ${whereSql}`)
  }

  if (spec.groupBy?.length) {
    const groupBySql = spec.groupBy
      .map((column) => resolveColumn(column, tableAliases, from.alias).sql)
      .join(", ")
    sqlParts.push(`GROUP BY ${groupBySql}`)
  }

  if (spec.orderBy?.length) {
    const orderBySql = spec.orderBy
      .map((entry) => {
        const direction = (entry.direction ?? "asc").toUpperCase()
        return `${resolveColumn(entry.column, tableAliases, from.alias).sql} ${direction}`
      })
      .join(", ")
    sqlParts.push(`ORDER BY ${orderBySql}`)
  }

  if (spec.limit !== undefined) {
    if (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > 10_000) {
      throw new Error("Query limit must be an integer between 1 and 10000")
    }
    sqlParts.push(`LIMIT ${spec.limit}`)
  }

  return {
    sql: sqlParts.join("\n"),
    params,
  }
}

export function buildInlineLakehouseQuery(spec: LakehouseQuerySpec): string {
  const built = buildLakehouseQuery(spec)
  let paramIndex = 0
  return built.sql.replace(/\?/g, () => inlineSqlValue(built.params[paramIndex++]))
}
