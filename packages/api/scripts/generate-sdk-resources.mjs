import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const METHODS = ["get", "post", "put", "patch", "delete"]

const [, , openApiPathArg, outputPathArg] = process.argv

if (!openApiPathArg || !outputPathArg) {
  console.error("usage: node scripts/generate-sdk-resources.mjs <openapi.json> <output.ts>")
  process.exit(1)
}

const openApiPath = resolve(process.cwd(), openApiPathArg)
const outputPath = resolve(process.cwd(), outputPathArg)
const document = JSON.parse(readFileSync(openApiPath, "utf8"))

function assertRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }

  return value
}

function getPathParams(path) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
}

function getOperationParameters(pathItem, operation) {
  return [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].filter(
    (parameter) => typeof parameter === "object" && parameter !== null && !("$ref" in parameter)
  )
}

function hasQueryParams(pathItem, operation) {
  return getOperationParameters(pathItem, operation).some((parameter) => parameter.in === "query")
}

function getSdkPath(operationId, operation) {
  const contract = operation["x-unprice"]

  if (!contract || contract.audience !== "public") {
    return null
  }

  if (contract.sdk === false) {
    return null
  }

  if (!contract.sdk || typeof contract.sdk !== "object") {
    throw new Error(
      `public operation ${operationId} must define x-unprice.sdk or x-unprice.sdk=false`
    )
  }

  const path = contract.sdk.path

  if (!Array.isArray(path) || path.length === 0) {
    throw new Error(`public operation ${operationId} must define x-unprice.sdk.path`)
  }

  const joinedPath = path.join(".")

  if (joinedPath !== operationId) {
    throw new Error(`public operation ${operationId} has mismatched sdk path ${joinedPath}`)
  }

  for (const part of path) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(part)) {
      throw new Error(`public operation ${operationId} has non-identifier sdk path part ${part}`)
    }
  }

  return path
}

function collectOperations(openApiDocument) {
  const paths = assertRecord(openApiDocument.paths, "openapi.paths")
  const operations = []

  for (const [path, pathItemValue] of Object.entries(paths)) {
    const pathItem = assertRecord(pathItemValue, `path item ${path}`)

    for (const method of METHODS) {
      const operationValue = pathItem[method]

      if (!operationValue) {
        continue
      }

      const operation = assertRecord(operationValue, `${method.toUpperCase()} ${path}`)
      const operationId = operation.operationId

      if (typeof operationId !== "string") {
        throw new Error(`${method.toUpperCase()} ${path} is missing operationId`)
      }

      const sdkPath = getSdkPath(operationId, operation)

      if (!sdkPath) {
        continue
      }

      operations.push({
        operationId,
        method: method.toUpperCase(),
        path,
        sdkPath,
        pathParams: getPathParams(path),
        hasInput:
          getPathParams(path).length > 0 ||
          hasQueryParams(pathItem, operation) ||
          Boolean(operation.requestBody),
      })
    }
  }

  return operations.sort((left, right) => left.operationId.localeCompare(right.operationId))
}

function insertOperation(tree, operation) {
  let cursor = tree
  const currentPath = []

  for (const part of operation.sdkPath.slice(0, -1)) {
    currentPath.push(part)
    cursor.children ??= new Map()

    if (!cursor.children.has(part)) {
      cursor.children.set(part, {})
    }

    cursor = cursor.children.get(part)

    if (cursor.operation) {
      throw new Error(
        `sdk path ${currentPath.join(".")} cannot be both an operation and a namespace for ${
          operation.operationId
        }`
      )
    }
  }

  const leafName = operation.sdkPath.at(-1)

  cursor.children ??= new Map()

  const existingLeaf = cursor.children.get(leafName)

  if (existingLeaf?.operation) {
    throw new Error(`duplicate sdk path ${operation.sdkPath.join(".")}`)
  }

  if (existingLeaf?.children) {
    throw new Error(
      `sdk path ${operation.sdkPath.join(".")} cannot be both a namespace and an operation`
    )
  }

  cursor.children.set(leafName, { operation })
}

function renderTypeNode(node, indent = "  ") {
  const children = [...(node.children ?? new Map()).entries()]

  return [
    "{",
    ...children.map(([name, child]) => {
      if (child.operation) {
        const id = child.operation.operationId

        if (!child.operation.hasInput) {
          return `${indent}${name}: () => Promise<ApiResult<OperationResponse<"${id}">>>`
        }

        return `${indent}${name}: (
${indent}  req: OperationInput<"${id}">
${indent}) => Promise<ApiResult<OperationResponse<"${id}">>>`
      }

      return `${indent}${name}: ${renderTypeNode(child, `${indent}  `)}`
    }),
    `${indent.slice(2)}}`,
  ].join("\n")
}

function renderValueNode(node, indent = "  ") {
  const children = [...(node.children ?? new Map()).entries()]

  return [
    "{",
    ...children.map(([name, child]) => {
      if (child.operation) {
        const id = child.operation.operationId
        const implementation = child.operation.hasInput
          ? `(req) => requester("${id}", req)`
          : `() => requester("${id}", undefined)`

        return `${indent}${name}: ${implementation},`
      }

      return `${indent}${name}: ${renderValueNode(child, `${indent}  `)},`
    }),
    `${indent.slice(2)}}`,
  ].join("\n")
}

function formatOutput(outputPath) {
  execFileSync("pnpm", ["biome", "format", outputPath, "--write"], {
    stdio: "ignore",
  })
}

const operations = collectOperations(document)
const root = {}

for (const operation of operations) {
  insertOperation(root, operation)
}

const operationsSource = operations
  .map((operation) => {
    const pathParams = operation.pathParams.map((param) => `"${param}"`).join(", ")

    return `  "${operation.operationId}": {
    method: "${operation.method}",
    path: "${operation.path}",
    pathParams: [${pathParams}],
  },`
  })
  .join("\n")

const source = `/* eslint-disable */
/* This file is generated by packages/api/scripts/generate-sdk-resources.mjs. */

import type { OperationInput, OperationRequester, OperationResponse } from "../operation-types"
import type { ApiResult } from "../result"

export const sdkOperations = {
${operationsSource}
} as const

export type SdkOperationId = keyof typeof sdkOperations

export type GeneratedSdkResources = ${renderTypeNode(root)}

export function createGeneratedSdkResources(
  requester: OperationRequester
): GeneratedSdkResources {
  return ${renderValueNode(root, "    ")}
}
`

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, source)
formatOutput(outputPath)
console.info(`generated ${operations.length} SDK operations at ${outputPath}`)
