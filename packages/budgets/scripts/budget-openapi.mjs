import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

// Writes the part of the API's OpenAPI document that @unprice/budgets types against: the public
// operations whose SDK path starts with `budgets`, every component they reference, and every
// error schema. Keeping all error schemas makes `ApiError` the same union as in @unprice/api, so
// @unprice/api can hand its own budget transport to this package's handles.

const METHODS = ["get", "post", "put", "patch", "delete"]
const [, , inputArg, outputArg] = process.argv

if (!inputArg || !outputArg) {
  console.error("usage: node scripts/budget-openapi.mjs <openapi.json> <output.json>")
  process.exit(1)
}

const document = JSON.parse(readFileSync(resolve(process.cwd(), inputArg), "utf8"))
const components = document.components ?? {}

const isBudgetOperation = (operation) => {
  const contract = operation?.["x-unprice"]
  return contract?.audience === "public" && contract.sdk?.path?.[0] === "budgets"
}

const paths = {}
for (const [path, item] of Object.entries(document.paths ?? {})) {
  const kept = Object.fromEntries(
    Object.entries(item).filter(
      ([method, operation]) => !METHODS.includes(method) || isBudgetOperation(operation)
    )
  )
  if (METHODS.some((method) => kept[method])) paths[path] = kept
}

// Walk every `$ref` reachable from the kept paths and the error schemas.
const keep = new Map()
const visit = (value) => {
  if (Array.isArray(value)) {
    for (const item of value) visit(item)
    return
  }
  if (typeof value !== "object" || value === null) return
  const ref = value.$ref
  if (typeof ref === "string" && ref.startsWith("#/components/")) {
    const [, , kind, name] = ref.split("/")
    const names = keep.get(kind) ?? new Set()
    if (!names.has(name)) {
      names.add(name)
      keep.set(kind, names)
      visit(components[kind]?.[name])
    }
  }
  for (const child of Object.values(value)) visit(child)
}
visit(paths)
for (const [name, schema] of Object.entries(components.schemas ?? {})) {
  if (schema?.properties?.error) visit({ $ref: `#/components/schemas/${name}` })
}

const kept = {}
for (const [kind, names] of keep) {
  kept[kind] = Object.fromEntries([...names].sort().map((name) => [name, components[kind][name]]))
}
if (components.securitySchemes) kept.securitySchemes = components.securitySchemes

const subset = { ...document, paths, components: kept }
writeFileSync(resolve(process.cwd(), outputArg), `${JSON.stringify(subset, null, 2)}\n`)
const operations = Object.values(paths).flatMap((item) => METHODS.filter((method) => item[method]))
console.info(
  `kept ${operations.length} budget operations and ${[...keep.values()].reduce((n, s) => n + s.size, 0)} components`
)
