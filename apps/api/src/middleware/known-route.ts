import type { MiddlewareHandler } from "hono"
import type { HonoEnv } from "~/hono/env"

type RegisteredRoute = {
  method: string
  path: string
}

type HttpMethod = "GET" | "POST"

const ALWAYS_ALLOWED_ROUTES: RegisteredRoute[] = [
  {
    method: "GET",
    path: "/favicon.ico",
  },
]

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function normalizeMethod(method: string): HttpMethod | "OPTIONS" | null {
  if (method === "HEAD") return "GET"
  if (method === "OPTIONS") return "OPTIONS"
  if (method === "GET" || method === "POST") return method
  return null
}

function isGlobalMiddlewareRoute(route: RegisteredRoute): boolean {
  return route.method === "ALL" && (route.path === "*" || route.path === "/*")
}

function isBroadcastRoute(route: RegisteredRoute): boolean {
  return route.method === "ALL" && route.path === "/broadcast/**"
}

function pathToRegExp(path: string): RegExp {
  const segments = path.split("/").map((segment) => {
    if (segment === "**") {
      return ".*"
    }

    if (segment === "*") {
      return "[^/]+"
    }

    if (
      (segment.startsWith("{") && segment.endsWith("}")) ||
      (segment.startsWith(":") && segment.length > 1)
    ) {
      return "[^/]+"
    }

    return escapeRegExp(segment)
  })

  return new RegExp(`^${segments.join("/")}$`)
}

function routeMatchesPath(route: RegisteredRoute, pathname: string): boolean {
  if (isGlobalMiddlewareRoute(route)) {
    return false
  }

  if (route.path.endsWith("/**")) {
    const basePath = route.path.slice(0, -3)
    return pathname === basePath || pathname.startsWith(`${basePath}/`)
  }

  return pathToRegExp(route.path).test(pathname)
}

function routeAllowsMethod(route: RegisteredRoute, method: HttpMethod | "OPTIONS"): boolean {
  if (method === "OPTIONS") {
    return true
  }

  if (isBroadcastRoute(route)) {
    return method === "GET"
  }

  return route.method === method
}

export function isKnownRoute(
  method: string,
  pathname: string,
  routes: readonly RegisteredRoute[]
): boolean {
  const normalizedMethod = normalizeMethod(method.toUpperCase())

  if (!normalizedMethod) {
    return false
  }

  return [...routes, ...ALWAYS_ALLOWED_ROUTES].some(
    (route) => routeMatchesPath(route, pathname) && routeAllowsMethod(route, normalizedMethod)
  )
}

export function knownRoute(
  getRoutes: () => readonly RegisteredRoute[]
): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const pathname = new URL(c.req.url).pathname

    if (!isKnownRoute(c.req.method, pathname, getRoutes())) {
      return c.body(null, 404)
    }

    await next()
  }
}
