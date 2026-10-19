import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// Prints the part of the API's OpenAPI document that @unprice/budgets types against: the public
// operations whose SDK path starts with `budgets`, and every component they reference. It also
// keeps every schema any operation answers with on an error status, so `ApiError` is the same
// union as in @unprice/api, which re-exports it and hands its own transport to this package's
// handles. Pipe the output into openapi-typescript and generate-sdk-resources.mjs (`-`).

const METHODS = ["get", "post", "put", "patch", "delete"]
const [, , inputArg] = process.argv

if (!inputArg) {
  console.error("usage: node tooling/scripts/sdk-codegen/budget-openapi.mjs <openapi.json>")
  process.exit(1)
}

const document = JSON.parse(readFileSync(resolve(process.cwd(), inputArg), "utf8"))
const components = document.components ?? {}

const isBudgetOperation = (operation) => {
  const contract = operation?.["x-unprice"]
  return contract?.audience === "public" && contract.sdk?.path?.[0] === "budgets"
}

const operationsOf = (item) => METHODS.flatMap((method) => (item[method] ? [item[method]] : []))

const paths = {}
for (const [path, item] of Object.entries(document.paths ?? {})) {
  const kept = Object.fromEntries(
    Object.entries(item).filter(
      ([method, operation]) => !METHODS.includes(method) || isBudgetOperation(operation)
    )
  )
  if (METHODS.some((method) => kept[method])) paths[path] = kept
}

// Walk every `$ref` reachable from the kept paths and from every operation's error responses.
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
for (const item of Object.values(document.paths ?? {})) {
  for (const operation of operationsOf(item)) {
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      if (/^[45]/.test(status)) visit(response)
    }
  }
}

const kept = {}
for (const [kind, names] of keep) {
  kept[kind] = Object.fromEntries([...names].sort().map((name) => [name, components[kind][name]]))
}
if (components.securitySchemes) kept.securitySchemes = components.securitySchemes

process.stdout.write(`${JSON.stringify({ ...document, paths, components: kept }, null, 2)}\n`)
const operations = Object.values(paths).flatMap(operationsOf)
console.error(
  `kept ${operations.length} budget operations and ${[...keep.values()].reduce((n, s) => n + s.size, 0)} components`
)
