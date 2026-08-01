import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { sdkOperationIds } from "./generated/sdk-resources"

const openApiMethods = ["get", "post", "put", "patch", "delete"] as const
const operationId = (...segments: string[]) => segments.join(".")

const removedOperationIds = [
  operationId("realtime", "createTicket"),
  operationId("events", "ingest"),
  operationId("events", "ingestSync"),
  operationId("entitlements", "verify"),
  operationId("plans", "getVersion"),
  operationId("payments", "methods", "create"),
  operationId("billing", "reservations", "flushForInvoicing"),
  operationId("wallet", "internalGet"),
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readOpenApiDocument = () =>
  JSON.parse(readFileSync(resolve(__dirname, "../../../apps/docs/openapi.json"), "utf8")) as unknown

const getPaths = (document: unknown) => {
  expect(isRecord(document)).toBe(true)

  if (!isRecord(document)) {
    throw new Error("OpenAPI document must be an object")
  }

  expect(isRecord(document.paths)).toBe(true)

  if (!isRecord(document.paths)) {
    throw new Error("OpenAPI document must have a paths object")
  }

  return document.paths
}

const collectOpenApiSdkOperationIds = (paths: Record<string, unknown>) => {
  const operationIds: string[] = []

  for (const pathItem of Object.values(paths)) {
    if (!isRecord(pathItem)) {
      continue
    }

    for (const method of openApiMethods) {
      const operation = pathItem[method]

      if (!isRecord(operation)) {
        continue
      }

      const contract = operation["x-unprice"]

      if (!isRecord(contract)) {
        continue
      }

      if (contract.audience !== "public" || contract.sdk === false) {
        continue
      }

      expect(typeof operation.operationId).toBe("string")

      if (typeof operation.operationId !== "string") {
        throw new Error("Public SDK OpenAPI operation must have a string operationId")
      }

      operationIds.push(operation.operationId)
    }
  }

  return operationIds.sort()
}

describe("OpenAPI SDK contract", () => {
  it("keeps generated SDK operations aligned with the public OpenAPI SDK surface", () => {
    const paths = getPaths(readOpenApiDocument())
    const openApiSdkOperationIds = collectOpenApiSdkOperationIds(paths)

    expect([...sdkOperationIds].sort()).toEqual(openApiSdkOperationIds)
  })

  // The equality assertion above passes when both sides are missing the same
  // operation, which is exactly what regenerating from a stale `apps/docs/openapi.json`
  // produces. Name the configuration operations explicitly so a spec that never
  // reached the live API fails here instead of shipping a silently smaller SDK.
  it("exposes the monetization configuration operations in the checked-in OpenAPI document", () => {
    const paths = getPaths(readOpenApiDocument())

    expect(collectOpenApiSdkOperationIds(paths)).toEqual(
      expect.arrayContaining(["monetization.apply", "monetization.get"])
    )
    expect(isRecord(paths["/v1/monetization/apply"])).toBe(true)
    expect(isRecord(paths["/v1/monetization/get"])).toBe(true)
  })

  it("does not expose stale removed operations in the OpenAPI SDK surface", () => {
    const sdkOperationIds = collectOpenApiSdkOperationIds(getPaths(readOpenApiDocument()))

    for (const operationId of removedOperationIds) {
      expect(sdkOperationIds).not.toContain(operationId)
    }
    expect(sdkOperationIds.some((operationId) => operationId.startsWith("agents."))).toBe(false)
    expect(
      sdkOperationIds.some((operationId) => operationId.startsWith("paymentProviderCallbacks."))
    ).toBe(false)
  })
})
