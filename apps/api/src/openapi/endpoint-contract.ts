import type { createRoute } from "@hono/zod-openapi"

type RouteConfig = Parameters<typeof createRoute>[0]

export type EndpointAudience = "public" | "internal" | "callback"
export type EndpointCategory = "runtime" | "configuration" | "money" | "analytics" | "operations"

export type EndpointContract = {
  audience: EndpointAudience
  category: EndpointCategory
  docs?: {
    expose: boolean
  }
  sdk:
    | false
    | {
        path: readonly [string, ...string[]]
      }
  idempotency?: {
    required: boolean
    location: "body" | "header"
    field: string
  }
}

type RouteIdentity = {
  operationId: string
  path: string
  tags: readonly string[]
}

type EndpointRouteConfig = RouteConfig & RouteIdentity

type EndpointRouteExtension = {
  "x-unprice": EndpointContract
}

function sdkPathToOperationId(path: readonly [string, ...string[]]): string {
  return path.join(".")
}

function getFirstPublicPathSegment(path: string): string | null {
  const parts = path.split("/").filter(Boolean)

  if (parts[0] !== "v1") {
    return null
  }

  if (parts[1] === "internal") {
    return parts[2] ?? null
  }

  return parts[1] ?? null
}

function normalizePathSegment(segment: string | null): string | null {
  if (!segment) {
    return null
  }

  return segment.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

export function validateEndpointContract(route: RouteIdentity, contract: EndpointContract): void {
  if (contract.sdk === undefined) {
    throw new Error(`endpoint ${route.operationId} must declare sdk metadata`)
  }

  if (contract.audience !== "public") {
    if (contract.sdk !== false) {
      throw new Error(`${contract.audience} endpoint ${route.operationId} must use sdk: false`)
    }

    return
  }

  if (contract.sdk === false) {
    return
  }

  const expectedOperationId = sdkPathToOperationId(contract.sdk.path)

  if (route.operationId !== expectedOperationId) {
    throw new Error(`public endpoint ${route.operationId} must use sdk.path ${expectedOperationId}`)
  }

  const sdkNamespace = contract.sdk.path[0]
  const firstTag = route.tags[0]

  if (firstTag !== sdkNamespace) {
    throw new Error(`public endpoint ${route.operationId} must use first tag ${sdkNamespace}`)
  }

  const firstPathSegment = normalizePathSegment(getFirstPublicPathSegment(route.path))

  if (firstPathSegment !== sdkNamespace) {
    throw new Error(
      `public endpoint ${route.operationId} must use first /v1 path segment ${sdkNamespace}`
    )
  }
}

export function defineEndpointContract<const TRoute extends EndpointRouteConfig>(
  route: TRoute,
  contract: EndpointContract
): TRoute & EndpointRouteExtension {
  validateEndpointContract(route, contract)

  return {
    ...route,
    "x-unprice": contract,
  }
}
